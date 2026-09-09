const { uid } = require('./format')
const domainCatalog = require('../data/domains')

const DOMAIN_GROUPS = {
  focus: ['learn', 'career', 'travel', 'connect', 'create'],
  body: ['health', 'travel'],
  rest: ['rest'],
  light: ['daily', 'connect', 'create']
}

const INTEREST_DOMAINS = {
  '游戏': 'rest', '短剧影视': 'rest', '短视频': 'rest', '什么也不做': 'rest',
  '健身': 'health', '散步': 'health', '外语': 'learn', '考证': 'learn', '阅读': 'learn',
  '考公': 'career', '旅行': 'travel', '城市探索': 'travel', '社交': 'connect', '创作': 'create'
}

function contextKey(context) {
  return [context.minutes, context.energy, context.environment, (context.locationSummary || '').trim().toLowerCase(), (context.note || '').trim().toLowerCase()].join('|')
}

function withPresentation(action, state, reason) {
  const domain = domainCatalog.findDomain(state.domains, action.domainId)
  const plan = state.plans.find((item) => item.id === action.planId) || state.plans.find((item) => item.focused && !['ended', 'paused'].includes(item.status) && (item.actionIds || []).includes(action.id)) || state.plans.find((item) => (item.actionIds || []).includes(action.id))
  return {
    ...action,
    domainName: domain ? domain.name : '生活',
    domainColor: domain ? domain.color : '#75806B',
    planId: plan ? plan.id : (action.planId || ''),
    planName: plan ? plan.name : '',
    reason: reason || '它与此刻的时间和状态刚好合拍。',
    locationNote: action.environments.includes('location') ? '仅提供活动类别，请自行确认具体地点与营业信息。' : ''
  }
}

function intentDomains(note) {
  const value = (note || '').toLowerCase()
  const exclude = new Set()
  if (/不想学习|不想看书|不想英语|不想考试|不想考公/.test(value)) { exclude.add('learn'); exclude.add('career') }
  if (/不想动|不想运动|不想健身/.test(value)) exclude.add('health')
  if (/不想出门|不想出去|不想户外/.test(value)) travelAndHealth(exclude)
  if (/不想社交|不想聊天|不想联系/.test(value)) exclude.add('connect')
  if (/不想娱乐|不想玩游戏|不想看短剧|不想刷视频/.test(value)) exclude.add('rest')

  const include = []
  if (/只想休息|放松|想娱乐|想玩游戏|想看短剧/.test(value) && !exclude.has('rest')) include.push('rest')
  if (/只想出去|想出门|想户外|想走走|想散步/.test(value) && !exclude.has('travel')) include.push('health', 'travel')
  if (/想学习|想看书|想学英语|想考试|想考公/.test(value)) include.push('learn', 'career')
  if (/想见朋友|想聊天|想社交|想联系/.test(value) && !exclude.has('connect')) include.push('connect')
  return { include: [...new Set(include)].filter((id) => !exclude.has(id)), exclude: [...exclude] }
}

function travelAndHealth(set) { set.add('travel'); set.add('health') }

function declinedIds(state, context) {
  const key = contextKey(context)
  const cutoff = Date.now() - 2 * 60 * 60 * 1000
  return new Set((state.declinedActions || []).filter((item) => item.declinedAt >= cutoff && (!item.contextKey || item.contextKey === key)).map((item) => item.actionId))
}

function isEligible(action, state, context, options = {}) {
  if (!action || action.hidden || action.minutes > context.minutes || !action.energy.includes(context.energy)) return false
  if (!options.ignoreDeclined && declinedIds(state, context).has(action.id)) return false
  if (!['any', 'location', 'manual'].includes(context.environment) && !action.environments.includes(context.environment) && !action.environments.includes('any')) return false
  if (['location', 'manual'].includes(context.environment) && !action.environments.some((item) => ['outdoor', 'location', 'any'].includes(item))) return false
  return true
}

function eligibleActions(state, context) {
  return state.actions.filter((action) => isEligible(action, state, context))
}

function recentPenalty(action, state) {
  const recent = state.footprints.slice(0, 8)
  const index = recent.findIndex((item) => item.actionId === action.id)
  return index < 0 ? 0 : 20 - index * 2
}

