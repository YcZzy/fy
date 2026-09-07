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
        sync.resumePending(repository.getState())
        this.globalData.cloudReady = true
      }
    }
  },

  onShow() {
    repository.reconcileActiveSession()
    if (this.globalData.cloudConfigured) {
      cloudService.flushPendingDeletes().catch((error) => cloudService.warn('待清理照片稍后重试', error))
    }
  },

  onHide() {
    repository.markPendingActionBackgrounded()
    if (this.globalData.cloudConfigured) require('./services/sync').flush().catch((error) => cloudService.warn('离开前未完成云同步，下次将继续', error))
  }
})
