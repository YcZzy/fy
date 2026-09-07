const THEMES = {
  now: { navigationBarBackgroundColor: '#F7F0EA', backgroundColor: '#F4EFE7' },
  moon: { navigationBarBackgroundColor: '#EDF3F4', backgroundColor: '#F4EFE7' },
  footprints: { navigationBarBackgroundColor: '#EEF3EF', backgroundColor: '#F4EFE7' }
}

function normalize(value) {
  return Object.prototype.hasOwnProperty.call(THEMES, value) ? value : 'now'
}

function fromOptions(options = {}) {
  return normalize(options.theme)
}

function withTheme(url, value) {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}theme=${normalize(value)}`
}

function apply(value) {
  const current = THEMES[normalize(value)]
  wx.setNavigationBarColor({
    frontColor: '#000000',
    backgroundColor: current.navigationBarBackgroundColor,
    animation: { duration: 0, timingFunc: 'easeIn' }
  })
  wx.setBackgroundColor({
    backgroundColor: current.backgroundColor,
    backgroundColorTop: current.navigationBarBackgroundColor,
    backgroundColorBottom: current.backgroundColor
  })
}

module.exports = { normalize, fromOptions, withTheme, apply }
