const cloud = require('wx-server-sdk')
const crypto = require('crypto')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTIONS = ['user_preferences', 'life_domains', 'actions', 'plans', 'wishes', 'footprints', 'reviews', 'ai_conversations', 'ai_usage']
const SYNC_COLLECTIONS = COLLECTIONS.filter((name) => name !== 'ai_usage')
const CONTROL = 'sync_control'
const DELETE_COLLECTION_CONCURRENCY = 3
const DELETE_BUDGET_MS = 5000
const hash = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 40)
const protocol = value => ({ protocol: 2, ...value })

async function initializeCollections() {
  const results = await Promise.all([...COLLECTIONS, CONTROL].map(async (name) => {
    try {
      await db.createCollection(name)
      return { name, status: 'created' }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      const code = error && (error.errCode || error.code)
      const exists = /already exists|exist|duplicate/i.test(message) || code === -502004
      return { name, status: exists ? 'exists' : 'failed', code, message }
    }
  }))
  const failed = results.filter((item) => item.status === 'failed')
  return { code: failed.length ? -1 : 0, results }
}

async function getAllOwned(collection, openid) {
  const records = []
  let offset = 0
  while (true) {
    const result = await db.collection(collection).where({ _openid: openid }).skip(offset).limit(100).get()
    records.push(...result.data)
    if (result.data.length < 100) break
    offset += result.data.length
  }
  return records
}

async function removeOwnedCollection(collection, openid, epoch) {
  const _ = db.command
  // The database evaluates the version predicate when removing each document.
  // A delayed invocation cannot match data written after this reset.
  const query = _.or([
    { _openid: openid, syncEpoch: _.lt(epoch) },
    { _openid: openid, syncEpoch: _.exists(false) }
  ])
  await db.collection(collection).where(query).remove()
  // Do not mark a partially applied/limited bulk operation as complete.
  const remaining = await db.collection(collection).where(query).limit(1).get()
  return { collection, done: remaining.data.length === 0 }
}

async function checkpointDelete(openid, deletion, completed) {
  return db.runTransaction(async (tx) => {
    const ref = tx.collection(CONTROL).doc(hash(openid))
    const current = await readDoc(ref)
    if (!current || current.epoch !== deletion.epoch || current.deleteRequestId !== deletion.requestId) throw new Error('DELETE_VERSION_CHANGED')
    if (!current.deleting) return current
    const done = [...new Set([...(current.deleteCompletedCollections || []), ...completed])]
    const next = { ...current, deleteCompletedCollections: done, deleting: !COLLECTIONS.every(name => done.includes(name)), revision: (current.revision || 0) + 1 }
    await ref.update({ data: { deleteCompletedCollections: done, deleting: next.deleting, revision: next.revision } })
    return next
  })
}

async function loadOwnedData(openid, requestedCollections) {
  const requested = Array.isArray(requestedCollections) && requestedCollections.length
    ? [...new Set(requestedCollections)].filter((name) => SYNC_COLLECTIONS.includes(name))
    : SYNC_COLLECTIONS
  const results = await Promise.all(requested.map(async (name) => {
    try { return { name, documents: await getAllOwned(name, openid) } }
    catch (error) {
      return { name, documents: [], error: error && error.message ? error.message : String(error) }
    }
  }))
  const failed = results.filter((item) => item.error)
  return {
    code: failed.length ? -1 : 0,
    data: results.reduce((all, item) => { all[item.name] = item.documents; return all }, {}),
    errors: failed.map((item) => ({ name: item.name, message: item.error }))
  }
}

