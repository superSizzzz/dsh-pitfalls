/**
 * 装配冒烟测试：用假 ctx 把 apply() 跑通，验证整条链路。
 *
 * store / detector 的单元测试管的是「一处判定对不对」，这里管的是「它们串起来
 * 还行不行」：事件有没有被接住、提醒有没有真的注入、命中历史时答案有没有带上。
 * 不起会话、不真加载 dsh —— 但会真加载插件模块，所以 import 层面的错误
 * （写错的导出、缺的依赖）也会在这里暴露。
 *
 *   node test/plugin.smoke.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../src/index.ts'

let passed = 0
const failures = []

function check(label, condition) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(label)
}

function equal(label, actual, expected) {
  check(`${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`, actual === expected)
}

const root = mkdtempSync(join(tmpdir(), 'pitfalls-smoke-'))
const injected = []
const sessionEvents = []
const disposed = []
const registered = new Map()

const session = { id: 'session-1', header: { cwd: 'D:/tmp/ws' } }
const agent = {
  session,
  inject: (message) => { injected.push(message) },
}

/** 假 ctx：只实现插件真正用到的那几处。 */
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => {} } },
  on: (event, handler) => {
    if (event === 'session/event') sessionEvents.push(handler)
    if (event === 'session/disposed') disposed.push(handler)
    return () => {}
  },
  get: (service) => (service === 'agents' ? { get: (id) => (id === session.id ? agent : undefined) } : undefined),
  effect: (callback) => { callback(); return () => {} },
}

/** 造一次工具调用 + 失败结果的配对事件。 */
function failedCall(callId, toolName, args, reason) {
  const content = [{ type: 'text', text: reason }]
  for (const handler of sessionEvents) {
    handler(session, { type: 'tool/call', data: { callId, name: toolName, arguments: JSON.stringify(args) } })
    handler(session, { type: 'tool/result', data: { message: { toolCallId: callId, isError: true, content } } })
  }
}

function okCall(callId, toolName) {
  for (const handler of sessionEvents) {
    handler(session, { type: 'tool/call', data: { callId, name: toolName, arguments: '{}' } })
    handler(session, { type: 'tool/result', data: { message: { toolCallId: callId, isError: false, content: [] } } })
  }
}

