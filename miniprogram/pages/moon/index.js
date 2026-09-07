const repository = require('../../services/repository')
const format = require('../../services/format')
const cloud = require('../../services/cloud')
const sync = require('../../services/sync')
const themeService = require('../../services/theme')
const statistics = require('../../services/statistics')

const FILTERS = [{ label: '全部', value: 'all' }, { label: '进行中', value: 'active' }, { label: '想做', value: 'want' }, { label: '暂停', value: 'paused' }, { label: '已结束', value: 'ended' }]

Page({
  data: { filters: FILTERS, filter: 'all', plans: [], focusedPlans: [], wishes: [], domains: [], actions: [], showActions: true, workspaceTab: 'plans', filterLabel: '全部', actionQuery: '', actionDomainId: '' },
  onShow() {
    if (repository.getState().deletionPending) { wx.navigateTo({ url: '/pages/settings/index' }); return }
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tabBar) tabBar.setData({ selected: 1 })
    this.refresh()
    sync.bootstrap(['domains', 'actions', 'plans', 'wishes', 'footprints'])
      .then(() => this.refresh())
      .catch((error) => cloud.warn('风月云端数据刷新失败，当前继续使用本地数据', error))
  },
  refresh() {
    const state = repository.getState()
    const decorate = (plan) => {
      const footprints = state.footprints.filter((item) => item.planId === plan.id).sort((a, b) => b.createdAt - a.createdAt)
      return {
        ...plan,
        count: footprints.length,
        duration: statistics.summarize(footprints).totalDuration,
        statusLabel: this.statusLabel(plan.status),
        lastAction: footprints[0] ? footprints[0].actionName : '还没有开始',
        lastFeeling: footprints[0] ? footprints[0].feelingLabel : '还没有留下感受'
      }
    }
    const plans = state.plans.filter((item) => this.data.filter === 'all' || item.status === this.data.filter).map(decorate)
    const domains = state.domains.filter((item) => !item.hidden).map((domain) => ({ ...domain, actionCount: state.actions.filter((item) => !item.hidden && item.domainId === domain.id).length }))
    const query = this.data.actionQuery.trim().toLowerCase()
    const actions = state.actions.filter((item) => !item.hidden)
      .filter((item) => !this.data.actionDomainId || item.domainId === this.data.actionDomainId)
      .filter((item) => !query || item.name.toLowerCase().includes(query))
      .map((action) => ({ ...action, domainName: (state.domains.find((item) => item.id === action.domainId) || {}).name || '生活' }))
    const focusedPlans = state.plans
      .filter((item) => item.focused && item.status !== 'ended')
      .sort((left, right) => Number(right.focusedAt || right.updatedAt || right.createdAt || 0) - Number(left.focusedAt || left.updatedAt || left.createdAt || 0))
      .slice(0, 3)
      .map(decorate)
    this.setData({ plans, focusedPlans, wishes: state.wishes, domains, actions, filterLabel: FILTERS.find((item) => item.value === this.data.filter).label })
  },
  statusLabel(value) { return ({ active: '进行中', want: '想做', paused: '暂停', ended: '已结束' })[value] || '想做' },
  setWorkspaceTab(event) { this.setData({ workspaceTab: event.currentTarget.dataset.value }) },
  setFilter(event) { this.setData({ filter: event.currentTarget.dataset.value }, () => this.refresh()) },
  openPlan(event) { wx.navigateTo({ url: themeService.withTheme(`/pages/plan/index?id=${event.currentTarget.dataset.id}`, 'moon') }) },
  addPlan() { wx.navigateTo({ url: themeService.withTheme('/pages/plan/index', 'moon') }) },
  addWish() {
    wx.showModal({ title: '记下一件惦记', editable: true, placeholderText: '模糊一点也没关系', confirmText: '记下来', success: (res) => { if (res.confirm && res.content.trim()) { repository.addWish(res.content); this.refresh() } } })
  },
  wishAction(event) {
    const { id, action } = event.currentTarget.dataset
    const wish = this.data.wishes.find((item) => item.id === id)
    if (!wish) return
    if (action === 'edit') {
      wx.showModal({ title: '修改想法', editable: true, content: wish.text, confirmText: '保存', success: (res) => { if (res.confirm && res.content.trim()) { repository.editWish(id, res.content); this.refresh() } } })
    } else if (action === 'delete') {
      wx.showModal({ title: '删掉这条想法？', content: '只删除想法，不影响已经存在的计划和足迹。', confirmText: '删除', confirmColor: '#A85F50', success: (res) => { if (res.confirm) { repository.deleteWish(id); this.refresh() } } })
    } else if (action === 'plan') {
      wx.navigateTo({ url: themeService.withTheme(`/pages/plan/index?wish=${encodeURIComponent(wish.text)}&wishId=${id}`, 'moon') })
    } else {
      wx.navigateTo({ url: themeService.withTheme(`/pages/chat/index?prompt=${encodeURIComponent(`帮我展开这个想法：${wish.text}`)}`, 'moon') })
    }
  },
  toggleActions() { this.setData({ showActions: !this.data.showActions }) },
  addAction() { wx.navigateTo({ url: themeService.withTheme('/pages/action-editor/index', 'moon') }) },
  openAction(event) { wx.navigateTo({ url: themeService.withTheme(`/pages/action/index?id=${event.currentTarget.dataset.id}`, 'moon') }) },
  editAction(event) { wx.navigateTo({ url: themeService.withTheme(`/pages/action-editor/index?id=${event.currentTarget.dataset.id}`, 'moon') }) },
  onActionSearch(event) { this.setData({ actionQuery: event.detail.value, showActions: true }, () => this.refresh()) },
  filterDomain(event) {
    const id = event.currentTarget.dataset.id
    this.setData({ actionDomainId: this.data.actionDomainId === id ? '' : id, showActions: true, workspaceTab: 'actions' }, () => this.refresh())
  },
  clearActionFilters() { this.setData({ actionQuery: '', actionDomainId: '' }, () => this.refresh()) },
  deleteAction(event) {
    const id = event.currentTarget.dataset.id
    wx.showModal({ title: '删除这个行动？', content: '将从行动库中删除，已经留下的足迹不受影响。', confirmText: '删除', confirmColor: '#A85F50', success: (res) => { if (res.confirm) { repository.deleteAction(id); this.refresh() } } })
  },
  openChat() { wx.navigateTo({ url: themeService.withTheme('/pages/chat/index', 'moon') }) }
})
