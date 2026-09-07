function changed(page) {
  page.dirty = true
  if (wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '内容还没保存，确定离开吗？' })
}
function saved(page) {
  page.dirty = false
  if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload()
}
function guard(page) {
  if (require('./repository').canApply(page.token)) return true
  if (wx.showToast) wx.showToast({ title: '数据已变化，请重新打开后操作', icon: 'none' })
  if (wx.switchTab) wx.switchTab({ url: '/pages/now/index' })
  return false
}
module.exports = { changed, saved, guard }
