const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const app = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'))
const missing = []
for (const page of app.pages) {
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    const file = path.join(root, 'miniprogram', `${page}.${ext}`)
    if (!fs.existsSync(file)) missing.push(path.relative(root, file))
  }
}
if (missing.length) throw new Error(`页面文件缺失:\n${missing.join('\n')}`)

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])
}
const files = walk(path.join(root, 'miniprogram')).concat(walk(path.join(root, 'cloudfunctions')))
files.filter((file) => file.endsWith('.json')).forEach((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
files.filter((file) => file.endsWith('.js')).forEach((file) => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }))

const wxml = files.filter((file) => file.endsWith('.wxml')).map((file) => fs.readFileSync(file, 'utf8')).join('\n')
for (const forbidden of ['.includes(', '.slice(', '.map(']) {
  if (wxml.includes(forbidden)) throw new Error(`WXML 中包含不支持的方法调用: ${forbidden}`)
}
for (const page of app.pages) {
  const js = fs.readFileSync(path.join(root, 'miniprogram', `${page}.js`), 'utf8')
  const markup = fs.readFileSync(path.join(root, 'miniprogram', `${page}.wxml`), 'utf8')
  const handlers = [...markup.matchAll(/bind(?:tap|input|change|confirm|longpress)="([A-Za-z_$][\w$]*)"/g)].map((match) => match[1])
  for (const handler of new Set(handlers)) {
    if (!new RegExp(`\\b${handler}\\s*\\(`).test(js)) throw new Error(`${page}.wxml 绑定了不存在的方法: ${handler}`)
  }
}
console.log(`检查通过：${app.pages.length} 个页面，${files.length} 个源码文件。`)
