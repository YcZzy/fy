const { uid } = require('./format')

const DOMAIN_GROUPS = {
  focus: ['learn', 'career', 'travel', 'connect', 'create'],
  body: ['health', 'travel'],
  rest: ['rest'],
  light: ['daily', 'connect', 'create']
}

function contextKey(context) {
  return [context.minutes, context.energy, context.environment, (context.note || '').trim().toLowerCase()].join('|')
}

function withPresentation(action, state, reason) {
  const domain = state.domains.find((item) => item.id === action.domainId)
  const plan = state.plans.find((item) => item.id === action.planId)
  return {
    ...action,
    domainName: domain ? domain.name : '生活',
    domainColor: domain ? domain.color : '#75806B',
    planName: plan ? plan.name : '',
    reason: reason || '它与此刻的时间和状态刚好合拍。',
    locationNote: action.environments.includes('location') ? '仅提供活动类别，请自行确认具体地点与营业信息。' : ''
  }
}

function intentDomainIds(note) {
  const value = (note || '').toLowerCase()
  if (/只想休息|不想动|放松|娱乐|游戏|短剧/.test(value)) return ['rest']
  if (/只想出去|出门|户外|走走|散步/.test(value)) return ['health', 'travel']
  if (/学习|看书|英语|考试|考公/.test(value)) return ['learn', 'career']
  if (/朋友|聊天|社交|联系/.test(value)) return ['connect']
  return []
}

function eligibleActions(state, context) {
  const declined = new Set(state.declinedActionIds.slice(-12))
  return state.actions.filter((action) => {
    if (action.hidden || declined.has(action.id)) return false
    if (action.minutes > context.minutes) return false
    if (!action.energy.includes(context.energy)) return false
    if (!['any', 'location', 'manual'].includes(context.environment) && !action.environments.includes(context.environment) && !action.environments.includes('any')) return false
    if (context.environment === 'location' && !action.environments.some((item) => ['outdoor', 'location', 'any'].includes(item))) return false
    return true
  })
}

function recentPenalty(action, state) {
  const recent = state.footprints.slice(0, 8)
  const index = recent.findIndex((item) => item.actionId === action.id)
  return index < 0 ? 0 : 20 - index * 2
}

function score(action, state, context) {
  let value = 100 - Math.abs(context.minutes - action.minutes) * 0.35
  const plan = state.plans.find((item) => item.id === action.planId)
  if (plan && plan.focused) value += 26
  if (action.minutes <= 15) value += 8
  if (context.energy === 'low' && action.energy.includes('low')) value += 10
  value -= recentPenalty(action, state)
  return value + Math.random() * 6
}

function pick(items, used, predicate) {
  const found = items.find((item) => !used.has(item.id) && predicate(item))
  if (found) used.add(found.id)
  return found
}

function recommend(state, context) {
  let candidates = eligibleActions(state, context).sort((a, b) => score(b, state, context) - score(a, state, context))
  if (candidates.length < 5) {
    const extras = state.actions.filter((item) => !item.hidden && !candidates.some((candidate) => candidate.id === item.id) && item.minutes <= context.minutes)
    candidates = candidates.concat(extras)
  }
  const intents = intentDomainIds(context.note)
  if (intents.length) candidates.sort((a, b) => Number(intents.includes(b.domainId)) - Number(intents.includes(a.domainId)))

  const used = new Set()
  const chosen = []
  const add = (item, reason) => { if (item) chosen.push(withPresentation(item, state, reason)) }

  if (intents.length) {
    candidates.filter((item) => intents.includes(item.domainId)).slice(0, 5).forEach((item) => add(pick(candidates, used, (x) => x.id === item.id), '你刚才说的，更像是想把时间交给这件事。'))
  } else {
    add(pick(candidates, used, (item) => state.plans.some((plan) => plan.focused && plan.id === item.planId)), '从最近惦记的事情里，轻轻往前走一步。')
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
  const planIds = new Set(state.plans.map((item) => item.id))
  const domainIds = new Set(state.domains.map((item) => item.id))
  return rawItems.filter((item) => item && typeof item.name === 'string' && item.name.trim().length >= 3)
    .map((item) => ({
      id: uid('ai_action'),
      name: item.name.trim().slice(0, 30),
      domainId: domainIds.has(item.domainId) ? item.domainId : 'daily',
      minutes: Math.max(5, Math.min(context.minutes, Number(item.minutes) || context.minutes)),
      energy: [context.energy],
      environments: [context.environment],
      preparation: String(item.preparation || '不需要额外准备').slice(0, 50),
      planId: planIds.has(item.planId) ? item.planId : '',
      source: 'ai',
      reason: String(item.reason || '它与此刻的状态刚好合拍。').slice(0, 70),
      locationNote: String(item.locationNote || '').slice(0, 70)
    }))
    .filter((item) => item.minutes <= context.minutes)
    .slice(0, 5)
    .map((item) => withPresentation(item, state, item.reason))
}

module.exports = { contextKey, recommend, normalizeAiRecommendations }
