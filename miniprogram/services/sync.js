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

function enabled() { return Boolean(env.CLOUD_ENV_ID && env.ENABLE_CLOUD_SYNC && wx.cloud) }
function clean(doc) {
  const value = { ...doc }
  delete value._id
  delete value._openid
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
    if (!current || entry.time > current.time || (entry.time === current.time && entry.origin === preferredOrigin)) selected.set(entry.id, entry)
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
async function upsertDocuments(collection, documents, remote) {
  const ref = wx.cloud.database().collection(collection)
  const remoteByLocalId = (remote || []).reduce((map, item) => { map[item.localId || item.id] = item; return map }, {})
  for (const item of documents) {
    const localId = item.localId || item.id
    const payload = { ...clean(item), localId, syncedAt: Date.now() }
    const existing = remoteByLocalId[localId]
    if (existing) {
      if (!sameDocument(existing, payload)) await ref.doc(existing._id).update({ data: payload })
    } else await ref.add({ data: payload })
  }
}
function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== 'object') return value
  return Object.keys(value).sort().reduce((result, key) => {
    if (!['_id', '_openid', 'syncedAt'].includes(key)) result[key] = normalized(value[key])
    return result
  }, {})
}
function sameDocument(left, right) {
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right))
}

async function mergeAndPushCollection(collection, state) {
  const remote = await ownDocuments(collection)
  if (collection === 'user_preferences') {
    const local = [{ ...state.preferences, localId: 'preferences' }]
    const merged = mergeCollection(local, remote, {}, true, 'preferences')
    await upsertDocuments(collection, wireDocuments(merged.items, {}, 'preferences'), remote)
    return { collection, key: 'preferences', merged }
  }
  const key = COLLECTION_KEYS[collection]
  const merged = mergeCollection(state[key] || [], remote, (state.syncTombstones || {})[key] || {}, true)
  const documents = wireDocuments(merged.items, merged.tombstones).map((item) => {
    if (key !== 'footprints') return item
    const safe = { ...item }
    delete safe.localPhotoPaths
    return safe
  })
  await upsertDocuments(collection, documents, remote)
  return { collection, key, merged }
}
async function pushOnce() {
  if (!enabled() || !initialized || !latestState || !pendingCollections.size) return
  const state = latestState
  const collections = [...pendingCollections]
  const capturedQueue = queueMap(state.syncQueue)
  pendingCollections.clear()
  let succeeded = false
  try {
    const results = []
    for (const collection of collections) results.push(await mergeAndPushCollection(collection, state))

    const repository = require('./repository')
    const fresh = repository.getState()
    const currentQueue = queueMap(fresh.syncQueue)
    fresh.syncTombstones = fresh.syncTombstones || {}
    results.forEach(({ collection, key, merged }) => {
      if (Number(currentQueue[collection] || 0) > Number(capturedQueue[collection] || 0)) return
      if (key === 'preferences') fresh.preferences = merged.items[0] || fresh.preferences
      else { fresh[key] = merged.items; fresh.syncTombstones[key] = merged.tombstones }
      delete currentQueue[collection]
    })
    fresh.syncQueue = Object.keys(currentQueue).map((collection) => ({ collection, queuedAt: currentQueue[collection] }))
    repository.saveState(fresh, { sync: false })
    latestState = fresh
    retryAttempt = 0
    succeeded = true
  } catch (error) {
    collections.forEach((collection) => pendingCollections.add(collection))
    retryAttempt += 1
    throw error
  } finally {
    if (pendingCollections.size) armTimer(succeeded ? 0 : Math.min(30000, 1000 * Math.pow(2, retryAttempt)))
  }
}
function push() {
  if (activePushPromise) return activePushPromise
  activePushPromise = pushOnce().finally(() => { activePushPromise = null })
  return activePushPromise
}
function armTimer(delay = 900) {
  if (!initialized) return
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    push().catch((error) => require('./cloud').warn('云端同步失败，已保留本地待同步任务', error))
  }, delay)
}
function schedule(state, collections) {
  if (!enabled() || !collections || !collections.length) return
  latestState = JSON.parse(JSON.stringify(state))
  collections.forEach((collection) => pendingCollections.add(collection))
  armTimer()
}
function resumePending(state) {
  if (!enabled()) return
  const value = state || require('./repository').getState()
  latestState = JSON.parse(JSON.stringify(value))
  Object.keys(queueMap(value.syncQueue)).forEach((collection) => pendingCollections.add(collection))
  if (pendingCollections.size) armTimer(0)
}
function initialize() { initialized = true }

