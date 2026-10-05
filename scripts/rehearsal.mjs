#!/usr/bin/env node
/**
 * 在**真实目录**上试一次两层档案的检索（不经过 dsh、不起会话、**只读不写**）。
 *
 * 用途有两个：排查「档案到底会写到哪」，以及在改完插件源码、重启 dsh 之前，
 * 先在真实数据上确认新代码的行为对不对。
 *
 *   node scripts/rehearsal.mjs                     # 用当前目录 + 默认查询词
 *   node scripts/rehearsal.mjs D:/repos/my-app        # 指定工作区
 *   node scripts/rehearsal.mjs D:/repos/my-app EPERM  # 顺便换个查询词
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PitfallLibrary } from '../src/library.ts'

const cwd = process.argv[2] ?? process.cwd()
const query = process.argv[3] ?? '编码 乱码'
const globalDir = process.env.DSH_HOME === undefined || process.env.DSH_HOME.trim().length === 0
  ? join(homedir(), '.dsh', 'pitfalls')
  : join(process.env.DSH_HOME.trim(), 'pitfalls')

const library = new PitfallLibrary({
  globalDir,
  projectDir: '.dsh/pitfalls',
  projectStore: true,
  backupToGlobal: true,
  indexLimit: 200,
})

console.log(`工作区    ${cwd}`)
console.log(`项目档案  ${library.projectDirOf(cwd)}`)
console.log(`全局档案  ${library.globalDir()}`)
const projectCount = library.projectOf(cwd)?.list().length ?? 0
console.log(`项目档案已有 ${projectCount} 条；全局已有 ${countGlobal()} 条`)
console.log('')

const hits = library.search(query, { cwd, limit: 5 })
console.log(`检索「${query}」→ ${hits.length} 条`)
for (const hit of hits) {
  console.log(`  [${hit.scope}] ${hit.entry.id}  ${hit.entry.title}`)
}

function countGlobal() {
  const found = library.search('', { cwd: '', limit: 1000 })
  return found.length
}
