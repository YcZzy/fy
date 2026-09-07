const DOMAINS = [
  { id: 'rest', name: '休息娱乐', icon: '月', color: '#A96542', order: 1 },
  { id: 'health', name: '身体健康', icon: '叶', color: '#75806B', order: 2 },
  { id: 'learn', name: '学习见识', icon: '书', color: '#9B7653', order: 3 },
  { id: 'career', name: '职业探索', icon: '路', color: '#70808A', order: 4 },
  { id: 'travel', name: '外出旅行', icon: '风', color: '#A87562', order: 5 },
  { id: 'connect', name: '人际连接', icon: '伴', color: '#9B6A62', order: 6 },
  { id: 'create', name: '兴趣创作', icon: '光', color: '#B28A54', order: 7 },
  { id: 'daily', name: '日常整理', icon: '居', color: '#7F776C', order: 8 }
]

const ACTIONS = [
  { id: 'a_walk', name: '下楼散步 20 分钟', domainId: 'health', minutes: 20, energy: ['low','medium','high'], environments: ['outdoor','any'], preparation: '穿一双舒服的鞋', source: 'system' },
  { id: 'a_stretch', name: '跟着呼吸舒展身体', domainId: 'health', minutes: 10, energy: ['low','medium','high'], environments: ['home','any'], preparation: '留出一小块空地', source: 'system' },
  { id: 'a_english', name: '听一段 15 分钟英语', domainId: 'learn', minutes: 15, energy: ['medium','high'], environments: ['home','commute','any'], preparation: '耳机', source: 'system' },
  { id: 'a_city', name: '了解一座城市的生活成本', domainId: 'travel', minutes: 30, energy: ['medium','high'], environments: ['home','any'], preparation: '选一座最近好奇的城市', source: 'system' },
  { id: 'a_friend', name: '给一位朋友发条近况', domainId: 'connect', minutes: 10, energy: ['low','medium','high'], environments: ['home','commute','any'], preparation: '想起一个人就够了', source: 'system' },
  { id: 'a_game', name: '安心玩一小时游戏', domainId: 'rest', minutes: 60, energy: ['low','medium','high'], environments: ['home'], preparation: '选一款现在想玩的', source: 'system' },
  { id: 'a_drama', name: '看两集喜欢的短剧', domainId: 'rest', minutes: 30, energy: ['low','medium'], environments: ['home','commute'], preparation: '不需要额外准备', source: 'system' },
  { id: 'a_read', name: '随手读十页书', domainId: 'learn', minutes: 20, energy: ['low','medium','high'], environments: ['home','commute','any'], preparation: '手边的一本书', source: 'system' },
  { id: 'a_tidy', name: '只整理一个小角落', domainId: 'daily', minutes: 10, energy: ['low','medium','high'], environments: ['home'], preparation: '从桌面或床边开始', source: 'system' },
  { id: 'a_exam', name: '做 20 道行测题', domainId: 'career', minutes: 30, energy: ['medium','high'], environments: ['home','any'], preparation: '题库或纸笔', source: 'system' },
  { id: 'a_photo', name: '拍下今晚的一束光', domainId: 'create', minutes: 10, energy: ['low','medium','high'], environments: ['home','outdoor','any'], preparation: '手机', source: 'system' },
  { id: 'a_song', name: '闭上眼听完一首歌', domainId: 'rest', minutes: 5, energy: ['low','medium','high'], environments: ['home','commute','any'], preparation: '一首现在想听的歌', source: 'system' },
  { id: 'a_tea', name: '慢慢喝一杯水或热茶', domainId: 'rest', minutes: 10, energy: ['low','medium','high'], environments: ['home','any'], preparation: '给自己倒一杯喜欢的饮品', source: 'system' },
  { id: 'a_roam', name: '沿一条没走过的小路逛逛', domainId: 'travel', minutes: 30, energy: ['medium','high'], environments: ['outdoor','location'], preparation: '只走熟悉且安全的公共区域', source: 'system' },
  { id: 'a_air', name: '到楼下吹十分钟晚风', domainId: 'health', minutes: 10, energy: ['low','medium','high'], environments: ['outdoor','location'], preparation: '留意天气与安全', source: 'system' },
  { id: 'a_cafe', name: '去附近找个地方坐坐', domainId: 'travel', minutes: 120, energy: ['medium','high'], environments: ['outdoor','location'], preparation: '只推荐地点类别，请自行确认营业信息', source: 'system' }
]

const PLANS = [
  { id: 'p_english', name: '六周英语体验', domainId: 'learn', why: '想看看外语能否重新进入日常', status: 'active', focused: true, actionIds: ['a_english'], createdAt: Date.now() - 86400000 * 4, updatedAt: Date.now() - 86400000 },
  { id: 'p_beijing', name: '北京街区探索', domainId: 'travel', why: '多认识一些下班后也能去的地方', status: 'want', focused: true, actionIds: [], createdAt: Date.now() - 86400000 * 2, updatedAt: Date.now() - 86400000 * 2 }
]

function createInitialState() {
  const now = Date.now()
  return {
    version: 4,
    preferences: {
      onboardingComplete: false,
      selectedInterests: [],
      lastContext: { minutes: 30, energy: 'medium', environment: 'any', note: '', locationSummary: '' },
      reminders: {},
      updatedAt: now
    },
    domains: DOMAINS,
    actions: ACTIONS,
    plans: PLANS,
    wishes: [{ id: 'w_city', text: '想去别的城市住几天', createdAt: now }],
    footprints: [],
    reviews: [],
    conversations: [],
    activeSession: null,
    pendingAction: null,
    recommendationCache: null,
    declinedActions: [],
    pendingFileDeletes: [],
    syncQueue: [],
    syncTombstones: {}
  }
}

module.exports = { DOMAINS, ACTIONS, PLANS, createInitialState }
