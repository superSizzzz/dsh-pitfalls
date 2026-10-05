#!/usr/bin/env node
/**
 * 把这份 checkout 的依赖解析接到 dsh 自己的依赖目录上，并且（可选）打印一份
 * 路径已经填好的 patch 片段。
 *
 * 插件不自己装 `@deepseek-ai/*` —— 那些包由 dsh 提供，package.json 里只
 * 声明 peerDependencies。但 Node 解析 `import '@deepseek-ai/dsh-tools'` 时
 * 需要一个能落地的 node_modules，而 dsh 的 profile 目录下正好有一份完整的。
 * 这个脚本把它链过来。
 *
 *   node scripts/link-deps.mjs           接依赖
 *   node scripts/link-deps.mjs --patch   接依赖，并打印可粘贴的 patch 片段
 *
 * Windows 上建的是 junction（不需要管理员权限，也不占额外磁盘）；其他平台建
 * 目录符号链接。
 */
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LINK = join(REPO, 'node_modules')
const PROBE = join('@deepseek-ai', 'dsh-tools')
const WANT_PATCH = process.argv.includes('--patch')

/** 插件入口的 file:// URL —— dsh 的 patch 层只认这个形式。 */
function pluginUrl() {
  return `file:///${join(REPO, 'src', 'index.ts').replace(/\\/g, '/')}`
}

/** dsh 的家目录：优先环境变量，否则 ~/.dsh —— 跟 dsh 自己的解析顺序一致。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/** 打印可以直接粘进 cordis.patch.yml 的片段。 */
function printPatch() {
  console.log('')
  console.log('把下面这段追加到补丁文件的末尾（注意是追加，别覆盖原有内容）：')
  console.log('  ~/.dsh/cordis.patch.yml                → home 层，所有 profile 生效')
  console.log('  ~/.dsh/profiles/web/cordis.patch.yml   → 只管 web profile')
  console.log('')
  console.log('- insert:')
  console.log('    - id: pitfalls')
  console.log(`      name: '${pluginUrl()}'`)
  console.log('      config:')
  console.log('        enabled: true')
  console.log('        failureStreak: 2')
  console.log('')
  console.log('dsh 的 profile 默认 patchReload: live —— 保存即热重载，不用重启。')
  console.log('想确认装上了：在 config 里加一行 logPath（例如 ~/.dsh/pitfalls.log），')
  console.log('然后看那个文件里有没有 {"event":"applied", ...}。')
  console.log('各配置项的含义见 README.md。')
}

const source = join(dshHome(), 'profiles', 'node_modules')

if (existsSync(join(LINK, PROBE))) {
  console.log(`✓ node_modules 已经可用（能解析 ${PROBE}）`)
  if (WANT_PATCH) printPatch()
  else console.log(`  插件路径：${pluginUrl()}\n  加 --patch 可以打印一份可直接粘贴的 patch 片段。`)
  process.exit(0)
}

if (!existsSync(source)) {
  console.error(`✗ 找不到 dsh 的依赖目录：${source}`)
  console.error('  dsh 至少启动过一次才会生成它。装好 dsh 并跑一次 `dsh web` 再回来。')
  console.error('  如果 dsh 装在别处，用 DSH_HOME 指过去，例如：')
  console.error('    $env:DSH_HOME = "D:\\somewhere\\.dsh"; node scripts/link-deps.mjs')
  process.exit(1)
}

if (existsSync(LINK)) {
  console.error(`✗ ${LINK} 已经存在，但里面解析不到 ${PROBE}。`)
  console.error('  这通常意味着你在这里手动装过依赖。先删掉它（或改名）再跑本脚本。')
  process.exit(1)
}

mkdirSync(REPO, { recursive: true })

try {
  symlinkSync(source, LINK, process.platform === 'win32' ? 'junction' : 'dir')
} catch (error) {
  console.error(`✗ 建链接失败：${error instanceof Error ? error.message : String(error)}`)
  console.error('  Windows 上建 junction 不需要管理员权限；如果被组策略挡住，')
  console.error(`  可以手动执行：New-Item -ItemType Junction -Path "${LINK}" -Target "${source}"`)
  process.exit(1)
}

console.log(`✓ 已把 node_modules 链到 ${source}`)
if (WANT_PATCH) printPatch()
else console.log(`\n  插件路径：${pluginUrl()}\n  加 --patch 可以打印一份可直接粘贴的 patch 片段。`)