try {
  equal('导出名正确', name, 'pitfalls')

  apply(ctx, {
    enabled: true,
    dir: root,
    // 项目档案用绝对路径指到临时目录：两层都走到，又不会把档案写进真实工作区。
    projectDir: join(root, 'project'),
    failureStreak: 2,
    matchHistory: true,
    reminderCooldownMs: 0,
    maxRemindersPerSession: 5,
    systemPromptSection: false,
  })

  // -------------------------------------------------------------------------
  // 1. 四个工具都注册上了
  equal('注册了四个工具', registered.size, 4)
  for (const toolName of ['pitfall_search', 'pitfall_record', 'pitfall_show', 'pitfall_update']) {
    check(`注册了 ${toolName}`, registered.has(toolName))
  }

  // -------------------------------------------------------------------------
  // 2. 先用工具记一条坑，等下验证「命中历史」
  const record = registered.get('pitfall_record')
  const recorded = await record.execute({
    title: 'dsh 沙箱里 node 管道 stdio 报 EPERM',
    symptom: 'node child_process 抓不到子进程输出，直接 EPERM',
    cause: '沙箱禁止打开命名管道，默认 stdio: pipe 就会失败',
    solution: '改成 stdio: inherit 或 ignore，或者绕开在沙箱里抓输出',
    area: 'dsh-sandbox',
    tags: ['sandbox', 'node'],
  }, { agent })
  check('record 工具返回 ok', recorded.ok === true)
  check('record 工具返回编号', String(recorded.id ?? '').startsWith('p-'))
  equal('同时写进项目档案与全局备份', Array.isArray(recorded.writtenTo) ? recorded.writtenTo.length : 0, 2)
  check('返回值点明了项目档案目录', (recorded.writtenTo ?? []).some((dir) => String(dir).includes('project')))

  // -------------------------------------------------------------------------
  // 3. 连续两次失败 → 注入一条提醒，且带上刚记的那条历史
  // 同一个工具的连续两次失败：第一次可能是探索，第二次才像是真撞上了什么。
  const pipeArgs = { command: 'node -e "spawn node --version"' }
  const pipeError = 'EPERM: operation not permitted, open named pipe'
  failedCall('c1', 'pwsh', pipeArgs, pipeError)
  equal('第一次失败不打扰', injected.length, 0)
  failedCall('c2', 'pwsh', pipeArgs, pipeError)
  equal('第二次失败注入一条提醒', injected.length, 1)

  const reminder = injected[0]
  const text = reminder?.content?.[0]?.text ?? ''
  equal('提醒是 user 角色', reminder?.role, 'user')
  equal('提醒带自定义 source kind', reminder?.source?.kind, 'pitfall')
  check('提醒里点名了工具', text.includes('pwsh'))
  check('提醒里带上了命中的历史编号', text.includes(recorded.id))
  check('提醒里带上了历史解法', text.includes('stdio: inherit'))
  check('提醒里标了来源（本项目）', text.includes('本项目'))

  // -------------------------------------------------------------------------
  // 4. 触发后清零：紧接着的失败不再注入
  failedCall('c3', 'pwsh', { command: 'node -e "spawn node --version"' }, 'EPERM')
  equal('第三次失败不再注入', injected.length, 1)
  failedCall('c4', 'pwsh', { command: 'node -e "spawn node --version"' }, 'EPERM')
  equal('再攒够两次才注入第二条', injected.length, 2)

  // -------------------------------------------------------------------------
  // 5. 成功会清零
  okCall('c5', 'pwsh')
  failedCall('c6', 'pwsh', { command: 'x' }, 'boom')
  equal('成功清零后单次失败不注入', injected.length, 2)

  // -------------------------------------------------------------------------
  // 6. 没有历史的坑：提醒里说清「档案里没有」
  failedCall('c7', 'read', { file_path: 'D:/nope/missing.ts' }, 'ENOENT: no such file or directory')
  failedCall('c8', 'read', { file_path: 'D:/nope/missing.ts' }, 'ENOENT: no such file or directory')
  equal('新坑也提醒', injected.length, 3)
  const newPitfallText = injected[2]?.content?.[0]?.text ?? ''
  check('新坑提醒说明档案里没有', newPitfallText.includes('没有搜到相关的坑'))
  check('新坑提醒给了记录的入口', newPitfallText.includes('pitfall_record'))

  // -------------------------------------------------------------------------
  // 7. 检索工具能从磁盘读到刚记的条目
  const search = registered.get('pitfall_search')
  const found = await search.execute({ query: 'EPERM 沙箱' }, { agent })
  check('检索命中', found.count >= 1)
  equal('返回的是精简条目', typeof found.hits?.[0]?.card, 'string')
  equal('命中标注来自项目档案', found.hits?.[0]?.from, '项目档案')

  // 全无命中时不能返回杂项
  const nothing = await search.execute({ query: '量子纠缠飞船' }, { agent })
  equal('无关查询返回 0 条', nothing.count, 0)
  check('无命中时给出提示', typeof nothing.hint === 'string')

  // -------------------------------------------------------------------------
  // 8. show / update 走通
  const show = registered.get('pitfall_show')
  const shown = await show.execute({ id: recorded.id }, { agent })
  equal('show 取回标题', shown.title, 'dsh 沙箱里 node 管道 stdio 报 EPERM')
  const missing = await show.execute({ id: 'p-nope' }, { agent })
  equal('show 未知编号返回 ok:false', missing.ok, false)

  const update = registered.get('pitfall_update')
  const updated = await update.execute({ id: recorded.id, note: '其实 inherit 也会丢输出，最终改成写文件再读' }, { agent })
  check('update 成功', updated.ok === true)
  const shownAgain = await show.execute({ id: recorded.id }, { agent })
  equal('补记进了 notes', shownAgain.notes.length, 1)
  check('补记内容正确', shownAgain.notes[0].text.includes('写文件'))

  // -------------------------------------------------------------------------
  // 9. subagent 会话不打扰
  const subSession = { id: 'sub-1', header: { cwd: 'D:/x', origin: 'subagent', delegationDepth: 1 } }
  const before = injected.length
  for (const handler of sessionEvents) {
    handler(subSession, { type: 'tool/call', data: { callId: 's1', name: 'pwsh', arguments: '{}' } })
    handler(subSession, { type: 'tool/result', data: { message: { toolCallId: 's1', isError: true, content: [] } } })
    handler(subSession, { type: 'tool/call', data: { callId: 's2', name: 'pwsh', arguments: '{}' } })
    handler(subSession, { type: 'tool/result', data: { message: { toolCallId: 's2', isError: true, content: [] } } })
  }
  equal('subagent 会话不注入提醒', injected.length, before)

  // -------------------------------------------------------------------------
  // 10. 会话结束后忘掉状态
  for (const handler of disposed) handler(session)
  failedCall('c9', 'pwsh', { command: 'x' }, 'boom')
  equal('forget 后单次失败不注入', injected.length, before)

  // -------------------------------------------------------------------------
  // 11. 总开关关掉时什么都不注册
  const offRegistered = new Map()
  const offCtx = { ...ctx, tools: { register: (definition) => { offRegistered.set(definition.name, definition) } } }
  apply(offCtx, { enabled: false, dir: root })
  equal('关闭时不注册工具', offRegistered.size, 0)
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`✗ smoke：${passed} 通过，${failures.length} 失败`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✓ smoke：${passed} 项断言全部通过`)
