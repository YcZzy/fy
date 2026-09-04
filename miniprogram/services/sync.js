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

function enabled() { return Boolean(env.CLOUD_ENV_ID && env.ENABLE_CLOUD_SYNC && wx.cloud) }
function clean(doc) {
  const value = { ...doc }
  delete value._id
  delete value._openid
  return value
}
async function ownDocuments(collection) {
  const result = await wx.cloud.database().collection(collection).where({ _openid: '{openid}' }).limit(100).get()
  return result.data || []
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
  try {
    const data = snapshot(state)
    for (const collection of collections) await syncCollection(collection, data[collection] || [])
  } finally {
    syncing = false
    if (pendingCollections.size) armTimer(0)
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
  if (preferences.length) { local.preferences = clean(preferences[0]); delete local.preferences.localId; delete local.preferences.syncedAt; foundRemote = true }
  for (const key of Object.keys(COLLECTIONS)) {
    const docs = byName[COLLECTIONS[key]] || []
    if (docs.length) {
      local[key] = docs.map((item) => { const value = clean(item); delete value.localId; delete value.syncedAt; return value })
      foundRemote = true
    }
  }
  // 云端恢复只落本地，不能再次触发全量回写。
  if (foundRemote) repository.saveState(local, { sync: false })
  else schedule(local, names)
}

module.exports = { schedule, bootstrap, sameDocument }
