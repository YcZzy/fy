const { createInitialState, DOMAINS, ACTIONS } = require('../data/defaults')
const { uid } = require('./format')

const STORAGE_KEY = 'feng_yue_state_v1'
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

function changedCollections(before, after) {
  return Object.keys(SYNC_COLLECTIONS)
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map((key) => SYNC_COLLECTIONS[key])
}

function ensureState() {
  let state = wx.getStorageSync(STORAGE_KEY)
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    state = createInitialState()
    wx.setStorageSync(STORAGE_KEY, state)
  } else if (state.version !== 2) {
    state.domains = [...(state.domains || []), ...DOMAINS.filter((item) => !(state.domains || []).some((existing) => existing.id === item.id))]
    state.actions = [...(state.actions || []), ...ACTIONS.filter((item) => !(state.actions || []).some((existing) => existing.id === item.id))]
    state.pendingFileDeletes = state.pendingFileDeletes || []
    state.syncQueue = state.syncQueue || []
    state.version = 2
    wx.setStorageSync(STORAGE_KEY, state)
  }
  return state
}

function getState() { return ensureState() }
function saveState(state, options = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('INVALID_STATE')
  state.updatedAt = Date.now()
  wx.setStorageSync(STORAGE_KEY, state)
  try {
    const env = require('../config/env')
    if (options.sync !== false && env.CLOUD_ENV_ID && env.ENABLE_CLOUD_SYNC && wx.cloud) {
      const collections = options.collections || Object.values(SYNC_COLLECTIONS)
      if (collections.length) require('./sync').schedule(state, collections)
    }
  } catch (error) { console.warn('同步队列暂不可用', error) }
  return state
}
function update(mutator) {
  const state = getState()
  const before = JSON.parse(JSON.stringify(state))
  // repository 的更新器只允许原地修改状态；忽略 push/unshift 等方法的数字返回值。
  mutator(state)
  return saveState(state, { collections: changedCollections(before, state) })
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
function saveRecommendations(items, key, source) {
  return update((state) => { state.recommendationCache = { key, items, source, createdAt: Date.now(), swaps: 0 } })
}
function incrementRecommendationSwaps() {
  return update((state) => { if (state.recommendationCache) state.recommendationCache.swaps += 1 })
}
function declineAction(actionId) {
  return update((state) => { if (!state.declinedActionIds.includes(actionId)) state.declinedActionIds.push(actionId) })
}
function startSession(action, mode, options = {}) {
  const now = Date.now()
  return update((state) => {
    if (mode === 'timer') {
      state.activeSession = { id: uid('s'), actionId: action.id, actionName: action.name, actionSnapshot: action, startedAt: now, expectedEndAt: now + action.minutes * 60000, status: 'running', reminder: Boolean(options.reminder), reminderPrompted: false }
      state.pendingAction = null
    } else {
      state.pendingAction = { id: uid('pending'), actionId: action.id, actionName: action.name, actionSnapshot: action, startedAt: now, prompted: false }
    }
  })
}
function pauseSession() {
  return update((state) => {
    if (!state.activeSession) return
    state.activeSession.pausedAt = Date.now()
    state.activeSession.elapsedBeforePause = Math.max(0, Math.round((Date.now() - state.activeSession.startedAt) / 1000))
    state.activeSession.status = 'paused'
  })
}
function resumeSession() {
  return update((state) => {
    const session = state.activeSession
    if (!session || session.status !== 'paused') return
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
    state.footprints.unshift({ createdAt: Date.now(), updatedAt: Date.now(), ...payload, id: payload.id || uid('f') })
    state.activeSession = null
    state.pendingAction = null
    const plan = state.plans.find((item) => item.id === payload.planId)
    if (plan) plan.updatedAt = Date.now()
  })
}
function saveFootprint(payload) {
  return update((state) => {
    const index = state.footprints.findIndex((item) => item.id === payload.id)
    if (index >= 0) state.footprints[index] = { ...state.footprints[index], ...payload, updatedAt: Date.now() }
    else state.footprints.unshift({ createdAt: Date.now(), updatedAt: Date.now(), ...payload, id: payload.id || uid('f') })
    state.activeSession = null
    state.pendingAction = null
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
    const value = { ...plan, id: plan.id || uid('p'), updatedAt: Date.now(), createdAt: plan.createdAt || Date.now() }
    if (index >= 0) state.plans[index] = value
    else state.plans.unshift(value)
  })
}
function addWish(text) { return update((state) => { state.wishes.unshift({ id: uid('w'), text: text.trim(), createdAt: Date.now() }) }) }
function deleteWish(id) { return update((state) => { state.wishes = state.wishes.filter((item) => item.id !== id) }) }
function saveAction(action) {
  return update((state) => {
    const index = state.actions.findIndex((item) => item.id === action.id)
    const value = { energy: ['low','medium','high'], environments: ['any'], preparation: '不需要额外准备', source: 'user', ...action, id: action.id || uid('a'), updatedAt: Date.now() }
    if (index >= 0) state.actions[index] = value
    else state.actions.unshift(value)
  })
}
function hideAction(id) { return update((state) => { const action = state.actions.find((item) => item.id === id); if (action) action.hidden = true }) }
function saveReview(review) { return update((state) => { state.reviews.unshift({ id: uid('r'), createdAt: Date.now(), ...review }) }) }
function saveConversation(conversation) {
  return update((state) => {
    const index = state.conversations.findIndex((item) => item.id === conversation.id)
    if (index >= 0) state.conversations[index] = conversation
    else state.conversations.unshift(conversation)
  })
}
function clearConversations() { return update((state) => { state.conversations = [] }) }
function deleteAllPersonalData() {
  const clean = createInitialState()
  clean.preferences.onboardingComplete = false
  wx.setStorageSync(STORAGE_KEY, clean)
  return clean
}

module.exports = {
  ensureState, getState, saveState, update, completeOnboarding, saveContext,
  saveRecommendations, incrementRecommendationSwaps, declineAction, startSession,
  pauseSession, resumeSession, clearSession, resolvePending, reconcileActiveSession,
  addFootprint, saveFootprint, deleteFootprint, queueFileDeletes, savePlan, addWish, deleteWish, saveReview,
  saveAction, hideAction, saveConversation, clearConversations, deleteAllPersonalData,
  changedCollections
}
