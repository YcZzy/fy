const env = require('../config/env')
const recommender = require('./recommender')
const domainCatalog = require('../data/domains')

function isReady() {
  return Boolean(env.CLOUD_ENV_ID && wx.cloud && wx.cloud.extend && wx.cloud.extend.AI)
}

function extractJson(text) {
  const source = String(text || '').replace(/```json|```/g, '').trim()
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('AI_JSON_INVALID')
  return JSON.parse(source.slice(start, end + 1))
}

async function generate(messages) {
  if (!isReady()) throw new Error('AI_NOT_CONFIGURED')
  const model = wx.cloud.extend.AI.createModel(env.AI_PROVIDER)
  let timeout
  const result = await Promise.race([
    model.generateText({ model: env.AI_MODEL, messages }),
    new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('AI_TIMEOUT')), 25000) })
  ]).finally(() => clearTimeout(timeout))
  const text = result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content
  if (!text) throw new Error('AI_EMPTY_RESPONSE')
  return { text, usage: result.usage || {} }
}

async function recommend(state, context) {
  const compact = {
    context,
    domains: domainCatalog.allDomains(state.domains).map(({ id, name }) => ({ id, name })),
    actions: state.actions.filter((item) => recommender.isEligible(item, state, context)).slice(0, 80).map(({ id, name, domainId, minutes, energy, environments, preparation }) => ({ id, name, domainId, minutes, energy, environments, preparation, planIds: state.plans.filter((plan) => (plan.actionIds || []).includes(id)).map((plan) => plan.id) })),
    focusedPlans: state.plans.filter((item) => item.focused && !['ended', 'paused'].includes(item.status)).map(({ id, name, domainId, actionIds }) => ({ id, name, domainId, actionIds: actionIds || [] })),
    recent: state.footprints.slice(0, 8).map(({ actionId, actionName, minutes, feeling }) => ({ actionId, actionName, minutes, feeling })),
    selectedInterests: state.preferences.selectedInterests || [],
    declinedActionIds: (state.declinedActions || []).filter((item) => item.declinedAt >= Date.now() - 2 * 60 * 60 * 1000).map((item) => item.actionId).slice(-12)
  }
  const system = '你是“风月为邻”的生活选择助手。语气温和、克制、略有诗意，但行动必须具体。娱乐与学习同等重要。不要评价、自律说教或虚构地点与用户经历。只返回 JSON：{"items":[{"name":"","domainId":"","minutes":30,"reason":"","planId":"","preparation":"","locationNote":""}]}。返回 1 至 5 项高匹配建议，复用已有行动时必须返回其 actionId，时长不得超过用户可用时间；未接入实时地点数据，只能推荐地点类别。'
  const result = await generate([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(compact) }])
  const parsed = extractJson(result.text)
  const items = recommender.normalizeAiRecommendations(parsed.items, state, context)
  if (!items.length) throw new Error('AI_RECOMMENDATION_INVALID')
  return { items, usage: result.usage }
}

async function organizeThought(text, state) {
  const thought = String(text || '').trim().slice(0, 500)
  if (!thought) throw new Error('THOUGHT_REQUIRED')
  const domains = domainCatalog.allDomains(state.domains).map(({ id, name }) => ({ id, name }))
  const context = {
    thought,
    domains,
    existingPlans: state.plans.filter((item) => item.status !== 'ended').slice(0, 30).map(({ id, name, domainId }) => ({ id, name, domainId })),
    existingActions: state.actions.filter((item) => !item.hidden).slice(0, 50).map(({ id, name, domainId }) => ({ id, name, domainId }))
  }
  const system = '你负责把用户“想做的事”整理成可确认的草稿。判断它是一次就能开始的 action，还是需要多步展开的 plan。不要把休息、娱乐或日常小事强行升级为计划；信息不足时优先 action。必须从给定 domains 选择最贴切的 domainId，无法判断时返回空字符串。不要评价、说教或虚构用户经历。只返回 JSON：{"type":"action或plan","name":"","domainId":"","why":"","minutes":30,"preparation":"","actions":[{"name":"","minutes":30,"preparation":""}]}。action 的 actions 必须为空；plan 可给 1 至 3 个具体、低门槛的建议行动。'
  const result = await generate([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(context) }])
  const draft = normalizeOrganizedDraft(extractJson(result.text), { domains })
  if (!draft) throw new Error('AI_ORGANIZATION_INVALID')
  return { draft, usage: result.usage }
}

