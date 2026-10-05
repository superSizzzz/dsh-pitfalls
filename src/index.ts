/**
 * dsh-pitfalls —— 踩坑档案。
 *
 * 要解决的问题：同一类坑会反复踩。上一次花两小时查出来的根因，下一次换个
 * 会话就忘光了，又从零开始试。
 *
 * 插件做三件事：
 *
 *   记     `pitfall_record` 把坑写成一条档案（现象 / 怎么踩进去的 / 怎么解决 / 证据）
 *   查     `pitfall_search` 撞上问题时先翻历史，命中就把当时的解法端出来
 *   盯     同一个工具连续失败到阈值时，自动往会话里注入一条提醒（带命中历史），
 *          免得模型钻进任务里想不起来查、也想不起来记
 *
 * 加载方式（本地 checkout，profile 默认 patchReload: live，改代码即热重载）：
 *   在 profile 的 cordis.patch.yml 里 insert 一条，name 指向本文件的 file:// URL。
 *   跑 `node scripts/link-deps.mjs --patch` 会打印一份路径已填好的片段。
 *
 * 设计边界要说清楚：**插件不替模型判断什么算坑**。自动检测只在「连续失败」这个
 * 客观信号上出声，是否记录、怎么描述由模型决定 —— 把判断权交出去，档案里才
 * 不会塞满「命令打错了」这种噪声。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Config, readConfig, resolveConfig } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { PitfallDetector } from './detector.ts'
import type { Verdict } from './detector.ts'
import { PROMPT_SECTION_ORDER, reminderSummary, reminderText, systemSectionText } from './policy.ts'
import type { ScopedPitfall } from './policy.ts'
import { PitfallLibrary } from './library.ts'
import type { PitfallEntry } from './store.ts'
import { registerTools } from './tools.ts'

/**
 * 本插件自己声明的消息来源 kind。
 *
 * harness 的 `MessageSourceMap` 是合并可扩展的（每个生产者声明自己的 kind）。
 * 注入的提醒必须能被看成「不是用户手打的那一类」：UI 不该把它渲染成用户发言，
 * 飞书桥那类只认 `kind === 'user'` 的消费者也不该被误触发。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    pitfall: { kind: 'pitfall'; form: 'notice'; summary: string }
  }
}

export const name = 'pitfalls'
/** 只硬依赖工具注册表；agents 用 ctx.get 软取，缺了就不做自动提醒。 */
export const inject = ['tools']
export { Config }

interface SessionLike {
  id: string
  header?: { cwd?: string; origin?: string; delegationDepth?: number }
}

interface SessionEventLike {
  type?: string
  seq?: number
  data?: unknown
}

interface AgentRegistryLike {
  get: (id: string) => Agent | undefined
  list?: () => Agent[]
}

/** 提示里要用的参数名：与其把整段参数塞进线索，不如挑几个定位字段。 */
const CLUE_KEYS = ['command', 'path', 'file_path', 'pattern', 'query', 'url', 'name', 'cwd']

/** 记住 tool/call 的名字与线索，等 tool/result 来时配对。 */
interface PendingCall {
  name: string
  clue: string
}

/** 在途调用表的上限：tool/result 漏事件时（中断、取消）不至于无限增长。 */
const PENDING_LIMIT = 500

/** 一次失败线索最多带多少字符进提醒。 */
const CLUE_MAX = 300

/**
 * dsh 的家目录：优先环境变量，否则 ~/.dsh —— 跟 dsh 自己的解析顺序一致。
 */
function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * 只处理顶层会话。
 *
 * subagent 的会话用完即弃，把提醒注进去等于扔进垃圾桶；它踩的坑由主 agent
 * 在结果里带出来。判定沿用 dsh 自己的口径（origin / delegationDepth）。
 */
function isTopLevel(session: SessionLike): boolean {
  const header = session.header
  if (header === undefined) return false
  if (header.origin === 'subagent') return false
  return (header.delegationDepth ?? 0) === 0
}

/** 把 tool/call 的原始参数串压成一行线索（命令、路径、检索词等）。 */
function clueFromArguments(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw.trim().slice(0, CLUE_MAX)
  }
  if (typeof parsed !== 'object' || parsed === null) return ''
  const record = parsed as Record<string, unknown>
  const parts: string[] = []
  for (const key of CLUE_KEYS) {
    const value = record[key]
    if (typeof value !== 'string' || value.trim().length === 0) continue
    parts.push(`${key}=${value.trim()}`)
    if (parts.length >= 3) break
  }
  return parts.join(' ').slice(0, CLUE_MAX)
}