function score(action, state, context) {
  let value = 100 - Math.abs(context.minutes - action.minutes) * 0.35
  const focused = state.plans.some((item) => item.focused && !['ended', 'paused'].includes(item.status) && (item.actionIds || []).includes(action.id))
  if (focused) value += 26
  if (action.minutes <= 15) value += 8
  if (context.energy === 'low' && action.energy.includes('low')) value += 10
  const selectedDomains = new Set((state.preferences.selectedInterests || []).map((item) => INTEREST_DOMAINS[item]).filter(Boolean))
  if (selectedDomains.has(action.domainId)) value += 14
  value -= recentPenalty(action, state)
  const lastPreference = state.footprints.find((item) => item.actionId === action.id && item.doAgain)
  if (lastPreference && lastPreference.doAgain === 'no') value -= 30
  if (lastPreference && lastPreference.doAgain === 'yes') value += 10
  return value + Math.random() * 6
}

function pick(items, used, predicate) {
  const found = items.find((item) => !used.has(item.id) && predicate(item))
  if (found) used.add(found.id)
  return found
}

function recommend(state, context, options = {}) {
  const previous = new Set(options.previousIds || [])
  let candidates = eligibleActions(state, context).map((item) => ({ item, score: score(item, state, context) - (previous.has(item.id) ? 100 : 0) })).sort((a, b) => b.score - a.score).map((entry) => entry.item)
  const intents = intentDomains(context.note)
  candidates = candidates.filter((item) => !intents.exclude.includes(item.domainId))
  if (intents.include.length) candidates.sort((a, b) => Number(intents.include.includes(b.domainId)) - Number(intents.include.includes(a.domainId)))

  const used = new Set()
  const chosen = []
  const add = (item, reason) => { if (item) chosen.push(withPresentation(item, state, reason)) }

  if (intents.include.length) {
    candidates.filter((item) => intents.include.includes(item.domainId)).slice(0, 5).forEach((item) => add(pick(candidates, used, (x) => x.id === item.id), '你刚才说的，更像是想把时间交给这件事。'))
  } else {
    add(pick(candidates, used, (item) => state.plans.some((plan) => plan.focused && !['ended', 'paused'].includes(plan.status) && (plan.actionIds || []).includes(item.id))), '从最近关注的计划里，轻轻往前走一步。')
    add(pick(candidates, used, (item) => item.minutes <= 15 || DOMAIN_GROUPS.light.includes(item.domainId)), '门槛不高，现在开始也来得及。')
    add(pick(candidates, used, (item) => DOMAIN_GROUPS.body.includes(item.domainId)), '让身体和眼睛换一换此刻的风景。')
    add(pick(candidates, used, (item) => DOMAIN_GROUPS.focus.includes(item.domainId)), '也许可以把一点时间交给好奇心。')
    add(pick(candidates, used, (item) => DOMAIN_GROUPS.rest.includes(item.domainId)), '主动选择休息，本身也是在照顾生活。')
  }
  candidates.forEach((item) => { if (chosen.length < 5) add(pick(candidates, used, (x) => x.id === item.id)) })
  return chosen.slice(0, 5)
}

function normalizeAiRecommendations(rawItems, state, context) {
  if (!Array.isArray(rawItems)) return []
  const domainIds = new Set(domainCatalog.allDomains(state.domains).map((item) => item.id))
  const intents = intentDomains(context.note); const used = new Set(); const names = new Set()
  return rawItems.filter((item) => item && typeof item.name === 'string' && item.name.trim().length >= 2).map((item) => {
    const name = item.name.trim().slice(0, 30)
    const existing = state.actions.find((value) => value.id === item.actionId || value.id === item.id) || state.actions.find((value) => value.name.trim().toLowerCase() === name.toLowerCase())
    const domainId = existing ? existing.domainId : (domainIds.has(item.domainId) ? item.domainId : '')
    const plan = state.plans.find((value) => value.id === item.planId && !['ended', 'paused'].includes(value.status) && value.domainId === domainId)
    const action = existing ? { ...existing } : {
      id: uid('ai_action'), name, domainId,
      minutes: Math.max(1, Math.min(context.minutes, Math.round(Number(item.minutes) || context.minutes))),
      energy: [context.energy], environments: [['location', 'manual'].includes(context.environment) ? 'location' : context.environment],
      preparation: String(item.preparation || '不需要额外准备').slice(0, 60), source: 'ai'
    }
    return { ...action, planId: plan ? plan.id : '', reason: String(item.reason || '它与此刻的状态刚好合拍。').slice(0, 100) }
  }).filter((item) => {
    const key = item.name.trim().toLowerCase()
    if (!isEligible(item, state, context) || intents.exclude.includes(item.domainId) || used.has(item.id) || names.has(key)) return false
    used.add(item.id); names.add(key); return true
  }).slice(0, 5).map((item) => withPresentation(item, state, item.reason))
}
module.exports = { contextKey, recommend, normalizeAiRecommendations, isEligible, intentDomains }
