const repository = require('../../services/repository')
const cloud = require('../../services/cloud')
const env = require('../../config/env')

Page({
  data: { cloudReady: false, envLabel: '本地模式', counts: {} },
  onShow() {
    const state = repository.getState()
    this.setData({ cloudReady: cloud.isSyncReady(), envLabel: env.CLOUD_ENV_ID || '尚未配置', counts: { plans: state.plans.length, footprints: state.footprints.length, conversations: state.conversations.length } })
  },
  openLocationSettings() { wx.openSetting() },
  clearChats() {
    wx.showModal({ title: '清空全部 AI 对话？', content: '计划、行动和足迹不会受影响。', confirmText: '清空', confirmColor: '#A85F50', success: (res) => { if (res.confirm) { repository.clearConversations(); this.onShow(); wx.showToast({ title: '已清空', icon: 'success' }) } } })
  },
  deleteAll() {
    wx.showModal({ title: '删除全部个人数据？', content: '这会删除偏好、计划、行动、足迹、照片、回顾和 AI 对话，且无法恢复。', confirmText: '继续删除', confirmColor: '#A85F50', success: (first) => {
      if (!first.confirm) return
      wx.showModal({ title: '最后确认', content: '确定要让所有个人数据离开吗？', confirmText: '全部删除', confirmColor: '#A85F50', success: async (second) => {
        if (!second.confirm) return
        wx.showLoading({ title: '正在删除' })
        const state = repository.getState()
        try { await cloud.deleteAllPersonalData() } catch (error) {
          console.warn('云端删除未完成', error)
          wx.hideLoading()
          wx.showModal({ title: '还没有全部删除', content: '云端数据删除失败，本地数据已保留。请检查网络或 dataManager 云函数后重试。', showCancel: false })
          return
        }
        state.footprints.forEach((item) => (item.localPhotoPaths || []).forEach((filePath) => wx.removeSavedFile({ filePath, fail: () => {} })))
        repository.deleteAllPersonalData()
        wx.hideLoading(); wx.reLaunch({ url: '/pages/onboarding/index' })
      } })
    } })
  }
})
