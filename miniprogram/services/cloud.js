const env = require('../config/env')

function isReady() { return Boolean(env.CLOUD_ENV_ID && wx.cloud) }
function isSyncReady() { return Boolean(isReady() && env.ENABLE_CLOUD_SYNC) }
function errorMessage(error) { return error && error.message ? error.message : String(error || 'UNKNOWN_CLOUD_ERROR') }
function warn(message, error) {
  const detail = errorMessage(error)
  if (/timeout/i.test(detail)) { console.warn(`${message}：请求超时`); return }
  console.warn(`${message}：${detail}`)
}

async function uploadFootprintPhoto(tempFilePath, footprintId) {
  if (!isReady()) throw new Error('CLOUD_NOT_CONFIGURED')
  const suffix = (tempFilePath.match(/\.[a-zA-Z0-9]+$/) || ['.jpg'])[0]
  const cloudPath = `footprints/${footprintId}/${Date.now()}${suffix}`
  const result = await wx.cloud.uploadFile({ cloudPath, filePath: tempFilePath })
  return result.fileID
}

async function saveLocalPhoto(tempFilePath) {
  return new Promise((resolve, reject) => {
    wx.saveFile({ tempFilePath, success: (res) => resolve(res.savedFilePath), fail: reject })
  })
}

async function persistPhoto(tempFilePath, footprintId) {
  if (!tempFilePath) return { fileId: '', localPath: '' }
  if (isReady()) {
    try { return { fileId: await uploadFootprintPhoto(tempFilePath, footprintId), localPath: '' } } catch (error) { console.warn('云照片上传失败，保留本地副本', error) }
  }
  return { fileId: '', localPath: await saveLocalPhoto(tempFilePath) }
}

function fileDeleteSucceeded(item) {
  if (!item) return false
  const status = Number(item.status)
  return item.code === 'SUCCESS' || status === 0 || status === -503003
}

async function deleteCloudFiles(fileIds) {
  if (!isReady() || !fileIds || !fileIds.length) return
  const result = await wx.cloud.deleteFile({ fileList: fileIds })
  const failed = (result.fileList || []).filter((item) => !fileDeleteSucceeded(item))
  if (failed.length) {
    const error = new Error('CLOUD_FILE_DELETE_INCOMPLETE')
    error.details = failed
    throw error
  }
}

async function flushPendingDeletes() {
  if (!isReady()) return
  const repository = require('./repository')
  const state = repository.getState()
  const fileIds = state.pendingFileDeletes || []
  if (!fileIds.length) return
  await deleteCloudFiles(fileIds)
  repository.update((value) => { value.pendingFileDeletes = [] })
}

async function getPhotoUrls(fileIds) {
  if (!isReady() || !fileIds || !fileIds.length) return {}
  const result = await wx.cloud.getTempFileURL({ fileList: fileIds })
  return (result.fileList || []).reduce((map, item) => { if (item.fileID && item.tempFileURL) map[item.fileID] = item.tempFileURL; return map }, {})
}

async function deleteAllPersonalData() {
  if (!isReady()) return { localOnly: true }
  const response = await wx.cloud.callFunction({ name: 'dataManager', data: { action: 'deleteAll', confirm: 'DELETE_MY_DATA' } })
  if (!response.result || response.result.code !== 0 || response.result.deleted !== true) {
    const error = new Error('CLOUD_DELETE_INCOMPLETE')
    error.details = response.result && response.result.failures
    throw error
  }
  return response.result
}

module.exports = { isReady, isSyncReady, persistPhoto, deleteCloudFiles, flushPendingDeletes, getPhotoUrls, deleteAllPersonalData, errorMessage, warn }
