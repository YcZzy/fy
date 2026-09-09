const { createInitialState } = require('../data/defaults')
const { uid } = require('./format')

const STORAGE_KEY = 'feng_yue_state_v1'
const STATE_VERSION = 4
const SYNC_COLLECTIONS = {
  preferences: 'user_preferences',
  domains: 'life_domains',
  actions: 'actions',
  plans: 'plans',
  footprints: 'footprints',
  reviews: 'reviews',
  conversations: 'ai_conversations',
  wishes: 'wishes'
}

function normalizeSyncQueue(queue) {
  const byCollection = {}
  ;(queue || []).forEach((item) => {
    const value = typeof item === 'string' ? { collection: item, queuedAt: 0 } : item
    if (!value || !value.collection) return
    const current = byCollection[value.collection]
    if (!current || Number(value.queuedAt || 0) > Number(current.queuedAt || 0)) byCollection[value.collection] = { collection: value.collection, queuedAt: Number(value.queuedAt || 0) }
  })
  return Object.values(byCollection)
}

function queueCollections(state, collections, queuedAt = Date.now()) {
  const queue = normalizeSyncQueue(state.syncQueue)
  const names = new Set(collections || [])
  const previous = queue.reduce((result, item) => { result[item.collection] = item.queuedAt; return result }, {})
  state.syncQueue = queue.filter((item) => !names.has(item.collection))
  names.forEach((collection) => state.syncQueue.push({ collection, queuedAt: Math.max(queuedAt, Number(previous[collection] || 0) + 1) }))
}

function recordDeletedItems(before, after, changedKeys) {
  after.syncTombstones = after.syncTombstones || {}
  const deletedAt = Date.now()
  changedKeys.forEach((key) => {
    if (!Array.isArray(before[key]) || !Array.isArray(after[key])) return
    const liveIds = new Set(after[key].map((item) => item && item.id).filter(Boolean))
    const removed = before[key].filter((item) => item && item.id && !liveIds.has(item.id))
    const tombstones = { ...(after.syncTombstones[key] || {}) }
    removed.forEach((item) => { tombstones[item.id] = Math.max(Number(tombstones[item.id] || 0), deletedAt) })
    liveIds.forEach((id) => { delete tombstones[id] })
    after.syncTombstones[key] = tombstones
  })
}

function changedCollections(before, after) {
  return Object.keys(SYNC_COLLECTIONS)
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => SYNC_COLLECTIONS[key])
}

function normalizeState(state) {
  const initial = createInitialState()
  let changed = false
  const setDefault = (key, value) => {
    if (state[key] !== undefined && state[key] !== null) return
    state[key] = value
    changed = true
  }
  setDefault('preferences', initial.preferences)
  ;['domains', 'actions', 'plans', 'wishes', 'footprints', 'reviews', 'conversations'].forEach((key) => setDefault(key, []))
  setDefault('declinedActions', state.declinedActionIds || [])
  setDefault('pendingFileDeletes', [])
  setDefault('syncQueue', [])
  setDefault('syncTombstones', {})
  setDefault('cloudEpoch', 0)
  setDefault('dataToken', uid('data'))
  setDefault('deletionPending', false)
  setDefault('lastSyncedAt', 0)
  state.preferences = { ...initial.preferences, ...state.preferences, lastContext: { ...initial.preferences.lastContext, ...state.preferences.lastContext } }

  const plansById = new Map((state.plans || []).map((plan) => [plan.id, plan]))
  state.plans.forEach((plan) => {
    const actionIds = [...new Set((plan.actionIds || []).filter(Boolean))]
    if (JSON.stringify(actionIds) !== JSON.stringify(plan.actionIds || [])) changed = true
    plan.actionIds = actionIds
  })
  state.actions.forEach((action) => {
    const legacyPlanIds = [...(Array.isArray(action.planIds) ? action.planIds : []), action.planId].filter(Boolean)
    legacyPlanIds.forEach((planId) => {
      const plan = plansById.get(planId)
      if (plan && !plan.actionIds.includes(action.id)) { plan.actionIds.push(action.id); plan.updatedAt = Date.now(); changed = true }
    })
    if (Object.prototype.hasOwnProperty.call(action, 'planId')) { delete action.planId; changed = true }
    if (Object.prototype.hasOwnProperty.call(action, 'planIds')) { delete action.planIds; changed = true }
  })
  if (Object.prototype.hasOwnProperty.call(state, 'declinedActionIds')) { delete state.declinedActionIds; changed = true }
  const declinedActions = (state.declinedActions || []).map((item) => typeof item === 'string' ? { actionId: item, declinedAt: 0, contextKey: '' } : item)
  if (JSON.stringify(declinedActions) !== JSON.stringify(state.declinedActions || [])) { state.declinedActions = declinedActions; changed = true }
  state.syncQueue = normalizeSyncQueue(state.syncQueue)
  state.syncTombstones = state.syncTombstones || {}
  if (state.version !== STATE_VERSION) { state.version = STATE_VERSION; changed = true }
  return changed
}