function localCandidatesForBootstrap(localItems, remoteItems, dirty) {
  if (dirty || !remoteItems.length) return localItems || []
  const remoteIds = new Set(remoteItems.map((item) => item.localId || item.id))
  const latestRemote = remoteItems.reduce((latest, item) => Math.max(latest, Number(item.syncedAt || 0), recordTime(item)), 0)
  return (localItems || []).filter((item) => remoteIds.has(item.id) || recordTime(item) > latestRemote)
}
function normalizePullKeys(keys) {
  const all = ['preferences', ...Object.keys(COLLECTIONS)]
  if (!Array.isArray(keys) || !keys.length) return all
  return [...new Set(keys)].filter((key) => all.includes(key))
}
async function bootstrapOnce(keys) {
  try {
    if (activePushPromise) {
      try { await activePushPromise } catch (error) { require('./cloud').warn('先前的同步未完成，继续用云端快照合并', error) }
    }
    const requestedKeys = normalizePullKeys(keys)
    const requestedCollections = requestedKeys.map((key) => key === 'preferences' ? 'user_preferences' : COLLECTIONS[key])
    const response = await wx.cloud.callFunction({ name: 'dataManager', data: { action: 'load', collections: requestedCollections } })
    if (!response.result || response.result.code !== 0) throw new Error('CLOUD_SNAPSHOT_LOAD_FAILED')
    const byName = response.result.data || {}
    const repository = require('./repository')
    const local = repository.getState()
    const recommendationInputsBefore = JSON.stringify([local.preferences, local.domains, local.actions, local.plans, local.footprints])
    const queued = queueMap(local.syncQueue)
    local.syncTombstones = local.syncTombstones || {}

    if (requestedKeys.includes('preferences')) {
      const remotePreferences = byName.user_preferences || []
      if (remotePreferences.length) {
        const latestRemotePreference = remotePreferences.reduce((latest, item) => Math.max(latest, recordTime(item)), 0)
        const keepLocalPreference = Boolean(queued.user_preferences) || recordTime(local.preferences) > latestRemotePreference
        const localPreferences = keepLocalPreference ? [{ ...local.preferences, localId: 'preferences' }] : []
        const merged = mergeCollection(localPreferences, remotePreferences, {}, Boolean(queued.user_preferences), 'preferences')
        if (merged.items[0]) local.preferences = merged.items[0]
      }
    }

    requestedKeys.filter((key) => key !== 'preferences').forEach((key) => {
      const collection = COLLECTIONS[key]
      const remote = byName[collection] || []
      const tombstones = local.syncTombstones[key] || {}
      if (!remote.length) return
      const dirty = Boolean(queued[collection])
      const localItems = localCandidatesForBootstrap(local[key], remote, dirty)
      const merged = mergeCollection(localItems, remote, dirty ? tombstones : {}, dirty)
      local[key] = merged.items
      local.syncTombstones[key] = merged.tombstones
    })

    const relationsMigrated = repository.normalizeState(local)
    const recommendationInputsAfter = JSON.stringify([local.preferences, local.domains, local.actions, local.plans, local.footprints])
    if (recommendationInputsBefore !== recommendationInputsAfter) local.recommendationCache = null
    repository.saveState(local, relationsMigrated ? { collections: ['actions', 'plans'] } : { sync: false })
    initialized = true
  } catch (error) {
    initialized = true
    throw error
  }
}
function bootstrap(keys) {
  if (!enabled()) return
  bootstrapPromise = bootstrapPromise.catch(() => {}).then(() => bootstrapOnce(keys))
  return bootstrapPromise
}
function flush() {
  return push()
}

module.exports = { initialize, schedule, bootstrap, flush, resumePending, sameDocument, ownDocuments, mergeCollection, recordTime }
