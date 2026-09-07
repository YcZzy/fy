const path = require('node:path')
const Module = require('node:module')
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

function fixture() {
  const documents = new Map()
  let owner = 'user-a', serial = Promise.resolve(), counter = 0
  const adminDeletes = []
  function collection(name) {
    if (!documents.has(name)) documents.set(name, new Map())
    const rows = documents.get(name)
    return {
      where(query) {
        let offset = 0, limit = 100
        return {
          skip(value) { offset = value; return this }, limit(value) { limit = value; return this },
          async get() { return { data: [...rows.values()].filter((item) => Object.entries(query).every(([key, value]) => item[key] === value)).slice(offset, offset + limit).map(copy) } }
        }
      },
      doc(id) {
        return {
          async get() { return { data: copy(rows.get(id)) || null } },
          async set({ data }) { rows.set(id, { ...copy(data), _id: id }) },
          async update({ data }) { if (!rows.has(id)) throw new Error('document not found'); rows.set(id, { ...rows.get(id), ...copy(data) }) },
          async remove() { rows.delete(id) }
        }
      },
      async add({ data }) { const id = 'doc-' + (++counter); rows.set(id, { ...copy(data), _id: id }); return { _id: id } }
    }
  }
  const db = {
    collection, async createCollection(name) { collection(name) },
    runTransaction(fn) {
      const run = serial.catch(() => {}).then(async () => {
        const snapshot = new Map([...documents].map(([name, rows]) => [name, new Map([...rows].map(([id, row]) => [id, copy(row)]))]))
        try { return await fn({ collection }) }
        catch (error) { documents.clear(); snapshot.forEach((rows, name) => documents.set(name, rows)); throw error }
      })
      serial = run; return run
    }
  }
  const sdk = { init() {}, database: () => db, getWXContext: () => ({ OPENID: owner }), DYNAMIC_CURRENT_ENV: 'isolated-test', async deleteFile(options) { adminDeletes.push(options); throw new Error('Administrative file deletion must not be used') } }
  const originalLoad = Module._load
  const modulePath = path.resolve(__dirname, '../../cloudfunctions/dataManager/index.js')
  Module._load = function (request, parent, isMain) { return request === 'wx-server-sdk' ? sdk : originalLoad.call(this, request, parent, isMain) }
  let main
  try { delete require.cache[modulePath]; main = require(modulePath).main } finally { Module._load = originalLoad }
  return {
    documents, adminDeletes, db,
    async call(event, openid = 'user-a') { owner = openid; return main(event) },
    rows(name) { return [...(documents.get(name) || new Map()).values()].map(copy) },
    async seed(name, value) { return collection(name).add({ data: value }) }
  }
}
module.exports = { fixture }
