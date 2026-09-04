const repository = require('../../services/repository')

const INTERESTS = ['游戏', '短剧影视', '短视频', '健身', '散步', '外语', '考证', '考公', '旅行', '城市探索', '社交', '阅读', '创作', '什么也不做']

Page({
  data: { step: 0, interests: INTERESTS, selected: [], selectedMap: {}, wish: '' },
  toggleInterest(event) {
    const value = event.currentTarget.dataset.value
    const selected = this.data.selected.includes(value) ? this.data.selected.filter((item) => item !== value) : [...this.data.selected, value]
    const selectedMap = selected.reduce((map, item) => { map[item] = true; return map }, {})
    this.setData({ selected, selectedMap })
  },
  onWishInput(event) { this.setData({ wish: event.detail.value }) },
  next() {
    if (this.data.step < 2) this.setData({ step: this.data.step + 1 })
    else this.finish()
  },
  skip() { this.finish() },
  finish() {
    repository.completeOnboarding(this.data.selected, this.data.wish)
    wx.switchTab({ url: '/pages/now/index' })
  }
})