/** 从结果内容里取文本（报错原文就在这儿），用于检索线索。 */
function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') parts.push(candidate.text)
  }
  return parts.join('\n').trim()
}

/** tool/result 的失败身份（error.name / error.code / error.reason）。 */
function errorCodeOf(data: unknown): string {
  if (typeof data !== 'object' || data === null) return ''
  const error = (data as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return ''
  const record = error as { name?: unknown; code?: unknown; reason?: unknown }
  const parts = [record.code, record.name, record.reason]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  return parts.join(' ')
}

export function apply(ctx: Context, rawConfig: unknown): void {
  const config = readConfig(rawConfig)
  const resolved = resolveConfig(config)
  const logger = ctx.logger

  const globalDir = resolved.dir.length > 0 ? resolved.dir : join(dshHome(), 'pitfalls')
  /**
   * 两层档案：当前工作区一本（项目的坑跟着项目走）、全局一本（兜底兼备份）。
   * 检索顺序、去重与同步都收在 library 里，这里只负责把它接上线。
   */
  const library = new PitfallLibrary({
    globalDir,
    projectDir: resolved.projectDir,
    projectStore: resolved.projectStore,
    backupToGlobal: resolved.backupToGlobal,
    indexLimit: resolved.indexLimit,
  })

  /**
   * 插件自己的排查日志。默认关闭。
   *
   * 刻意不走 harness 的 logger：最需要排查的时刻恰恰是「它到底有没有在管事」，
   * 一条独立落到自己文件里的 JSONL 比混在别人日志里好用。写失败什么都不做。
   */
  let logReady = false
  const log = (event: string, detail: Record<string, unknown> = {}): void => {
    if (resolved.logPath.length === 0) return
    try {
      if (!logReady) {
        mkdirSync(dirname(resolved.logPath), { recursive: true })
        logReady = true
      }
      const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail })
      appendFileSync(resolved.logPath, `${line}\n`, 'utf8')
    } catch {
      // 落盘失败不是错误。
    }
  }

  if (!config.enabled) {
    log('disabled')
    logger.info('[pitfalls] 已关闭（config.enabled = false），不注册工具与监听')
    return
  }

  registerTools(ctx, {
    enabled: () => config.enabled,
    library: () => library,
    log,
  })

  const detector = new PitfallDetector({
    failureStreak: resolved.failureStreak,
    cooldownMs: resolved.reminderCooldownMs,
    maxPerSession: resolved.maxRemindersPerSession,
  })
  const pending = new Map<string, PendingCall>()

  const agents = (): AgentRegistryLike | undefined => ctx.get('agents') as AgentRegistryLike | undefined

  /**
   * 用失败的线索去翻档案。只在配了 matchHistory 时才真的检索。
   *
   * 顺序也在这儿定下：**先当前工作区的项目档案，不够再由全局补齐** —— 那本
   * 全局档案既是兜底也是备份，所以「别的项目踩过的坑」照样能捞出来，只是排在
   * 后面，并且会标明来源。
   */
  const findHistory = (cwd: string, verdict: Verdict): ScopedPitfall[] => {
    if (!resolved.matchHistory) return []
    try {
      // 线索里可能混着路径与符号，tokenize 会自己挑出可用的词。
      return library.search(verdict.clue, { cwd, limit: 3 })
        .map((hit) => ({ entry: hit.entry, scope: hit.scope }))
    } catch (error) {
      log('search-failed', { detail: String(error) })
      return []
    }
  }

  /**
   * 把提醒投进模型看得见的地方。
   *
   * 走 `agent.inject()` 而不是 followup：inject 不唤醒驱动、不新开一轮，只在
   * 下一个 pre-step 被取走 —— 正好是「这一步刚失败，下一步该换个思路」的位置。
   * 任何失败都吞掉：插件不许打断会话。
   */
  const deliver = (session: SessionLike, verdict: Verdict): void => {
    const sessionId = session.id
    try {
      const agent = agents()?.get(sessionId)
      if (agent === undefined) return
      const matches = findHistory(session.header?.cwd ?? '', verdict)
      const input = { toolName: verdict.toolName, count: verdict.count, clue: verdict.clue, matches }
      agent.inject(createUserMessage({
        content: [{ type: 'text' as const, text: reminderText(input) }],
        source: {
          kind: 'pitfall',
          form: 'notice',
          summary: reminderSummary(input),
        },
      }))
      log('reminder', {
        sessionId,
        toolName: verdict.toolName,
        count: verdict.count,
        matches: matches.length,
        fromProject: matches.filter((match) => match.scope === 'project').length,
      })
    } catch (error) {
      // 投递失败（agent 已退出等）不是错误，下一次有机会再说。
      log('reminder-failed', { sessionId, detail: String(error) })
    }
  }

  if (resolved.autoDetect) {
    ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
      // 整个 handler 兜一层：档案是纯附加能力，任何意外都不该在别人的事件派发里留噪声。
      try {
        observe(session, event)
      } catch (error) {
        log('observe-failed', { detail: String(error) })
      }
    })

    ctx.on('session/disposed', (session: SessionLike) => {
      detector.forget(session.id)
    })

    function observe(session: SessionLike, event: SessionEventLike): void {
      if (!isTopLevel(session)) return
      const data = event.data

      if (event.type === 'tool/call') {
        const record = data as { callId?: unknown; name?: unknown; arguments?: unknown } | undefined
        const callId = typeof record?.callId === 'string' ? record.callId : ''
        const toolName = typeof record?.name === 'string' ? record.name : ''
        if (callId.length === 0 || toolName.length === 0) return
        if (pending.size >= PENDING_LIMIT) {
          // 只丢最早的一批：漏掉名字的失败结果仍然会被记成「未知工具」，不至于丢事件。
          let dropped = 0
          for (const key of pending.keys()) {
            pending.delete(key)
            dropped += 1
            if (dropped >= 100) break
          }
        }
        pending.set(`${session.id}:${callId}`, { name: toolName, clue: clueFromArguments(record?.arguments) })
        return
      }

      if (event.type !== 'tool/result') return
      const record = data as {
        message?: { toolCallId?: unknown; isError?: unknown; content?: unknown }
      } | undefined
      const message = record?.message
      if (message === undefined) return
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
      const key = `${session.id}:${callId}`
      const call = pending.get(key)
      pending.delete(key)
      const toolName = call?.name ?? '未知工具'

      if (message.isError !== true) {
        detector.observeSuccess(session.id, toolName)
        return
      }

      const body = textOfContent(message.content)
      const code = errorCodeOf(data)
      const clue = [call?.clue, code, body]
        .filter((part) => typeof part === 'string' && part.length > 0)
        .join(' | ')
        .slice(0, CLUE_MAX)
      const verdict = detector.observe({ sessionId: session.id, toolName, clue, at: Date.now() })
      if (verdict !== null) deliver(session, verdict)
    }
  }

  // 预防层：把「踩坑就记、开工先查」写进系统提示。
  // 整段包在 try 里：提示词注入失败绝不能连累插件加载。
  if (resolved.systemPromptSection) {
    try {
      const systemPrompt = ctx.get('systemPrompt') as {
        section?: (input: { name: string; order: number; text: string }) => unknown
      } | undefined
      if (systemPrompt?.section === undefined) {
        logger.warn('[pitfalls] 没有可用的 systemPrompt 服务，跳过提示词注入')
      } else {
        ctx.effect(() => systemPrompt.section?.({
          name: 'pitfalls:policy',
          order: PROMPT_SECTION_ORDER,
          text: systemSectionText({
            projectDir: resolved.projectStore ? resolved.projectDir : '',
            globalDir,
          }),
        }))
        log('prompt-section-registered')
      }
    } catch (error) {
      logger.warn(`[pitfalls] 提示词注入失败（其余功能不受影响）：${String(error)}`)
      log('prompt-section-failed', { detail: String(error) })
    }
  }

  log('applied', {
    globalDir,
    projectDir: resolved.projectStore && resolved.projectDir.length > 0 ? resolved.projectDir : '(off)',
    backupToGlobal: resolved.backupToGlobal,
    node: process.version,
    autoDetect: resolved.autoDetect,
    failureStreak: resolved.failureStreak,
    headless: process.argv.includes('--headless'),
  })
  const layout = resolved.projectStore
    ? `全局 ${globalDir}；项目档案随工作区写入 ${resolved.projectDir}`
    : `全局 ${globalDir}（未启用项目档案）`
  logger.info(`[pitfalls] 踩坑档案就绪：${layout}`)
}
