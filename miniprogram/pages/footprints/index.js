const repository = require('../../services/repository')
const ai = require('../../services/ai')
const cloud = require('../../services/cloud')
const format = require('../../services/format')

const PERIODS = [{ label: '本周', value: 'week' }, { label: '本月', value: 'month' }, { label: '今年', value: 'year' }, { label: '自定义', value: 'custom' }]

Page({
  data: { tab: 'timeline', footprints: [], periods: PERIODS, period: 'week', startDate: '', endDate: '', stats: null, reviews: [], reviewing: false },
  onShow() {
    const state = repository.getState()
    if (state.preferences.openReviewOnNextShow) {
      repository.update((value) => { value.preferences.openReviewOnNextShow = false })
      this.setData({ tab: 'review' })
    }
    this.refresh()
  },
  async refresh() {
    const state = repository.getState()
    const fileIds = state.footprints.reduce((all, item) => all.concat(item.photoFileIds || []), [])
    let urls = {}
    try { urls = await cloud.getPhotoUrls(fileIds) } catch (error) { console.warn('照片临时地址获取失败', error) }
    const completionLabels = { done: '', partial: '做了一部分', not_started: '最后没做' }
    const footprints = state.footprints.map((item) => {
      const plan = state.plans.find((value) => value.id === item.planId)
      return { ...item, planName: plan ? plan.name : '', dateLabel: format.dateLabel(item.createdAt), durationLabel: format.duration(item.minutes), completionLabel: completionLabels[item.completionStatus] || '', photo: (item.localPhotoPaths && item.localPhotoPaths[0]) || ((item.photoFileIds && item.photoFileIds[0]) ? urls[item.photoFileIds[0]] : '') }
    })
    this.setData({ footprints }, () => this.calculateStats())
  },
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
    if (this.data.period === 'custom' && this.data.endDate) end = new Date(`${this.data.endDate}T23:59:59`)
    return { start: start.getTime(), end: end.getTime() }
  },
  calculateStats() {
    const { start, end } = this.range()
    const all = repository.getState().footprints.filter((item) => item.createdAt >= start && item.createdAt <= end)
    const byDomain = {}
    const byAction = {}
    const feelings = { love: 0, good: 0, okay: 0, poor: 0 }
    let totalMinutes = 0
    all.forEach((item) => {
      totalMinutes += item.minutes || 0
      if (!byDomain[item.domainId]) byDomain[item.domainId] = { name: item.domainName, count: 0, minutes: 0 }
      byDomain[item.domainId].count += 1; byDomain[item.domainId].minutes += item.minutes || 0
      byAction[item.actionName] = (byAction[item.actionName] || 0) + 1
      if (item.feeling) feelings[item.feeling] += 1
    })
    const domains = Object.values(byDomain).sort((a, b) => b.minutes - a.minutes).map((item) => ({ ...item, duration: format.duration(item.minutes) }))
    const favorite = Object.keys(byAction).sort((a, b) => byAction[b] - byAction[a])[0] || '还没有反复出现的事情'
    this.currentRangeItems = all
    const reviews = repository.getState().reviews.filter((item) => item.period === this.data.period)
    this.setData({ stats: { count: all.length, totalDuration: format.duration(totalMinutes), domains, feelings, favorite }, reviews })
  },
  editFootprint(event) {
    const item = repository.getState().footprints.find((footprint) => footprint.id === event.currentTarget.dataset.id)
    if (item) wx.navigateTo({ url: `/pages/record/index?footprintId=${item.id}&actionId=${item.actionId}&mode=edit` })
  },
  openPlan(event) { wx.navigateTo({ url: `/pages/plan/index?id=${event.currentTarget.dataset.id}` }) },
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
    if (this.data.period === 'custom' && (!this.data.startDate || !this.data.endDate || this.data.startDate > this.data.endDate)) { wx.showToast({ title: '请选择有效的日期范围', icon: 'none' }); return }
    if (!this.currentRangeItems.length) { wx.showToast({ title: '先留下一点足迹吧', icon: 'none' }); return }
    this.setData({ reviewing: true })
    let content = ''
    try {
      const result = await ai.review(this.currentRangeItems, PERIODS.find((item) => item.value === this.data.period).label)
      content = result.content
    } catch (error) {
      const stats = this.data.stats
      content = `这段时间留下了 ${stats.count} 次足迹，共有 ${stats.totalDuration}。${stats.domains.length ? `时间更多地流向了${stats.domains.slice(0,2).map((item) => item.name).join('和')}。` : ''}最常出现的是“${stats.favorite}”。不必急着从中得到答案，能看见这些选择已经很好。`
      wx.showToast({ title: '风暂时没有回音，已生成基础回顾', icon: 'none' })
    }
    const { start, end } = this.range()
    repository.saveReview({ period: this.data.period, content, startDate: this.data.startDate, endDate: this.data.endDate, rangeStart: start, rangeEnd: end })
    this.setData({ reviewing: false }); this.refresh()
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