function ensureState() {
  let state = wx.getStorageSync(STORAGE_KEY)
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    state = createInitialState()
    wx.setStorageSync(STORAGE_KEY, state)
  } else if (normalizeState(state)) {
    queueCollections(state, ['actions', 'plans'])
    wx.setStorageSync(STORAGE_KEY, state)
  }
  state.syncQueue = normalizeSyncQueue(state.syncQueue)
  state.syncTombstones = state.syncTombstones || {}
  return state
}

function getState() { return ensureState() }
function saveState(state, options = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('INVALID_STATE')
  const collections = options.sync === false ? [] : (options.collections || Object.values(SYNC_COLLECTIONS))
  if (collections.length) queueCollections(state, collections)
  state.updatedAt = Date.now()
  wx.setStorageSync(STORAGE_KEY, state)
  try {
    const env = require('../config/env')
    if (options.sync !== false && env.CLOUD_ENV_ID && env.ENABLE_CLOUD_SYNC && wx.cloud) {
      if (collections.length) require('./sync').schedule(state, collections)
    }
  } catch (error) { console.warn('同步队列暂不可用', error) }
  return state
}
function update(mutator) {
  const state = getState()
  if (state.deletionPending) throw new Error('PERSONAL_DATA_DELETION_PENDING')
  const before = JSON.parse(JSON.stringify(state))
  // repository 的更新器只允许原地修改状态；忽略 push/unshift 等方法的数字返回值。
  mutator(state)
  const changedKeys = Object.keys(SYNC_COLLECTIONS).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(state[key]))
  recordDeletedItems(before, state, changedKeys)
  if (changedKeys.some((key) => ['preferences', 'domains', 'actions', 'plans', 'footprints'].includes(key))) state.recommendationCache = null
  return saveState(state, { collections: changedKeys.map((key) => SYNC_COLLECTIONS[key]) })
}
function completeOnboarding(interests, wish) {
  return update((state) => {
    state.preferences.onboardingComplete = true
    state.preferences.selectedInterests = interests
    state.preferences.updatedAt = Date.now()
    if (wish && wish.trim()) state.wishes.unshift({ id: uid('w'), text: wish.trim(), createdAt: Date.now() })
  })
}
function saveContext(context) {
  return update((state) => { state.preferences.lastContext = context; state.preferences.updatedAt = Date.now() })
}
function saveRecommendations(items, key, source, swaps = 0) {
  return update((state) => { state.recommendationCache = { key, items, source, createdAt: Date.now(), swaps } })
}
function clearRecommendationCache() { return update((state) => { state.recommendationCache = null }) }
function incrementRecommendationSwaps() {
  return update((state) => { if (state.recommendationCache) state.recommendationCache.swaps += 1 })
}
function declineAction(actionId, contextKey = '') {
  return update((state) => {
    state.declinedActions = (state.declinedActions || []).filter((item) => item.actionId !== actionId)
    state.declinedActions.push({ actionId, contextKey, declinedAt: Date.now() })
    state.declinedActions = state.declinedActions.slice(-30)
  })
}
function startSession(action, mode, options = {}) {
  const now = Date.now()
  return update((state) => {
    const existing = state.activeSession || state.pendingAction
    if (existing) {
      if (existing.actionId === action.id) return
      throw new Error('SESSION_ALREADY_ACTIVE')
    }
    if (mode === 'timer') {
      state.activeSession = { id: uid('s'), actionId: action.id, actionName: action.name, actionSnapshot: action, startedAt: now, expectedEndAt: now + action.minutes * 60000, status: 'running', reminder: Boolean(options.reminder), reminderPrompted: false }
      state.pendingAction = null
    } else {
      state.pendingAction = { id: uid('pending'), actionId: action.id, actionName: action.name, actionSnapshot: action, startedAt: now, promptAfterAt: now + 60000, backgroundedAt: 0, prompted: false }
    }
  })
}
function markPendingActionBackgrounded() {
  return update((state) => {
    if (state.pendingAction && !state.pendingAction.prompted) state.pendingAction.backgroundedAt = Date.now()
  })
}
function pauseSession() {
  return update((state) => {
    if (!state.activeSession || state.activeSession.status !== 'running') return
    state.activeSession.pausedAt = Date.now()
    state.activeSession.elapsedBeforePause = Math.max(0, Math.round((Date.now() - state.activeSession.startedAt) / 1000))
    state.activeSession.status = 'paused'
  })
}
function resumeSession() {
  return update((state) => {
    const session = state.activeSession
    if (!session || session.status !== 'paused') return
    session.expectedEndAt += Math.max(0, Date.now() - (session.pausedAt || Date.now()))
    session.startedAt = Date.now() - (session.elapsedBeforePause || 0) * 1000
    session.status = 'running'
    delete session.pausedAt
  })
}
function clearSession() { return update((state) => { state.activeSession = null }) }
function resolvePending() { return update((state) => { state.pendingAction = null }) }
function reconcileActiveSession() {
  const state = getState()
  if (!state.activeSession || state.activeSession.status !== 'running') return state
  return state
}
function addFootprint(payload) {
  return update((state) => {
    if (payload.id && state.footprints.some((item) => item.id === payload.id)) return
    state.footprints.unshift({ createdAt: Date.now(), updatedAt: Date.now(), ...payload, id: payload.id || uid('f') })
    if (payload.sessionId && state.activeSession && state.activeSession.id === payload.sessionId) state.activeSession = null
    if (payload.sessionId && state.pendingAction && state.pendingAction.id === payload.sessionId) state.pendingAction = null
    const plan = state.plans.find((item) => item.id === payload.planId)
    if (plan) plan.updatedAt = Date.now()
  })
}
function saveFootprint(payload) {
  return update((state) => {
    const index = state.footprints.findIndex((item) => item.id === payload.id)
    if (index >= 0) state.footprints[index] = { ...state.footprints[index], ...payload, updatedAt: Date.now() }
    else state.footprints.unshift({ createdAt: Date.now(), updatedAt: Date.now(), ...payload, id: payload.id || uid('f') })
  })
}
function deleteFootprint(id) {
  return update((state) => { state.footprints = state.footprints.filter((item) => item.id !== id) })
}
function queueFileDeletes(fileIds) {
  return update((state) => { state.pendingFileDeletes = [...new Set([...(state.pendingFileDeletes || []), ...(fileIds || [])])] })
}
function savePlan(plan) {
  return update((state) => {
    const index = state.plans.findIndex((item) => item.id === plan.id)
    const validActionIds = new Set(state.actions.filter((item) => !item.hidden && item.domainId === plan.domainId).map((item) => item.id))
    const value = { ...plan, actionIds: [...new Set((plan.actionIds || []).filter((id) => validActionIds.has(id)))], id: plan.id || uid('p'), updatedAt: Date.now(), createdAt: plan.createdAt || Date.now() }
    if (index >= 0) state.plans[index] = value
    else state.plans.unshift(value)
  })
}
function addWish(text) { return update((state) => { state.wishes.unshift({ id: uid('w'), text: text.trim(), createdAt: Date.now() }) }) }
function deleteWish(id) { return update((state) => { state.wishes = state.wishes.filter((item) => item.id !== id) }) }
function editWish(id, text) { return update((state) => { const wish = state.wishes.find((item) => item.id === id); if (wish) { wish.text = text.trim(); wish.updatedAt = Date.now() } }) }
function deletePlan(id) {
  return update((state) => {
    const plan = state.plans.find((item) => item.id === id)
    if (!plan) return
    state.footprints.forEach((item) => { if (item.planId === id && !item.planName) { item.planName = plan.name; item.updatedAt = Date.now() } })
    state.plans = state.plans.filter((item) => item.id !== id)
  })
}
function saveActionWithPlans(action, planIds = []) {
  const actionId = action.id || uid('a')
  return update((state) => {
    const index = state.actions.findIndex((item) => item.id === actionId)
    const value = { energy: ['low','medium','high'], environments: ['any'], preparation: '不需要额外准备', source: 'user', ...action, id: actionId, updatedAt: Date.now() }
    delete value.planId
    delete value.planIds
    if (index >= 0) state.actions[index] = value
    else state.actions.unshift(value)
    const selected = new Set((planIds || []).filter(Boolean))
    state.plans.forEach((plan) => {
      const actionIds = new Set(plan.actionIds || [])
      const before = [...actionIds]
      if (selected.has(plan.id) && plan.domainId === value.domainId && plan.status !== 'ended') actionIds.add(actionId)
      else actionIds.delete(actionId)
      plan.actionIds = [...actionIds]
      if (JSON.stringify(before) !== JSON.stringify(plan.actionIds)) plan.updatedAt = Date.now()
    })
  })
}
function saveAction(action) {
  const legacyPlanId = action.planId || ''
  const state = getState()
  const existingPlanIds = action.id ? state.plans.filter((plan) => (plan.actionIds || []).includes(action.id)).map((plan) => plan.id) : []
  return saveActionWithPlans(action, legacyPlanId ? [...new Set([...existingPlanIds, legacyPlanId])] : existingPlanIds)
}
function saveOrganizedDraft(draft) {
  if (!draft || !['action', 'plan'].includes(draft.type)) throw new TypeError('INVALID_ORGANIZED_DRAFT')
  if (draft.type === 'action') {
    const action = { ...draft, id: draft.id || uid('a'), source: 'ai' }
    delete action.type
    delete action.actions
    delete action.why
    saveAction(action)
    return { type: 'action', id: action.id }
  }
  const planId = draft.id || uid('p')
  const created = []
  update((state) => {
    ;(draft.actions || []).forEach((item) => {
      const normalizedName = String(item.name || '').trim().toLowerCase()
      if (!normalizedName) return
      let action = state.actions.find((value) => !value.hidden && value.domainId === draft.domainId && value.name.trim().toLowerCase() === normalizedName)
      if (!action) {
        action = { energy: ['low', 'medium', 'high'], environments: ['any'], preparation: '不需要额外准备', ...item, id: item.id || uid('a'), domainId: draft.domainId || '', source: 'ai', createdAt: Date.now(), updatedAt: Date.now() }
        state.actions.unshift(action)
      }
      created.push(action.id)
    })
    state.plans.unshift({ id: planId, name: String(draft.name || '').trim(), why: String(draft.why || '').trim(), domainId: draft.domainId || '', status: 'want', focused: false, importantDate: '', actionIds: created, source: 'ai', createdAt: Date.now(), updatedAt: Date.now() })
  })
  return { type: 'plan', id: planId }
}
function setPlanAction(planId, actionId, linked) {
  return update((state) => {
    const plan = state.plans.find((item) => item.id === planId)
    const action = state.actions.find((item) => item.id === actionId)
    if (!plan || !action) return
    const actionIds = new Set(plan.actionIds || [])
    if (linked && plan.status !== 'ended' && plan.domainId === action.domainId) actionIds.add(actionId)
    else actionIds.delete(actionId)
    plan.actionIds = [...actionIds]
    plan.updatedAt = Date.now()
  })
}
function hideAction(id) { return update((state) => { const action = state.actions.find((item) => item.id === id); if (action) { action.hidden = true; action.updatedAt = Date.now() } }) }
function deleteAction(id) {
  return update((state) => {
    state.actions = state.actions.filter((item) => item.id !== id)
    state.plans.forEach((plan) => {
      const actionIds = (plan.actionIds || []).filter((actionId) => actionId !== id)
      if (actionIds.length !== (plan.actionIds || []).length) plan.updatedAt = Date.now()
      plan.actionIds = actionIds
    })
  })
}
function saveReview(review) { return update((state) => { state.reviews.unshift({ id: uid('r'), createdAt: Date.now(), ...review }) }) }
function updateReview(id, content) {
  return update((state) => {
    const review = state.reviews.find((item) => item.id === id)
    if (review) { review.content = content; review.updatedAt = Date.now() }
  })
}
function deleteReview(id) { return update((state) => { state.reviews = state.reviews.filter((item) => item.id !== id) }) }
function saveConversation(conversation) {
  return update((state) => {
    const index = state.conversations.findIndex((item) => item.id === conversation.id)
    if (index >= 0) state.conversations[index] = conversation
    else state.conversations.unshift(conversation)
  })
}
function clearConversations() { return update((state) => { state.conversations = [] }) }
function deleteAllPersonalData(epoch = 0) {
  const previous = getState()
  if (wx.removeSavedFile) previous.footprints.forEach((item) => (item.localPhotoPaths || []).forEach((filePath) => wx.removeSavedFile({ filePath, fail: () => {} })))
  const sync = require('./sync')
  if (sync.reset) sync.reset()
  const clean = createInitialState()
  clean.cloudEpoch = epoch
  wx.setStorageSync(STORAGE_KEY, clean)
  return clean
}
function dataToken() { return getState().dataToken }
function canApply(token) { const state = getState(); return !state.deletionPending && state.dataToken === token }
function markDeletion(pending, requestId) {
  const state = getState()
  state.deletionPending = pending
  if (requestId) state.deleteRequestId = requestId
  return saveState(state, { sync: false })
}

module.exports = {
  ensureState, getState, saveState, update, completeOnboarding, saveContext,
  saveRecommendations, clearRecommendationCache, incrementRecommendationSwaps, declineAction, startSession, markPendingActionBackgrounded,
  pauseSession, resumeSession, clearSession, resolvePending, reconcileActiveSession,
  addFootprint, saveFootprint, deleteFootprint, queueFileDeletes, savePlan, addWish, deleteWish, saveReview,
  saveAction, saveActionWithPlans, saveOrganizedDraft, setPlanAction, hideAction, deleteAction, saveConversation, clearConversations, deleteAllPersonalData, updateReview, deleteReview,
  changedCollections, normalizeState, deletePlan, editWish, dataToken, canApply, markDeletion
}
