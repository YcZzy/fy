// Audit-only probes. Uses in-memory wx mocks; never connects to WeChat or CloudBase.
// Historical defect probes for baseline 5a10abb. These assert OLD bugs and are
// expected to fail after fixes. Run `npm run check` for current acceptance tests.
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const root = path.resolve(__dirname, '../..')
const storage = new Map()
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const timer = global.setTimeout
const interval = global.setInterval
global.setTimeout = () => 1
global.setInterval = () => 1
global.wx = {
  getStorageSync: key => copy(storage.get(key)),
  setStorageSync: (key, value) => storage.set(key, copy(value)),
  showToast() {}, showModal() {}, showActionSheet() {}, navigateBack() {},
  navigateTo() {}, redirectTo() {}, switchTab() {},
  setNavigationBarColor() {}, setBackgroundColor() {}
}
const repo = require(path.join(root, 'miniprogram/services/repository'))
const ai = require(path.join(root, 'miniprogram/services/ai'))
const sync = require(path.join(root, 'miniprogram/services/sync'))
const cloud = require(path.join(root, 'miniprogram/services/cloud'))
const recommender = require(path.join(root, 'miniprogram/services/recommender'))
const originalAI = { ...ai }
const results = []
function reset() { storage.clear(); delete wx.cloud; Object.assign(ai, originalAI); repo.ensureState() }
function page(name) {
  let definition
  global.Page = value => { definition = value }
  const file = path.join(root, 'miniprogram/pages', name, 'index.js')
  delete require.cache[require.resolve(file)]
  require(file)
  const instance = { ...definition, data: copy(definition.data) }
  instance.setData = function (values, callback) {
    for (const [key, value] of Object.entries(values)) {
      const keys = key.split('.')
      let target = this.data
      for (const part of keys.slice(0, -1)) target = target[part] ||= {}
      target[keys.at(-1)] = value
    }
    if (callback) callback()
  }
  return instance
}
async function probe(id, title, run) {
  reset()
  const evidence = await run()
  results.push({ id, title, reproduced: true, evidence })
  console.log(`${id}: ${title} — ${JSON.stringify(evidence)}`)
}
async function main() {
  await probe('R01', 'Local-mode onShow throws on all three tabs', () => {
    repo.completeOnboarding([], '')
    const errors = {}
    for (const name of ['now', 'moon', 'footprints']) {
      try { page(name).onShow() } catch (error) { errors[name] = error.message }
      assert.match(errors[name], /then/)
    }
    return errors
  })
  await probe('R02', 'Editing an old footprint clears an unrelated timer', () => {
    repo.addFootprint({ id: 'old', actionId: 'a_song', actionName: 'Old', minutes: 5 })
    repo.startSession(repo.getState().actions[0], 'timer')
    assert.ok(repo.getState().activeSession)
    repo.saveFootprint({ id: 'old', note: 'Edited' })
    assert.equal(repo.getState().activeSession, null)
    return { activeSessionAfterEdit: repo.getState().activeSession }
  })
  await probe('R03', 'Pausing does not extend reminder deadline', () => {
    const realNow = Date.now
    let now = 1800000000000
    Date.now = () => now
    try {
      repo.startSession({ id: 'a', name: 'Ten minutes', minutes: 10 }, 'timer', { reminder: true })
      now += 2 * 60000; repo.pauseSession()
      now += 30 * 60000; repo.resumeSession()
      const s = repo.getState().activeSession
      assert.ok(now >= s.expectedEndAt)
      return { actualActiveMinutes: (now - s.startedAt) / 60000, reminderAlreadyDue: true }
    } finally { Date.now = realNow }
  })
  await probe('R04', 'Second direct action silently replaces the first', () => {
    repo.startSession({ id: 'a', name: 'First', minutes: 10 }, 'direct')
    repo.startSession({ id: 'b', name: 'Second', minutes: 10 }, 'direct')
    assert.equal(repo.getState().pendingAction.actionId, 'b')
    return { pendingActionId: repo.getState().pendingAction.actionId }
  })
  await probe('R05', 'Dismissing the direct-action prompt consumes the only prompt', () => {
    repo.startSession({ id: 'a', name: 'First', minutes: 10 }, 'direct')
    const p = page('now')
    p.promptPending(repo.getState().pendingAction) // mock sheet is dismissed without success
    assert.equal(repo.getState().pendingAction.prompted, true)
    assert.equal(p.shouldPromptPending(repo.getState().pendingAction), false)
    const markup = fs.readFileSync(path.join(root, 'miniprogram/pages/now/index.wxml'), 'utf8')
    assert.equal(markup.includes('pendingAction'), false)
    return { willPromptAgain: false, pendingEntryInTemplate: false }
  })
  await probe('R06', 'Not-started records become most frequent actions; unknown time becomes zero', () => {
    repo.addFootprint({ actionId: 'a_song', actionName: 'Never performed', domainId: 'rest', domainName: 'Rest', minutes: null, completionStatus: 'not_started' })
    const p = page('footprints'); p.calculateStats()
    assert.equal(p.data.stats.favorite, 'Never performed')
    assert.equal(p.data.stats.totalDuration, '0 分钟')
    return p.data.stats
  })
  await probe('R07', 'Recommendation response uses stale context after selections change', async () => {
    let resolve
    ai.recommend = () => new Promise(done => { resolve = done })
    const p = page('now')
    const request = p.generate()
    p.updateContext('minutes', 10)
    resolve({ items: [{ id: 'stale', name: 'Thirty minute activity', minutes: 30 }] })
    await request
    assert.equal(p.data.context.minutes, 10)
    assert.equal(p.data.recommendations[0].minutes, 30)
    return { selectedMinutes: p.data.context.minutes, displayedMinutes: p.data.recommendations[0].minutes }
  })
  await probe('R08', 'AI recommendation receives a new ID on each generation', () => {
    const state = repo.getState()
    const raw = [{ name: state.actions[0].name, domainId: 'health', minutes: 20 }]
    const a = recommender.normalizeAiRecommendations(raw, state, state.preferences.lastContext)[0]
    const b = recommender.normalizeAiRecommendations(raw, state, state.preferences.lastContext)[0]
    repo.saveAction(a); repo.saveAction(b)
    const count = repo.getState().actions.filter(x => x.name === a.name).length
    assert.equal(count, 3)
    return { sameNameActionCount: count, distinctIds: a.id !== b.id }
  })
  await probe('R09', 'Existing action detail discards recommendation reason', () => {
    const a = repo.getState().actions[0]
    repo.saveRecommendations([{ ...a, reason: 'Specific context reason' }], 'test', 'rule')
    const p = page('action'); p.onLoad({ id: a.id }); p.load()
    assert.equal(p.data.action.reason, undefined)
    return { reasonInCache: 'Specific context reason', reasonInDetail: p.data.action.reason || null }
  })
  await probe('R10', 'Changing review period during request mislabels saved content', async () => {
    repo.addFootprint({ actionName: 'Sample', domainId: 'rest', domainName: 'Rest', minutes: 10 })
    const p = page('footprints'); p.calculateStats()
    let resolve, requestedLabel
    ai.review = (_items, label) => { requestedLabel = label; return new Promise(done => { resolve = done }) }
    const request = p.generateReview()
    p.setPeriod({ currentTarget: { dataset: { value: 'month' } } })
    resolve({ content: 'A weekly review' }); await request
    assert.equal(repo.getState().reviews[0].period, 'month')
    return { requestedLabel, savedPeriod: repo.getState().reviews[0].period }
  })
  await probe('R11', 'Clear conversation during generation is undone by the response', async () => {
    const p = page('chat'); p.onLoad({})
    let resolve
    ai.chat = () => new Promise(done => { resolve = done })
    p.setData({ input: 'Hello' }); const request = p.send()
    wx.showModal = options => options.success({ confirm: true })
    p.clearConversation()
    resolve({ reply: 'Old response', draft: null }); await request
    assert.equal(repo.getState().conversations.length, 1)
    assert.equal(p.data.messages.length, 2)
    wx.showModal = () => {}
    return { messagesAfterClearAndResponse: p.data.messages.length }
  })
  await probe('R12', 'Direct AI draft save loses preparation and source', () => {
    const p = page('chat')
    p.setData({ draft: { type: 'action', name: 'Use headphones', domainId: 'rest', minutes: 10, preparation: 'Headphones' } })
    p.saveDraft()
    const a = repo.getState().actions[0]
    assert.equal(a.preparation, '不需要额外准备')
    assert.equal(a.source, 'user')
    return { preparation: a.preparation, source: a.source }
  })
  await probe('R13', 'New-device default preferences supersede older cloud preferences', async () => {
    const remote = { localId: 'preferences', onboardingComplete: true, selectedInterests: ['阅读'], lastContext: { minutes: 60, energy: 'low', environment: 'home' }, updatedAt: Date.now() - 86400000 }
    wx.cloud = { callFunction: async () => ({ result: { code: 0, data: { user_preferences: [remote] } } }) }
    await sync.bootstrap(['preferences'])
    const p = repo.getState().preferences
    assert.equal(p.onboardingComplete, false)
    assert.deepEqual(p.selectedInterests, [])
    return { cloudInterests: remote.selectedInterests, restoredInterests: p.selectedInterests, restoredOnboarding: p.onboardingComplete }
  })
  await probe('R14', 'Pending sync restores private data after delete-all', async () => {
    const remote = []
    wx.cloud = {
      callFunction: async () => { remote.length = 0; return { result: { code: 0, deleted: true } } },
      database: () => ({ collection: () => ({
        where() { return { skip() { return this }, limit() { return this }, get: async () => ({ data: copy(remote) }) } },
        add: async ({ data }) => { remote.push({ ...copy(data), _id: String(remote.length) }) },
        doc: () => ({ update: async () => {} })
      }) })
    }
    sync.initialize()
    repo.addWish('PRIVATE_AUDIT_SENTINEL')
    await cloud.deleteAllPersonalData()
    repo.deleteAllPersonalData()
    assert.ok(!repo.getState().wishes.some(x => x.text === 'PRIVATE_AUDIT_SENTINEL'))
    await sync.flush()
    assert.ok(remote.some(x => x.text === 'PRIVATE_AUDIT_SENTINEL'))
    assert.ok(repo.getState().wishes.some(x => x.text === 'PRIVATE_AUDIT_SENTINEL'))
    return { deletedWishReuploaded: true, deletedWishRestoredLocally: true }
  })
  fs.writeFileSync(path.join(__dirname, 'reproduction-results.json'), JSON.stringify({ scope: 'Node isolated mocks; no live cloud or native renderer', results }, null, 2) + '\n')
  console.log(`Reproduced ${results.length} findings. These are defect probes, not acceptance tests.`)
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  global.setTimeout = timer; global.setInterval = interval
})
