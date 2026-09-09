const repository = require('../../services/repository')
const themeService = require('../../services/theme')
const format = require('../../services/format')
const form = require('../../services/form')
const domainCatalog = require('../../data/domains')

const ENERGIES = [{ value: 'low', label: '很累也能做' }, { value: 'medium', label: '一般状态' }, { value: 'high', label: '状态不错' }]
const ENVIRONMENTS = [{ value: 'home', label: '在家' }, { value: 'outdoor', label: '户外' }, { value: 'commute', label: '通勤中' }, { value: 'any', label: '不限' }, { value: 'location', label: '附近' }]

Page({
  data: { action: null, domains: [], plans: [], domainIndex: 0, energies: ENERGIES, environments: ENVIRONMENTS, energyMap: {}, environmentMap: {}, planMap: {}, isNew: true, theme: 'now' },
  onLoad(options) {
    this.token = repository.dataToken()
    const theme = themeService.fromOptions(options)
    themeService.apply(theme)
    const state = repository.getState()
    const existing = options.id ? state.actions.find((item) => item.id === options.id) : null
    if (options.id && !existing) { wx.showToast({ title: '这个行动已不存在', icon: 'none' }); wx.navigateBack(); return }
    let draft = null
    try { draft = options.draft ? JSON.parse(decodeURIComponent(options.draft)) : null } catch (error) { console.warn('行动草稿解析失败', error) }
    this.draftConversationId = draft && draft.conversationId
    const requestedPlanId = (draft && draft.planId) || options.planId || ''
    const requestedPlan = state.plans.find((item) => item.id === requestedPlanId)
    const domainId = existing ? existing.domainId : ((requestedPlan && requestedPlan.domainId) || options.domainId || (draft && draft.domainId) || '')
    const action = existing ? { ...existing } : { id: draft && draft.id || format.uid('a'), name: draft ? (draft.name || '') : '', domainId, minutes: draft ? Math.max(1, Number(draft.minutes) || 30) : 30, energy: ['low','medium','high'], environments: ['any'], preparation: draft ? (draft.preparation || '') : '', source: draft ? 'ai' : 'user' }
    const domains = [{ id: '', name: '未分类' }, ...domainCatalog.allDomains(state.domains)]
    const linkedPlanIds = existing ? state.plans.filter((item) => (item.actionIds || []).includes(existing.id)).map((item) => item.id) : []
    const planMap = this.toMap([...linkedPlanIds, requestedPlanId].filter(Boolean))
    const plans = state.plans.filter((item) => item.status !== 'ended' && item.domainId === action.domainId)
    this.setData({ action, domains, plans, domainIndex: Math.max(0, domains.findIndex((item) => item.id === action.domainId)), energyMap: this.toMap(action.energy), environmentMap: this.toMap(action.environments), planMap, isNew: !existing, theme })
  },
  toMap(values) { return (values || []).reduce((map, item) => { map[item] = true; return map }, {}) },
  onName(event) { form.changed(this); this.setData({ 'action.name': event.detail.value }) },
  onMinutes(event) { form.changed(this); this.setData({ 'action.minutes': event.detail.value.replace(/\D/g, '').slice(0, 3) }) },
  onPreparation(event) { form.changed(this); this.setData({ 'action.preparation': event.detail.value }) },
  onDomain(event) { form.changed(this);
    const index = Number(event.detail.value)
    const domain = this.data.domains[index]
    if (!domain) return
    const domainId = domain.id
    const state = repository.getState()
    const plans = state.plans.filter((item) => item.status !== 'ended' && item.domainId === domainId)
    const allowed = new Set(plans.map((item) => item.id))
    const planMap = Object.keys(this.data.planMap).reduce((map, id) => { if (this.data.planMap[id] && allowed.has(id)) map[id] = true; return map }, {})
    const removed = Object.keys(planMap).length !== Object.keys(this.data.planMap).filter((id) => this.data.planMap[id]).length
    this.setData({ domainIndex: index, 'action.domainId': domainId, plans, planMap })
    if (removed) wx.showToast({ title: '已移除其他板块的计划关联', icon: 'none' })
  },
  togglePlan(event) { form.changed(this);
    const id = event.currentTarget.dataset.id
    this.setData({ planMap: { ...this.data.planMap, [id]: !this.data.planMap[id] } })
  },
  toggleEnergy(event) { form.changed(this);
    const value = event.currentTarget.dataset.value
    const map = { ...this.data.energyMap, [value]: !this.data.energyMap[value] }
    this.setData({ energyMap: map })
  },
  toggleEnvironment(event) { form.changed(this);
    const value = event.currentTarget.dataset.value
    let map = { ...this.data.environmentMap }
    if (value === 'any') map = { any: true }
    else { delete map.any; map[value] = !map[value] }
    this.setData({ environmentMap: map })
  },
  onShow() { form.guard(this) },
  onUnload() { form.saved(this) },
  save() {
    if (this.saved || !form.guard(this)) return
    const name = this.data.action.name.trim()
    const minutes = Number(this.data.action.minutes)
    const energy = Object.keys(this.data.energyMap).filter((key) => this.data.energyMap[key])
    const environments = Object.keys(this.data.environmentMap).filter((key) => this.data.environmentMap[key])
    if (!name) { wx.showToast({ title: '给行动起个名字吧', icon: 'none' }); return }
    if (!minutes) { wx.showToast({ title: '填写预计时间', icon: 'none' }); return }
    if (!energy.length || !environments.length) { wx.showToast({ title: '至少选择一种状态和环境', icon: 'none' }); return }
    const planIds = Object.keys(this.data.planMap).filter((id) => this.data.planMap[id])
    repository.saveActionWithPlans({ ...this.data.action, name, minutes, energy, environments, preparation: this.data.action.preparation.trim() || '不需要额外准备' }, planIds)
    this.saved = true; form.saved(this)
    if (this.draftConversationId) repository.update((state) => { const item = state.conversations.find((value) => value.id === this.draftConversationId); if (item && item.draft && item.draft.id === this.data.action.id) { item.draft = null; item.updatedAt = Date.now() } })
    wx.showToast({ title: '行动已保存', icon: 'success' }); setTimeout(() => wx.navigateBack(), 500)
  },
  remove() {
    wx.showModal({ title: '删除这个行动？', content: '已经留下的足迹不会被删除。', confirmText: '删除', confirmColor: '#A85F50', success: (res) => {
      if (!res.confirm) return
      repository.deleteAction(this.data.action.id); form.saved(this); wx.navigateBack()
    } })
  }
})
