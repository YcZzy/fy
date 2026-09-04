const path = require('path')

const { createInitialState } = require(path.resolve(__dirname, '../miniprogram/data/defaults.js'))
const recommender = require(path.resolve(__dirname, '../miniprogram/services/recommender.js'))

const state = createInitialState()
const context = { minutes: 30, energy: 'medium', environment: 'home', locationSummary: '', note: '今晚不想学习' }
const recommendations = recommender.recommend(state, context)
if (recommendations.some((item) => ['learn', 'career'].includes(item.domainId))) throw new Error('否定学习意图时不应推荐学习或考试')

const parsed = recommender.intentDomains('今晚不想出门，只想玩游戏')
if (!parsed.exclude.includes('travel') || !parsed.exclude.includes('health')) throw new Error('不想出门应排除户外板块')
if (!parsed.include.includes('rest')) throw new Error('只想玩游戏应保留娱乐意图')

state.declinedActions = [{ actionId: 'a_song', contextKey: recommender.contextKey(context), declinedAt: Date.now() }]
if (recommender.isEligible(state.actions.find((item) => item.id === 'a_song'), state, context)) throw new Error('同一上下文刚拒绝的行动不应立刻再次出现')

const aiItems = Array.from({ length: 5 }, (_, index) => ({ name: `学习行动${index}`, domainId: 'learn', minutes: 10 }))
if (recommender.normalizeAiRecommendations(aiItems, state, context).length) throw new Error('AI 结果也必须服从否定意图')

console.log('推荐回归通过：否定意图、娱乐选择和临时拒绝均按预期处理。')
