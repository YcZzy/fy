const repository = require('../../services/repository')
const cloud = require('../../services/cloud')
const sync = require('../../services/sync')
const format = require('../../services/format')
const themeService = require('../../services/theme')
Page({
  data: { cloudReady: false, counts: {}, theme: 'now', syncInfo: '', syncing: false, deleting: false, deletionPending: false, lastSynced: '', interests: '', pendingPhotos: 0 },
  onLoad(options) { const theme = themeService.fromOptions(options); this.setData({ theme }); themeService.apply(theme) },
  onShow() { this.refresh(); this.onHide(); this.statusTimer = setInterval(() => this.refresh(), 2000) },
  onHide() { if (this.statusTimer) clearInterval(this.statusTimer); this.statusTimer = null },
  onUnload() { this.onHide() },
  refresh() {
    const state = repository.getState(); const status = sync.getStatus(); const configured = cloud.isSyncReady()
    let syncInfo = '数据保存在这台设备上'
    if (configured) syncInfo = status.state === 'error' ? '同步未完成，本机数据已保留' : status.state === 'syncing' ? '正在同步' : status.pending ? '有 ' + status.pending + ' 类数据等待同步' : state.lastSyncedAt ? '最近一次同步已完成' : '尚未完成首次同步'
    if (state.deletionPending) syncInfo = '删除尚未完成，已暂停同步，请继续删除'
    this.setData({ cloudReady: configured, syncInfo, deletionPending: state.deletionPending,
      lastSynced: state.lastSyncedAt ? format.dateKey(state.lastSyncedAt) + ' ' + new Date(state.lastSyncedAt).toTimeString().slice(0, 5) : '暂无',
      counts: { plans: state.plans.length, footprints: state.footprints.length, conversations: state.conversations.length },
      interests: (state.preferences.selectedInterests || []).join('、') || '还没有选择，可随时调整',
      pendingPhotos: state.footprints.filter((item) => (item.localPhotoPaths || []).length && !(item.photoFileIds || []).length).length })
  },
  editInterests() { wx.navigateTo({ url: '/pages/onboarding/index?edit=interests' }) },
  openLocationSettings() { wx.openSetting() },
  async retrySync() {
    if (this.data.syncing || this.data.deletionPending) return
    this.setData({ syncing: true })
    try { await sync.bootstrap(); await cloud.flushPendingUploads(); await cloud.flushPendingDeletes(); await sync.retry(); wx.showToast({ title: '同步已完成', icon: 'success' }) }
    catch (error) { wx.showToast({ title: '暂未同步完成，请稍后再试', icon: 'none' }) }
    finally { this.setData({ syncing: false }); this.refresh() }
  },
  showPrivacy() {
    wx.showModal({ title: '数据如何使用', showCancel: false, content: '偏好、计划、行动、足迹和对话保存在本机；启用云能力时会同步到你的个人云端空间。照片按需上传，失败时保留本机副本并重试。\n\n想法整理会把你主动输入的文字和已有行动、计划名称交给 AI 判断分类与整理方式；此刻推荐会接收状态、兴趣和行动摘要，聊天会接收近期对话及生活摘要，回顾会接收所选日期内的记录和文字。照片及足迹经纬度不发送给 AI。\n\n删除足迹会清理关联照片；删除全部数据后仅保留用于阻止旧设备恢复数据的云端重置版本，不保留生活内容。' })
  },
  showHelp() { wx.showModal({ title: '怎样使用风月为邻', showCancel: false, content: '此刻：写下一件想做的事，系统会整理成行动或计划草稿；也可以按时间和状态看看现在能做什么。直接去做的事情会留在首页，回来即可记录。\n风月：想做清单收下还不想整理的念头；计划、行动和分类都可以随时修改。\n足迹：保存经历，也能补记过去的事情。未知时长不等于零，最后没有去做会单独统计。\n提醒只在行动页或返回此刻时出现，不是后台闹钟。' }) },
  clearChats() {
    wx.showModal({ title: '清空全部 AI 对话？', content: '消息和未保存草稿会删除，已保存的计划、行动与足迹不受影响。', confirmText: '清空', success: (res) => { if (res.confirm) { repository.clearConversations(); this.refresh(); wx.showToast({ title: '已清空', icon: 'success' }) } } })
  },
  deleteAll() {
    if (this.data.deleting) return
    if (this.data.deletionPending) { this.performDelete(); return }
    wx.showModal({ title: '删除全部个人数据？', content: '偏好、计划、行动、足迹、照片、回顾和 AI 对话将被删除，无法恢复。其他设备也会在下次同步时重置。', confirmText: '继续删除', confirmColor: '#A85F50', success: (first) => {
      if (!first.confirm) return
      wx.showModal({ title: '确认删除全部数据', content: '确定删除并重新开始吗？', confirmText: '全部删除', confirmColor: '#A85F50', success: (second) => { if (second.confirm) this.performDelete() } })
    } })
  },
  async performDelete() {
    this.setData({ deleting: true }); wx.showLoading({ title: '正在删除' })
    try {
      const result = await cloud.deleteAllPersonalData()
      const state = repository.getState()
      state.footprints.forEach((item) => (item.localPhotoPaths || []).forEach((filePath) => wx.removeSavedFile({ filePath, fail: () => {} })))
      repository.deleteAllPersonalData(result.epoch || 0)
      wx.reLaunch({ url: '/pages/onboarding/index' })
    } catch (error) { wx.showModal({ title: '删除尚未完成', content: '本机副本已保留，同步已暂停。请检查网络后点击“继续删除”，避免遗漏数据。', showCancel: false }); cloud.warn('删除尚未完成', error) }
    finally { wx.hideLoading(); this.setData({ deleting: false }); this.refresh() }
  }
})
