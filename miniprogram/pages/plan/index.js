const repository = require('../../services/repository')
const format = require('../../services/format')
const recommender = require('../../services/recommender')
const themeService = require('../../services/theme')
const form = require('../../services/form')
const statistics = require('../../services/statistics')

const STATUSES = [{ value: 'want', label: '想做' }, { value: 'active', label: '进行中' }, { value: 'paused', label: '暂停' }, { value: 'ended', label: '已结束' }]

Page({
  data: { plan: { id: '', name: '', why: '', status: 'want', focused: false, importantDate: '', domainId: 'daily', actionIds: [] }, statuses: STATUSES, domains: [], domainIndex: 0, domainName: '', isNew: true, actions: [], footprints: [], stats: null, theme: 'now', dirty: false },
  onLoad(options) {
    this.token = repository.dataToken()
    const theme = themeService.fromOptions(options)
    themeService.apply(theme)
    this.planId = options.id || ''
    this.wishId = options.wishId || ''
    const state = repository.getState()
    let plan = options.id ? state.plans.find((item) => item.id === options.id) : null
    let draft = null
    try { draft = options.draft ? JSON.parse(decodeURIComponent(options.draft)) : null } catch (error) { console.warn('计划草稿解析失败', error) }
    if (options.id && !plan) { wx.showToast({ title: '这个计划已不存在', icon: 'none' }); wx.navigateBack(); return }
    this.draftConversationId = draft && draft.conversationId
    if (!plan) plan = { id: draft && draft.id || format.uid('p'), name: draft ? draft.name : (options.wish ? decodeURIComponent(options.wish) : ''), why: draft ? (draft.why || '') : '', status: 'want', focused: false, importantDate: '', domainId: draft ? (draft.domainId || 'daily') : 'daily', actionIds: [] }
    const domains = state.domains.filter((item) => !item.hidden)
    const domainIndex = Math.max(0, domains.findIndex((item) => item.id === plan.domainId))
    this.setData({ plan: { ...plan, actionIds: plan.actionIds || [] }, domains, domainIndex, domainName: (domains[domainIndex] || {}).name || '生活', isNew: !options.id, theme }, () => this.refreshRelated())
  },
  onShow() {
    if (!form.guard(this)) return
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
    const footprints = state.footprints.filter((item) => item.planId === planId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5).map((item) => ({ ...item, dateLabel: format.dateLabel(item.createdAt), durationLabel: format.duration(item.minutes) }))
    const allFootprints = state.footprints.filter((item) => item.planId === planId)
    const stats = statistics.summarize(allFootprints)
    this.setData({ actions, footprints, stats: { ...stats, duration: stats.totalDuration } })
  },
  onName(event) { this.change({ 'plan.name': event.detail.value }) },
  onWhy(event) { this.change({ 'plan.why': event.detail.value }) },
  setStatus(event) {
    const status = event.currentTarget.dataset.value
    const changes = { 'plan.status': status }
    if (status === 'ended') { changes['plan.focused'] = false; changes['plan.focusedAt'] = 0 }
    this.change(changes)
  },
  toggleFocus() {
    if (this.data.plan.focused) { this.change({ 'plan.focused': false, 'plan.focusedAt': 0 }); return }
    if (this.data.plan.status === 'ended') { wx.showToast({ title: '已结束的计划不能加入关注', icon: 'none' }); return }
    const focusedCount = repository.getState().plans.filter((item) => item.id !== this.data.plan.id && item.focused && item.status !== 'ended').length
    if (focusedCount >= 3) { wx.showToast({ title: '最多关注三个计划', icon: 'none' }); return }
    this.change({ 'plan.focused': true, 'plan.focusedAt': Date.now() })
  },
  onDate(event) { this.change({ 'plan.importantDate': event.detail.value }) },
  clearDate() { this.change({ 'plan.importantDate': '' }) },
  change(values, callback) { this.setData({ ...values, dirty: true }, callback); form.changed(this) },
  onUnload() { form.saved(this) },
  onDomain(event) {
    const domainIndex = Number(event.detail.value)
    const domain = this.data.domains[domainIndex]
    const state = repository.getState()
    const compatibleIds = (this.data.plan.actionIds || []).filter((id) => {
      const action = state.actions.find((item) => item.id === id)
      return action && action.domainId === domain.id
    })
    const removed = compatibleIds.length !== (this.data.plan.actionIds || []).length
    this.change({ domainIndex, domainName: domain.name, 'plan.domainId': domain.id, 'plan.actionIds': compatibleIds }, () => this.refreshRelated())
    if (removed) wx.showToast({ title: '已移除其他板块的行动关联', icon: 'none' })
  },
  persist() {
    if (!form.guard(this)) return null
    const plan = { ...this.data.plan, name: this.data.plan.name.trim(), why: this.data.plan.why.trim() }
    if (!plan.name) { wx.showToast({ title: '给计划起个名字吧', icon: 'none' }); return null }
    if (plan.status === 'ended') { plan.focused = false; plan.focusedAt = 0 }
    repository.savePlan(plan)
    if (this.wishId) { repository.deleteWish(this.wishId); this.wishId = '' }
    if (this.draftConversationId) {
      repository.update((state) => { const item = state.conversations.find((value) => value.id === this.draftConversationId); if (item && item.draft && item.draft.id === plan.id) { item.draft = null; item.updatedAt = Date.now() } })
    }
    this.planId = plan.id; this.setData({ plan, isNew: false, dirty: false }); form.saved(this)
    return plan
  },
  save() { if (this.persist()) { this.refreshRelated(); wx.showToast({ title: '计划已保存', icon: 'success' }) } },
  deletePlan() {
    wx.showModal({ title: '删除这个计划？', content: '行动库和已经留下的足迹会保留。', confirmText: '删除', success: (res) => { if (res.confirm) { repository.deletePlan(this.data.plan.id); form.saved(this); wx.navigateBack() } } })
  },
  allFootprints() {
    if (!this.persist()) return
    const local = repository.getState(); local.timelinePlanId = this.data.plan.id; repository.saveState(local, { sync: false })
    wx.switchTab({ url: '/pages/footprints/index' })
  },
  toggleActionLink(event) {
    const id = event.currentTarget.dataset.id
    const actionIds = new Set(this.data.plan.actionIds || [])
    if (actionIds.has(id)) actionIds.delete(id)
    else actionIds.add(id)
    this.change({ 'plan.actionIds': [...actionIds] }, () => this.refreshRelated())
  },
  addAction() {
    const plan = this.persist(); if (!plan) return
    this.returningFromActionEditor = true
    wx.navigateTo({ url: themeService.withTheme('/pages/action-editor/index?planId=' + plan.id + '&domainId=' + plan.domainId, this.data.theme) })
  },
  openAction(event) {
    const plan = this.persist(); if (!plan) return
    wx.navigateTo({ url: themeService.withTheme('/pages/action/index?id=' + event.currentTarget.dataset.id + '&planId=' + plan.id, this.data.theme) })
  },
  editAction(event) {
    const plan = this.persist(); if (!plan) return
    this.returningFromActionEditor = true
    wx.navigateTo({ url: themeService.withTheme('/pages/action-editor/index?id=' + event.currentTarget.dataset.id + '&planId=' + plan.id, this.data.theme) })
  },
  askNext() {
    const plan = this.persist(); if (!plan) return
    this.returningFromActionEditor = true
    wx.navigateTo({ url: themeService.withTheme('/pages/chat/index?planId=' + plan.id + '&prompt=' + encodeURIComponent('为计划“' + plan.name + '”想一个现在可以开始的具体行动'), this.data.theme) })
  },
  reflect() {
    wx.showModal({ title: '回头看看', editable: true, content: this.data.plan.reflection || '', placeholderText: '最近做这件事，感觉怎么样？', confirmText: '保存', success: (res) => {
      if (!res.confirm) return
      const plan = { ...this.data.plan, reflection: res.content.trim() }
      this.setData({ plan }); this.persist(); wx.showToast({ title: '已经记下', icon: 'success' })
    } })
  }
})
