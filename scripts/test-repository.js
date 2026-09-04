const path = require('path')

const storage = new Map()
global.wx = {
  cloud: {},
  getStorageSync(key) { return storage.get(key) },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))) }
}

const repositoryPath = path.resolve(__dirname, '../miniprogram/services/repository.js')
const syncPath = path.resolve(__dirname, '../miniprogram/services/sync.js')
const scheduledCollections = []
require.cache[syncPath] = {
  id: syncPath,
  filename: syncPath,
  loaded: true,
  exports: { schedule(state, collections) { scheduledCollections.push(collections) } }
}
delete require.cache[repositoryPath]
const repository = require(repositoryPath)

repository.ensureState()
repository.addWish('想看看秋天的海')
repository.saveReview({ period: 'week', content: '这一周有一些真实发生过的生活。' })
repository.startSession({ id: 'a_test', name: '出去走走', minutes: 10 }, 'direct')

const state = repository.getState()
if (!state || typeof state !== 'object') throw new Error('状态不再是对象')
if (state.wishes[0].text !== '想看看秋天的海') throw new Error('想做清单保存失败')
if (state.reviews.length !== 1 || state.reviews[0].period !== 'week') throw new Error('回望保存失败')
if (!state.pendingAction || state.pendingAction.backgroundedAt !== 0) throw new Error('直接去做不应立即标记为已离开小程序')
repository.markPendingActionBackgrounded()
if (!repository.getState().pendingAction.backgroundedAt) throw new Error('进入后台后应记录待行动的离开时间')
if (scheduledCollections[0].join(',') !== 'wishes') throw new Error('想做清单不应触发全量云同步')
if (scheduledCollections[1].join(',') !== 'reviews') throw new Error('回望不应触发全量云同步')

repository.update((value) => { value.activeSession = { id: 'local-only' } })
if (scheduledCollections.length !== 2) throw new Error('仅本地状态不应触发云同步')

repository.saveState(repository.getState(), { sync: false })
if (scheduledCollections.length !== 2) throw new Error('云端恢复不应再次回写云端')

storage.set('feng_yue_state_v1', 1)
const recovered = repository.ensureState()
if (!recovered || typeof recovered !== 'object' || recovered.version !== 3) throw new Error('损坏状态恢复失败')

console.log('仓储回归通过：增量同步、云端恢复、回望保存及损坏状态恢复。')
