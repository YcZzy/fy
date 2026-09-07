const path = require('path')
const Module = require('module')

const cloudServicePath = path.resolve(__dirname, '../miniprogram/services/cloud.js')
const envPath = path.resolve(__dirname, '../miniprogram/config/env.js')
const dataManagerPath = path.resolve(__dirname, '../cloudfunctions/dataManager/index.js')

async function loadCloudService(deleteResult) {
  delete require.cache[cloudServicePath]
  delete require.cache[envPath]
  global.wx = { cloud: { async deleteFile() { return deleteResult } } }
  return require(cloudServicePath)
}

async function runDataManager(deleteResult) {
  const documents = {
    footprints: [{ _id: 'footprint-1', _openid: 'user-1', photoFileIds: ['cloud://photo-a'] }]
  }
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init() {},
    getWXContext() { return { OPENID: 'user-1' } },
    database() {
      return {
        collection(name) {
          return {
            where() {
              let offset = 0
              let limit = 100
              return {
                skip(value) { offset = value; return this },
                limit(value) { limit = value; return this },
                async get() { return { data: (documents[name] || []).slice(offset, offset + limit) } }
              }
            },
            doc(id) {
              return { async remove() { documents[name] = (documents[name] || []).filter((item) => item._id !== id) } }
            }
          }
        }
      }
    },
    async deleteFile() { return deleteResult }
  }
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'wx-server-sdk') return cloud
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    delete require.cache[dataManagerPath]
    const dataManager = require(dataManagerPath)
    return await dataManager.main({ action: 'deleteAll', confirm: 'DELETE_MY_DATA' })
  } finally {
    Module._load = originalLoad
    delete require.cache[dataManagerPath]
  }
}

async function main() {
  let service = await loadCloudService({ fileList: [{ fileID: 'cloud://photo-a', code: 'SUCCESS' }] })
  await service.deleteCloudFiles(['cloud://photo-a'])

  service = await loadCloudService({ fileList: [{ fileID: 'cloud://photo-b', status: 0 }] })
  await service.deleteCloudFiles(['cloud://photo-b'])

  service = await loadCloudService({ fileList: [{ fileID: 'cloud://photo-missing', status: -503003, errMsg: 'storage file not exists' }] })
  await service.deleteCloudFiles(['cloud://photo-missing'])

  service = await loadCloudService({ fileList: [{ fileID: 'cloud://photo-c', status: -1, errMsg: 'permission denied' }] })
  let rejected = false
  try { await service.deleteCloudFiles(['cloud://photo-c']) } catch (error) {
    rejected = error.message === 'CLOUD_FILE_DELETE_INCOMPLETE' && error.details[0].fileID === 'cloud://photo-c'
  }
  if (!rejected) throw new Error('云文件真实删除失败时必须保留失败详情')

  let result = await runDataManager({ fileList: [{ fileID: 'cloud://photo-a', code: 'SUCCESS' }] })
  if (result.code !== 0 || result.deleted !== true) throw new Error('dataManager 必须识别 Node SDK 的 code=SUCCESS')

  result = await runDataManager({ fileList: [{ fileID: 'cloud://photo-a', status: 0 }] })
  if (result.code !== 0 || result.deleted !== true) throw new Error('dataManager 必须继续兼容旧式 status=0')

  result = await runDataManager({ fileList: [{ fileID: 'cloud://photo-a', status: -503003, errMsg: 'storage file not exists' }] })
  if (result.code !== 0 || result.deleted !== true) throw new Error('dataManager 必须把文件已不存在视为删除成功')

  result = await runDataManager({ fileList: [{ fileID: 'cloud://photo-a', code: 'FAILED', message: 'denied' }] })
  const failure = result.failures && result.failures.find((item) => item.target === 'files')
  if (!failure || failure.details[0].message !== 'denied') throw new Error('dataManager 必须返回云文件的真实失败详情')

  console.log('云文件删除回归通过：客户端和 dataManager 均兼容成功状态、文件已不存在状态，并保留真实失败详情。')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
