const env = require('../config/env')

const COLLECTIONS = {
  domains: 'life_domains',
  actions: 'actions',
  plans: 'plans',
  footprints: 'footprints',
  reviews: 'reviews',
  conversations: 'ai_conversations',
  wishes: 'wishes'
}
const COLLECTION_KEYS = Object.keys(COLLECTIONS).reduce((result, key) => { result[COLLECTIONS[key]] = key; return result }, { user_preferences: 'preferences' })

let pendingTimer = null
let initialized = false
let bootstrapPromise = Promise.resolve()
let activePushPromise = null
let latestState = null
const pendingCollections = new Set()
let retryAttempt = 0
let generation = 0
let suspended = false
let status = { state: 'idle', error: '', lastSyncedAt: 0 }
function getStatus() {
  const local = require('./repository').getState()
  return { ...status, state: local.deletionPending ? 'deleting' : status.state, pending: local.syncQueue.length, lastSyncedAt: local.lastSyncedAt || status.lastSyncedAt }
}
function reset() {
  generation += 1; suspended = false
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = null; latestState = null; pendingCollections.clear(); retryAttempt = 0
  status = { state: 'idle', error: '', lastSyncedAt: 0 }
}
async function prepareDelete() {
  suspended = true; generation += 1
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = null; status.state = 'deleting'
  await Promise.allSettled([activePushPromise, bootstrapPromise].filter(Boolean))
  latestState = null; pendingCollections.clear()
}
async function request(data) {
  const response = await wx.cloud.callFunction({ name: 'dataManager', data })
  const result = response.result
  if (!result || result.protocol !== 2) throw new Error('请更新云端 dataManager 后重试')
  if (result.code !== 0) throw new Error(result.message || '云同步暂未完成')
  return result
}
function acceptEpoch(result) {
  const repository = require('./repository')
  if (result.deleting) throw new Error('个人数据删除尚未完成，请在设置中继续')
  if (repository.getState().cloudEpoch === result.epoch) return true
  repository.deleteAllPersonalData(result.epoch)
  status.state = 'reset'
  if (wx.showToast) wx.showToast({ title: '已按其他设备的删除操作重置数据', icon: 'none' })
  return false
}
function failed(error) { status = { ...status, state: 'error', error: error.message || '同步未完成' } }

function enabled() { return Boolean(env.CLOUD_ENV_ID && env.ENABLE_CLOUD_SYNC && wx.cloud) }
function clean(doc) {
  const value = { ...doc }
  delete value._id
  delete value._openid
  delete value.syncEpoch
  return value
}
function recordTime(item) {
  return Number(item && (item.updatedAt || item.deletedAt || item.createdAt || item.syncedAt) || 0)
}
function queueMap(queue) {
  return (queue || []).reduce((result, item) => {
    const value = typeof item === 'string' ? { collection: item, queuedAt: 0 } : item
    if (value && value.collection) result[value.collection] = Math.max(Number(result[value.collection] || 0), Number(value.queuedAt || 0))
    return result
  }, {})
}
function candidate(raw, origin, fallbackId) {
  const value = clean(raw || {})
  const id = value.localId || value.id || fallbackId
  delete value.localId
  delete value.syncedAt
  return { id, value, origin, deleted: value._deleted === true, time: recordTime(raw) }
}
function mergeCollection(localItems, remoteItems, localTombstones = {}, preferLocal = true, fallbackId = '') {
  const selected = new Map()
  const choose = (entry) => {
    if (!entry.id) return
    const current = selected.get(entry.id)
    const preferredOrigin = preferLocal ? 'local' : 'remote'
    if (!current || entry.time > current.time || (entry.time === current.time && (entry.deleted && !current.deleted || entry.deleted === current.deleted && entry.origin === preferredOrigin))) selected.set(entry.id, entry)
  }
  ;(localItems || []).forEach((item) => choose(candidate(item, 'local', fallbackId)))
  Object.keys(localTombstones || {}).forEach((id) => {
    const deletedAt = Number(localTombstones[id] || 0)
    choose(candidate({ id, _deleted: true, deletedAt, updatedAt: deletedAt }, 'local', id))
  })
  ;(remoteItems || []).forEach((item) => choose(candidate(item, 'remote', fallbackId)))

  const items = []
  const tombstones = {}
  selected.forEach((entry, id) => {
    if (entry.deleted) { tombstones[id] = entry.time; return }
    const value = { ...entry.value }
    delete value._deleted
    delete value.deletedAt
    items.push(value)
  })
  return { items, tombstones }
}
function wireDocuments(items, tombstones, fallbackId = '') {
  const live = (items || []).map((item) => ({ ...item, localId: item.id || fallbackId, _deleted: false }))
  const deleted = Object.keys(tombstones || {}).map((id) => {
    const deletedAt = Number(tombstones[id] || 0)
    return { id, localId: id, _deleted: true, deletedAt, updatedAt: deletedAt }
  })
  return [...live, ...deleted]
}

