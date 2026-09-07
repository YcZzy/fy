const env = require('../config/env')
const photoWork = new Set()
let uploadQueue = null
let deleteWork = null

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

function persistPhoto(tempFilePath, footprintId) {
  const repository = require('./repository')
  const token = repository.dataToken()
  if (!repository.canApply(token)) return Promise.reject(new Error('PERSONAL_DATA_DELETION_PENDING'))
  const operation = (async () => {
    if (!tempFilePath) return { fileId: '', localPath: '' }
    const localPath = await saveLocalPhoto(tempFilePath)
    let fileId = ''
    if (isReady()) {
      try { fileId = await uploadFootprintPhoto(localPath, footprintId) }
      catch (error) { warn('照片已保存在本机，联网后将继续上传', error) }
    }
    if (!repository.canApply(token)) {
      if (fileId) {
        try { await deleteCloudFiles([fileId]) }
        catch (error) { const state = repository.getState(); state.pendingFileDeletes = [...new Set([...state.pendingFileDeletes, fileId])]; repository.saveState(state, { sync: false }) }
      }
      wx.removeSavedFile({ filePath: localPath, fail: () => {} })
      throw new Error('DATA_CHANGED')
    }
    return { fileId, localPath }
  })()
  photoWork.add(operation); operation.then(() => photoWork.delete(operation), () => photoWork.delete(operation))
  return operation
}
async function flushPendingUploads() {
  if (!isReady()) return
  if (uploadQueue) return uploadQueue
  uploadQueue = (async () => {
    const repository = require('./repository'); const token = repository.dataToken()
    for (const item of repository.getState().footprints) {
      if (!repository.canApply(token)) return
      if ((item.photoFileIds || []).length || !(item.localPhotoPaths || []).length) continue
      const path = item.localPhotoPaths[0]
      const fileId = await uploadFootprintPhoto(path, item.id)
      const current = repository.getState().footprints.find((value) => value.id === item.id)
      if (repository.canApply(token) && current && (current.localPhotoPaths || [])[0] === path && !(current.photoFileIds || []).length) {
        repository.update((state) => { const record = state.footprints.find((value) => value.id === item.id); record.photoFileIds = [fileId]; record.updatedAt = Date.now() })
      } else {
        try { await deleteCloudFiles([fileId]) }
        catch (error) { const state = repository.getState(); state.pendingFileDeletes = [...new Set([...state.pendingFileDeletes, fileId])]; repository.saveState(state, { sync: false }) }
      }
    }
  })().finally(() => { uploadQueue = null })
  return uploadQueue
}

function fileDeleteSucceeded(item) {
  if (!item) return false
  const status = Number(item.status)
  return item.code === 'SUCCESS' || status === 0 || status === -503003
}

async function deleteCloudFiles(fileIds) {
  if (!isReady() || !fileIds || !fileIds.length) return
  for (let index = 0; index < fileIds.length; index += 50) {
    const batch = fileIds.slice(index, index + 50)
    const result = await wx.cloud.deleteFile({ fileList: batch })
    const failed = batch.filter((id) => !((result.fileList || []).some((item) => (item.fileID || item.fileId) === id && fileDeleteSucceeded(item))))
    if (failed.length) { const error = new Error('CLOUD_FILE_DELETE_INCOMPLETE'); error.details = (result.fileList || []).filter((item) => failed.includes(item.fileID || item.fileId)); throw error }
  }
}

async function flushPendingDeletes() {
  if (!isReady()) return
  const repository = require('./repository')
  const state = repository.getState()
  const fileIds = state.pendingFileDeletes || []
  if (!fileIds.length) return
  await deleteCloudFiles(fileIds)
  if (!repository.getState().deletionPending) repository.update((value) => { value.pendingFileDeletes = value.pendingFileDeletes.filter((id) => !fileIds.includes(id)) })
}

async function getPhotoUrls(fileIds) {
  if (!isReady() || !fileIds || !fileIds.length) return {}
  const unique = [...new Set(fileIds)]; const urls = {}
  for (let index = 0; index < unique.length; index += 50) {
    const result = await wx.cloud.getTempFileURL({ fileList: unique.slice(index, index + 50) })
    ;(result.fileList || []).forEach((item) => { if (item.fileID && item.tempFileURL) urls[item.fileID] = item.tempFileURL })
  }
  return urls
}

function deleteAllPersonalData() {
  if (deleteWork) return deleteWork
  deleteWork = (async () => {
    const repository = require('./repository'); const sync = require('./sync')
    const state = repository.getState()
    const requestId = state.deleteRequestId || require('./format').uid('delete')
    repository.markDeletion(true, requestId)
    await sync.prepareDelete()
    await Promise.allSettled([...photoWork, uploadQueue].filter(Boolean))
    if (!isReady()) return { localOnly: true, epoch: state.cloudEpoch }
    const begin = await wx.cloud.callFunction({ name: 'dataManager', data: { action: 'beginDelete', requestId } })
    const value = begin.result
    if (!value || value.protocol !== 2 || value.code !== 0) throw new Error((value && value.message) || '请更新云端 dataManager 后重试')
    const fresh = repository.getState()
    const files = [...new Set([...(value.fileIds || []), ...fresh.pendingFileDeletes, ...fresh.footprints.reduce((all, item) => all.concat(item.photoFileIds || []), [])])]
    await deleteCloudFiles(files)
    const response = await wx.cloud.callFunction({ name: 'dataManager', data: { action: 'deleteAll', confirm: 'DELETE_MY_DATA', requestId: value.requestId, epoch: value.epoch } })
    if (!response.result || response.result.code !== 0 || !response.result.deleted) throw new Error((response.result && response.result.message) || '云端删除尚未完成')
    return response.result
  })().finally(() => { deleteWork = null })
  return deleteWork
}
module.exports = { isReady, isSyncReady, persistPhoto, flushPendingUploads, deleteCloudFiles, flushPendingDeletes, getPhotoUrls, deleteAllPersonalData, errorMessage, warn }
