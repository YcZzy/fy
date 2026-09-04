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

let pendingTimer = null
let syncing = false
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
async function syncCollection(collection, items) {
  const ref = wx.cloud.database().collection(collection)
  const remote = await ownDocuments(collection)
  const remoteByLocalId = remote.reduce((map, item) => { map[item.localId] = item; return map }, {})
  const localIds = new Set()
  for (const item of items) {
    const localId = item.localId || item.id
    localIds.add(localId)
    const payload = { ...clean(item), localId, syncedAt: Date.now() }
    const existing = remoteByLocalId[localId]
    if (existing) {
      if (!sameDocument(existing, payload)) await ref.doc(existing._id).update({ data: payload })
    } else await ref.add({ data: payload })
  }
  for (const item of remote) {
    if (!localIds.has(item.localId)) await ref.doc(item._id).remove()
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
function snapshot(state) {
  return {
    user_preferences: [{ localId: 'preferences', ...state.preferences, updatedAt: state.preferences.updatedAt || state.updatedAt }],
    ...Object.keys(COLLECTIONS).reduce((result, key) => {
      result[COLLECTIONS[key]] = (state[key] || []).map((item) => {
        if (key !== 'footprints') return item
        const safe = { ...item }
        delete safe.localPhotoPaths
        return safe
      })
      return result
    }, {})
  }
}
async function push() {
  if (!enabled() || syncing || !latestState || !pendingCollections.size) return
  const state = latestState
  const collections = [...pendingCollections]
  pendingCollections.clear()
  syncing = true
  let succeeded = false
  try {
    const data = snapshot(state)
    for (const collection of collections) await syncCollection(collection, data[collection] || [])
    retryAttempt = 0
    succeeded = true
  } catch (error) {
    collections.forEach((collection) => pendingCollections.add(collection))
    retryAttempt += 1
    throw error
  } finally {
    syncing = false
    if (pendingCollections.size) armTimer(succeeded ? 0 : Math.min(30000, 1000 * Math.pow(2, retryAttempt)))
  }
}
function armTimer(delay = 900) {
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    push().catch((error) => console.warn('云端同步失败，本地数据仍已保存', error))
  }, delay)
}
function schedule(state, collections = Object.keys(snapshot(state))) {
  if (!enabled() || !collections.length) return
  latestState = JSON.parse(JSON.stringify(state))
  collections.forEach((collection) => pendingCollections.add(collection))
  if (!syncing) armTimer()
}
async function bootstrap() {
  if (!enabled()) return
  const repository = require('./repository')
  const local = repository.getState()
  let foundRemote = false
  const names = ['user_preferences', ...Object.values(COLLECTIONS)]
  const response = await wx.cloud.callFunction({ name: 'dataManager', data: { action: 'load' } })
  if (!response.result || response.result.code !== 0) throw new Error('CLOUD_SNAPSHOT_LOAD_FAILED')
  const byName = response.result.data || {}
  const preferences = byName.user_preferences || []
  foundRemote = preferences.length > 0 || Object.values(COLLECTIONS).some((name) => (byName[name] || []).length > 0)
  if (foundRemote) {
    if (preferences.length) { local.preferences = clean(preferences[0]); delete local.preferences.localId; delete local.preferences.syncedAt }
    for (const key of Object.keys(COLLECTIONS)) {
      const docs = byName[COLLECTIONS[key]] || []
      local[key] = docs.map((item) => { const value = clean(item); delete value.localId; delete value.syncedAt; return value })
    }
  }
  // 云端恢复只落本地，不能再次触发全量回写。
  if (foundRemote) repository.saveState(local, { sync: false })
  else schedule(local, names)
}

module.exports = { schedule, bootstrap, sameDocument, ownDocuments }
