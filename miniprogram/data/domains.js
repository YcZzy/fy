const SYSTEM_DOMAINS = [
  { id: 'rest', name: '休闲娱乐', color: '#A87562' },
  { id: 'health', name: '运动健康', color: '#718C78' },
  { id: 'learn', name: '学习成长', color: '#70859A' },
  { id: 'career', name: '工作事业', color: '#8B7D70' },
  { id: 'travel', name: '旅行探索', color: '#6F9090' },
  { id: 'connect', name: '社交陪伴', color: '#AA7B79' },
  { id: 'create', name: '创作表达', color: '#89799C' },
  { id: 'daily', name: '日常生活', color: '#8A8A68' }
]

function allDomains(personalDomains = []) {
  const byId = new Map(SYSTEM_DOMAINS.map((item) => [item.id, { ...item, system: true }]))
  personalDomains.filter((item) => item && item.id && !item.hidden).forEach((item) => {
    byId.set(item.id, { ...(byId.get(item.id) || {}), ...item })
  })
  return [...byId.values()]
}

function findDomain(personalDomains, id) {
  if (!id) return null
  return allDomains(personalDomains).find((item) => item.id === id) || null
}

function usedDomains(state) {
  const used = new Set([
    ...(state.actions || []).filter((item) => !item.hidden).map((item) => item.domainId),
    ...(state.plans || []).map((item) => item.domainId)
  ].filter(Boolean))
  return allDomains(state.domains).filter((item) => used.has(item.id))
}

module.exports = { SYSTEM_DOMAINS, allDomains, findDomain, usedDomains }
