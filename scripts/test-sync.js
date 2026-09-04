const path = require('path')

global.wx = { cloud: {} }

const sync = require(path.resolve(__dirname, '../miniprogram/services/sync.js'))

const remote = {
  _id: 'remote-id',
  _openid: 'private-user',
  localId: 'a_walk',
  id: 'a_walk',
  name: '散步',
  environments: ['outdoor', 'any'],
  syncedAt: 100
}
const unchanged = {
  name: '散步',
  id: 'a_walk',
  environments: ['outdoor', 'any'],
  localId: 'a_walk',
  syncedAt: 200
}
const changed = { ...unchanged, name: '晚风里散步' }

if (!sync.sameDocument(remote, unchanged)) throw new Error('仅云端元数据变化时不应 update')
if (sync.sameDocument(remote, changed)) throw new Error('业务字段变化时必须 update')

console.log('云同步回归通过：相同文档不会重复 update。')
