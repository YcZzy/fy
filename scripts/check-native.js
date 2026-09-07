const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '../miniprogram')
const install = process.env.WECHAT_DEVTOOLS_PATH || 'C:/Program Files (x86)/Tencent/微信web开发者工具'
const modules = path.join(install, 'resources/app.asar.unpacked/node_modules')
const compilers = {
  '.wxml': path.join(modules, 'wcc-exec', process.platform === 'win32' ? 'wcc.exe' : 'wcc'),
  '.wxss': path.join(modules, 'wcc-exec', process.platform === 'win32' ? 'wcsc.exe' : 'wcsc')
}
for (const binary of Object.values(compilers)) {
  if (!fs.existsSync(binary)) throw new Error(`未找到微信原生编译器：${binary}。请安装开发者工具，或设置 WECHAT_DEVTOOLS_PATH 为其安装目录。`)
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)])
}
const counts = { '.wxml': 0, '.wxss': 0 }
for (const file of walk(root)) {
  const ext = path.extname(file)
  if (!compilers[ext]) continue
  const relative = path.relative(root, file).replace(/\\/g, '/')
  const result = spawnSync(compilers[ext], [relative], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  if (result.error || result.status !== 0) throw new Error(`${relative} 编译失败：${result.error || result.stderr || result.stdout}`)
  counts[ext] += 1
}
console.log(`微信原生编译通过：${counts['.wxml']} 个 WXML、${counts['.wxss']} 个 WXSS。此检查不替代模拟器和真机视觉验收。`)
