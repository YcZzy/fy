const assert = require('node:assert/strict')
const path = require('node:path')
const { fixture } = require('./helpers/cloud-fixture')
const root = path.resolve(__dirname, '..')
const storage = new Map()
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const originalTimers = { setTimeout, setInterval, clearTimeout, clearInterval }
global.setTimeout = () => 1; global.setInterval = () => 1
global.clearTimeout = () => {}; global.clearInterval = () => {}
global.wx = {
  getStorageSync: (key) => copy(storage.get(key)), setStorageSync: (key, value) => storage.set(key, copy(value)),
  showToast() {}, showModal() {}, showActionSheet() {}, navigateBack() {}, navigateTo() {}, redirectTo() {}, switchTab() {},
  setNavigationBarColor() {}, setBackgroundColor() {}, removeSavedFile() {},
  saveFile({ tempFilePath, success }) { success({ savedFilePath: 'saved/' + tempFilePath }) }
}
const repo = require('../miniprogram/services/repository')
const ai = require('../miniprogram/services/ai')
const sync = require('../miniprogram/services/sync')
const cloud = require('../miniprogram/services/cloud')
const recommender = require('../miniprogram/services/recommender')
const originalAI = { ...ai }
let count = 0
function page(name) {
  let definition
  global.Page = (value) => { definition = value }
  const file = path.join(root, 'miniprogram/pages', name, 'index.js')
  delete require.cache[require.resolve(file)]; require(file)
  const p = { ...definition, data: copy(definition.data) }
  p.setData = function (values, callback) {
    for (const [key, value] of Object.entries(values)) {
      const keys = key.split('.'); let target = this.data
      for (const part of keys.slice(0, -1)) target = target[part] ||= {}
      target[keys.at(-1)] = value
    }
    if (callback) callback()
  }
  return p
}
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done }); return { promise, resolve } }
function connect(server = fixture()) {
  wx.cloud = {
    callFunction: async ({ data }) => ({ result: await server.call(data) }),
    deleteFile: async ({ fileList }) => ({ fileList: fileList.map((fileID) => ({ fileID, status: 0 })) }),
    getTempFileURL: async ({ fileList }) => ({ fileList: fileList.map((fileID) => ({ fileID, tempFileURL: 'https://test.invalid/photo' })) }),
    uploadFile: async ({ cloudPath }) => ({ fileID: 'cloud://test/' + cloudPath })
  }
  sync.initialize(); return server
}
async function test(name, run) {
  sync.reset(); storage.clear(); delete wx.cloud; Object.assign(ai, originalAI)
  wx.showModal = () => {}; repo.ensureState()
  await run(); count += 1; console.log('通过：' + name)
}
function addTestAction(overrides = {}) {
  repo.saveAction({ id: 'test-action', name: '用户添加的行动', domainId: '', minutes: 10, ...overrides })
  return repo.getState().actions.find(item => item.id === (overrides.id || 'test-action'))
}
async function main() {
  await test('R01 本地模式三个主页面完整执行', async () => {
    repo.completeOnboarding([], '')
    for (const name of ['now', 'moon', 'footprints']) { const p = page(name); await p.onShow(); if (p.onHide) p.onHide() }
  })
  await test('R02 编辑历史足迹保留当前计时', () => {
    repo.addFootprint({ id: 'old', actionId: 'a_song', actionName: 'Old', minutes: 5 })
    repo.startSession(addTestAction(), 'timer')
    const sessionId = repo.getState().activeSession.id
    repo.saveFootprint({ id: 'old', note: 'Edited' })
    assert.equal(repo.getState().activeSession.id, sessionId)
  })
  await test('R03 暂停三十分钟不消耗提醒剩余时间', () => {
    const real = Date.now; let now = 1800000000000; Date.now = () => now
    try {
      repo.startSession({ id: 'a', name: 'Ten minutes', minutes: 10 }, 'timer', { reminder: true })
      now += 2 * 60000; repo.pauseSession(); now += 30 * 60000; repo.resumeSession()
      const s = repo.getState().activeSession
      assert.equal(s.expectedEndAt - now, 8 * 60000); assert.equal(now - s.startedAt, 2 * 60000)
    } finally { Date.now = real }
  })
  await test('R04 新行动不会覆盖尚未处理的直接行动', () => {
    repo.startSession({ id: 'a', name: 'First', minutes: 10 }, 'direct')
    assert.throws(() => repo.startSession({ id: 'b', name: 'Second', minutes: 10 }, 'direct'), /SESSION_ALREADY_ACTIVE/)
    assert.equal(repo.getState().pendingAction.actionId, 'a')
  })
  await test('R05 关闭一次追问后仍能主动记录', () => {
    repo.startSession({ id: 'a', name: 'First', minutes: 10 }, 'direct')
    const p = page('now'); p.promptPending(repo.getState().pendingAction); p.refresh()
    assert.equal(p.data.pendingAction.actionId, 'a')
    let destination; wx.navigateTo = ({ url }) => { destination = url }; p.openPending()
    assert.match(destination, /mode=direct/)
  })
  await test('R06 未做与未知时长不计作参与和零分钟', () => {
    repo.addFootprint({ actionId: 'a_song', actionName: 'Never performed', domainId: 'rest', minutes: null, completionStatus: 'not_started' })
    const p = page('footprints'); p.calculateStats()
    assert.equal(p.data.stats.participatedCount, 0); assert.equal(p.data.stats.notStartedCount, 1)
    assert.equal(p.data.stats.totalDuration, '未记录时长'); assert.notEqual(p.data.stats.favorite, 'Never performed')
  })
  await test('R07 更改推荐条件后忽略迟到响应', async () => {
    const d = deferred(); ai.recommend = () => d.promise
    const p = page('now'); const request = p.generate(); p.updateContext('minutes', 10)
    d.resolve({ items: [{ id: 'stale', name: 'Thirty minutes', minutes: 30 }] }); await request
    assert.equal(p.data.context.minutes, 10); assert.equal(p.data.recommendations.length, 0); assert.equal(p.data.generating, false)
  })
  await test('R08 AI 复用既有行动身份并去重', () => {
    addTestAction(); const state = repo.getState(); const raw = [{ name: state.actions[0].name, domainId: 'health', minutes: 20 }]
    const a = recommender.normalizeAiRecommendations([...raw, ...raw], state, state.preferences.lastContext)
    const b = recommender.normalizeAiRecommendations(raw, state, state.preferences.lastContext)
    assert.equal(a.length, 1); assert.equal(a[0].id, state.actions[0].id); assert.equal(b[0].id, a[0].id)
  })
  await test('R09 详情保留本次推荐原因', () => {
    const action = addTestAction()
    repo.saveRecommendations([{ ...action, reason: 'Specific context reason' }], 'test', 'rule')
    const p = page('action'); p.onLoad({ id: action.id }); p.load()
    assert.equal(p.data.action.reason, 'Specific context reason')
  })
  await test('R10 回顾切换周期后仍按请求时的日期保存', async () => {
    repo.addFootprint({ actionName: 'Sample', domainId: 'rest', minutes: 10 })
    const p = page('footprints'); const d = deferred(); ai.review = () => d.promise
    const request = p.generateReview(); const originalRange = p.range()
    p.setPeriod({ currentTarget: { dataset: { value: 'month' } } })
    d.resolve({ content: 'Weekly review' }); await request
    const saved = repo.getState().reviews[0]
    assert.equal(saved.period, 'week'); assert.equal(saved.rangeStart, originalRange.start); assert.equal(saved.rangeEnd, originalRange.end)
  })
  await test('R11 清空对话不会被在途回复恢复', async () => {
    const p = page('chat'); p.onLoad({}); const d = deferred(); ai.chat = () => d.promise
    p.setData({ input: 'Hello' }); const request = p.send()
    wx.showModal = (options) => options.success({ confirm: true }); p.clearConversation()
    d.resolve({ reply: 'Old response', draft: null }); await request
    assert.equal(p.data.messages.length, 0); assert.equal(repo.getState().conversations.length, 0)
  })
  await test('R12 草稿直接保存保留准备事项与 AI 来源', () => {
    const p = page('chat'); p.onLoad({})
    p.setData({ draft: { type: 'action', name: 'Use headphones', domainId: 'rest', minutes: 10, preparation: 'Headphones' } }); p.saveDraft()
    const action = repo.getState().actions[0]
    assert.equal(action.preparation, 'Headphones'); assert.equal(action.source, 'ai'); assert.ok(p.data.savedTarget.id)
  })
  await test('R13 新设备恢复云端偏好', async () => {
    const server = connect()
    await server.seed('user_preferences', { localId: 'preferences', _openid: 'user-a', onboardingComplete: true, selectedInterests: ['阅读'], updatedAt: Date.now() - 86400000 })
    await sync.bootstrap(['preferences'])
    assert.equal(repo.getState().preferences.onboardingComplete, true); assert.deepEqual(repo.getState().preferences.selectedInterests, ['阅读'])
  })
  await test('R14 删除会清掉旧待同步快照', async () => {
    const server = connect(); repo.addWish('PRIVATE_SENTINEL')
    const result = await cloud.deleteAllPersonalData(); repo.deleteAllPersonalData(result.epoch); await sync.flush()
    assert.equal(server.rows('wishes').length, 0); assert.equal(repo.getState().wishes.length, 0)
  })
  await test('分批删除中断后保留本机数据，重试自动续删到完成', async () => {
    const server = connect(fixture({ bulkRemoveLimit: 10 })); repo.addWish('keep-local-until-done')
    for (let index = 0; index < 31; index += 1) await server.seed('actions', { id: 'batch-' + index, _openid: 'user-a' })
    const originalCall = wx.cloud.callFunction
    let calls = 0
    wx.cloud.callFunction = async options => {
      if (options.data.action === 'deleteAll' && ++calls === 2) throw new Error('simulated timeout')
      return originalCall(options)
    }
    await assert.rejects(cloud.deleteAllPersonalData(), /simulated timeout/)
    assert.equal(repo.getState().deletionPending, true)
    assert.equal(repo.getState().wishes[0].text, 'keep-local-until-done')
    assert.equal(server.rows('actions').length, 21)
    assert.equal(server.rows('sync_control')[0].deleting, true)
    wx.cloud.callFunction = originalCall
    const result = await cloud.deleteAllPersonalData()
    assert.equal(result.deleted, true); assert.equal(result.epoch, 1)
    repo.deleteAllPersonalData(result.epoch)
    assert.equal(repo.getState().deletionPending, false)
    assert.equal(server.rows('actions').length, 0)
  })
  await test('在途推送结束后删除，旧请求不能重新出现', async () => {
    const server = connect(); const ready = deferred(), release = deferred(); const originalCall = wx.cloud.callFunction
    wx.cloud.callFunction = async (options) => { if (options.data.action === 'sync') { ready.resolve(); await release.promise } return originalCall(options) }
    repo.addWish('in-flight'); const pushing = sync.flush(); await ready.promise
    const deleting = cloud.deleteAllPersonalData(); release.resolve(); await pushing
    const result = await deleting; repo.deleteAllPersonalData(result.epoch); await sync.flush()
    assert.equal(server.rows('wishes').length, 0); assert.equal(repo.getState().wishes.length, 0)
  })
  await test('旧设备看到重置版本后清空旧数据', async () => {
    const server = connect(); repo.addWish('old device')
    const begin = await server.call({ action: 'beginDelete', requestId: 'another-device' })
    await server.call({ action: 'deleteAll', confirm: 'DELETE_MY_DATA', requestId: begin.requestId, epoch: begin.epoch })
    await sync.bootstrap(); assert.equal(repo.getState().wishes.length, 0); assert.equal(repo.getState().cloudEpoch, 1)
  })
  await test('照片失败保留本机，重试后补上传', async () => {
    connect(); wx.cloud.uploadFile = async () => { throw new Error('offline') }
    const photo = await cloud.persistPhoto('temporary.jpg', 'photo-record')
    assert.ok(photo.localPath); assert.equal(photo.fileId, '')
    repo.addFootprint({ id: 'photo-record', actionName: 'Photo', localPhotoPaths: [photo.localPath], photoFileIds: [] })
    wx.cloud.uploadFile = async () => ({ fileID: 'cloud://recovered' })
    await cloud.flushPendingUploads(); assert.deepEqual(repo.getState().footprints[0].photoFileIds, ['cloud://recovered'])
  })
  await test('云端历史可以直接恢复到新设备', async () => {
    const server = connect(); await server.seed('ai_conversations', { _openid: 'user-a', id: 'old-conversation', localId: 'old-conversation', title: 'History', messages: [], updatedAt: 100 })
    await sync.bootstrap(['conversations']); assert.equal(repo.getState().conversations[0].id, 'old-conversation')
  })
  await test('新用户和删除后重启均无预设个人数据', async () => {
    const keys = ['domains', 'actions', 'plans', 'wishes', 'footprints', 'reviews', 'conversations']
    const assertEmpty = () => keys.forEach(key => assert.deepEqual(repo.getState()[key], [], key))
    assertEmpty()
    const onboarding = page('onboarding'); onboarding.onLoad({}); onboarding.refreshPreview()
    assert.deepEqual(onboarding.data.previewActions, [])
    onboarding.skip(); assertEmpty()
    addTestAction(); repo.addWish('主动填写的愿望')
    repo.deleteAllPersonalData(7); assertEmpty()
    const restarted = repo.ensureState()
    assert.equal(restarted.cloudEpoch, 7); assert.deepEqual(restarted.syncQueue, [])
    assert.equal(restarted.recommendationCache, null)
    assert.deepEqual(restarted.preferences.selectedInterests, [])
    const server = connect(); await sync.flush()
    assert.equal(server.rows('actions').length, 0); assert.equal(server.rows('life_domains').length, 0)
  })
  await test('空数据下可创建首个行动和计划且不会生成默认板块', () => {
    const action = page('action-editor'); action.onLoad({})
    assert.equal(repo.getState().actions.length, 0)
    assert.equal(action.data.action.domainId, '')
    action.onName({ detail: { value: '第一件想做的事' } }); action.save()
    const plan = page('plan'); plan.onLoad({}); plan.onName({ detail: { value: '第一个计划' } }); plan.save()
    assert.equal(repo.getState().actions.length, 1); assert.equal(repo.getState().plans.length, 1)
    assert.equal(repo.getState().domains.length, 0)
  })
  await test('新计划一次流程可关联行动，重复保存不重复创建', () => {
    addTestAction()
    const p = page('plan'); p.onLoad({}); p.onName({ detail: { value: '整理体验' } })
    assert.ok(p.data.actions.length)
    p.toggleActionLink({ currentTarget: { dataset: { id: p.data.actions[0].id } } }); p.save(); p.save()
    assert.equal(repo.getState().plans.length, 1); assert.equal(repo.getState().plans[0].actionIds.length, 1); assert.equal(p.data.isNew, false)
  })
  await test('计时进入记录页被冻结；保存只结束对应会话', async () => {
    const action = addTestAction(); repo.startSession(action, 'timer')
    const p = page('record'); p.onLoad({ actionId: action.id, mode: 'timer' })
    assert.equal(repo.getState().activeSession.status, 'paused')
    await p.save(); await p.save()
    assert.equal(repo.getState().activeSession, null); assert.equal(repo.getState().footprints.length, 1)
  })
  await test('历史足迹保留当时名称，补记可选择过去日期', async () => {
    repo.addFootprint({ id: 'old', actionId: 'a_song', actionName: 'Old name', domainId: 'rest', domainName: 'Rest', minutes: null })
    addTestAction({ id: 'a_song', name: 'New name' })
    const p = page('record'); p.onLoad({ footprintId: 'old', actionId: 'a_song', mode: 'edit' })
    assert.equal(p.data.action.name, 'Old name'); p.onDate({ detail: { value: '2026-01-02' } }); await p.save()
    assert.equal(require('../miniprogram/services/format').dateKey(repo.getState().footprints[0].createdAt), '2026-01-02')
  })
  await test('草稿修改取消后可恢复，保存后才清除', () => {
    const p = page('chat'); p.onLoad({}); const draft = { id: 'draft-a', type: 'action', name: 'Draft', domainId: 'rest', minutes: 10, conversationId: p.conversation.id }
    p.finishMessage([{ role: 'user', content: 'Draft please' }], draft); p.editDraft()
    assert.equal(repo.getState().conversations[0].draft.id, 'draft-a')
    const editor = page('action-editor'); editor.onLoad({ draft: encodeURIComponent(JSON.stringify(draft)) }); editor.save()
    assert.equal(repo.getState().conversations[0].draft, null)
  })
  await test('丢失云响应协议时保留本机数据，不误报同步成功', async () => {
    connect(); wx.cloud.callFunction = async () => ({ result: { code: 0, data: {} } })
    repo.addWish('keep local'); await assert.rejects(sync.flush(), /dataManager/)
    assert.equal(repo.getState().wishes[0].text, 'keep local'); assert.ok(repo.getState().syncQueue.length); assert.equal(sync.getStatus().state, 'error')
  })
  await test('设置清空历史后，返回旧聊天页面不会恢复消息', async () => {
    const p = page('chat'); p.onLoad({}); p.finishMessage([{ role: 'user', content: 'Private history' }], null)
    const oldId = p.conversation.id; p.onHide(); repo.clearConversations(); p.onShow()
    await Promise.resolve()
    assert.equal(p.data.messages.length, 0); assert.notEqual(p.conversation.id, oldId); assert.equal(repo.getState().conversations.length, 0)
    p.onHide()
  })
  await test('照片删除失败保留删除进度，重试成功后才允许重置', async () => {
    const server = connect(); repo.addFootprint({ id: 'private-photo', actionName: 'Photo', photoFileIds: ['cloud://private'] })
    await sync.flush()
    const originalDelete = wx.cloud.deleteFile
    wx.cloud.deleteFile = async () => ({ fileList: [{ fileID: 'cloud://private', status: -1 }] })
    await assert.rejects(cloud.deleteAllPersonalData(), /CLOUD_FILE_DELETE_INCOMPLETE/)
    assert.equal(repo.getState().deletionPending, true); assert.equal(repo.getState().footprints.length, 1)
    assert.equal(server.rows('sync_control')[0].deleting, true); assert.equal(server.rows('footprints').length, 1)
    assert.throws(() => repo.addWish('must not sync'), /PERSONAL_DATA_DELETION_PENDING/)
    wx.cloud.deleteFile = originalDelete
    const result = await cloud.deleteAllPersonalData(); repo.deleteAllPersonalData(result.epoch)
    assert.equal(server.rows('footprints').length, 0); assert.equal(repo.getState().deletionPending, false)
  })
  await test('数据重置后旧计划编辑页不能重新保存内容', () => {
    const p = page('plan'); p.onLoad({}); p.onName({ detail: { value: 'Old private plan' } })
    repo.deleteAllPersonalData(1); p.save()
    assert.equal(repo.getState().plans.length, 0)
  })
  await test('同步过程中继续修改，保留新内容并在下一次上传', async () => {
    const server = connect(); const ready = deferred(), release = deferred(); const originalCall = wx.cloud.callFunction
    let held = false
    wx.cloud.callFunction = async (options) => {
      if (options.data.action === 'sync' && !held) { held = true; ready.resolve(); await release.promise }
      return originalCall(options)
    }
    repo.addWish('first'); const pushing = sync.flush(); await ready.promise
    repo.addWish('second'); release.resolve(); await pushing
    assert.equal(repo.getState().wishes.length, 2); assert.ok(repo.getState().syncQueue.length)
    await sync.flush()
    assert.equal(server.rows('wishes').length, 2); assert.equal(repo.getState().syncQueue.length, 0)
  })
  await test('相同时间的删除标记优先，推送后吸收其他设备的新内容', async () => {
    const merged = sync.mergeCollection([{ id: 'same', updatedAt: 100 }], [{ id: 'same', _deleted: true, updatedAt: 100 }])
    assert.equal(merged.items.length, 0); assert.equal(merged.tombstones.same, 100)
    const server = connect(); await server.seed('wishes', { id: 'remote', localId: 'remote', _openid: 'user-a', text: 'Another device', updatedAt: 100 })
    repo.addWish('Local'); await sync.flush()
    assert.equal(repo.getState().wishes.length, 2); assert.equal(repo.getState().syncQueue.length, 0)
    const revision = server.rows('sync_control')[0].revision
    sync.schedule(repo.getState(), ['wishes']); await sync.flush()
    assert.equal(server.rows('sync_control')[0].revision, revision)
  })
  console.log(`页面与完整流程回归通过：${count} 个场景。`)
}
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => Object.assign(global, originalTimers))
