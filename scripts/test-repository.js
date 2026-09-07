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
if (!state.syncQueue.some((item) => item.collection === 'wishes')) throw new Error('待同步任务必须持久化')
repository.markPendingActionBackgrounded()
if (!repository.getState().pendingAction.backgroundedAt) throw new Error('进入后台后应记录待行动的离开时间')
if (scheduledCollections[0].join(',') !== 'wishes') throw new Error('想做清单不应触发全量云同步')
if (scheduledCollections[1].join(',') !== 'reviews') throw new Error('回望不应触发全量云同步')

repository.update((value) => { value.activeSession = { id: 'local-only' } })
if (scheduledCollections.length !== 2) throw new Error('仅本地状态不应触发云同步')

repository.saveState(repository.getState(), { sync: false })
if (scheduledCollections.length !== 2) throw new Error('云端恢复不应再次回写云端')

repository.saveAction({ id: 'a_delete_test', name: '待删除行动', domainId: 'daily', minutes: 10 })
repository.savePlan({ id: 'p_link_test', name: '整理体验', domainId: 'daily', status: 'active', focused: true, actionIds: [] })
repository.savePlan({ id: 'p_link_test_2', name: '另一个整理体验', domainId: 'daily', status: 'want', focused: false, actionIds: [] })
repository.savePlan({ id: 'p_other_domain', name: '身体体验', domainId: 'health', status: 'active', focused: false, actionIds: [] })
repository.saveActionWithPlans({ id: 'a_link_test', name: '收拾桌面', domainId: 'daily', minutes: 10 }, ['p_link_test', 'p_link_test_2', 'p_other_domain'])
const linkedState = repository.getState()
if (!linkedState.actions.some((item) => item.id === 'a_link_test')) throw new Error('计划中新建的行动必须进入行动库')
if (!linkedState.plans.find((item) => item.id === 'p_link_test').actionIds.includes('a_link_test')) throw new Error('行动与计划关联失败')
if (!linkedState.plans.find((item) => item.id === 'p_link_test_2').actionIds.includes('a_link_test')) throw new Error('行动应支持关联多个计划')
if (linkedState.plans.find((item) => item.id === 'p_other_domain').actionIds.includes('a_link_test')) throw new Error('不同板块的计划与行动不能关联')
if (linkedState.actions.find((item) => item.id === 'a_link_test').planId) throw new Error('行动库不应保存单一计划外键')
repository.addFootprint({ id: 'f_delete_test', actionId: 'a_delete_test', actionName: '待删除行动', minutes: 10 })
repository.saveRecommendations([{ id: 'a_delete_test' }], 'test', 'rule')
repository.deleteAction('a_delete_test')
const stateAfterActionDelete = repository.getState()
if (stateAfterActionDelete.actions.some((item) => item.id === 'a_delete_test')) throw new Error('行动删除失败')
if (!stateAfterActionDelete.footprints.some((item) => item.id === 'f_delete_test')) throw new Error('删除行动不应删除历史足迹')
if (!stateAfterActionDelete.syncTombstones.actions.a_delete_test) throw new Error('删除行动必须保留同步删除标记')
if (stateAfterActionDelete.recommendationCache) throw new Error('行动变化后必须清除首页推荐缓存')

repository.deleteAction('a_link_test')
if (repository.getState().plans.some((item) => (item.actionIds || []).includes('a_link_test'))) throw new Error('删除行动后必须清理全部计划关联')
repository.deleteAction('a_walk')
if (repository.getState().actions.some((item) => item.id === 'a_walk')) throw new Error('已删除的默认行动不应被状态规范化重新加入')

storage.set('feng_yue_state_v1', {
  version: 3,
  preferences: { onboardingComplete: true, selectedInterests: [], lastContext: { minutes: 30, energy: 'medium', environment: 'any', note: '', locationSummary: '' } },
  domains: [], actions: [{ id: 'a_legacy', name: '旧行动', domainId: 'daily', minutes: 10, planId: 'p_legacy' }],
  plans: [{ id: 'p_legacy', name: '旧计划', domainId: 'daily', status: 'active' }]
})
const migrated = repository.ensureState()
if (migrated.version !== 4 || !migrated.plans.find((item) => item.id === 'p_legacy').actionIds.includes('a_legacy')) throw new Error('旧计划行动关联迁移失败')
if (Object.prototype.hasOwnProperty.call(migrated.actions.find((item) => item.id === 'a_legacy'), 'planId')) throw new Error('迁移后不应残留行动 planId')

storage.set('feng_yue_state_v1', 1)
const recovered = repository.ensureState()
if (!recovered || typeof recovered !== 'object' || recovered.version !== 4) throw new Error('损坏状态恢复失败')

console.log('仓储回归通过：增量同步、云端恢复、回望保存及损坏状态恢复。')
