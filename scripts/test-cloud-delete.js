const path = require('path')

const cloudServicePath = path.resolve(__dirname, '../miniprogram/services/cloud.js')
const envPath = path.resolve(__dirname, '../miniprogram/config/env.js')

async function loadCloudService(deleteResult) {
  delete require.cache[cloudServicePath]
  delete require.cache[envPath]
  global.wx = { cloud: { async deleteFile() { return deleteResult } } }
  return require(cloudServicePath)
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

  service = await loadCloudService({ fileList: [] })
  let missingRejected = false
  try { await service.deleteCloudFiles(['cloud://missing-result']) } catch (error) { missingRejected = true }
  if (!missingRejected) throw new Error('缺少文件结果不能当作成功')
  console.log('云文件删除回归通过：调用者权限下删除，成功/已不存在/失败/遗漏结果均被正确处理。')

}

main().catch((error) => { console.error(error); process.exitCode = 1 })