async function chat(messages, contextSummary) {
  const system = '你是“问风月”。温和、克制、略有诗意，但回答清楚具体，不说教、不诊断。娱乐和休息也是正常生活。若用户要求创建行动或计划，只提出草稿，绝不声称已保存。只返回 JSON：{"reply":"给用户的话","draft":null}；若有草稿，draft 为 {"type":"action或plan","name":"","domainId":"rest|health|learn|career|travel|connect|create|daily","minutes":30,"why":"","planId":"可选且必须来自摘要中的真实计划ID","preparation":""}。'
  const safeMessages = messages.slice(-12).map(({ role, content }) => ({ role, content }))
  const result = await generate([{ role: 'system', content: `${system}\n可用的非敏感摘要：${JSON.stringify(contextSummary)}` }, ...safeMessages])
  const parsed = extractJson(result.text)
  if (typeof parsed.reply !== 'string' || !parsed.reply.trim()) throw new Error('AI_REPLY_INVALID')
  const draft = normalizeDraft(parsed.draft, contextSummary)
  return { reply: parsed.reply.trim().slice(0, 6000), draft, usage: result.usage }
}

async function review(footprints, rangeLabel) {
  if (footprints.length > 300) throw new Error('AI_REVIEW_TOO_LARGE')
  const data = footprints.map(({ actionName, domainName, minutes, feeling, note, createdAt, completionStatus }) => ({ actionName, domainName, minutes, feeling, note, createdAt, completionStatus }))
  const system = '你为“风月为邻”生成生活回顾。区分 completionStatus：not_started 是没有去做，不得描述为实际经历；minutes 为空表示未知而非零。只描述发生过的事情、感受与温和可能性，不打分、不制造负罪感、不制定目标。周回顾 150-300 字。只返回 JSON：{"content":""}。'
  const result = await generate([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ rangeLabel, footprints: data }) }])
  const parsed = extractJson(result.text)
  if (typeof parsed.content !== 'string' || !parsed.content.trim()) throw new Error('AI_REVIEW_INVALID')
  return { content: parsed.content.trim().slice(0, 6000), usage: result.usage }
}

function normalizeDraft(raw, summary = {}) {
  if (!raw || !['action', 'plan'].includes(raw.type) || typeof raw.name !== 'string' || !raw.name.trim()) return null
  const domains = summary.domains || []
  const domainId = domains.some((item) => item.id === raw.domainId) ? raw.domainId : ''
  const plan = (summary.plans || []).find((item) => item.id === raw.planId && item.domainId === domainId)
  return { type: raw.type, name: raw.name.trim().slice(0, 30), domainId, minutes: Math.min(720, Math.max(1, Math.round(Number(raw.minutes) || 30))), why: String(raw.why || '').slice(0, 180), preparation: String(raw.preparation || '不需要额外准备').slice(0, 60), planId: plan ? plan.id : '', source: 'ai' }
}

function normalizeOrganizedDraft(raw, summary = {}) {
  const draft = normalizeDraft(raw, summary)
  if (!draft) return null
  const actions = draft.type === 'plan' && Array.isArray(raw.actions) ? raw.actions
    .filter((item) => item && typeof item.name === 'string' && item.name.trim())
    .slice(0, 3)
    .map((item) => ({
      name: item.name.trim().slice(0, 30),
      domainId: draft.domainId,
      minutes: Math.min(720, Math.max(1, Math.round(Number(item.minutes) || 30))),
      preparation: String(item.preparation || '不需要额外准备').slice(0, 60),
      energy: ['low', 'medium', 'high'],
      environments: ['any'],
      source: 'ai'
    })) : []
  return { ...draft, actions }
}

module.exports = { isReady, recommend, organizeThought, chat, review, normalizeDraft, normalizeOrganizedDraft }
