const repository = require('../../services/repository')
const cloud = require('../../services/cloud')
const format = require('../../services/format')
const themeService = require('../../services/theme')
const form = require('../../services/form')
const domainCatalog = require('../../data/domains')
const FEELINGS = [{ value: 'love', label: '很喜欢', symbol: '晴' }, { value: 'good', label: '还不错', symbol: '暖' }, { value: 'okay', label: '一般', symbol: '平' }, { value: 'poor', label: '不太喜欢', symbol: '淡' }]
const DURATIONS = [{ label: '10 分钟', value: 10 }, { label: '半小时', value: 30 }, { label: '1 小时', value: 60 }, { label: '2 小时', value: 120 }, { label: '不记录', value: null }]
const COMPLETIONS = [{ value: 'done', label: '做完了' }, { value: 'partial', label: '做了一部分' }, { value: 'not_started', label: '最后没做' }]
Page({
  data: { action: null, feelings: FEELINGS, durations: DURATIONS, completions: COMPLETIONS, completion: 'done', minutes: null, customMinutes: '', feeling: '', note: '', again: '', photoPath: '', location: null, saving: false, theme: 'now', isEdit: false, manual: false, expanded: false, recordDate: '', today: '', domains: [], domainIndex: 0 },
  onLoad(options) {
    this.token = repository.dataToken(); this.disposed = false
    const theme = themeService.fromOptions(options); themeService.apply(theme)
    this.footprintId = options.footprintId || ''; this.mode = options.mode || 'manual'
    this.recordId = this.footprintId || format.uid('f')
    let state = repository.getState()
    this.existing = this.footprintId ? state.footprints.find((item) => item.id === this.footprintId) : null
    if (this.footprintId && !this.existing) { wx.showToast({ title: '这条足迹已不存在', icon: 'none' }); wx.navigateBack(); return }
    const existing = this.existing
    let session = this.mode === 'timer' ? state.activeSession : this.mode === 'direct' ? state.pendingAction : null
    if (session && session.actionId !== options.actionId) session = null
    if (!existing && ['timer', 'direct'].includes(this.mode) && !session) { wx.showToast({ title: '这件事已处理，请从足迹中查看', icon: 'none' }); wx.navigateBack(); return }
    if (this.mode === 'timer' && session && session.status === 'running') { repository.pauseSession(); state = repository.getState(); session = state.activeSession }
    this.sessionId = session ? session.id : ''
    const domains = [{ id: '', name: '未分类' }, ...domainCatalog.allDomains(state.domains)]
    const raw = existing ? { id: existing.actionId, name: existing.actionName, domainId: existing.domainId, domainName: existing.domainName, planId: existing.planId || '', planName: existing.planName || '', minutes: existing.minutes } :
      (session && session.actionSnapshot) || state.actions.find((item) => item.id === options.actionId) || { id: '', name: '', domainId: '', minutes: null }
    const domain = domainCatalog.findDomain(state.domains, raw.domainId)
    const planId = raw.planId || options.planId || ''
    const plan = state.plans.find((item) => item.id === planId)
    const action = { ...raw, domainName: raw.domainName || (domain && domain.name) || '生活', planId, planName: raw.planName || (plan && plan.name) || '' }
    const minutes = existing ? existing.minutes : this.mode === 'timer' && session ? Math.max(1, Math.round((session.elapsedBeforePause || 0) / 60)) : null
    this.originalPhotoFileIds = (existing && existing.photoFileIds) || []
    this.originalLocalPhotoPaths = (existing && existing.localPhotoPaths) || []
    const recordDate = format.dateKey(existing ? existing.createdAt : session ? session.startedAt : Date.now())
    this.setData({ action, theme, minutes, customMinutes: minutes === null ? '' : String(minutes), completion: existing ? existing.completionStatus || (existing.completed === false ? 'partial' : 'done') : 'done',
      feeling: existing ? existing.feeling || '' : '', note: existing ? existing.note || '' : '', again: existing ? existing.doAgain || '' : '',
      photoPath: this.originalLocalPhotoPaths[0] || this.originalPhotoFileIds[0] || '', location: existing ? existing.location || null : null,
      isEdit: Boolean(existing), manual: !raw.id && !existing, expanded: Boolean(existing), recordDate, today: format.dateKey(Date.now()), domains, domainIndex: Math.max(0, domains.findIndex((item) => item.id === action.domainId)) })
  },
  onUnload() { this.disposed = true; form.saved(this) },
  change(values) { this.setData(values); form.changed(this) },
  onName(event) { this.change({ 'action.name': event.detail.value }) },
  onDomain(event) { const index = Number(event.detail.value); const domain = this.data.domains[index]; if (!domain) return; this.change({ domainIndex: index, 'action.domainId': domain.id, 'action.domainName': domain.name }) },
  onDate(event) { this.change({ recordDate: event.detail.value }) },
  toggleDetails() { this.setData({ expanded: !this.data.expanded }) },
  selectDuration(event) { const value = event.currentTarget.dataset.value === 'none' ? null : Number(event.currentTarget.dataset.value); this.change({ minutes: value, customMinutes: value === null ? '' : String(value) }) },
  onCustomMinutes(event) { const value = event.detail.value.replace(/\D/g, '').slice(0, 3); this.change({ customMinutes: value, minutes: value ? Number(value) : null }) },
  selectFeeling(event) { const value = event.currentTarget.dataset.value; this.change({ feeling: this.data.feeling === value ? '' : value }) },
  selectCompletion(event) { const completion = event.currentTarget.dataset.value; this.change({ completion, ...(completion === 'not_started' ? { minutes: null, customMinutes: '' } : {}) }) },
  onNote(event) { this.change({ note: event.detail.value }) },
  selectAgain(event) { const value = event.currentTarget.dataset.value; this.change({ again: this.data.again === value ? '' : value }) },
  choosePhoto() { wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'], success: (res) => { this.photoChanged = true; this.change({ photoPath: res.tempFiles[0].tempFilePath }) } }) },
  removePhoto() { this.photoChanged = true; this.change({ photoPath: '' }) },
  chooseLocation() {
    wx.chooseLocation({ success: (value) => {
      wx.showActionSheet({ alertText: '这次想保留多少位置信息？', itemList: ['只保留地点名称', '保留名称和精确位置'], success: (res) => {
        const location = { name: value.name || value.address || '一个地方' }
        if (res.tapIndex === 1) Object.assign(location, { address: value.address || '', latitude: value.latitude, longitude: value.longitude })
        this.change({ location })
      } })
    }, fail: () => wx.showToast({ title: '没有选择位置', icon: 'none' }) })
  },
  removeLocation() { this.change({ location: null }) },
  async save() {
    if (this.data.saving || !this.data.action || !repository.canApply(this.token)) return
    const name = this.data.action.name.trim()
    if (!name) { wx.showToast({ title: '写下刚才做了什么', icon: 'none' }); return }
    if (!this.data.recordDate || this.data.recordDate > this.data.today) { wx.showToast({ title: '请选择今天或之前的日期', icon: 'none' }); return }
    if (this.data.minutes !== null && this.data.minutes <= 0) { wx.showToast({ title: '请填写正数分钟或选择不记录', icon: 'none' }); return }
    this.setData({ saving: true })
    let photo = { fileId: '', localPath: '' }
    try {
      if (this.data.photoPath && (!this.footprintId || this.photoChanged)) photo = await cloud.persistPhoto(this.data.photoPath, this.recordId)
      else if (this.footprintId && !this.photoChanged) photo = { fileId: this.originalPhotoFileIds[0] || '', localPath: this.originalLocalPhotoPaths[0] || '' }
      if (this.disposed || !repository.canApply(this.token)) {
        if (this.photoChanged || !this.footprintId) {
          if (photo.fileId) await cloud.deleteCloudFiles([photo.fileId]).catch(() => {
            const state = repository.getState(); state.pendingFileDeletes = [...new Set([...state.pendingFileDeletes, photo.fileId])]; repository.saveState(state, { sync: false })
          })
          if (photo.localPath) wx.removeSavedFile({ filePath: photo.localPath, fail: () => {} })
        }
        return
      }
      const feeling = FEELINGS.find((item) => item.value === this.data.feeling)
      const existingTime = this.existing && this.existing.createdAt
      const createdAt = existingTime && format.dateKey(existingTime) === this.data.recordDate ? existingTime : this.data.recordDate === this.data.today ? Date.now() : new Date(`${this.data.recordDate}T12:00:00`).getTime()
      const payload = { id: this.recordId, sessionId: this.sessionId, actionId: this.data.action.id, actionName: name, domainId: this.data.action.domainId, domainName: this.data.action.domainName,
        planId: this.data.action.planId || '', planName: this.data.action.planName || '', createdAt,
        minutes: this.data.completion === 'not_started' ? null : this.data.minutes, feeling: this.data.feeling, feelingLabel: feeling ? feeling.label : '未记录感受', note: this.data.note.trim(), doAgain: this.data.again,
        photoFileIds: photo.fileId ? [photo.fileId] : [], localPhotoPaths: photo.localPath ? [photo.localPath] : [], location: this.data.location, completionStatus: this.data.completion, completed: this.data.completion === 'done', sourceMode: this.existing ? this.existing.sourceMode : this.mode }
      if (this.footprintId) repository.saveFootprint(payload); else repository.addFootprint(payload)
      if (this.footprintId && this.photoChanged) {
        cloud.deleteCloudFiles(this.originalPhotoFileIds).catch(() => { if (repository.canApply(this.token)) repository.queueFileDeletes(this.originalPhotoFileIds) })
        this.originalLocalPhotoPaths.forEach((filePath) => wx.removeSavedFile({ filePath, fail: () => {} }))
      }
      form.saved(this); wx.showToast({ title: this.footprintId ? '修改已保存' : '足迹留下了', icon: 'success' })
      setTimeout(() => wx.switchTab({ url: '/pages/footprints/index' }), 500)
    } catch (error) { console.error(error); this.setData({ saving: false }); wx.showToast({ title: '暂时没保存好，请再试一次', icon: 'none' }) }
  },
  skip() {
    if (this.data.saving) return
    if (this.footprintId || this.data.manual) { wx.navigateBack(); return }
    wx.showModal({ title: '不留下记录，结束这件事？', content: '已经填写的内容不会保存。', confirmText: '不记录', success: (res) => {
      if (!res.confirm) return
      const state = repository.getState()
      if (state.activeSession && state.activeSession.id === this.sessionId) repository.clearSession()
      if (state.pendingAction && state.pendingAction.id === this.sessionId) repository.resolvePending()
      form.saved(this); wx.switchTab({ url: '/pages/now/index' })
    } })
  }
})
