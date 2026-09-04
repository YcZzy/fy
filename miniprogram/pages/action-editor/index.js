const repository = require('../../services/repository')

const ENERGIES = [{ value: 'low', label: '很累也能做' }, { value: 'medium', label: '一般状态' }, { value: 'high', label: '状态不错' }]
const ENVIRONMENTS = [{ value: 'home', label: '在家' }, { value: 'outdoor', label: '户外' }, { value: 'commute', label: '通勤中' }, { value: 'any', label: '不限' }, { value: 'location', label: '附近' }]

Page({
  data: { action: null, domains: [], plans: [], domainIndex: 0, planIndex: 0, energies: ENERGIES, environments: ENVIRONMENTS, energyMap: {}, environmentMap: {}, isNew: true },
  onLoad(options) {
    const state = repository.getState()
    const existing = options.id ? state.actions.find((item) => item.id === options.id) : null
    let draft = null
    try { draft = options.draft ? JSON.parse(decodeURIComponent(options.draft)) : null } catch (error) { console.warn('行动草稿解析失败', error) }
    const action = existing ? { ...existing } : { id: '', name: draft ? (draft.name || '') : '', domainId: draft ? (draft.domainId || 'daily') : 'daily', minutes: draft ? Math.max(5, Number(draft.minutes) || 30) : 30, energy: ['low','medium','high'], environments: ['any'], preparation: draft ? (draft.preparation || '') : '', planId: (draft && draft.planId) || options.planId || '', source: draft ? 'ai' : 'user' }
    const domains = state.domains.filter((item) => !item.hidden)
    const plans = [{ id: '', name: '不关联计划' }, ...state.plans.filter((item) => item.status !== 'ended' || item.id === action.planId)]
    this.setData({ action, domains, plans, domainIndex: Math.max(0, domains.findIndex((item) => item.id === action.domainId)), planIndex: Math.max(0, plans.findIndex((item) => item.id === action.planId)), energyMap: this.toMap(action.energy), environmentMap: this.toMap(action.environments), isNew: !existing })
  },
  toMap(values) { return (values || []).reduce((map, item) => { map[item] = true; return map }, {}) },
  onName(event) { this.setData({ 'action.name': event.detail.value }) },
  onMinutes(event) { this.setData({ 'action.minutes': event.detail.value.replace(/\D/g, '').slice(0, 3) }) },
  onPreparation(event) { this.setData({ 'action.preparation': event.detail.value }) },
  onDomain(event) { const index = Number(event.detail.value); this.setData({ domainIndex: index, 'action.domainId': this.data.domains[index].id }) },
  onPlan(event) { const index = Number(event.detail.value); this.setData({ planIndex: index, 'action.planId': this.data.plans[index].id }) },
  toggleEnergy(event) {
    const value = event.currentTarget.dataset.value
    const map = { ...this.data.energyMap, [value]: !this.data.energyMap[value] }
    this.setData({ energyMap: map })
  },
  toggleEnvironment(event) {
    const value = event.currentTarget.dataset.value
    let map = { ...this.data.environmentMap }
    if (value === 'any') map = { any: true }
    else { delete map.any; map[value] = !map[value] }
    this.setData({ environmentMap: map })
  },
  save() {
    const name = this.data.action.name.trim()
    const minutes = Number(this.data.action.minutes)
    const energy = Object.keys(this.data.energyMap).filter((key) => this.data.energyMap[key])
    const environments = Object.keys(this.data.environmentMap).filter((key) => this.data.environmentMap[key])
    if (!name) { wx.showToast({ title: '给行动起个名字吧', icon: 'none' }); return }
    if (!minutes) { wx.showToast({ title: '填写预计时间', icon: 'none' }); return }
    if (!energy.length || !environments.length) { wx.showToast({ title: '至少选择一种状态和环境', icon: 'none' }); return }
    repository.saveAction({ ...this.data.action, name, minutes, energy, environments, preparation: this.data.action.preparation.trim() || '不需要额外准备' })
    wx.showToast({ title: '行动已保存', icon: 'success' }); setTimeout(() => wx.navigateBack(), 500)
  },
  remove() {
    wx.showModal({ title: '删除这个行动？', content: '已经留下的足迹不会被删除。', confirmText: '删除', confirmColor: '#A85F50', success: (res) => {
      if (!res.confirm) return
      repository.deleteAction(this.data.action.id); wx.navigateBack()
    } })
  }
})
