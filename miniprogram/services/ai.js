const env = require('../config/env')
const recommender = require('./recommender')

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
  const result = await model.generateText({ model: env.AI_MODEL, messages })
  const text = result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content
  if (!text) throw new Error('AI_EMPTY_RESPONSE')
  if (env.ENABLE_CLOUD_SYNC && result.usage) {
    wx.cloud.database().collection('ai_usage').add({ data: { model: env.AI_MODEL, usage: result.usage, ok: true, createdAt: Date.now() } }).catch((error) => console.warn('AI 用量记录失败', error))
  }
  return { text, usage: result.usage || {} }
}

async function recommend(state, context) {
  const compact = {
    context,
    domains: state.domains.filter((item) => !item.hidden).map(({ id, name }) => ({ id, name })),
    actions: state.actions.filter((item) => !item.hidden).map(({ id, name, domainId, minutes, energy, environments, preparation, planId }) => ({ id, name, domainId, minutes, energy, environments, preparation, planId })),
    focusedPlans: state.plans.filter((item) => item.focused).map(({ id, name, domainId }) => ({ id, name, domainId })),
    recent: state.footprints.slice(0, 8).map(({ actionId, actionName, minutes, feeling }) => ({ actionId, actionName, minutes, feeling })),
    declinedActionIds: state.declinedActionIds.slice(-12)
  }
  const system = '你是“风月为邻”的生活选择助手。语气温和、克制、略有诗意，但行动必须具体。娱乐与学习同等重要。不要评价、自律说教或虚构地点与用户经历。只返回 JSON：{"items":[{"name":"","domainId":"","minutes":30,"reason":"","planId":"","preparation":"","locationNote":""}]}。必须恰好 5 项，时长不得超过用户可用时间；未接入实时地点数据，只能推荐地点类别。'
  const result = await generate([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(compact) }])
  const parsed = extractJson(result.text)
  const items = recommender.normalizeAiRecommendations(parsed.items, state, context)
  if (items.length !== 5) throw new Error('AI_RECOMMENDATION_INVALID')
  return { items, usage: result.usage }
}

async function chat(messages, contextSummary) {
  const system = '你是“问风月”。温和、克制、略有诗意，但回答清楚具体，不说教、不诊断。娱乐和休息也是正常生活。若用户要求创建行动或计划，只提出草稿，绝不声称已保存。只返回 JSON：{"reply":"给用户的话","draft":null}；若有草稿，draft 为 {"type":"action或plan","name":"","domainId":"rest|health|learn|career|travel|connect|create|daily","minutes":30,"why":""}。'
  const safeMessages = messages.slice(-12).map(({ role, content }) => ({ role, content }))
  const result = await generate([{ role: 'system', content: `${system}\n可用的非敏感摘要：${JSON.stringify(contextSummary)}` }, ...safeMessages])
  return { ...extractJson(result.text), usage: result.usage }
}

async function review(footprints, rangeLabel) {
  const data = footprints.map(({ actionName, domainName, minutes, feeling, note, createdAt }) => ({ actionName, domainName, minutes, feeling, note, createdAt }))
  const system = '你为“风月为邻”生成生活回顾。只描述发生过的事情、感受与温和可能性，不打分、不制造负罪感、不制定目标。周回顾 150-300 字。只返回 JSON：{"content":""}。'
  const result = await generate([{ role: 'system', content: system }, { role: 'user', content: JSON.stringify({ rangeLabel, footprints: data }) }])
  return { ...extractJson(result.text), usage: result.usage }
}

module.exports = { isReady, recommend, chat, review }
