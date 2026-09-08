const { createInitialState } = require('../../miniprogram/data/defaults')

function createRecommendationState() {
  const state = createInitialState()
  state.domains = ['rest', 'health', 'learn', 'daily'].map(id => ({ id, name: id }))
  state.actions = [
    { id: 'a_walk', name: '测试散步', domainId: 'health', minutes: 20 },
    { id: 'a_song', name: '测试听歌', domainId: 'rest', minutes: 5 },
    { id: 'a_read', name: '测试阅读', domainId: 'learn', minutes: 10 },
    { id: 'a_tidy', name: '测试整理', domainId: 'daily', minutes: 10 }
  ].map(item => ({ ...item, energy: ['low', 'medium', 'high'], environments: ['any'], preparation: '', source: 'user' }))
  return state
}

module.exports = { createRecommendationState }
