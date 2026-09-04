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

async function main() {
  if (!sync.sameDocument(remote, unchanged)) throw new Error('仅云端元数据变化时不应 update')
  if (sync.sameDocument(remote, changed)) throw new Error('业务字段变化时必须 update')

  const documents = Array.from({ length: 205 }, (_, index) => ({ _id: String(index), _openid: 'private-user', localId: `f_${index}` }))
  wx.cloud.database = () => ({
    collection: () => ({
      where: () => {
        let offset = 0
        let limit = 100
        return {
          skip(value) { offset = value; return this },
          limit(value) { limit = value; return this },
          async get() { return { data: documents.slice(offset, offset + limit) } }
        }
      }
    })
  })
  const all = await sync.ownDocuments('footprints')
  if (all.length !== 205) throw new Error('云同步必须分页读取全部远端记录')

  console.log('云同步回归通过：相同文档不重复更新，远端记录完整分页。')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
