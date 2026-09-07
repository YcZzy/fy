const repository = require('../../services/repository')
const ai = require('../../services/ai')
const cloud = require('../../services/cloud')
const format = require('../../services/format')
const sync = require('../../services/sync')
const themeService = require('../../services/theme')
const statistics = require('../../services/statistics')

const PERIODS = [{ label: '本周', value: 'week' }, { label: '本月', value: 'month' }, { label: '今年', value: 'year' }, { label: '自定义', value: 'custom' }]

Page({
  data: { tab: 'timeline', footprints: [], periods: PERIODS, period: 'week', startDate: '', endDate: '', stats: null, reviews: [], reviewing: false, query: '', limit: 30, totalCount: 0, filterStart: '', filterEnd: '', plans: [], planIndex: 0 },
  onShow() {
    this.visible = true
    if (repository.getState().deletionPending) { wx.navigateTo({ url: '/pages/settings/index' }); return }
    const tabBar = typeof this.getTabBar === 'function' && this.getTabBar()
    if (tabBar) tabBar.setData({ selected: 2 })
    const state = repository.getState()
    if (state.preferences.openReviewOnNextShow) {
      repository.update((value) => { value.preferences.openReviewOnNextShow = false })
      this.setData({ tab: 'review' })
    }
    const plans = [{ id: '', name: '全部计划' }, ...state.plans]
    const desiredPlanId = state.timelinePlanId || ''
    if (desiredPlanId) {
      const local = repository.getState(); delete local.timelinePlanId; repository.saveState(local, { sync: false })
      this.setData({ tab: 'timeline' })
    }
    this.setData({ plans, planIndex: desiredPlanId ? Math.max(0, plans.findIndex((item) => item.id === desiredPlanId)) : this.data.planIndex })
    this.refresh()
    sync.bootstrap(['plans', 'footprints', 'reviews'])
      .then(() => { if (this.visible) this.refresh() })
      .catch((error) => cloud.warn('足迹云端数据刷新失败，当前继续使用本地数据', error))
  },
  onHide() { this.visible = false; this.reviewRequest = (this.reviewRequest || 0) + 1; this.setData({ reviewing: false }) },
  onUnload() { this.onHide() },
  async refresh() {
    const revision = this.refreshRevision = (this.refreshRevision || 0) + 1
    const token = repository.dataToken(); const state = repository.getState()
    const labels = { done: '', partial: '做了一部分', not_started: '最后没做' }
    const query = this.data.query.trim().toLowerCase()
    const selectedPlanId = (this.data.plans[this.data.planIndex] || {}).id || ''
    const plans = [{ id: '', name: '全部计划' }, ...state.plans]
    const planIndex = Math.max(0, plans.findIndex((item) => item.id === selectedPlanId))
    const planId = plans[planIndex].id
    this.setData({ plans, planIndex })
    const all = state.footprints.slice().sort((a, b) => b.createdAt - a.createdAt)
      .filter((item) => (!query || [item.actionName, item.note || '', item.domainName].join(' ').toLowerCase().includes(query)) && (!planId || item.planId === planId))
      .filter((item) => (!this.data.filterStart || format.dateKey(item.createdAt) >= this.data.filterStart) && (!this.data.filterEnd || format.dateKey(item.createdAt) <= this.data.filterEnd))
    const footprints = all.slice(0, this.data.limit).map((item) => {
      const plan = state.plans.find((value) => value.id === item.planId)
      return { ...item, planName: plan ? plan.name : item.planName || '', planAvailable: Boolean(plan), dateLabel: format.dateLabel(item.createdAt), durationLabel: format.duration(item.minutes), completionLabel: labels[item.completionStatus] || '', photo: (item.localPhotoPaths || [])[0] || '' }
    })
    this.setData({ footprints, totalCount: all.length }, () => this.calculateStats())
    const fileIds = footprints.reduce((all, item) => all.concat(item.photoFileIds || []), [])
    try {
      const urls = await cloud.getPhotoUrls(fileIds)
      if (revision !== this.refreshRevision || !repository.canApply(token)) return
      this.setData({ footprints: footprints.map((item) => ({ ...item, photo: item.photo || urls[(item.photoFileIds || [])[0]] || '' })) })
    } catch (error) { cloud.warn('照片稍后加载，文字记录已显示', error) }
  },
  onSearch(event) { this.setData({ query: event.detail.value, limit: 30 }, () => this.refresh()) },
  onFilterStart(event) { this.setData({ filterStart: event.detail.value, limit: 30 }, () => this.refresh()) },
  onFilterEnd(event) { this.setData({ filterEnd: event.detail.value, limit: 30 }, () => this.refresh()) },
  onPlanFilter(event) { this.setData({ planIndex: Number(event.detail.value), limit: 30 }, () => this.refresh()) },
  clearFilters() { this.setData({ query: '', filterStart: '', filterEnd: '', planIndex: 0, limit: 30 }, () => this.refresh()) },
  onReachBottom() { if (this.data.footprints.length < this.data.totalCount) this.setData({ limit: this.data.limit + 30 }, () => this.refresh()) },
  addRecord() { wx.navigateTo({ url: themeService.withTheme('/pages/record/index?mode=manual', 'footprints') }) },
  previewPhoto(event) { const item = this.data.footprints.find((value) => value.id === event.currentTarget.dataset.id); if (item && item.photo) wx.previewImage({ current: item.photo, urls: [item.photo] }) },
  setTab(event) { this.setData({ tab: event.currentTarget.dataset.value }, () => { if (this.data.tab === 'review') this.calculateStats() }) },
  setPeriod(event) { this.setData({ period: event.currentTarget.dataset.value }, () => this.calculateStats()) },
  onStartDate(event) { this.setData({ startDate: event.detail.value }, () => this.calculateStats()) },
  onEndDate(event) { this.setData({ endDate: event.detail.value }, () => this.calculateStats()) },
  range() {
    const now = new Date(); let start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); let end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    if (this.data.period === 'week') start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
    if (this.data.period === 'month') start = new Date(now.getFullYear(), now.getMonth(), 1)
    if (this.data.period === 'year') start = new Date(now.getFullYear(), 0, 1)
    if (this.data.period === 'custom' && this.data.startDate) start = new Date(`${this.data.startDate}T00:00:00`)
    if (this.data.period === 'custom' && this.data.endDate) end = new Date(`${this.data.endDate}T00:00:00`); if (this.data.period === 'custom' && this.data.endDate) end.setDate(end.getDate() + 1)
    return { start: start.getTime(), end: end.getTime() }
  },
  calculateStats() {
    const { start, end } = this.range()
    const all = repository.getState().footprints.filter((item) => item.createdAt >= start && item.createdAt < end)
    this.currentRangeItems = all
    const reviews = repository.getState().reviews.filter((item) => item.period === this.data.period).slice().sort((a, b) => b.createdAt - a.createdAt).map((item) => ({ ...item,
      rangeLabel: item.rangeStart && item.rangeEnd ? format.dateKey(item.rangeStart) + ' 至 ' + format.dateKey(item.rangeEnd - 1) : item.startDate && item.endDate ? item.startDate + ' 至 ' + item.endDate : '较早保存的回顾（未记录日期范围）',
      savedDate: format.dateKey(item.createdAt)
    }))
    this.setData({ stats: statistics.summarize(all), reviews })
  },
  editFootprint(event) {
    const item = repository.getState().footprints.find((footprint) => footprint.id === event.currentTarget.dataset.id)
    if (item) wx.navigateTo({ url: themeService.withTheme(`/pages/record/index?footprintId=${item.id}&actionId=${item.actionId}&mode=edit`, 'footprints') })
  },
  openPlan(event) { wx.navigateTo({ url: themeService.withTheme(`/pages/plan/index?id=${event.currentTarget.dataset.id}`, 'footprints') }) },
  deleteFootprint(event) {
    const id = event.currentTarget.dataset.id
    const item = repository.getState().footprints.find((footprint) => footprint.id === id)
    if (!item) return
    wx.showModal({ title: '删除这次足迹？', content: '关联照片和位置也会一起删除，计划仍会保留。', confirmText: '删除', confirmColor: '#A85F50', success: async (res) => {
      if (!res.confirm) return
      try { await cloud.deleteCloudFiles(item.photoFileIds || []) } catch (error) { console.warn(error); repository.queueFileDeletes(item.photoFileIds || []); wx.showToast({ title: '照片会在联网后继续清理', icon: 'none' }) }
      ;(item.localPhotoPaths || []).forEach((filePath) => wx.removeSavedFile({ filePath, fail: () => {} }))
      repository.deleteFootprint(id); this.refresh()
    } })
  },
  async generateReview() {
    if (this.data.reviewing) return
    if (this.data.period === 'custom' && (!this.data.startDate || !this.data.endDate || this.data.startDate > this.data.endDate)) { wx.showToast({ title: '请选择有效的日期范围', icon: 'none' }); return }
    this.calculateStats()
    const items = JSON.parse(JSON.stringify(this.currentRangeItems || []))
    if (!items.length) { wx.showToast({ title: '这段时间还没有足迹', icon: 'none' }); return }
    const period = this.data.period; const { start, end } = this.range()
    const label = PERIODS.find((item) => item.value === period).label
    const startDate = format.dateKey(start), endDate = format.dateKey(end - 1)
    const token = repository.dataToken(); const request = this.reviewRequest = (this.reviewRequest || 0) + 1
    const valid = () => repository.canApply(token) && this.reviewRequest === request
    this.setData({ reviewing: true })
    let content = '', source = 'ai'
    try {
      const result = await ai.review(items, startDate + ' 至 ' + endDate)
      content = result.content
    } catch (error) {
      const stats = statistics.summarize(items); source = 'rule'
      content = '这段时间留下了 ' + stats.count + ' 条记录，其中实际参与 ' + stats.participatedCount + ' 次。' + (stats.notStartedCount ? '另有 ' + stats.notStartedCount + ' 次最后没有去做。' : '') + '已知时长：' + stats.totalDuration + '。' + (stats.unknownDurationCount ? '还有 ' + stats.unknownDurationCount + ' 次没有记录时长。' : '') + (stats.domains.length ? '记录涉及' + stats.domains.map((item) => item.name).join('、') + '。' : '') + '可以把这些选择和感受留给以后的自己。'
    }
    if (!valid()) return
    repository.saveReview({ period, content, source, startDate, endDate, rangeStart: start, rangeEnd: end })
    this.setData({ reviewing: false }); this.refresh()
    wx.showToast({ title: label + (source === 'ai' ? '回顾已保存' : '基础回顾已保存'), icon: 'none' })
  },
  deleteReview(event) {
    const id = event.currentTarget.dataset.id
    wx.showModal({ title: '删除这段回顾？', content: '足迹仍会保留，只删除这段回顾文字。', confirmText: '删除', confirmColor: '#A85F50', success: (res) => {
      if (!res.confirm) return
      repository.deleteReview(id); this.refresh()
    } })
  },
  editReview(event) {
    const id = event.currentTarget.dataset.id
    const review = repository.getState().reviews.find((item) => item.id === id)
    if (!review) return
    wx.showModal({ title: '修改这段回顾', editable: true, content: review.content, confirmText: '保存', success: (res) => {
      if (!res.confirm || !res.content.trim()) return
      repository.updateReview(id, res.content.trim()); this.refresh()
    } })
  }
})
