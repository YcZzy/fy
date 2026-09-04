const repository = require('../../services/repository')
const format = require('../../services/format')

const FILTERS = [{ label: '全部', value: 'all' }, { label: '进行中', value: 'active' }, { label: '想做', value: 'want' }, { label: '暂停', value: 'paused' }, { label: '已结束', value: 'ended' }]

Page({
  data: { filters: FILTERS, filter: 'all', plans: [], focusedPlans: [], wishes: [], domains: [], actions: [], showActions: false },
  onShow() { this.refresh() },
  refresh() {
    const state = repository.getState()
    const decorate = (plan) => {
      const footprints = state.footprints.filter((item) => item.planId === plan.id)
      return { ...plan, count: footprints.length, duration: format.duration(footprints.reduce((sum, item) => sum + (item.minutes || 0), 0)), statusLabel: this.statusLabel(plan.status) }
    }
    const plans = state.plans.filter((item) => this.data.filter === 'all' || item.status === this.data.filter).map(decorate)
    const domains = state.domains.filter((item) => !item.hidden).map((domain) => ({ ...domain, actionCount: state.actions.filter((item) => !item.hidden && item.domainId === domain.id).length }))
    const actions = state.actions.filter((item) => !item.hidden).map((action) => ({ ...action, domainName: (state.domains.find((item) => item.id === action.domainId) || {}).name || '生活' }))
    this.setData({ plans, focusedPlans: state.plans.filter((item) => item.focused && item.status !== 'ended').map(decorate), wishes: state.wishes, domains, actions })
  },
  statusLabel(value) { return ({ active: '进行中', want: '想做', paused: '暂停', ended: '已结束' })[value] || '想做' },
  setFilter(event) { this.setData({ filter: event.currentTarget.dataset.value }, () => this.refresh()) },
  openPlan(event) { wx.navigateTo({ url: `/pages/plan/index?id=${event.currentTarget.dataset.id}` }) },
  addPlan() { wx.navigateTo({ url: '/pages/plan/index' }) },
  addWish() {
    wx.showModal({ title: '记下一件惦记', editable: true, placeholderText: '模糊一点也没关系', confirmText: '记下来', success: (res) => { if (res.confirm && res.content.trim()) { repository.addWish(res.content); this.refresh() } } })
  },
  wishAction(event) {
    const { id, action } = event.currentTarget.dataset
    const wish = this.data.wishes.find((item) => item.id === id)
    if (action === 'delete') {
      wx.showModal({ title: '删掉这条想法？', content: '只删除想法，不影响已经存在的计划和足迹。', confirmText: '删除', confirmColor: '#A85F50', success: (res) => { if (res.confirm) { repository.deleteWish(id); this.refresh() } } })
    } else if (action === 'plan') {
      wx.navigateTo({ url: `/pages/plan/index?wish=${encodeURIComponent(wish.text)}&wishId=${id}` })
    } else {
      wx.navigateTo({ url: `/pages/chat/index?prompt=${encodeURIComponent(`帮我展开这个想法：${wish.text}`)}` })
    }
  },
  toggleActions() { this.setData({ showActions: !this.data.showActions }) },
  addAction() {
    wx.showModal({ title: '添加一个具体行动', editable: true, placeholderText: '例如：下楼散步 20 分钟', confirmText: '添加', success: (res) => {
      if (!res.confirm || !res.content.trim()) return
      repository.saveAction({ name: res.content.trim(), domainId: 'daily', minutes: 30 })
      this.setData({ showActions: true }); this.refresh()
    } })
  },
  hideAction(event) {
    const id = event.currentTarget.dataset.id
    wx.showModal({ title: '从行动库隐藏？', content: '历史足迹不会被删除。', confirmText: '隐藏', confirmColor: '#A85F50', success: (res) => { if (res.confirm) { repository.hideAction(id); this.refresh() } } })
  },
  openChat() { wx.navigateTo({ url: '/pages/chat/index' }) }
})
