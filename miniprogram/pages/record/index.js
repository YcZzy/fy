const repository = require('../../services/repository')
const cloud = require('../../services/cloud')
const format = require('../../services/format')
const themeService = require('../../services/theme')

const FEELINGS = [
  { value: 'love', label: '很喜欢', symbol: '晴' },
  { value: 'good', label: '还不错', symbol: '暖' },
  { value: 'okay', label: '一般', symbol: '平' },
  { value: 'poor', label: '不太喜欢', symbol: '淡' }
]
const DURATIONS = [{ label: '10 分钟', value: 10 }, { label: '半小时', value: 30 }, { label: '1 小时', value: 60 }, { label: '2 小时', value: 120 }, { label: '不记录', value: null }]
const COMPLETIONS = [{ value: 'done', label: '做完了' }, { value: 'partial', label: '做了一部分' }, { value: 'not_started', label: '最后没做' }]

Page({
  data: { action: null, feelings: FEELINGS, durations: DURATIONS, completions: COMPLETIONS, completion: 'done', minutes: 30, customMinutes: '', feeling: '', note: '', again: '', photoPath: '', location: null, saving: false, theme: 'now' },
  onLoad(options) {
    const theme = themeService.fromOptions(options)
    this.setData({ theme })
    themeService.apply(theme)
    this.actionId = options.actionId
    this.planId = options.planId || ''
    this.footprintId = options.footprintId || ''
    this.mode = options.mode || 'manual'
    const state = repository.getState()
    const existing = this.footprintId ? state.footprints.find((item) => item.id === this.footprintId) : null
    const cached = state.recommendationCache && state.recommendationCache.items || []
    const rawAction = state.actions.find((item) => item.id === this.actionId) || cached.find((item) => item.id === this.actionId) || (state.activeSession && state.activeSession.actionId === this.actionId && state.activeSession.actionSnapshot) || (state.pendingAction && state.pendingAction.actionId === this.actionId && state.pendingAction.actionSnapshot) || (existing && { id: existing.actionId, name: existing.actionName, domainId: existing.domainId, planId: existing.planId, minutes: existing.minutes || 30 })
    if (!rawAction) { wx.navigateBack(); return }
    const sessionSnapshot = state.activeSession && state.activeSession.actionId === this.actionId && state.activeSession.actionSnapshot
    const pendingSnapshot = state.pendingAction && state.pendingAction.actionId === this.actionId && state.pendingAction.actionSnapshot
    const planId = this.planId || (existing && existing.planId) || (sessionSnapshot && sessionSnapshot.planId) || (pendingSnapshot && pendingSnapshot.planId) || rawAction.planId || ''
    const action = { ...rawAction, planId }
    let minutes = action.minutes
    if (this.mode === 'timer' && state.activeSession) {
      const seconds = state.activeSession.status === 'paused' ? state.activeSession.elapsedBeforePause : (Date.now() - state.activeSession.startedAt) / 1000
      minutes = Math.max(1, Math.round(seconds / 60))
    }
    const domain = state.domains.find((item) => item.id === action.domainId)
    if (existing) {
      minutes = existing.minutes
      this.originalPhotoFileIds = existing.photoFileIds || []
      this.originalLocalPhotoPaths = existing.localPhotoPaths || []
      this.setData({
        action: { ...action, domainName: existing.domainName || action.domainName || (domain && domain.name) || '生活' }, minutes,
        customMinutes: minutes === null ? '' : String(minutes), completion: existing.completionStatus || (existing.completed === false ? 'partial' : 'done'), feeling: existing.feeling || '', note: existing.note || '', again: existing.doAgain || '',
        photoPath: (existing.localPhotoPaths && existing.localPhotoPaths[0]) || (existing.photoFileIds && existing.photoFileIds[0]) || '', location: existing.location || null
      })
    } else this.setData({ action: { ...action, domainName: action.domainName || (domain && domain.name) || '生活' }, minutes, customMinutes: String(minutes) })
  },
  selectDuration(event) {
    const raw = event.currentTarget.dataset.value
    const value = raw === 'none' ? null : Number(raw)
    this.setData({ minutes: value, customMinutes: value === null ? '' : String(value) })
  },
  onCustomMinutes(event) {
    const value = event.detail.value.replace(/\D/g, '').slice(0, 3)
    this.setData({ customMinutes: value, minutes: value ? Number(value) : null })
  },
  selectFeeling(event) { this.setData({ feeling: event.currentTarget.dataset.value }) },
  selectCompletion(event) {
    const completion = event.currentTarget.dataset.value
    this.setData({ completion, ...(completion === 'not_started' ? { minutes: null, customMinutes: '' } : {}) })
  },
  onNote(event) { this.setData({ note: event.detail.value }) },
  selectAgain(event) { this.setData({ again: event.currentTarget.dataset.value }) },
  choosePhoto() {
    wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'], success: (res) => { this.photoChanged = true; this.setData({ photoPath: res.tempFiles[0].tempFilePath }) } })
  },
  removePhoto() { this.photoChanged = true; this.setData({ photoPath: '' }) },
  chooseLocation() {
    wx.showModal({
      title: '为这次足迹留下位置', content: '位置只在你确认后保存。可以只保留地点名称；删除足迹时会一并删除位置。', confirmText: '选择位置',
      success: (modal) => {
        if (!modal.confirm) return
        wx.chooseLocation({ success: (value) => this.setData({ location: { name: value.name || value.address || '一个地方', address: value.address || '', latitude: value.latitude, longitude: value.longitude } }), fail: () => wx.showToast({ title: '没有选择位置', icon: 'none' }) })
      }
    })
  },
  removeLocation() { this.setData({ location: null }) },
  async save() {
    if (this.data.saving) return
    this.setData({ saving: true })
    const state = repository.getState()
    const tempId = format.uid('f')
    let photo = { fileId: '', localPath: '' }
    try {
      if (this.data.photoPath && (!this.footprintId || this.photoChanged)) photo = await cloud.persistPhoto(this.data.photoPath, tempId)
      else if (this.footprintId && !this.photoChanged) photo = { fileId: (this.originalPhotoFileIds || [])[0] || '', localPath: (this.originalLocalPhotoPaths || [])[0] || '' }
      const feelingOption = FEELINGS.find((item) => item.value === this.data.feeling)
      const payload = {
        id: this.footprintId || undefined,
        actionId: this.data.action.id, actionName: this.data.action.name, domainId: this.data.action.domainId,
        domainName: this.data.action.domainName, planId: this.data.action.planId || '', minutes: this.data.minutes,
        feeling: this.data.feeling, feelingLabel: feelingOption ? feelingOption.label : '未记录感受', note: this.data.note.trim(),
        doAgain: this.data.again, photoFileIds: photo.fileId ? [photo.fileId] : [], localPhotoPaths: photo.localPath ? [photo.localPath] : [],
        location: this.data.location, completionStatus: this.data.completion, completed: this.data.completion === 'done', sourceMode: this.mode
      }
      if (this.footprintId) repository.saveFootprint(payload)
      else repository.addFootprint(payload)
      if (this.footprintId && this.photoChanged && this.originalPhotoFileIds && this.originalPhotoFileIds.length) cloud.deleteCloudFiles(this.originalPhotoFileIds).catch(() => repository.queueFileDeletes(this.originalPhotoFileIds))
      if (this.footprintId && this.photoChanged) (this.originalLocalPhotoPaths || []).forEach((filePath) => wx.removeSavedFile({ filePath, fail: () => {} }))
      wx.showToast({ title: '足迹留下了', icon: 'success' })
      setTimeout(() => wx.switchTab({ url: '/pages/footprints/index' }), 650)
    } catch (error) {
      console.error(error)
      wx.showToast({ title: '暂时没保存好，请再试一次', icon: 'none' })
    } finally { this.setData({ saving: false }) }
  },
  skip() {
      if (this.footprintId) { wx.navigateBack(); return }
      repository.addFootprint({ actionId: this.data.action.id, actionName: this.data.action.name, domainId: this.data.action.domainId, domainName: this.data.action.domainName, planId: this.data.action.planId || '', minutes: null, feeling: '', feelingLabel: '未记录感受', completionStatus: this.data.completion, completed: this.data.completion === 'done', sourceMode: this.mode })
    wx.switchTab({ url: '/pages/footprints/index' })
  }
})
