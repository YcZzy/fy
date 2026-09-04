const repository = require('../../services/repository')

const STATUSES = [{ value: 'want', label: '想做' }, { value: 'active', label: '进行中' }, { value: 'paused', label: '暂停' }, { value: 'ended', label: '已结束' }]

Page({
  data: { plan: { id: '', name: '', why: '', status: 'want', focused: false, importantDate: '', domainId: 'daily' }, statuses: STATUSES, domains: [], domainIndex: 0, isNew: true },
  onLoad(options) {
    this.wishId = options.wishId || ''
    const state = repository.getState()
    let plan = options.id ? state.plans.find((item) => item.id === options.id) : null
    let draft = null
    try { draft = options.draft ? JSON.parse(decodeURIComponent(options.draft)) : null } catch (error) { console.warn('计划草稿解析失败', error) }
    if (!plan) plan = { id: '', name: draft ? draft.name : (options.wish ? decodeURIComponent(options.wish) : ''), why: draft ? (draft.why || '') : '', status: 'want', focused: false, importantDate: '', domainId: draft ? (draft.domainId || 'daily') : 'daily' }
    const domains = state.domains.filter((item) => !item.hidden)
    this.setData({ plan: { ...plan }, domains, domainIndex: Math.max(0, domains.findIndex((item) => item.id === plan.domainId)), isNew: !options.id })
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
  }
})
