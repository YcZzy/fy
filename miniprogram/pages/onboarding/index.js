const repository = require('../../services/repository')

const INTERESTS = ['游戏', '短剧影视', '短视频', '健身', '散步', '外语', '考证', '考公', '旅行', '城市探索', '社交', '阅读', '创作', '什么也不做']
const INTEREST_DOMAINS = {
  '游戏': 'rest', '短剧影视': 'rest', '短视频': 'rest', '什么也不做': 'rest',
  '健身': 'health', '散步': 'health', '外语': 'learn', '考证': 'learn', '阅读': 'learn',
  '考公': 'career', '旅行': 'travel', '城市探索': 'travel', '社交': 'connect', '创作': 'create'
}

Page({
  data: { step: 0, interests: INTERESTS, selected: [], selectedMap: {}, customInterest: '', wish: '', previewActions: [] },
  onShow() { if (this.data.step === 3) this.refreshPreview() },
  toggleInterest(event) {
    const value = event.currentTarget.dataset.value
    const selected = this.data.selected.includes(value) ? this.data.selected.filter((item) => item !== value) : [...this.data.selected, value]
    const selectedMap = selected.reduce((map, item) => { map[item] = true; return map }, {})
    this.setData({ selected, selectedMap })
  },
  onCustomInterest(event) { this.setData({ customInterest: event.detail.value }) },
  addCustomInterest() {
    const value = this.data.customInterest.trim().slice(0, 12)
    if (!value) return
    const interests = this.data.interests.includes(value) ? this.data.interests : [...this.data.interests, value]
    const selected = this.data.selected.includes(value) ? this.data.selected : [...this.data.selected, value]
    const selectedMap = selected.reduce((map, item) => { map[item] = true; return map }, {})
    this.setData({ interests, selected, selectedMap, customInterest: '' })
  },
  onWishInput(event) { this.setData({ wish: event.detail.value }) },
  next() {
    if (this.data.step < 3) {
      const step = this.data.step + 1
      this.setData({ step }, () => { if (step === 3) this.refreshPreview() })
    }
    else this.finish()
  },
  refreshPreview() {
    const state = repository.getState()
    const selectedDomains = new Set(this.data.selected.map((item) => INTEREST_DOMAINS[item]).filter(Boolean))
    const actions = state.actions.filter((item) => !item.hidden)
    const preferred = selectedDomains.size ? actions.filter((item) => selectedDomains.has(item.domainId)) : actions
    const previewActions = [...preferred, ...actions.filter((item) => !preferred.some((value) => value.id === item.id))].slice(0, 8)
      .map((item) => ({ ...item, domainName: (state.domains.find((domain) => domain.id === item.domainId) || {}).name || '生活' }))
    this.setData({ previewActions })
  },
  editAction(event) { wx.navigateTo({ url: `/pages/action-editor/index?id=${event.currentTarget.dataset.id}` }) },
  addAction() { wx.navigateTo({ url: '/pages/action-editor/index' }) },
  removeAction(event) {
    repository.hideAction(event.currentTarget.dataset.id)
    this.refreshPreview()
  },
  skip() { this.finish() },
  finish() {
    repository.completeOnboarding(this.data.selected, this.data.wish)
    wx.switchTab({ url: '/pages/now/index' })
  }
})
