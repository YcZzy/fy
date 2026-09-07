const TABS = [
  {
    pagePath: '/pages/now/index',
    text: '此刻',
    tone: 'apricot',
    icon: '/assets/tab/now.svg',
    activeIcon: '/assets/tab/now-active.svg'
  },
  {
    pagePath: '/pages/moon/index',
    text: '风月',
    tone: 'mist',
    icon: '/assets/tab/moon.svg',
    activeIcon: '/assets/tab/moon-active.svg'
  },
  {
    pagePath: '/pages/footprints/index',
    text: '足迹',
    tone: 'sage',
    icon: '/assets/tab/footprints.svg',
    activeIcon: '/assets/tab/footprints-active.svg'
  }
]

Component({
  data: {
    selected: 0,
    tabs: TABS
  },

  lifetimes: {
    attached() { this.syncSelected() }
  },

  pageLifetimes: {
    show() { this.syncSelected() }
  },

  methods: {
    syncSelected() {
      const pages = getCurrentPages()
      const route = pages.length ? `/${pages[pages.length - 1].route}` : ''
      const selected = TABS.findIndex((item) => item.pagePath === route)
      if (selected >= 0 && selected !== this.data.selected) this.setData({ selected })
    },

    switchTab(event) {
      const index = Number(event.currentTarget.dataset.index)
      const target = TABS[index]
      if (!target || index === this.data.selected) return
      this.setData({ selected: index })
      wx.switchTab({ url: target.pagePath })
    }
  }
})
