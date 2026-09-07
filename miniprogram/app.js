const env = require('./config/env')
const repository = require('./services/repository')
const cloudService = require('./services/cloud')

App({
  globalData: {
    cloudReady: false,
    cloudConfigured: false,
    envId: env.CLOUD_ENV_ID
  },

  onLaunch() {
    repository.ensureState()
    if (env.CLOUD_ENV_ID && wx.cloud) {
      wx.cloud.init({ env: env.CLOUD_ENV_ID, traceUser: true })
      this.globalData.cloudConfigured = true
      if (env.ENABLE_CLOUD_SYNC) {
        const sync = require('./services/sync')
        sync.initialize()
        this.globalData.initialSync = sync.bootstrap().then(() => {
          sync.resumePending(repository.getState())
          this.globalData.cloudReady = true
        }).catch((error) => cloudService.warn('暂时使用本机数据', error))
      }
    }
  },

  async onShow() {
    if (repository.getState().deletionPending) return
    repository.reconcileActiveSession()
    if (this.globalData.cloudConfigured) {
      if (env.ENABLE_CLOUD_SYNC) {
        try {
          await this.globalData.initialSync
          await require('./services/sync').bootstrap(['footprints'])
          if (repository.getState().deletionPending) return
        } catch (error) { cloudService.warn('先确认云端数据版本，再继续照片同步', error); return }
      }
      cloudService.flushPendingDeletes().catch((error) => cloudService.warn('待清理照片稍后重试', error))
      cloudService.flushPendingUploads().catch((error) => cloudService.warn('照片仍保存在本机，稍后继续上传', error))
    }
  },

  onHide() {
    if (repository.getState().deletionPending) return
    repository.markPendingActionBackgrounded()
    if (this.globalData.cloudConfigured) require('./services/sync').flush().catch((error) => cloudService.warn('离开前未完成云同步，下次将继续', error))
  }
})
