const path = require('path')

const { createInitialState } = require(path.resolve(__dirname, '../miniprogram/data/defaults.js'))
const recommender = require(path.resolve(__dirname, '../miniprogram/services/recommender.js'))
const { createRecommendationState } = require('./helpers/recommendation-fixture')

const state = createRecommendationState()
const context = { minutes: 30, energy: 'medium', environment: 'home', locationSummary: '', note: '今晚不想学习' }
const recommendations = recommender.recommend(state, context)
if (!recommendations.length) throw new Error('用户已有可用行动时应能推荐')
if (recommender.recommend(createInitialState(), context).length) throw new Error('空行动库不得凭空生成预设推荐')
if (recommendations.some((item) => ['learn', 'career'].includes(item.domainId))) throw new Error('否定学习意图时不应推荐学习或考试')

const parsed = recommender.intentDomains('今晚不想出门，只想玩游戏')
if (!parsed.exclude.includes('travel') || !parsed.exclude.includes('health')) throw new Error('不想出门应排除户外板块')
if (!parsed.include.includes('rest')) throw new Error('只想玩游戏应保留娱乐意图')

state.declinedActions = [{ actionId: 'a_song', contextKey: recommender.contextKey(context), declinedAt: Date.now() }]
if (recommender.isEligible(state.actions.find((item) => item.id === 'a_song'), state, context)) throw new Error('同一上下文刚拒绝的行动不应立刻再次出现')

const aiItems = Array.from({ length: 5 }, (_, index) => ({ name: `学习行动${index}`, domainId: 'learn', minutes: 10 }))
if (recommender.normalizeAiRecommendations(aiItems, state, context).length) throw new Error('AI 结果也必须服从否定意图')

const mismatched = recommender.normalizeAiRecommendations([{ name: '收拾桌面十分钟', domainId: 'daily', minutes: 10, planId: 'p_english' }], state, { minutes: 30, energy: 'medium', environment: 'home', locationSummary: '', note: '' })
if (mismatched[0] && mismatched[0].planId) throw new Error('AI 行动不能关联到不同板块的计划')

const endedState = createInitialState()
endedState.plans = [{ id: 'p_ended', name: '已经结束的体验', domainId: 'daily', status: 'ended', focused: true, actionIds: ['a_ended'] }]
endedState.actions = [{ id: 'a_ended', name: '旧计划行动', domainId: 'daily', minutes: 10, energy: ['medium'], environments: ['home'] }]
const endedRecommendations = recommender.recommend(endedState, { minutes: 30, energy: 'medium', environment: 'home', locationSummary: '', note: '' })
if (endedRecommendations.some((item) => item.reason === '从最近关注的计划里，轻轻往前走一步。')) throw new Error('已结束计划不应继续获得关注推荐')

console.log('推荐回归通过：否定意图、娱乐选择、临时拒绝及已结束计划过滤均按预期处理。')
