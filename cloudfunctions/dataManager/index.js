const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTIONS = ['user_preferences', 'life_domains', 'actions', 'plans', 'wishes', 'footprints', 'reviews', 'ai_conversations', 'ai_usage']
const SYNC_COLLECTIONS = COLLECTIONS.filter((name) => name !== 'ai_usage')

async function initializeCollections() {
  const results = await Promise.all(COLLECTIONS.map(async (name) => {
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

async function removeOwned(collection, openid) {
  while (true) {
    const result = await db.collection(collection).where({ _openid: openid }).limit(100).get()
    if (!result.data.length) break
    await Promise.all(result.data.map((item) => db.collection(collection).doc(item._id).remove()))
  }
}

function fileDeleteSucceeded(item) {
  if (!item) return false
  const status = Number(item.status)
  return item.code === 'SUCCESS' || status === 0 || status === -503003
}

async function removeFiles(fileList) {
  const failed = []
  for (let index = 0; index < fileList.length; index += 50) {
    const result = await cloud.deleteFile({ fileList: fileList.slice(index, index + 50) })
    failed.push(...(result.fileList || []).filter((item) => !fileDeleteSucceeded(item)))
  }
  if (failed.length) {
    const error = new Error('FILE_DELETE_INCOMPLETE')
    error.details = failed
    throw error
  }
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

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) throw new Error('UNAUTHENTICATED')
  if (event.action === 'initialize' && event.confirm === 'CREATE_COLLECTIONS') return initializeCollections()
  if (event.action === 'load') return loadOwnedData(OPENID, event.collections)
  if (event.action !== 'deleteAll' || event.confirm !== 'DELETE_MY_DATA') throw new Error('INVALID_CONFIRMATION')

  const failures = []
  let footprints = []
  let footprintsReadable = true
  try { footprints = await getAllOwned('footprints', OPENID) }
  catch (error) {
    footprintsReadable = false
    failures.push({ target: 'footprints_read', message: error && error.message ? error.message : String(error) })
  }
  const fileList = [...new Set(footprints
    .reduce((all, item) => all.concat(Array.isArray(item.photoFileIds) ? item.photoFileIds : []), [])
    .filter((fileId) => typeof fileId === 'string' && fileId.trim()))]
  let filesDeleted = true
  if (fileList.length) {
    try { await removeFiles(fileList) }
    catch (error) {
      filesDeleted = false
      failures.push({ target: 'files', message: error && error.message ? error.message : String(error), details: error && error.details ? error.details : [] })
    }
  }
  // 只有确认照片已处理后才删除足迹文档，失败时保留文件 ID 以便下次重试。
  const removableCollections = COLLECTIONS.filter((name) => name !== 'footprints')
  if (footprintsReadable && filesDeleted) removableCollections.push('footprints')
  for (const collection of removableCollections) {
    try { await removeOwned(collection, OPENID) }
    catch (error) { failures.push({ target: collection, message: error && error.message ? error.message : String(error) }) }
  }
  if (failures.length) return { code: -1, deleted: false, failures }
  return { code: 0, deleted: true, collections: COLLECTIONS.length, files: fileList.length }
}
