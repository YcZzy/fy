const assert = require('node:assert/strict')
const { fixture } = require('./helpers/cloud-fixture')

async function main() {
  const server = fixture()
  const call = server.call
  const load = await call({ action: 'load' })
  assert.equal(load.protocol, 2); assert.equal(load.epoch, 0)
  await server.seed('wishes', { id: 'b-private', localId: 'b-private', _openid: 'user-b', text: 'B only' })
  const push = { action: 'sync', epoch: 0, collection: 'wishes', documents: [{ id: 'a-private', text: 'A only', updatedAt: 10, _openid: 'user-b', syncEpoch: 999 }] }
  assert.equal((await call(push)).code, 0)
  const own = await call({ action: 'load', collections: ['wishes'] })
  assert.equal(own.data.wishes.length, 1)
  assert.equal(own.data.wishes[0]._openid, 'user-a')
  assert.equal(own.data.wishes[0].syncEpoch, 0, 'client cannot forge the version used for deletion')
  await call({ ...push, documents: [{ id: 'a-private', text: 'Stale', updatedAt: 5 }] })
  assert.equal((await call({ action: 'load', collections: ['wishes'] })).data.wishes[0].text, 'A only')
  assert.notEqual((await call({ ...push, collection: 'sync_control' })).code, 0)
  // Deletion fences new writes before it enumerates files or removes documents.
  await server.seed('footprints', { _openid: 'user-a', photoFileIds: ['cloud://owned-by-caller'] })
  const begin = await call({ action: 'beginDelete', requestId: 'delete-a' })
  assert.equal(begin.epoch, 1); assert.deepEqual(begin.fileIds, ['cloud://owned-by-caller'])
  assert.notEqual((await call(push)).code, 0)
  assert.notEqual((await call({ action: 'deleteAll', epoch: 1, requestId: 'wrong', confirm: 'DELETE_MY_DATA' })).code, 0)
  const retry = await call({ action: 'beginDelete', requestId: 'delete-a' })
  assert.equal(retry.epoch, 1)
  const finish = { action: 'deleteAll', epoch: 1, requestId: 'delete-a', confirm: 'DELETE_MY_DATA' }
  assert.equal((await call(finish)).deleted, true)
  assert.equal((await call(finish)).deleted, true)
  assert.equal(server.rows('wishes').length, 1)
  assert.equal(server.rows('wishes')[0]._openid, 'user-b')
  assert.equal(server.rows('footprints').length, 0)
  assert.equal(server.adminDeletes.length, 0)
  assert.notEqual((await call(push)).code, 0, 'old devices cannot upload into the new epoch')
  assert.equal((await call({ ...push, epoch: 1 })).code, 0)
  const other = await call({ action: 'load' }, 'user-b')
  assert.equal(other.epoch, 0); assert.equal(other.data.wishes[0].text, 'B only')
  // Simultaneous reset and sync serialize on the control document.
  const racing = fixture()
  await racing.call({ action: 'load' })
  await Promise.all([
    racing.call({ action: 'sync', epoch: 0, collection: 'wishes', documents: [{ id: 'race', text: 'old write' }] }),
    racing.call({ action: 'beginDelete', requestId: 'race-delete' })
  ])
  await racing.call({ action: 'deleteAll', epoch: 1, requestId: 'race-delete', confirm: 'DELETE_MY_DATA' })
  assert.equal(racing.rows('wishes').length, 0)
  const duplicate = fixture()
  await duplicate.call({ action: 'load' })
  await duplicate.seed('wishes', { id: 'old', localId: 'old', text: 'Old', _openid: 'user-a' })
  await duplicate.call({ action: 'beginDelete', requestId: 'duplicate' })
  const collection = duplicate.db.collection
  let release, reached, held = false
  const paused = new Promise(resolve => { reached = resolve })
  const gate = new Promise(resolve => { release = resolve })
  duplicate.db.collection = function (name) {
    const value = collection(name)
    if (name !== 'wishes') return value
    return { ...value, where(query) {
      const cursor = value.where(query); const remove = cursor.remove
      cursor.remove = async () => { if (!held) { held = true; reached(); await gate } return remove.call(cursor) }
      return cursor
    } }
  }
  const deletion = { action: 'deleteAll', epoch: 1, requestId: 'duplicate', confirm: 'DELETE_MY_DATA' }
  const slow = duplicate.call(deletion); await paused
  assert.equal((await duplicate.call(deletion)).deleted, true)
  assert.equal((await duplicate.call({ action: 'sync', epoch: 1, collection: 'wishes', documents: [{ id: 'old', text: 'After reset' }] })).code, 0)
  release(); assert.equal((await slow).deleted, true)
  assert.equal(duplicate.rows('wishes')[0].text, 'After reset')
  // Request count is independent of document count: no per-document delete/read.
  const large = fixture()
  for (let index = 0; index < 1500; index += 1) await large.seed('actions', { id: 'large-' + index, _openid: 'user-a', ...(index % 2 ? { syncEpoch: 0 } : {}) })
  await large.seed('actions', { id: 'other-owner', _openid: 'user-b' })
  await large.call({ action: 'beginDelete', requestId: 'large' })
  const largeDelete = { action: 'deleteAll', confirm: 'DELETE_MY_DATA', requestId: 'large', epoch: 1 }
  const before = { ...large.operations }
  assert.equal((await large.call(largeDelete)).deleted, true)
  assert.deepEqual(large.rows('actions').map(item => item.id), ['other-owner'])
  assert.equal(large.operations.bulkRemoves - before.bulkRemoves, 9)
  assert.equal(large.operations.documentRemoves - before.documentRemoves, 0)
  assert.equal(large.operations.documentReads - before.documentReads, 4)
  assert.equal(large.operations.transactions - before.transactions, 4)
  assert.equal((await large.call(largeDelete)).deleted, true)
  assert.equal((await large.call({ action: 'beginDelete', requestId: 'next-deletion' })).epoch, 2)
  assert.deepEqual(large.rows('sync_control')[0].deleteCompletedCollections, [])

  // A limited bulk result must never be treated as complete; retries reuse the epoch.
  const limited = fixture({ bulkRemoveLimit: 10 })
  for (let index = 0; index < 37; index += 1) await limited.seed('actions', { id: 'limited-' + index, _openid: 'user-a' })
  await limited.call({ action: 'beginDelete', requestId: 'large' })
  let result = await limited.call(largeDelete), attempts = 0
  assert.equal(result.pending, true); assert.equal(result.deleted, false)
  assert.equal(limited.rows('actions').length, 27)
  assert.equal(limited.rows('sync_control')[0].deleting, true)
  assert.notEqual((await limited.call({ ...push, epoch: 1 })).code, 0)
  const resumed = await limited.call({ action: 'beginDelete', requestId: 'new-local-request' })
  assert.equal(resumed.requestId, 'large'); assert.equal(resumed.epoch, 1)
  while (!result.deleted && attempts++ < 10) result = await limited.call(largeDelete)
  assert.equal(result.deleted, true); assert.ok(attempts > 1)
  assert.equal(limited.rows('actions').length, 0)

  // Slow database work checkpoints completed collections for the next invocation.
  const slowDatabase = fixture()
  await slowDatabase.call({ action: 'beginDelete', requestId: 'slow' })
  const transact = slowDatabase.db.runTransaction, now = Date.now
  let clock = 0
  slowDatabase.db.runTransaction = async fn => { const value = await transact(fn); clock += 2000; return value }
  Date.now = () => clock
  let partial
  try { partial = await slowDatabase.call({ ...largeDelete, requestId: 'slow' }) }
  finally { Date.now = now; slowDatabase.db.runTransaction = transact }
  assert.equal(partial.pending, true)
  assert.equal(slowDatabase.rows('sync_control')[0].deleteCompletedCollections.length, 6)
  assert.equal((await slowDatabase.call({ ...largeDelete, requestId: 'slow' })).deleted, true)
  console.log('云端协议回归通过：身份隔离、旧版本拒写、删除幂等、并发删除保留重置后新数据和最小文件权限。')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
