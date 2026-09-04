const repository = require('../../services/repository')
const format = require('../../services/format')

Page({
  data: { action: null, session: null, elapsed: '00:00', finished: false },
  onLoad(options) { this.actionId = options.id; this.timer = null },
  onShow() { this.load() },
  onHide() { this.clearTicker() },
  onUnload() { this.clearTicker() },
  load() {
    const state = repository.getState()
    const cached = state.recommendationCache && state.recommendationCache.items || []
    const raw = state.actions.find((item) => item.id === this.actionId) || cached.find((item) => item.id === this.actionId) || (state.activeSession && state.activeSession.actionId === this.actionId && state.activeSession.actionSnapshot) || (state.pendingAction && state.pendingAction.actionId === this.actionId && state.pendingAction.actionSnapshot)
    if (!raw) { wx.showToast({ title: '行动不存在', icon: 'none' }); setTimeout(() => wx.navigateBack(), 500); return }
    const domain = state.domains.find((item) => item.id === raw.domainId)
    const plan = state.plans.find((item) => item.id === raw.planId)
    const domainName = raw.domainName || (domain && domain.name) || '生活'
    const action = { ...raw, domainName, domainInitial: domainName.slice(0, 1), planName: raw.planName || (plan && plan.name) || '', duration: format.duration(raw.minutes) }
    const session = state.activeSession && state.activeSession.actionId === raw.id ? state.activeSession : null
    this.setData({ action, session })
    this.startTicker()
  },
  startTimer() {
    const state = repository.getState()
    if (state.activeSession && state.activeSession.actionId !== this.data.action.id) {
      wx.showModal({ title: '还有一件事正在计时', content: `先处理“${state.activeSession.actionName}”，再开始新的行动。`, confirmText: '去看看', success: (res) => { if (res.confirm) wx.redirectTo({ url: `/pages/action/index?id=${state.activeSession.actionId}` }) } })
      return
    }
    repository.startSession(this.data.action, 'timer')
    this.load()
  },
  startWithReminder() {
    const state = repository.getState()
    if (state.activeSession && state.activeSession.actionId !== this.data.action.id) { this.startTimer(); return }
    repository.startSession(this.data.action, 'timer', { reminder: true })
    wx.showToast({ title: '到预计时间会提醒一次', icon: 'none' })
    this.load()
  },
  direct() {
    repository.startSession(this.data.action, 'direct')
    wx.showToast({ title: '去吧，回来时再记一笔', icon: 'none' })
    setTimeout(() => wx.navigateBack(), 900)
  },
  pause() { repository.pauseSession(); this.load() },
  resume() { repository.resumeSession(); this.load() },
  finish() { wx.navigateTo({ url: `/pages/record/index?actionId=${this.data.action.id}&mode=timer` }) },
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
  clearTicker() { if (this.timer) clearInterval(this.timer); this.timer = null }
  ,promptReminder() {
    repository.update((state) => { if (state.activeSession) state.activeSession.reminderPrompted = true })
    wx.showActionSheet({ alertText: '预计时间到了，想怎么继续？', itemList: ['结束并记录', '继续 15 分钟', '不再提醒'], success: (res) => {
      if (res.tapIndex === 0) this.finish()
      if (res.tapIndex === 1) { repository.update((state) => { if (state.activeSession) { state.activeSession.expectedEndAt = Date.now() + 15 * 60000; state.activeSession.reminderPrompted = false } }); this.load() }
    } })
  }
})