async function ownDocuments(collection) {
  const records = []
  let offset = 0
  while (true) {
    const result = await wx.cloud.database().collection(collection).where({ _openid: '{openid}' }).skip(offset).limit(100).get()
    const page = result.data || []
    records.push(...page)
    if (page.length < 100) break
    offset += page.length
  }
  return records
}
function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => {
    if (!['_id', '_openid', 'syncedAt', 'syncEpoch'].includes(key)) result[key] = normalized(value[key])
    return result
  }, {})
}
function sameDocument(left, right) {
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right))
}

async function pushOnce() {
  if (!enabled() || suspended || !initialized || !latestState || !pendingCollections.size) return
  const repository = require('./repository')
  if (repository.getState().deletionPending) return
  const ownGeneration = generation
  const state = latestState
  const collections = [...pendingCollections]
  const capturedQueue = queueMap(state.syncQueue)
  pendingCollections.clear(); status.state = 'syncing'
  try {
    const snapshot = await request({ action: 'load', collections })
    if (ownGeneration !== generation || suspended || !acceptEpoch(snapshot)) return
    const results = []
    for (const collection of collections) {
      if (ownGeneration !== generation || suspended) return
      const key = COLLECTION_KEYS[collection]
      const local = key === 'preferences' ? [{ ...state.preferences, localId: 'preferences' }] : state[key] || []
      const remote = snapshot.data[collection] || []
      const merged = mergeCollection(local, remote, (state.syncTombstones || {})[key] || {}, true, key === 'preferences' ? 'preferences' : '')
      const documents = wireDocuments(merged.items, merged.tombstones, key === 'preferences' ? 'preferences' : '').map((item) => {
        const safe = { ...item }; delete safe.localPhotoPaths; return safe
      }).filter((item) => {
        const existing = remote.find((value) => (value.localId || value.id) === item.localId)
        return !existing || !sameDocument(existing, item)
      })
      for (let index = 0; index < documents.length; index += 20) {
        if (ownGeneration !== generation || suspended) return
        await request({ action: 'sync', epoch: state.cloudEpoch, collection, documents: documents.slice(index, index + 20) })
      }
      results.push({ collection, key })
    }
    if (ownGeneration !== generation || suspended) return
    const committed = await request({ action: 'load', collections })
    if (ownGeneration !== generation || suspended || !acceptEpoch(committed)) return
    const fresh = repository.getState()
    const before = JSON.stringify([fresh.preferences, fresh.domains, fresh.actions, fresh.plans, fresh.footprints])
    const currentQueue = queueMap(fresh.syncQueue)
    results.forEach(({ collection, key }) => {
      if (Number(currentQueue[collection] || 0) > Number(capturedQueue[collection] || 0)) return
      const localItems = key === 'preferences' ? [{ ...fresh.preferences, localId: 'preferences' }] : fresh[key]
      const merged = mergeCollection(localItems, committed.data[collection] || [], fresh.syncTombstones[key] || {}, false, key === 'preferences' ? 'preferences' : '')
      if (key === 'preferences') fresh.preferences = merged.items[0] || fresh.preferences
      else {
        if (key === 'footprints') merged.items.forEach((item) => {
          const previous = fresh.footprints.find((value) => value.id === item.id)
          if (previous && recordTime(previous) === recordTime(item) && previous.localPhotoPaths) item.localPhotoPaths = previous.localPhotoPaths
        })
        fresh[key] = merged.items; fresh.syncTombstones[key] = merged.tombstones
      }
      delete currentQueue[collection]
    })
    fresh.syncQueue = Object.keys(currentQueue).map((collection) => ({ collection, queuedAt: currentQueue[collection] }))
    if (before !== JSON.stringify([fresh.preferences, fresh.domains, fresh.actions, fresh.plans, fresh.footprints])) fresh.recommendationCache = null
    fresh.lastSyncedAt = Date.now()
    repository.saveState(fresh, { sync: false }); latestState = fresh; retryAttempt = 0
    status = { state: 'synced', error: '', lastSyncedAt: fresh.lastSyncedAt }
  } catch (error) {
    if (ownGeneration === generation && !suspended) {
      collections.forEach((collection) => pendingCollections.add(collection)); retryAttempt += 1; failed(error)
      throw error
    }
  } finally {
    if (ownGeneration === generation && !suspended && pendingCollections.size) armTimer(Math.min(30000, 1000 * Math.pow(2, retryAttempt)))
  }
}
function push() {
  if (activePushPromise) return activePushPromise
  activePushPromise = pushOnce().finally(() => { activePushPromise = null })
  return activePushPromise
}
function armTimer(delay = 900) {
  if (!initialized || suspended) return
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    push().catch((error) => require('./cloud').warn('云端同步失败，已保留本地待同步任务', error))
  }, delay)
}
function schedule(state, collections) {
  if (!enabled() || suspended || state.deletionPending || !collections || !collections.length) return
  latestState = JSON.parse(JSON.stringify(state))
  collections.forEach((collection) => pendingCollections.add(collection)); armTimer()
}
function resumePending(state) {
  if (!enabled()) return
  const value = state || require('./repository').getState()
  if (value.deletionPending) { suspended = true; return }
  latestState = JSON.parse(JSON.stringify(value))
  Object.keys(queueMap(value.syncQueue)).forEach((collection) => pendingCollections.add(collection))
  if (pendingCollections.size) armTimer(0)
}
function initialize() { initialized = true }
function normalizePullKeys(keys) {
  const all = ['preferences', ...Object.keys(COLLECTIONS)]
  return !Array.isArray(keys) || !keys.length ? all : [...new Set(keys)].filter((key) => all.includes(key))
}
async function bootstrapOnce(keys, ownGeneration) {
  if (suspended || ownGeneration !== generation) return
  const repository = require('./repository')
  if (repository.getState().deletionPending) return
  try {
    if (activePushPromise) await activePushPromise.catch(() => {})
    if (suspended || ownGeneration !== generation) return
    const requestedKeys = normalizePullKeys(keys)
    const result = await request({ action: 'load', collections: requestedKeys.map((key) => key === 'preferences' ? 'user_preferences' : COLLECTIONS[key]) })
    if (ownGeneration !== generation || suspended || !acceptEpoch(result)) return
    const local = repository.getState()
    const before = JSON.stringify([local.preferences, local.domains, local.actions, local.plans, local.footprints])
    const queued = queueMap(local.syncQueue)
    requestedKeys.forEach((key) => {
      const collection = key === 'preferences' ? 'user_preferences' : COLLECTIONS[key]
      const remote = result.data[collection] || []
      if (key === 'preferences') {
        if (!remote.length) return
        const keepLocal = Boolean(queued[collection])
        const merged = mergeCollection(keepLocal ? [{ ...local.preferences, localId: 'preferences' }] : [], remote, {}, keepLocal, 'preferences')
        local.preferences = merged.items[0] || local.preferences
      } else {
        if (!remote.length) return
        const ids = new Set(remote.map((item) => item.localId || item.id))
        const latest = Math.max(...remote.map(recordTime))
        const candidates = queued[collection] ? local[key] : (local[key] || []).filter((item) => ids.has(item.id) || recordTime(item) > latest)
        const merged = mergeCollection(candidates, remote, local.syncTombstones[key] || {}, Boolean(queued[collection]))
        // Device-local photo files are never part of the cloud document.
        if (key === 'footprints') merged.items.forEach((item) => {
          const previous = local.footprints.find((value) => value.id === item.id)
          if (previous && recordTime(previous) === recordTime(item) && previous.localPhotoPaths) item.localPhotoPaths = previous.localPhotoPaths
        })
        local[key] = merged.items; local.syncTombstones[key] = merged.tombstones
      }
    })
    repository.normalizeState(local)
    const after = JSON.stringify([local.preferences, local.domains, local.actions, local.plans, local.footprints])
    if (before !== after) local.recommendationCache = null
    local.lastSyncedAt = Date.now()
    repository.saveState(local, { sync: false })
    status = { state: 'synced', error: '', lastSyncedAt: local.lastSyncedAt }
    initialized = true
    if (pendingCollections.size) latestState = JSON.parse(JSON.stringify(local))
  } catch (error) { if (ownGeneration === generation && !suspended) { initialized = true; failed(error); throw error } }
}
function bootstrap(keys) {
  if (!enabled() || suspended) return Promise.resolve()
  const ownGeneration = generation
  bootstrapPromise = bootstrapPromise.catch(() => {}).then(() => bootstrapOnce(keys, ownGeneration))
  return bootstrapPromise
}
async function retry() { await bootstrap(); resumePending(); await push() }
function flush() { return push() }
module.exports = { initialize, schedule, bootstrap, flush, resumePending, sameDocument, ownDocuments, mergeCollection, recordTime, reset, prepareDelete, getStatus, retry }
