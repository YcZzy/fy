const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTIONS = ['user_preferences', 'life_domains', 'actions', 'plans', 'wishes', 'footprints', 'reviews', 'ai_conversations', 'ai_usage']
const SYNC_COLLECTIONS = COLLECTIONS.filter((name) => name !== 'ai_usage')

async function initializeCollections() {
  const results = await Promise.all(COLLECTIONS.map(async (name) => {
    try {
      await db.createCollection(name)
      return { name, status: 'created' }
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      const code = error && (error.errCode || error.code)
      const exists = /already exists|exist|duplicate/i.test(message) || code === -502004
      return { name, status: exists ? 'exists' : 'failed', code, message }
    }
  }))
  const failed = results.filter((item) => item.status === 'failed')
  return { code: failed.length ? -1 : 0, results }
}

async function getAllOwned(collection, openid) {
  const records = []
  let offset = 0
  while (true) {
    const result = await db.collection(collection).where({ _openid: openid }).skip(offset).limit(100).get()
    records.push(...result.data)
    if (result.data.length < 100) break
    offset += result.data.length
  }
  return records
}

async function removeOwned(collection, openid) {
  while (true) {
    const result = await db.collection(collection).where({ _openid: openid }).limit(100).get()
    if (!result.data.length) break
    await Promise.all(result.data.map((item) => db.collection(collection).doc(item._id).remove()))
  }
}

async function loadOwnedData(openid) {
  const results = await Promise.all(SYNC_COLLECTIONS.map(async (name) => {
    try { return { name, documents: await getAllOwned(name, openid) } }
    catch (error) {
      return { name, documents: [], error: error && error.message ? error.message : String(error) }
    }
  }))
  const failed = results.filter((item) => item.error)
  return {
    code: failed.length ? -1 : 0,
    data: results.reduce((all, item) => { all[item.name] = item.documents; return all }, {}),
    errors: failed.map((item) => ({ name: item.name, message: item.error }))
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) throw new Error('UNAUTHENTICATED')
  if (event.action === 'initialize' && event.confirm === 'CREATE_COLLECTIONS') return initializeCollections()
  if (event.action === 'load') return loadOwnedData(OPENID)
  if (event.action !== 'deleteAll' || event.confirm !== 'DELETE_MY_DATA') throw new Error('INVALID_CONFIRMATION')

  const footprints = await getAllOwned('footprints', OPENID).catch(() => [])
  const fileList = footprints.reduce((all, item) => all.concat(item.photoFileIds || []), [])
  if (fileList.length) await cloud.deleteFile({ fileList })
  for (const collection of COLLECTIONS) await removeOwned(collection, OPENID).catch((error) => console.warn(`skip ${collection}`, error.message))
  return { deleted: true, collections: COLLECTIONS.length, files: fileList.length }
}
