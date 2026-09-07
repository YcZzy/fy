const assert = require('node:assert/strict')
const { fixture } = require('./helpers/cloud-fixture')

async function main() {
  const server = fixture()
  const call = server.call
  const load = await call({ action: 'load' })
  assert.equal(load.protocol, 2); assert.equal(load.epoch, 0)
  await server.seed('wishes', { id: 'b-private', localId: 'b-private', _openid: 'user-b', text: 'B only' })
  const push = { action: 'sync', epoch: 0, collection: 'wishes', documents: [{ id: 'a-private', text: 'A only', updatedAt: 10, _openid: 'user-b' }] }
  assert.equal((await call(push)).code, 0)
  const own = await call({ action: 'load', collections: ['wishes'] })
  assert.equal(own.data.wishes.length, 1)
  assert.equal(own.data.wishes[0]._openid, 'user-a')
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
      const cursor = value.where(query); const get = cursor.get
      cursor.get = async () => { if (!held) { held = true; reached(); await gate } return get.call(cursor) }
      return cursor
    } }
  }
  const deletion = { action: 'deleteAll', epoch: 1, requestId: 'duplicate', confirm: 'DELETE_MY_DATA' }
  const slow = duplicate.call(deletion); await paused
  assert.equal((await duplicate.call(deletion)).deleted, true)
  assert.equal((await duplicate.call({ action: 'sync', epoch: 1, collection: 'wishes', documents: [{ id: 'new', text: 'After reset' }] })).code, 0)
  release(); assert.equal((await slow).deleted, true)
  assert.equal(duplicate.rows('wishes')[0].text, 'After reset')
  console.log('云端协议回归通过：身份隔离、旧版本拒写、删除幂等、并发删除保留重置后新数据和最小文件权限。')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