async function readDoc(ref) {
  try { const result = await ref.get(); return Array.isArray(result.data) ? result.data[0] : result.data }
  catch (error) {
    if (/document.*(not exist|not found)|document_not_(found|exist)/i.test(error.message || '')) return null
    throw error
  }
}
async function control(openid) {
  return db.runTransaction(async (tx) => {
    const ref = tx.collection(CONTROL).doc(hash(openid))
    let value = await readDoc(ref)
    if (!value) { value = { epoch: 0, deleting: false, revision: 0 }; await ref.set({ data: value }) }
    return value
  })
}
function time(item) { return Number(item && (item.updatedAt || item.deletedAt || item.createdAt) || 0) }
async function syncDocuments(openid, event) {
  if (!SYNC_COLLECTIONS.includes(event.collection) || !Array.isArray(event.documents) || event.documents.length > 20) throw new Error('INVALID_SYNC_PAYLOAD')
  const existing = await getAllOwned(event.collection, openid)
  const byId = existing.reduce((all, item) => { const id = item.localId || item.id; if (!all[id] || time(item) > time(all[id])) all[id] = item; return all }, {})
  for (const raw of event.documents) {
    const localId = raw && (raw.localId || raw.id)
    if (typeof localId !== 'string' || !localId || localId.length > 160 || JSON.stringify(raw).length > 500000) throw new Error('INVALID_DOCUMENT')
    await db.runTransaction(async (tx) => {
      const controlRef = tx.collection(CONTROL).doc(hash(openid))
      const meta = await readDoc(controlRef)
      if (!meta || meta.deleting || meta.epoch !== event.epoch) throw new Error('云端数据版本已变化，请刷新后重试')
      const docId = byId[localId] ? byId[localId]._id : hash(openid + '|' + event.collection + '|' + localId)
      const ref = tx.collection(event.collection).doc(docId)
      const current = await readDoc(ref)
      if (current && current._openid !== openid) throw new Error('FORBIDDEN')
      if (current && (time(current) > time(raw) || (time(current) === time(raw) && current._deleted && !raw._deleted))) return
      const payload = { ...raw, localId, _openid: openid, syncEpoch: event.epoch, syncedAt: Date.now() }
      delete payload._id; delete payload.localPhotoPaths
      await ref.set({ data: payload })
      // Writing the same control document serializes sync commits with deletion.
      await controlRef.update({ data: { revision: (meta.revision || 0) + 1 } })
    })
  }
  return protocol({ code: 0 })
}
async function beginDelete(openid, requestId) {
  if (typeof requestId !== 'string' || !requestId || requestId.length > 160) throw new Error('INVALID_DELETE_REQUEST')
  const meta = await db.runTransaction(async (tx) => {
    const ref = tx.collection(CONTROL).doc(hash(openid))
    const current = await readDoc(ref) || { epoch: 0, revision: 0 }
    if (current.deleteRequestId === requestId) return current
    if (current.deleting) return current
    const next = { epoch: current.epoch + 1, deleting: true, deleteRequestId: requestId, deleteCompletedCollections: [], revision: (current.revision || 0) + 1 }
    await ref.set({ data: next }); return next
  })
  const footprints = meta.deleting ? await getAllOwned('footprints', openid) : []
  const fileIds = [...new Set(footprints.reduce((all, item) => all.concat(item.photoFileIds || []), []))]
  return protocol({ code: 0, epoch: meta.epoch, requestId: meta.deleteRequestId, deleted: !meta.deleting, fileIds })
}
async function finishDelete(openid, event) {
  const startedAt = Date.now()
  let meta = await control(openid)
  if (event.confirm !== 'DELETE_MY_DATA' || event.requestId !== meta.deleteRequestId || event.epoch !== meta.epoch) throw new Error('INVALID_CONFIRMATION')
  if (!meta.deleting) return protocol({ code: 0, deleted: true, epoch: meta.epoch })
  let groups = 0
  // File deletion still uses the caller's client SDK before this step.
  while (meta.deleting && groups < Math.ceil(COLLECTIONS.length / DELETE_COLLECTION_CONCURRENCY) && Date.now() - startedAt < DELETE_BUDGET_MS) {
    const pending = COLLECTIONS.filter(name => !(meta.deleteCompletedCollections || []).includes(name)).slice(0, DELETE_COLLECTION_CONCURRENCY)
    const results = await Promise.all(pending.map(async collection => {
      try { return await removeOwnedCollection(collection, openid, meta.epoch) }
      catch (error) { return { collection, error: error.message || String(error) } }
    }))
    const completed = results.filter(item => item.done).map(item => item.collection)
    meta = await checkpointDelete(openid, event, completed)
    groups += 1
    const failures = results.filter(item => item.error).map(item => ({ target: item.collection, message: item.error }))
    if (failures.length) return protocol({ code: -1, deleted: false, message: '删除尚未完成，请重试', failures })
    if (results.some(item => !item.done)) break
  }
  console.info('deleteAll bulk', { groups, completedCollections: (meta.deleteCompletedCollections || []).length, elapsedMs: Date.now() - startedAt, deleted: !meta.deleting })
  return protocol({ code: 0, deleted: !meta.deleting, pending: meta.deleting, epoch: meta.epoch })
}
exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) throw new Error('UNAUTHENTICATED')
  try {
    if (event.action === 'initialize' && event.confirm === 'CREATE_COLLECTIONS') return protocol(await initializeCollections())
    if (event.action === 'beginDelete') return await beginDelete(OPENID, event.requestId)
    if (event.action === 'deleteAll') return await finishDelete(OPENID, event)
    const meta = await control(OPENID)
    if (meta.deleting) return protocol({ code: -1, deleting: true, epoch: meta.epoch, message: '个人数据删除尚未完成，请在设置中继续' })
    if (event.action === 'load') {
      const snapshot = await loadOwnedData(OPENID, event.collections)
      const latest = await control(OPENID)
      if (latest.deleting || latest.epoch !== meta.epoch) throw new Error('数据版本已变化，请重试')
      return protocol({ ...snapshot, epoch: meta.epoch })
    }
    if (event.action === 'sync') return await syncDocuments(OPENID, event)
    throw new Error('UNKNOWN_ACTION')
  } catch (error) { return protocol({ code: -1, message: error.message || '云端操作未完成' }) }
}
