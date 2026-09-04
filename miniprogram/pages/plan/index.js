const repository = require('../../services/repository')
const format = require('../../services/format')
const recommender = require('../../services/recommender')

const STATUSES = [{ value: 'want', label: '想做' }, { value: 'active', label: '进行中' }, { value: 'paused', label: '暂停' }, { value: 'ended', label: '已结束' }]

Page({
  data: { plan: { id: '', name: '', why: '', status: 'want', focused: false, importantDate: '', domainId: 'daily' }, statuses: STATUSES, domains: [], domainIndex: 0, isNew: true, actions: [], footprints: [], stats: null },
  onLoad(options) {
    this.planId = options.id || ''
    this.wishId = options.wishId || ''
    const state = repository.getState()
    let plan = options.id ? state.plans.find((item) => item.id === options.id) : null
    let draft = null
    try { draft = options.draft ? JSON.parse(decodeURIComponent(options.draft)) : null } catch (error) { console.warn('计划草稿解析失败', error) }
    if (!plan) plan = { id: '', name: draft ? draft.name : (options.wish ? decodeURIComponent(options.wish) : ''), why: draft ? (draft.why || '') : '', status: 'want', focused: false, importantDate: '', domainId: draft ? (draft.domainId || 'daily') : 'daily' }
    const domains = state.domains.filter((item) => !item.hidden)
    this.setData({ plan: { ...plan }, domains, domainIndex: Math.max(0, domains.findIndex((item) => item.id === plan.domainId)), isNew: !options.id }, () => this.refreshRelated())
  },
  onShow() { if (this.planId) this.refreshRelated() },
  refreshRelated() {
    const planId = this.planId || this.data.plan.id
    if (!planId) return
    const state = repository.getState()
    const context = state.preferences.lastContext
    const actions = state.actions.filter((item) => !item.hidden && item.planId === planId)
      .map((item) => ({ ...item, suitableNow: recommender.isEligible(item, state, context), domainName: (state.domains.find((domain) => domain.id === item.domainId) || {}).name || '生活' }))
      .sort((left, right) => Number(right.suitableNow) - Number(left.suitableNow))
    const footprints = state.footprints.filter((item) => item.planId === planId).slice(0, 5).map((item) => ({ ...item, dateLabel: format.dateLabel(item.createdAt), durationLabel: format.duration(item.minutes) }))
    const allFootprints = state.footprints.filter((item) => item.planId === planId)
    const minutes = allFootprints.reduce((sum, item) => sum + (item.minutes || 0), 0)
    const feelings = { love: 0, good: 0, okay: 0, poor: 0 }
    allFootprints.forEach((item) => { if (feelings[item.feeling] !== undefined) feelings[item.feeling] += 1 })
    this.setData({ actions, footprints, stats: { count: allFootprints.length, duration: format.duration(minutes), feelings } })
  },
  onName(event) { this.setData({ 'plan.name': event.detail.value }) },
  onWhy(event) { this.setData({ 'plan.why': event.detail.value }) },
  setStatus(event) { this.setData({ 'plan.status': event.currentTarget.dataset.value }) },
  toggleFocus() { this.setData({ 'plan.focused': !this.data.plan.focused }) },
  onDate(event) { this.setData({ 'plan.importantDate': event.detail.value }) },
  onDomain(event) {
    const domainIndex = Number(event.detail.value)
    this.setData({ domainIndex, 'plan.domainId': this.data.domains[domainIndex].id })
  },
  save() {
    const plan = { ...this.data.plan, name: this.data.plan.name.trim(), why: this.data.plan.why.trim() }
    if (!plan.name) { wx.showToast({ title: '给计划起个名字吧', icon: 'none' }); return }
    repository.savePlan(plan)
    if (this.wishId) repository.deleteWish(this.wishId)
    wx.showToast({ title: '计划已保存', icon: 'success' })
    setTimeout(() => wx.navigateBack(), 500)
  },
  addAction() { wx.navigateTo({ url: `/pages/action-editor/index?planId=${this.data.plan.id}` }) },
  openAction(event) { wx.navigateTo({ url: `/pages/action/index?id=${event.currentTarget.dataset.id}` }) },
  editAction(event) { wx.navigateTo({ url: `/pages/action-editor/index?id=${event.currentTarget.dataset.id}` }) },
  askNext() { wx.navigateTo({ url: `/pages/chat/index?planId=${this.data.plan.id}&prompt=${encodeURIComponent(`为计划“${this.data.plan.name}”想一个现在可以开始的具体行动`)}` }) },
  reflect() {
    wx.showModal({ title: '回头看看', editable: true, content: this.data.plan.reflection || '', placeholderText: '最近做这件事，感觉怎么样？', confirmText: '保存', success: (res) => {
      if (!res.confirm) return
      const plan = { ...this.data.plan, reflection: res.content.trim() }
      repository.savePlan(plan); this.setData({ plan }); wx.showToast({ title: '已经记下', icon: 'success' })
    } })
  }
})
