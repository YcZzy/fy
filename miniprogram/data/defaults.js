function createInitialState() {
  const now = Date.now()
  return {
    version: 4,
    preferences: {
      onboardingComplete: false,
      selectedInterests: [],
      lastContext: { minutes: 30, energy: 'medium', environment: 'any', note: '', locationSummary: '' },
      reminders: {},
      updatedAt: 0
    },
    domains: [],
    actions: [],
    plans: [],
    wishes: [],
    footprints: [],
    reviews: [],
    conversations: [],
    activeSession: null,
    pendingAction: null,
    recommendationCache: null,
    declinedActions: [],
    pendingFileDeletes: [],
    syncQueue: [],
    syncTombstones: {},
    cloudEpoch: 0,
    dataToken: `${now}_${Math.random().toString(36).slice(2)}`,
    deletionPending: false,
    lastSyncedAt: 0
  }
}

module.exports = { createInitialState }
