function pad(value) { return String(value).padStart(2, '0') }
function dateKey(timestamp) {
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
function dateLabel(timestamp) {
  const d = new Date(timestamp)
  const today = dateKey(Date.now())
  const target = dateKey(timestamp)
  if (target === today) return '今天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
function duration(minutes) {
  if (minutes === null || minutes === undefined) return '未记录时长'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}
function greeting() {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了，慢一点也很好'
  if (hour < 11) return '早上好，给今天留一点余地'
  if (hour < 14) return '中午好，歇一会儿吧'
  if (hour < 18) return '下午好，放慢呼吸，让阳光正好穿过'
  return '晚上好，把空闲还给生活'
}
function uid(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` }

module.exports = { dateKey, dateLabel, duration, greeting, uid }
