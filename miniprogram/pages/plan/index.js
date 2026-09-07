const repository = require('../../services/repository')
const format = require('../../services/format')
const recommender = require('../../services/recommender')
const themeService = require('../../services/theme')

const STATUSES = [{ value: 'want', label: '想做' }, { value: 'active', label: '进行中' }, { value: 'paused', label: '暂停' }, { value: 'ended', label: '已结束' }]

Page({
  data: { plan: { id: '', name: '', why: '', status: 'want', focused: false, importantDate: '', domainId: 'daily', actionIds: [] }, statuses: STATUSES, domains: [], domainIndex: 0, domainName: '', isNew: true, actions: [], footprints: [], stats: null, theme: 'now' },
  onLoad(options) {
    const theme = themeService.fromOptions(options)
    themeService.apply(theme)
    this.planId = options.id || ''
    this.wishId = options.wishId || ''
    const state = repository.getState()
    let plan = options.id ? state.plans.find((item) => item.id === options.id) : null
    let draft = null
    try { draft = options.draft ? JSON.parse(decodeURIComponent(options.draft)) : null } catch (error) { console.warn('计划草稿解析失败', error) }
    if (!plan) plan = { id: '', name: draft ? draft.name : (options.wish ? decodeURIComponent(options.wish) : ''), why: draft ? (draft.why || '') : '', status: 'want', focused: false, importantDate: '', domainId: draft ? (draft.domainId || 'daily') : 'daily', actionIds: [] }
    const domains = state.domains.filter((item) => !item.hidden)
    const domainIndex = Math.max(0, domains.findIndex((item) => item.id === plan.domainId))
    this.setData({ plan: { ...plan, actionIds: plan.actionIds || [] }, domains, domainIndex, domainName: (domains[domainIndex] || {}).name || '生活', isNew: !options.id, theme }, () => this.refreshRelated())
  },
  onShow() {
    if (!this.planId) return
    if (this.returningFromActionEditor) {
      const stored = repository.getState().plans.find((item) => item.id === this.planId)
      if (stored) this.setData({ 'plan.actionIds': stored.actionIds || [] })
      this.returningFromActionEditor = false
    }
    this.refreshRelated()
  },
  refreshRelated() {
    const planId = this.planId || this.data.plan.id
    if (!planId) return
    const state = repository.getState()
    const context = state.preferences.lastContext
    const linkedIds = new Set(this.data.plan.actionIds || [])
    const actions = state.actions.filter((item) => !item.hidden && item.domainId === this.data.plan.domainId)
      .map((item) => ({ ...item, linked: linkedIds.has(item.id), suitableNow: recommender.isEligible(item, state, context), domainName: (state.domains.find((domain) => domain.id === item.domainId) || {}).name || '生活' }))
      .sort((left, right) => Number(right.linked) - Number(left.linked) || Number(right.suitableNow) - Number(left.suitableNow))
    const footprints = state.footprints.filter((item) => item.planId === planId).slice(0, 5).map((item) => ({ ...item, dateLabel: format.dateLabel(item.createdAt), durationLabel: format.duration(item.minutes) }))
    const allFootprints = state.footprints.filter((item) => item.planId === planId)
    const minutes = allFootprints.reduce((sum, item) => sum + (item.minutes || 0), 0)
    const feelings = { love: 0, good: 0, okay: 0, poor: 0 }
    allFootprints.forEach((item) => { if (feelings[item.feeling] !== undefined) feelings[item.feeling] += 1 })
    this.setData({ actions, footprints, stats: { count: allFootprints.length, duration: format.duration(minutes), feelings } })
  },
  onName(event) { this.setData({ 'plan.name': event.detail.value }) },
  onWhy(event) { this.setData({ 'plan.why': event.detail.value }) },
  setStatus(event) {
    const status = event.currentTarget.dataset.value
    const changes = { 'plan.status': status }
    if (status === 'ended') { changes['plan.focused'] = false; changes['plan.focusedAt'] = 0 }
    this.setData(changes)
  },
  toggleFocus() {
    if (this.data.plan.focused) { this.setData({ 'plan.focused': false, 'plan.focusedAt': 0 }); return }
    if (this.data.plan.status === 'ended') { wx.showToast({ title: '已结束的计划不能加入关注', icon: 'none' }); return }
    const focusedCount = repository.getState().plans.filter((item) => item.id !== this.data.plan.id && item.focused && item.status !== 'ended').length
    if (focusedCount >= 3) { wx.showToast({ title: '最多关注三个计划', icon: 'none' }); return }
    this.setData({ 'plan.focused': true, 'plan.focusedAt': Date.now() })
  },
  onDate(event) { this.setData({ 'plan.importantDate': event.detail.value }) },
  onDomain(event) {
    const domainIndex = Number(event.detail.value)
    const domain = this.data.domains[domainIndex]
    const state = repository.getState()
    const compatibleIds = (this.data.plan.actionIds || []).filter((id) => {
      const action = state.actions.find((item) => item.id === id)
      return action && action.domainId === domain.id
    })
    const removed = compatibleIds.length !== (this.data.plan.actionIds || []).length
    this.setData({ domainIndex, domainName: domain.name, 'plan.domainId': domain.id, 'plan.actionIds': compatibleIds }, () => this.refreshRelated())
    if (removed) wx.showToast({ title: '已移除其他板块的行动关联', icon: 'none' })
  },
  save() {
    const plan = { ...this.data.plan, name: this.data.plan.name.trim(), why: this.data.plan.why.trim() }
    if (!plan.name) { wx.showToast({ title: '给计划起个名字吧', icon: 'none' }); return }
    if (plan.status === 'ended') { plan.focused = false; plan.focusedAt = 0 }
    repository.savePlan(plan)
    if (this.wishId) repository.deleteWish(this.wishId)
    wx.showToast({ title: '计划已保存', icon: 'success' })
    setTimeout(() => wx.navigateBack(), 500)
  },
  toggleActionLink(event) {
    const id = event.currentTarget.dataset.id
    const actionIds = new Set(this.data.plan.actionIds || [])
    if (actionIds.has(id)) actionIds.delete(id)
    else actionIds.add(id)
    this.setData({ 'plan.actionIds': [...actionIds] }, () => this.refreshRelated())
  },
  addAction() {
    const plan = { ...this.data.plan, name: this.data.plan.name.trim(), why: this.data.plan.why.trim() }
    if (!plan.name) { wx.showToast({ title: '先给计划起个名字吧', icon: 'none' }); return }
    repository.savePlan(plan)
    this.setData({ plan })
    this.returningFromActionEditor = true
    wx.navigateTo({ url: themeService.withTheme(`/pages/action-editor/index?planId=${plan.id}&domainId=${plan.domainId}`, this.data.theme) })
  },
  openAction(event) { wx.navigateTo({ url: themeService.withTheme(`/pages/action/index?id=${event.currentTarget.dataset.id}&planId=${this.data.plan.id}`, this.data.theme) }) },
  editAction(event) {
    const plan = { ...this.data.plan, name: this.data.plan.name.trim(), why: this.data.plan.why.trim() }
    repository.savePlan(plan)
    this.setData({ plan })
    this.returningFromActionEditor = true
    wx.navigateTo({ url: themeService.withTheme(`/pages/action-editor/index?id=${event.currentTarget.dataset.id}&planId=${plan.id}`, this.data.theme) })
  },
  askNext() {
    const plan = { ...this.data.plan, name: this.data.plan.name.trim(), why: this.data.plan.why.trim() }
    repository.savePlan(plan)
    this.setData({ plan })
    this.returningFromActionEditor = true
    wx.navigateTo({ url: themeService.withTheme(`/pages/chat/index?planId=${plan.id}&prompt=${encodeURIComponent(`为计划“${plan.name}”想一个现在可以开始的具体行动`)}`, this.data.theme) })
  },
  reflect() {
    wx.showModal({ title: '回头看看', editable: true, content: this.data.plan.reflection || '', placeholderText: '最近做这件事，感觉怎么样？', confirmText: '保存', success: (res) => {
      if (!res.confirm) return
      const plan = { ...this.data.plan, reflection: res.content.trim() }
      repository.savePlan(plan); this.setData({ plan }); wx.showToast({ title: '已经记下', icon: 'success' })
    } })
  }
})
