const repository = require('../../services/repository')
const recommender = require('../../services/recommender')
const ai = require('../../services/ai')
const format = require('../../services/format')
const cloud = require('../../services/cloud')
const sync = require('../../services/sync')
const themeService = require('../../services/theme')

const TIME_OPTIONS = [{ label: '10 分钟', value: 10 }, { label: '30 分钟', value: 30 }, { label: '1 小时', value: 60 }, { label: '2 小时', value: 120 }, { label: '半天', value: 240 }, { label: '自定义', value: -1 }]
const ENERGY_OPTIONS = [{ label: '很累', value: 'low' }, { label: '一般', value: 'medium' }, { label: '状态不错', value: 'high' }]
const ENV_OPTIONS = [{ label: '在家', value: 'home' }, { label: '户外', value: 'outdoor' }, { label: '通勤中', value: 'commute' }, { label: '不限', value: 'any' }, { label: '使用当前位置', value: 'location' }, { label: '手动地区', value: 'manual' }]

Page({
  data: {
    greeting: '', timeOptions: TIME_OPTIONS, energyOptions: ENERGY_OPTIONS, envOptions: ENV_OPTIONS,
    context: { minutes: 30, energy: 'medium', environment: 'any', note: '', locationSummary: '' },
    continueActions: [], recommendations: [], generating: false, recommendationSource: '', activeSession: null, activeElapsed: '',
    pendingAction: null
  },
  onLoad() { this.timer = null },
  onShow() {
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tabBar) tabBar.setData({ selected: 0 })
    const state = repository.getState()
    if (!state.preferences.onboardingComplete) { wx.redirectTo({ url: '/pages/onboarding/index' }); return }
    this.refresh(state)
    sync.bootstrap(['preferences', 'domains', 'actions', 'plans', 'footprints'])
      .then(() => this.refresh())
      .catch((error) => cloud.warn('此刻云端数据刷新失败，当前继续使用本地数据', error))
    if (this.shouldPromptPending(state.pendingAction)) { this.promptPending(state.pendingAction); return }
    if (this.shouldPromptReminder(state.activeSession)) { this.promptActiveReminder(); return }
    this.maybePromptWeeklyReview()
  },
  onHide() { this.clearTicker() },
  onUnload() { this.clearTicker() },
  refresh(state = repository.getState()) {
    const continueActions = this.buildContinueActions(state, state.preferences.lastContext)
    this.setData({
      greeting: format.greeting(), context: state.preferences.lastContext, continueActions,
      recommendations: state.recommendationCache && state.recommendationCache.key === recommender.contextKey(state.preferences.lastContext) ? state.recommendationCache.items : [],
      recommendationSource: state.recommendationCache && state.recommendationCache.key === recommender.contextKey(state.preferences.lastContext) ? state.recommendationCache.source : '',
      activeSession: state.activeSession, pendingAction: state.pendingAction
    })
    this.startTicker()
  },
  buildContinueActions(state, context) {
    const focusedPlans = state.plans
      .filter((item) => item.focused && item.status !== 'ended')
      .sort((left, right) => Number(right.focusedAt || right.updatedAt || right.createdAt || 0) - Number(left.focusedAt || left.updatedAt || left.createdAt || 0))
      .slice(0, 3)
    const seen = new Set()
    const continueActions = []
    focusedPlans.forEach((plan, planOrder) => {
      ;(plan.actionIds || []).forEach((actionId) => {
        if (seen.has(actionId)) return
        const action = state.actions.find((item) => item.id === actionId && !item.hidden && item.domainId === plan.domainId)
        if (!action) return
        seen.add(actionId)
        const domain = state.domains.find((item) => item.id === action.domainId)
        continueActions.push({ ...action, planId: plan.id, planName: plan.name, planOrder, suitableNow: recommender.isEligible(action, state, context), domainName: (domain && domain.name) || '生活', domainColor: (domain && domain.color) || '#A87562', duration: format.duration(action.minutes) })
      })
    })
    continueActions.sort((left, right) => Number(right.suitableNow) - Number(left.suitableNow) || left.planOrder - right.planOrder || Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
    return continueActions.slice(0, 3)
  },
  selectTime(event) {
    const value = Number(event.currentTarget.dataset.value)
    if (value !== -1) { this.updateContext('minutes', value); return }
    wx.showModal({ title: '这次有多少时间', editable: true, placeholderText: '填写分钟数', confirmText: '使用', success: (res) => {
      const minutes = Number(String(res.content || '').replace(/\D/g, ''))
      if (res.confirm && minutes > 0) this.updateContext('minutes', Math.min(720, minutes))
    } })
  },
  selectEnergy(event) { this.updateContext('energy', event.currentTarget.dataset.value) },
  selectEnvironment(event) {
    const value = event.currentTarget.dataset.value
    if (value === 'location') { this.requestFuzzyLocation(); return }
    if (value === 'manual') { this.enterManualRegion(); return }
    this.updateContext('environment', value)
  },
  onNoteInput(event) { this.updateContext('note', event.detail.value, false) },
  updateContext(key, value, persist = true) {
    const context = { ...this.data.context, [key]: value }
    this.setData({ context, continueActions: this.buildContinueActions(repository.getState(), context), recommendations: [], recommendationSource: '' })
    if (persist) repository.saveContext(context)
  },
  requestFuzzyLocation() {
    wx.showModal({
      title: '使用当前位置',
      content: '请在地图中主动确认所在城市或区域。推荐时只使用地点名称摘要，不保存也不发送精确经纬度。',
      confirmText: '继续',
      success: (modal) => {
        if (!modal.confirm) return
        wx.chooseLocation({
          success: (value) => {
            const summary = String(value.address || value.name || '已确认所在地区').slice(0, 30)
            const context = { ...this.data.context, environment: 'location', locationSummary: summary }
            this.setData({ context, continueActions: this.buildContinueActions(repository.getState(), context), recommendations: [], recommendationSource: '' })
            repository.saveContext(context)
          },
          fail: () => this.enterManualRegion('位置没有授权，可以手动写城市或区域')
        })
      }
    })
  },
  enterManualRegion(title = '手动填写城市或区域') {
    wx.showModal({ title, editable: true, placeholderText: '例如：北京朝阳', confirmText: '使用', success: (res) => {
      if (!res.confirm || !res.content.trim()) { this.updateContext('environment', 'any'); return }
      const context = { ...this.data.context, environment: 'manual', locationSummary: res.content.trim().slice(0, 30) }
      this.setData({ context, continueActions: this.buildContinueActions(repository.getState(), context), recommendations: [], recommendationSource: '' }); repository.saveContext(context)
    } })
  },
  similarAction(event) {
    const id = event.currentTarget.dataset.id
    const current = this.data.recommendations.find((item) => item.id === id)
    if (!current) return
    const state = repository.getState()
    const replacement = state.actions.find((item) => item.id !== id && item.domainId === current.domainId && recommender.isEligible(item, state, this.data.context) && !this.data.recommendations.some((shown) => shown.id === item.id))
    if (!replacement) { wx.showToast({ title: '暂时没有更相近的选择', icon: 'none' }); return }
    const domain = state.domains.find((item) => item.id === replacement.domainId)
    const plan = state.plans.find((value) => value.focused && value.status !== 'ended' && (value.actionIds || []).includes(replacement.id)) || state.plans.find((value) => (value.actionIds || []).includes(replacement.id))
    const item = { ...replacement, planId: plan ? plan.id : '', domainName: domain.name, domainColor: domain.color, reason: '换一种相近的方式，也许更合此刻的心意。', planName: plan ? plan.name : '', locationNote: replacement.environments.includes('location') ? '仅提供活动类别，请自行确认具体地点与营业信息。' : '' }
    const recommendations = this.data.recommendations.map((shown) => shown.id === id ? item : shown)
    const swaps = state.recommendationCache ? state.recommendationCache.swaps : 0
    repository.saveRecommendations(recommendations, recommender.contextKey(this.data.context), 'rule', swaps)
    this.setData({ recommendations, recommendationSource: 'rule' })
  },
  async generate() {
    if (this.data.generating) return
    const context = { ...this.data.context, note: this.data.context.note.trim() }
    repository.saveContext(context)
    const state = repository.getState()
    const key = recommender.contextKey(context)
    this.setData({ generating: true })
    try {
      const result = await ai.recommend(state, context)
      repository.saveRecommendations(result.items, key, 'ai')
      this.setData({ recommendations: result.items, recommendationSource: 'ai' })
    } catch (error) {
      console.warn('AI 推荐不可用，使用基础推荐', error)
      const items = recommender.recommend(state, context)
      repository.saveRecommendations(items, key, 'rule')
      this.setData({ recommendations: items, recommendationSource: 'rule' })
      wx.showToast({ title: '风暂时没有回音，先看看这些', icon: 'none', duration: 2600 })
    } finally { this.setData({ generating: false }) }
  },
  swapGroup() {
    const state = repository.incrementRecommendationSwaps()
    const swaps = state.recommendationCache ? state.recommendationCache.swaps : 1
    const items = recommender.recommend(state, this.data.context)
    repository.saveRecommendations(items, recommender.contextKey(this.data.context), 'rule', swaps)
    this.setData({ recommendations: items, recommendationSource: 'rule' })
    if (swaps >= 3) wx.showModal({ title: '还没有遇到合适的？', content: '也可以告诉风月，你现在最不想做什么。', confirmText: '问风月', success: (res) => { if (res.confirm) this.openChat() } })
  },
  chooseAction(event) {
    const id = event.currentTarget.dataset.id
    const item = this.data.recommendations.find((value) => value.id === id)
    if (item && item.source === 'ai' && !repository.getState().actions.some((value) => value.id === id)) {
      repository.saveAction({ id: item.id, name: item.name, domainId: item.domainId, minutes: item.minutes, energy: item.energy, environments: item.environments, preparation: item.preparation, planId: item.planId || '', source: 'ai' })
    }
    const planId = (item && item.planId) || ''
    wx.navigateTo({ url: themeService.withTheme(`/pages/action/index?id=${id}${planId ? `&planId=${planId}` : ''}`, 'now') })
  },
  declineAction(event) {
    repository.declineAction(event.currentTarget.dataset.id, recommender.contextKey(this.data.context))
    this.swapGroup()
  },
  continueAction(event) {
    const { id, planId } = event.currentTarget.dataset
    wx.navigateTo({ url: themeService.withTheme(`/pages/action/index?id=${id}&planId=${planId}`, 'now') })
  },
  openChat() { wx.navigateTo({ url: themeService.withTheme('/pages/chat/index', 'now') }) },
  openSettings() { wx.navigateTo({ url: themeService.withTheme('/pages/settings/index', 'now') }) },
  openActive() {
    const planId = (this.data.activeSession.actionSnapshot && this.data.activeSession.actionSnapshot.planId) || ''
    wx.navigateTo({ url: themeService.withTheme(`/pages/action/index?id=${this.data.activeSession.actionId}${planId ? `&planId=${planId}` : ''}`, 'now') })
  },
  shouldPromptPending(pending) { return Boolean(pending && !pending.prompted && pending.backgroundedAt && Date.now() >= (pending.promptAfterAt || pending.startedAt + 60000)) },
  promptPending(pending) {
    repository.update((state) => { if (state.pendingAction) state.pendingAction.prompted = true })
    wx.showActionSheet({
      alertText: `刚才“${pending.actionName}”，后来去做了吗？`,
      itemList: ['做了，留个足迹', '没有', '暂时不记录'],
      success: (res) => {
        const planId = (pending.actionSnapshot && pending.actionSnapshot.planId) || ''
        if (res.tapIndex === 0) wx.navigateTo({ url: themeService.withTheme(`/pages/record/index?actionId=${pending.actionId}&mode=direct${planId ? `&planId=${planId}` : ''}`, 'now') })
        else repository.resolvePending()
      }
    })
  },
  shouldPromptReminder(session) { return Boolean(session && session.reminder && !session.reminderPrompted && session.status === 'running' && Date.now() >= session.expectedEndAt) },
  promptActiveReminder() {
    repository.update((state) => { if (state.activeSession) state.activeSession.reminderPrompted = true })
    wx.showActionSheet({ alertText: '预计时间到了，想怎么继续？', itemList: ['结束并记录', '继续 15 分钟', '不再提醒'], success: (res) => {
      const session = repository.getState().activeSession
      if (!session) return
      if (res.tapIndex === 0) {
        const planId = (session.actionSnapshot && session.actionSnapshot.planId) || ''
        wx.navigateTo({ url: themeService.withTheme(`/pages/record/index?actionId=${session.actionId}&mode=timer${planId ? `&planId=${planId}` : ''}`, 'now') })
      }
      if (res.tapIndex === 1) repository.update((state) => { if (state.activeSession) { state.activeSession.expectedEndAt = Date.now() + 15 * 60000; state.activeSession.reminderPrompted = false } })
    } })
  },
  maybePromptWeeklyReview() {
    const now = new Date()
    if (now.getDay() !== 0 || now.getHours() < 18) return
    const key = format.dateKey(now.getTime())
    const state = repository.getState()
    if (state.preferences.weeklyPromptKey === key) return
    repository.update((value) => { value.preferences.weeklyPromptKey = key })
    wx.showModal({ title: '这一周，要不要回头看看？', content: '也可以之后从“足迹—回望”主动查看。', confirmText: '去回望', cancelText: '本周不提醒', success: (res) => {
      if (!res.confirm) return
      repository.update((value) => { value.preferences.openReviewOnNextShow = true })
      wx.switchTab({ url: '/pages/footprints/index' })
    } })
  },
  startTicker() {
    this.clearTicker()
    if (!this.data.activeSession) return
    const tick = () => {
      const session = repository.getState().activeSession
      if (!session) { this.setData({ activeSession: null }); this.clearTicker(); return }
      const seconds = session.status === 'paused' ? (session.elapsedBeforePause || 0) : Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000))
      const h = Math.floor(seconds / 3600)
      const m = Math.floor((seconds % 3600) / 60)
      const s = seconds % 60
      this.setData({ activeElapsed: `${h ? `${String(h).padStart(2,'0')}:` : ''}${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`, activeSession: session })
    }
    tick(); this.timer = setInterval(tick, 1000)
  },
  clearTicker() { if (this.timer) clearInterval(this.timer); this.timer = null }
})
