const env = require('./config/env')
const repository = require('./services/repository')

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
        this.initializeCloudData()
      }
    }
  },

  async initializeCloudData() {
    const initKey = `cloud_collections_initialized_v1_${env.CLOUD_ENV_ID}`
    try {
      if (!wx.getStorageSync(initKey)) {
        const result = await wx.cloud.callFunction({
          name: 'dataManager',
          data: { action: 'initialize', confirm: 'CREATE_COLLECTIONS' }
        })
        if (!result.result || result.result.code !== 0) throw new Error('COLLECTION_INITIALIZATION_FAILED')
        wx.setStorageSync(initKey, true)
      }
    } catch (error) {
      console.warn('集合自动初始化未完成，将尝试同步已有集合', error)
    }
    try {
      await require('./services/sync').bootstrap()
      this.globalData.cloudReady = true
    } catch (error) {
      this.globalData.cloudReady = false
      console.warn('云端初始化同步未完成', error)
    }
  },

  onShow() {
    repository.reconcileActiveSession()
    if (this.globalData.cloudConfigured) require('./services/cloud').flushPendingDeletes().catch((error) => console.warn('待清理照片稍后重试', error))
  },

  onHide() {
    repository.markPendingActionBackgrounded()
  }
})
