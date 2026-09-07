const format = require('./format')
function summarize(records) {
  const participated = records.filter((item) => item.completionStatus !== 'not_started')
  const timed = participated.filter((item) => Number.isFinite(item.minutes) && item.minutes >= 0)
  const byDomain = {}; const byAction = {}; const feelings = { love: 0, good: 0, okay: 0, poor: 0 }
  participated.forEach((item) => {
    const domain = byDomain[item.domainId] || (byDomain[item.domainId] = { name: item.domainName || '生活', count: 0, minutes: 0, timed: 0 })
    domain.count += 1
    if (Number.isFinite(item.minutes)) { domain.minutes += item.minutes; domain.timed += 1 }
    byAction[item.actionName] = (byAction[item.actionName] || 0) + 1
    if (feelings[item.feeling] !== undefined) feelings[item.feeling] += 1
  })
  return {
    count: records.length, participatedCount: participated.length, notStartedCount: records.length - participated.length,
    unknownDurationCount: participated.length - timed.length,
    totalDuration: timed.length ? format.duration(timed.reduce((sum, item) => sum + item.minutes, 0)) : '未记录时长',
    domains: Object.values(byDomain).sort((a, b) => b.minutes - a.minutes).map((item) => ({ ...item, duration: item.timed ? format.duration(item.minutes) : '未记录时长' })),
    feelings,
    favorite: Object.keys(byAction).filter((name) => byAction[name] > 1).sort((a, b) => byAction[b] - byAction[a])[0] || '还没有反复出现的事情'
  }
}
module.exports = { summarize }
