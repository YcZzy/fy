const repository = require('../../services/repository')
const ai = require('../../services/ai')
const format = require('../../services/format')
const sync = require('../../services/sync')
const cloud = require('../../services/cloud')
const themeService = require('../../services/theme')
const QUICK = ['此刻做什么', '展开一个想法', '帮我建个计划', '回顾最近生活', '想点周末去处', '随便聊聊']
Page({
  data: { messages: [], input: '', quick: QUICK, history: [], historyLimit: 20, historyCount: 0, showHistory: false, sending: false, draft: null, scrollInto: '', theme: 'now', savedTarget: null },
  onLoad(options) {
    const theme = themeService.fromOptions(options); themeService.apply(theme)
    this.token = repository.dataToken(); this.planId = options.planId || ''; this.requestId = 0
    this.setData({ theme }); this.newConversation(); this.refreshHistory()
    if (options.prompt) this.setData({ input: decodeURIComponent(options.prompt) }, () => this.send())
  },
  onShow() {
    this.visible = true
    if (repository.getState().deletionPending) { wx.navigateBack(); return }
    this.restoreConversation()
    this.refreshHistory()
    sync.bootstrap(['conversations']).then(() => {
      if (!this.visible) return
      if (!repository.canApply(this.token)) { this.token = repository.dataToken(); this.newConversation() }
      this.restoreConversation()
      this.refreshHistory()
    }).catch((error) => cloud.warn('先显示本机对话，联网后可重试', error))
  },
  onHide() { this.visible = false; this.invalidate() },
  onUnload() { this.onHide() },
  restoreConversation() {
    const current = repository.getState().conversations.find((item) => item.id === this.conversation.id)
    if (!current && (this.data.messages.length || this.data.draft)) { this.newConversation(); return }
    if (current && !this.data.sending) { this.conversation = current; this.setData({ messages: current.messages || [], draft: current.draft || null }) }
  },
  invalidate() { this.requestId = (this.requestId || 0) + 1; this.setData({ sending: false }) },
  newConversation() {
    this.invalidate()
    this.conversation = { id: format.uid('c'), title: '一段新对话', messages: [], draft: null, createdAt: Date.now(), updatedAt: Date.now() }
    this.setData({ messages: [], draft: null, input: '', showHistory: false, savedTarget: null })
  },
  refreshHistory() {
    const all = repository.getState().conversations.slice().sort((a, b) => b.updatedAt - a.updatedAt)
    this.setData({ history: all.slice(0, this.data.historyLimit).map((item) => ({ ...item, dateLabel: format.dateLabel(item.updatedAt) })), historyCount: all.length })
  },
  toggleHistory() { this.setData({ showHistory: !this.data.showHistory }); this.refreshHistory() },
  moreHistory() { this.setData({ historyLimit: this.data.historyLimit + 20 }); this.refreshHistory() },
  onInput(event) { this.setData({ input: event.detail.value }) },
  useQuick(event) { this.setData({ input: event.currentTarget.dataset.value }, () => this.send()) },
  async send() {
    const content = this.data.input.trim()
    if (!content || this.data.sending || !repository.canApply(this.token)) return
    const requestId = this.requestId = (this.requestId || 0) + 1
    const conversationId = this.conversation.id
    const valid = () => requestId === this.requestId && conversationId === this.conversation.id && repository.canApply(this.token)
    const user = { id: format.uid('m'), role: 'user', content, createdAt: Date.now() }
    const messages = [...this.data.messages, user]
    this.finishMessage(messages, this.data.draft)
    this.setData({ input: '', sending: true, showHistory: false, scrollInto: user.id })
    try {
      const state = repository.getState()
      const contextSummary = {
        domains: state.domains.filter((item) => !item.hidden).map(({ id, name }) => ({ id, name })),
        focusedPlans: state.plans.filter((item) => item.focused && !['ended', 'paused'].includes(item.status)).map(({ id, name }) => ({ id, name })),
        plans: state.plans.filter((item) => item.status !== 'ended').slice(0, 30).map(({ id, name, domainId }) => ({ id, name, domainId })),
        wishes: state.wishes.slice(0, 8).map((item) => item.text),
        recentFootprints: state.footprints.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 8).map(({ actionName, minutes, feelingLabel, completionStatus }) => ({ actionName, minutes, feelingLabel, completionStatus }))
      }
      const result = await ai.chat(messages, contextSummary)
      if (!valid()) return
      const assistant = { id: format.uid('m'), role: 'assistant', content: result.reply, createdAt: Date.now() }
      const plan = this.planId ? state.plans.find((item) => item.id === this.planId && item.status !== 'ended') : null
      let draft = result.draft
      if (draft) draft = { ...draft, id: format.uid(draft.type === 'plan' ? 'p' : 'a'), conversationId, ...(draft.type === 'action' && plan ? { planId: plan.id, domainId: plan.domainId } : {}) }
      this.finishMessage([...messages, assistant], draft || this.data.draft)
    } catch (error) {
      if (!valid()) return
      const assistant = { id: format.uid('m'), role: 'assistant', content: '暂时没有收到回复。可以重试这条消息，或先把想法保存到想做清单。', createdAt: Date.now(), failed: true }
      this.finishMessage([...messages, assistant], this.data.draft)
    } finally { if (valid()) this.setData({ sending: false, scrollInto: 'conversation-bottom' }) }
  },
  finishMessage(messages, draft) {
    if (!repository.canApply(this.token)) return
    this.conversation = { ...this.conversation, messages, draft, updatedAt: Date.now() }
    const firstUser = messages.find((item) => item.role === 'user')
    if (firstUser) this.conversation.title = firstUser.content.slice(0, 18)
    repository.saveConversation(this.conversation)
    this.setData({ messages, draft, scrollInto: 'conversation-bottom' }); this.refreshHistory()
  },
  retryMessage() {
    if (this.data.sending) return
    const messages = [...this.data.messages]
    if (messages.length && messages[messages.length - 1].failed) messages.pop()
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'user') return
    messages.pop(); this.setData({ messages, input: last.content }, () => this.send())
  },
  keepThought() {
    const user = this.data.messages.slice().reverse().find((item) => item.role === 'user')
    if (!user) return
    repository.addWish(user.content); wx.showToast({ title: '已记入想做清单', icon: 'success' })
  },
  saveDraft() {
    const draft = this.data.draft
    if (!draft || !repository.canApply(this.token)) return
    const value = { ...draft, id: draft.id || format.uid(draft.type === 'plan' ? 'p' : 'a'), source: 'ai' }
    delete value.type; delete value.conversationId
    if (draft.type === 'plan') repository.savePlan({ ...value, status: 'want', focused: false, actionIds: [] })
    else repository.saveAction({ ...value, preparation: draft.preparation || '不需要额外准备', energy: draft.energy || ['low', 'medium', 'high'], environments: draft.environments || ['any'] })
    this.finishMessage(this.data.messages, null)
    this.setData({ savedTarget: { type: draft.type, id: value.id } })
    wx.showToast({ title: '已保存', icon: 'success' })
  },
  openSaved() {
    const target = this.data.savedTarget
    if (target) wx.navigateTo({ url: themeService.withTheme(`/pages/${target.type === 'plan' ? 'plan' : 'action'}/index?id=${target.id}`, this.data.theme) })
  },
  editDraft() {
    if (!this.data.draft) return
    wx.navigateTo({ url: themeService.withTheme(`/pages/${this.data.draft.type === 'plan' ? 'plan' : 'action-editor'}/index?draft=${encodeURIComponent(JSON.stringify(this.data.draft))}`, this.data.theme) })
  },
  discardDraft() { this.finishMessage(this.data.messages, null) },
  messageMenu(event) {
    const id = event.currentTarget.dataset.id
    wx.showActionSheet({ itemList: ['删除这条消息'], success: () => { this.invalidate(); this.finishMessage(this.data.messages.filter((item) => item.id !== id), this.data.draft) } })
  },
  clearConversation() {
    if (!this.data.messages.length && !this.data.draft) return
    wx.showModal({ title: '清空这段对话？', content: '当前消息和未保存草稿会被删除，已经保存的计划与行动不受影响。', confirmText: '清空', success: (res) => {
      if (!res.confirm) return
      this.invalidate(); const id = this.conversation.id
      repository.update((state) => { state.conversations = state.conversations.filter((item) => item.id !== id) })
      this.newConversation(); this.refreshHistory()
    } })
  },
  openConversation(event) {
    const item = repository.getState().conversations.find((value) => value.id === event.currentTarget.dataset.id)
    if (!item) return
    this.invalidate(); this.conversation = item
    this.setData({ messages: item.messages || [], draft: item.draft || null, showHistory: false, savedTarget: null, scrollInto: 'conversation-bottom' })
  },
  deleteConversation(event) {
    const id = event.currentTarget.dataset.id
    wx.showModal({ title: '删除这段对话？', content: '消息和未保存草稿会一起删除。', confirmText: '删除', success: (res) => {
      if (!res.confirm) return
      repository.update((state) => { state.conversations = state.conversations.filter((item) => item.id !== id) })
      if (this.conversation.id === id) this.newConversation()
      this.refreshHistory()
    } })
  }
})
