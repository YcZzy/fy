const repository = require('../../services/repository')
const ai = require('../../services/ai')
const cloud = require('../../services/cloud')
const format = require('../../services/format')

const PERIODS = [{ label: '本周', value: 'week' }, { label: '本月', value: 'month' }, { label: '今年', value: 'year' }, { label: '自定义', value: 'custom' }]

Page({
  data: { tab: 'timeline', footprints: [], periods: PERIODS, period: 'week', startDate: '', endDate: '', stats: null, reviews: [], reviewing: false },
  onShow() { this.refresh(); this.maybePromptWeeklyReview() },
  async refresh() {
    const state = repository.getState()
    const fileIds = state.footprints.reduce((all, item) => all.concat(item.photoFileIds || []), [])
    let urls = {}
    try { urls = await cloud.getPhotoUrls(fileIds) } catch (error) { console.warn('照片临时地址获取失败', error) }
    const footprints = state.footprints.map((item) => ({ ...item, dateLabel: format.dateLabel(item.createdAt), durationLabel: format.duration(item.minutes), photo: (item.localPhotoPaths && item.localPhotoPaths[0]) || ((item.photoFileIds && item.photoFileIds[0]) ? urls[item.photoFileIds[0]] : '') }))
    this.setData({ footprints, reviews: state.reviews }, () => this.calculateStats())
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
    this.setData({ stats: { count: all.length, totalDuration: format.duration(totalMinutes), domains, feelings, favorite } })
  },
  editFootprint(event) {
    const item = repository.getState().footprints.find((footprint) => footprint.id === event.currentTarget.dataset.id)
    if (item) wx.navigateTo({ url: `/pages/record/index?footprintId=${item.id}&actionId=${item.actionId}&mode=edit` })
  },
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
    repository.saveReview({ period: this.data.period, content, startDate: this.data.startDate, endDate: this.data.endDate })
    this.setData({ reviewing: false }); this.refresh()
  },
  deleteReview(event) {
    const id = event.currentTarget.dataset.id
    repository.update((state) => { state.reviews = state.reviews.filter((item) => item.id !== id) })
    this.refresh()
  },
  maybePromptWeeklyReview() {
    const now = new Date()
    if (now.getDay() !== 0 || now.getHours() < 18) return
    const key = format.dateKey(now.getTime())
    const state = repository.getState()
    if (state.preferences.weeklyPromptKey === key) return
    repository.update((value) => { value.preferences.weeklyPromptKey = key })
    wx.showModal({ title: '这一周，要不要回头看看？', content: '不着急，也可以之后从“足迹—回望”再来。', confirmText: '去回望', cancelText: '以后再说', success: (res) => { if (res.confirm) this.setData({ tab: 'review' }, () => this.calculateStats()) } })
  }
})
