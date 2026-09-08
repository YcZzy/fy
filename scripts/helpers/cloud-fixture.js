const path = require('node:path')
const Module = require('node:module')
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

function fixture(options = {}) {
  const documents = new Map()
  const operations = { queryReads: 0, documentReads: 0, documentRemoves: 0, bulkRemoves: 0, transactions: 0 }
  const command = {
    lt: value => ({ operation: 'lt', value }),
    exists: value => ({ operation: 'exists', value }),
    or: conditions => ({ operation: 'or', conditions })
  }
  function matches(item, query) {
    if (query.operation === 'or') return query.conditions.some(condition => matches(item, condition))
    return Object.entries(query).every(([key, value]) => {
      if (value && value.operation === 'lt') return typeof item[key] === 'number' && item[key] < value.value
      if (value && value.operation === 'exists') return Object.prototype.hasOwnProperty.call(item, key) === value.value
      return item[key] === value
    })
  }
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
          async get() { operations.queryReads += 1; return { data: [...rows.values()].filter(item => matches(item, query)).slice(offset, offset + limit).map(copy) } },
          async remove() {
            operations.bulkRemoves += 1
            let removed = 0
            for (const [id, item] of rows) if (matches(item, query) && removed < (options.bulkRemoveLimit || Infinity)) { rows.delete(id); removed += 1 }
            return { stats: { removed } }
          }
        }
      },
      doc(id) {
        return {
          async get() { operations.documentReads += 1; return { data: copy(rows.get(id)) || null } },
          async set({ data }) { rows.set(id, { ...copy(data), _id: id }) },
          async update({ data }) { if (!rows.has(id)) throw new Error('document not found'); rows.set(id, { ...rows.get(id), ...copy(data) }) },
          async remove() { operations.documentRemoves += 1; rows.delete(id) }
        }
      },
      async add({ data }) { const id = 'doc-' + (++counter); rows.set(id, { ...copy(data), _id: id }); return { _id: id } }
    }
  }
  const db = {
    collection, command, async createCollection(name) { collection(name) },
    runTransaction(fn) {
      operations.transactions += 1
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
    documents, adminDeletes, db, operations,
    async call(event, openid = 'user-a') { owner = openid; return main(event) },
    rows(name) { return [...(documents.get(name) || new Map()).values()].map(copy) },
    async seed(name, value) { return collection(name).add({ data: value }) }
  }
}
module.exports = { fixture }
