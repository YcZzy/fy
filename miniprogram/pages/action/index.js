const repository = require('../../services/repository')
const format = require('../../services/format')
const themeService = require('../../services/theme')

Page({
  data: { action: null, session: null, elapsed: '00:00', finished: false, theme: 'now', plans: [], planIndex: 0 },
  onLoad(options) {
    this.token = repository.dataToken()
    this.actionId = options.id
    this.planId = options.planId || ''; this.planSelected = Object.prototype.hasOwnProperty.call(options, 'planId')
    this.timer = null
    const theme = themeService.fromOptions(options)
    this.setData({ theme })
    themeService.apply(theme)
  },
  onShow() { this.load() },
  onHide() { this.clearTicker() },
  onUnload() { this.clearTicker() },
  load() {
    const state = repository.getState()
    const cached = state.recommendationCache && state.recommendationCache.items || []
    const entity = state.actions.find((item) => item.id === this.actionId)
    const suggestion = cached.find((item) => item.id === this.actionId)
    const snapshot = (state.activeSession && state.activeSession.actionId === this.actionId && state.activeSession.actionSnapshot) || (state.pendingAction && state.pendingAction.actionId === this.actionId && state.pendingAction.actionSnapshot)
    const raw = snapshot || (entity ? { ...entity, ...(suggestion ? { reason: suggestion.reason, locationNote: suggestion.locationNote, planId: suggestion.planId } : {}) } : suggestion)
    if (!raw) { wx.showToast({ title: '行动不存在', icon: 'none' }); setTimeout(() => wx.navigateBack(), 500); return }
    const domain = state.domains.find((item) => item.id === raw.domainId)
    const sessionSnapshot = state.activeSession && state.activeSession.actionId === raw.id && state.activeSession.actionSnapshot
    const pendingSnapshot = state.pendingAction && state.pendingAction.actionId === raw.id && state.pendingAction.actionSnapshot
    const planId = (sessionSnapshot && sessionSnapshot.planId) || (pendingSnapshot && pendingSnapshot.planId) || (this.planSelected ? this.planId : raw.planId || '')
    const plan = state.plans.find((item) => item.id === planId)
    const domainName = raw.domainName || (domain && domain.name) || '生活'
    const action = { ...raw, planId, domainName, domainInitial: domainName.slice(0, 1), planName: raw.planName || (plan && plan.name) || '', duration: format.duration(raw.minutes) }
    const session = state.activeSession && state.activeSession.actionId === raw.id ? state.activeSession : null
    const plans = [{ id: '', name: '不关联计划' }, ...state.plans.filter((item) => item.status !== 'ended' && (item.actionIds || []).includes(raw.id))]
    this.setData({ action, session, plans, planIndex: Math.max(0, plans.findIndex((item) => item.id === planId)) })
    this.startTicker()
  },
  onPlan(event) {
    if (this.data.session) return
    const planIndex = Number(event.detail.value); const plan = this.data.plans[planIndex]
    this.planId = plan.id; this.planSelected = true; this.setData({ planIndex, 'action.planId': plan.id, 'action.planName': plan.id ? plan.name : '' })
  },
  canStart() {
    if (!repository.canApply(this.token)) { wx.switchTab({ url: '/pages/now/index' }); return false }
    const state = repository.getState(); const existing = state.activeSession || state.pendingAction
    if (!existing) return true
    const url = state.activeSession ? this.sessionUrl(existing) : themeService.withTheme('/pages/record/index?actionId=' + existing.actionId + '&mode=direct', this.data.theme)
    wx.showModal({ title: state.activeSession ? '还有一件事正在计时' : '还有一件事等待记录', content: '先处理“' + existing.actionName + '”，再开始新的行动。', confirmText: '去看看', success: (res) => { if (res.confirm) wx.navigateTo({ url }) } })
    return false
  },
  startTimer() {
    if (!this.canStart()) return
    repository.startSession(this.data.action, 'timer'); this.load()
  },
  startWithReminder() {
    if (!this.canStart()) return
    repository.startSession(this.data.action, 'timer', { reminder: true }); this.load()
  },
  direct() {
    if (!this.canStart()) return
    repository.startSession(this.data.action, 'direct')
    wx.showToast({ title: '回来后可在“此刻”记录', icon: 'none' })
    setTimeout(() => wx.switchTab({ url: '/pages/now/index' }), 600)
  },
  pause() { repository.pauseSession(); this.load() },
  resume() { repository.resumeSession(); this.load() },
  finish() { wx.navigateTo({ url: themeService.withTheme(`/pages/record/index?actionId=${this.data.action.id}&mode=timer${this.data.action.planId ? `&planId=${this.data.action.planId}` : ''}`, this.data.theme) }) },
  cancel() {
    wx.showModal({ title: '结束这次计时？', content: '可以直接结束，不会留下失败记录。', confirmText: '结束', confirmColor: '#A85F50', success: (res) => { if (res.confirm) { repository.clearSession(); this.load() } } })
  },
  later() { wx.navigateBack() },
  startTicker() {
    this.clearTicker()
    if (!this.data.session) return
    const tick = () => {
      const session = repository.getState().activeSession
      if (!session || session.actionId !== this.actionId) { this.setData({ session: null }); this.clearTicker(); return }
      const seconds = session.status === 'paused' ? (session.elapsedBeforePause || 0) : Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000))
      const hours = Math.floor(seconds / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      const rest = seconds % 60
      this.setData({ session, elapsed: `${hours ? `${String(hours).padStart(2,'0')}:` : ''}${String(minutes).padStart(2,'0')}:${String(rest).padStart(2,'0')}` })
      if (session.reminder && !session.reminderPrompted && session.status === 'running' && Date.now() >= session.expectedEndAt) this.promptReminder()
    }
    tick(); this.timer = setInterval(tick, 1000)
  },
  clearTicker() { if (this.timer) clearInterval(this.timer); this.timer = null },
  sessionUrl(session) {
    const planId = (session.actionSnapshot && session.actionSnapshot.planId) || ''
    return themeService.withTheme(`/pages/action/index?id=${session.actionId}${planId ? `&planId=${planId}` : ''}`, this.data.theme)
  },
  promptReminder() {
    repository.update((state) => { if (state.activeSession) state.activeSession.reminderPrompted = true })
    wx.showActionSheet({ alertText: '预计时间到了，想怎么继续？', itemList: ['结束并记录', '继续 15 分钟', '不再提醒'], success: (res) => {
      if (res.tapIndex === 0) this.finish()
      if (res.tapIndex === 1) { repository.update((state) => { if (state.activeSession) { state.activeSession.expectedEndAt = Date.now() + 15 * 60000; state.activeSession.reminderPrompted = false } }); this.load() }
    } })
  }
})
