const repository = require('../../services/repository')
const ai = require('../../services/ai')
const format = require('../../services/format')

const QUICK = ['此刻做什么', '展开一个想法', '帮我建个计划', '回顾最近生活', '想点周末去处', '随便聊聊']

Page({
  data: { messages: [], input: '', quick: QUICK, history: [], sending: false, draft: null, scrollInto: '' },
  onLoad(options) {
    this.planId = options.planId || ''
    const state = repository.getState()
    this.conversation = { id: format.uid('c'), title: '一段新对话', messages: [], createdAt: Date.now(), updatedAt: Date.now() }
    this.setData({ history: state.conversations.slice(0, 6) })
    if (options.prompt) this.setData({ input: decodeURIComponent(options.prompt) }, () => this.send())
  },
  onInput(event) { this.setData({ input: event.detail.value }) },
  useQuick(event) { this.setData({ input: event.currentTarget.dataset.value }, () => this.send()) },
  async send() {
    const content = this.data.input.trim()
    if (!content || this.data.sending) return
    const user = { id: format.uid('m'), role: 'user', content, createdAt: Date.now() }
    const messages = [...this.data.messages, user]
    this.setData({ messages, input: '', sending: true, draft: null, scrollInto: user.id })
    try {
      const state = repository.getState()
      const contextSummary = {
        domains: state.domains.filter((item) => !item.hidden).map(({ id, name }) => ({ id, name })),
        focusedPlans: state.plans.filter((item) => item.focused).map(({ id, name }) => ({ id, name })),
        plans: state.plans.filter((item) => item.status !== 'ended').slice(0, 20).map(({ id, name, domainId }) => ({ id, name, domainId })),
        wishes: state.wishes.slice(0, 8).map((item) => item.text),
        recentFootprints: state.footprints.slice(0, 8).map(({ actionName, minutes, feelingLabel }) => ({ actionName, minutes, feelingLabel }))
      }
      const result = await ai.chat(messages, contextSummary)
      const assistant = { id: format.uid('m'), role: 'assistant', content: result.reply || '这一刻可以先不急着回答。', createdAt: Date.now() }
      const draft = result.draft && result.draft.type === 'action' && this.planId ? { ...result.draft, planId: this.planId } : result.draft
      this.finishMessage([...messages, assistant], draft || null)
    } catch (error) {
      console.warn('AI 对话不可用', error)
      const assistant = { id: format.uid('m'), role: 'assistant', content: '风暂时没有回音。你仍然可以从“此刻”的已有行动里选一件，或者先把这个念头留在想做清单里。', createdAt: Date.now(), failed: true }
      this.finishMessage([...messages, assistant], null)
    }
  },
  finishMessage(messages, draft) {
    this.conversation.messages = messages
    this.conversation.updatedAt = Date.now()
    if (messages.length === 2) this.conversation.title = messages[0].content.slice(0, 18)
    repository.saveConversation(this.conversation)
    const last = messages[messages.length - 1]
    this.setData({ messages, draft, sending: false, scrollInto: last.id })
  },
  saveDraft() {
    const draft = this.data.draft
    if (!draft) return
    if (draft.type === 'plan') {
      repository.savePlan({ name: draft.name || '一段新体验', why: draft.why || '', domainId: draft.domainId || 'daily', status: 'want', focused: false })
    } else {
      repository.saveAction({ name: draft.name || '一个新行动', domainId: draft.domainId || 'daily', minutes: Math.max(5, Number(draft.minutes) || 30), planId: draft.planId || '' })
    }
    this.setData({ draft: null })
    wx.showToast({ title: '确认后已保存', icon: 'success' })
  },
  editDraft() {
    const draft = this.data.draft
    if (!draft) return
    if (draft.type === 'plan') {
      this.setData({ draft: null })
      wx.navigateTo({ url: `/pages/plan/index?draft=${encodeURIComponent(JSON.stringify(draft))}` })
      return
    }
    this.setData({ draft: null })
    wx.navigateTo({ url: `/pages/action-editor/index?draft=${encodeURIComponent(JSON.stringify(draft))}` })
  },
  discardDraft() { this.setData({ draft: null }) },
  messageMenu(event) {
    const id = event.currentTarget.dataset.id
    wx.showActionSheet({ itemList: ['删除这条消息'], success: () => {
      const messages = this.data.messages.filter((item) => item.id !== id)
      this.finishMessage(messages, null)
    } })
  },
  clearConversation() {
    if (!this.data.messages.length) return
    wx.showModal({ title: '清空这段对话？', content: '只删除当前对话，不影响计划、行动和足迹。', confirmText: '清空', confirmColor: '#A85F50', success: (res) => {
      if (!res.confirm) return
      repository.update((state) => { state.conversations = state.conversations.filter((item) => item.id !== this.conversation.id) })
      this.conversation.messages = []; this.setData({ messages: [], draft: null, history: repository.getState().conversations.slice(0, 6) })
    } })
  },
  openConversation(event) {
    const item = repository.getState().conversations.find((conversation) => conversation.id === event.currentTarget.dataset.id)
    if (!item) return
    this.conversation = item
    this.setData({ messages: item.messages || [], draft: null, scrollInto: (item.messages && item.messages.length) ? item.messages[item.messages.length - 1].id : '' })
  },
  deleteConversation(event) {
    const id = event.currentTarget.dataset.id
    repository.update((state) => { state.conversations = state.conversations.filter((item) => item.id !== id) })
    this.setData({ history: repository.getState().conversations.slice(0, 6) })
  }
})
