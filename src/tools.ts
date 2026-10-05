/**
 * 模型面向的四个工具。
 *
 * 描述里写死触发时机，而不是只描述功能 —— 工具什么时候被调用，取决于
 * 模型读到的那段话，含混的描述会让它在无关的时候也来调一次。
 *
 * 命名统一 `pitfall_` 前缀，四个工具语义不重叠：
 *   search  查历史（撞上问题、动手之前）
 *   record  记新坑（解决或绕过之后）
 *   show    看全文（检索结果里那条真相关，要看细节）
 *   update  补记（后来有更好的解法，或状态变了）
 *
 * 档案是两层的：当前工作区一本（项目的坑跟着项目走），全局一本（兜底 + 备份）。
 * 返回值里每条都带 `from`，让模型知道结果是从哪本里捞出来的。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { PitfallLibrary, PitfallScope } from './library.ts'
import type { PitfallEntry, PitfallStatus } from './store.ts'
import { statusLabel, summarize } from './store.ts'

/** 只取我们真正会用到的会话字段，避免把 dsh-session 的整套类型拖进来。 */
interface SessionLike {
  id: string
  header?: { cwd?: string }
}

interface AgentLike {
  session: SessionLike
}

export interface ToolDeps {
  enabled: () => boolean
  library: () => PitfallLibrary
  /** 记一条插件自己的排查日志（未配置 logPath 时是空操作）。 */
  log: (event: string, detail?: Record<string, unknown>) => void
}

/** 输出契约：一律一个 JSON 对象，render 成一段文本给模型读。 */
const OBJECT_OUTPUT = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

const STATUS_DESC = 'solved（已解决）｜workaround（只绕过，没根治）｜open（还没解决，先记下）。默认 solved。'

/** 从执行上下文里取当前工作区。拿不到就退化成只用全局档案。 */
function cwdOf(exec: { agent?: unknown }): string {
  const agent = exec.agent as AgentLike | undefined
  return agent?.session.header?.cwd ?? ''
}

function scopeLabel(scope: PitfallScope): string {
  return scope === 'project' ? '项目档案' : '全局档案'
}

/** 检索结果里一条记录的紧凑形态：够判断「要不要看全文」，不塞整篇正文。 */
function compact(entry: PitfallEntry, dir: string, scope: PitfallScope): Record<string, unknown> {
  return {
    id: entry.id,
    title: entry.title,
    status: statusLabel(entry.status),
    tags: entry.tags,
    area: entry.area,
    at: entry.at,
    updatedAt: entry.updatedAt,
    symptom: entry.symptom.slice(0, 300),
    solution: entry.solution.slice(0, 400),
    from: scopeLabel(scope),
    card: `${dir}/cards/${entry.id}.md`,
  }
}

export function registerTools(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'pitfall_search',
    description: '翻「踩坑档案」：按关键词找以前踩过的坑（现象 / 怎么踩进去的 / 怎么解决）。'
      + '**撞上报错、构建失败、行为诡异、接口不按预期时，动手之前先搜一次**，别从零猜。'
      + '线索用「报错关键词 + 涉及的模块/命令/文件名」；搜不到就正常干活，不要为了搜而搜。'
      + '检索顺序是：先当前工作区的项目档案，不足的部分再从全局档案补齐（每条结果都标了来自哪本）。'
      + '返回的是精简条目，要看全文用 pitfall_show。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '检索线索。可以是报错关键词、模块名、命令行、文件名，空格分隔多个线索。留空按时间列最近的记录。',
      },
      tag: { type: 'string', description: '只在这个标签里找（精确匹配）。' },
      status: { type: 'string', enum: ['solved', 'workaround', 'open'], description: '只看某种状态。' },
      limit: { type: 'integer', description: '最多返回几条，默认 8。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args, exec) {
      if (!deps.enabled()) return { ok: false, error: '踩坑档案插件已关闭' }
      const library = deps.library()
      const cwd = cwdOf(exec)
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 30) : 8
      const status = typeof args.status === 'string' ? args.status as PitfallStatus : undefined
      const hits = library.search(typeof args.query === 'string' ? args.query : '', {
        cwd,
        ...args.tag === undefined ? {} : { tag: args.tag },
        ...status === undefined ? {} : { status },
        limit,
      })
      const projectDir = library.projectDirOf(cwd)
      deps.log('search', {
        sessionId: exec.agent?.session.id ?? '',
        query: typeof args.query === 'string' ? args.query : '',
        cwd,
        hits: hits.length,
        fromProject: hits.filter((hit) => hit.scope === 'project').length,
      })
      if (hits.length === 0) {
        return {
          ok: true,
          count: 0,
          searched: projectDir.length > 0 ? [projectDir, library.globalDir()] : [library.globalDir()],
          hint: '两本档案里都没有相关的坑。这次可能是新问题 —— 解决或绕过之后用 pitfall_record 记一笔。',
          hits: [],
        }
      }
      return {
        ok: true,
        count: hits.length,
        searched: projectDir.length > 0 ? [projectDir, library.globalDir()] : [library.globalDir()],
        hits: hits.map((hit) => compact(hit.entry, hit.dir, hit.scope)),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pitfall_record',
    description: '把刚踩过的坑记进「踩坑档案」，供以后遇到同类问题时翻。'
      + '**判据**：这个问题花了力气才搞清（试错两次以上、翻过源码、换过思路），并且已经解决或已经绕过。'
      + '手滑拼错、看错路径这类一次性失误不用记。'
      + '坑要能复现：写清触发条件，不能只写「报了个错」。'
      + '四栏都写：现象、怎么踩进去的、怎么解决的、证据。'
      + '记录会同时写进当前工作区的项目档案与全局档案（后者当备份），不用你自己选。'
      + '记完不用向用户汇报这件事，除非他问起。',
    parameters: {
      title: { type: 'string', required: true, description: '一句话说清是什么坑（会作为索引里的标题）。' },
      symptom: { type: 'string', required: true, description: '现象：当时看到什么 —— 报错、异常行为、和预期的差距。贴关键原文，别只写「报错了」。' },
      cause: { type: 'string', required: true, description: '怎么踩进去的：根因与触发条件。说清「什么条件下必然复现」。' },
      solution: { type: 'string', required: true, description: '怎么解决的：实际做了什么。只是绕过的话写清绕法，以及为什么没根治。' },
      evidence: { type: 'string', description: '证据：原始报错片段、命令、文件路径与行号（可多行）。' },
      area: { type: 'string', description: '涉及范围：文件名、目录、命令或模块名。检索时权重高于正文，尽量填。' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: '标签，便于按主题翻档案。例如 windows、sandbox、encoding、cordis。',
      },
      status: { type: 'string', enum: ['solved', 'workaround', 'open'], description: STATUS_DESC },
    },
    output: OBJECT_OUTPUT,
    async execute(args, exec) {
      if (!deps.enabled()) return { ok: false, error: '踩坑档案插件已关闭' }
      const library = deps.library()
      const cwd = cwdOf(exec)
      const outcome = library.record({
        title: args.title,
        symptom: args.symptom,
        cause: args.cause,
        solution: args.solution,
        ...args.evidence === undefined ? {} : { evidence: args.evidence },
        ...args.area === undefined ? {} : { area: args.area },
        ...args.tags === undefined ? {} : { tags: args.tags as string[] },
        ...args.status === undefined ? {} : { status: args.status as PitfallStatus },
        cwd,
        sessionId: exec.agent?.session.id ?? '',
        source: 'model',
      }, cwd)
      const written = outcome.scopes
        .map((scope) => (scope === 'project' ? outcome.projectDir : outcome.globalDir))
        .filter((dir) => dir.length > 0)
      deps.log('record', {
        id: outcome.entry.id,
        title: outcome.entry.title,
        sessionId: exec.agent?.session.id ?? '',
        scopes: outcome.scopes,
      })
      return {
        ok: true,
        id: outcome.entry.id,
        writtenTo: written,
        note: outcome.scopes.includes('project')
          ? '已入档：项目档案一份（跟着这个项目走），全局档案一份（当备份）。同一类问题以后再遇到，pitfall_search 就能翻到它。'
          : '已入全局档案。当前工作区没启用项目档案，所以这次只写了一处。',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pitfall_show',
    description: '看某条踩坑记录的全文（现象、怎么踩进去的、怎么解决的、证据、后续补充）。'
      + '检索结果里挑出来真相关的那条，要看细节时用它。先查当前工作区的项目档案，再查全局档案。',
    parameters: {
      id: { type: 'string', required: true, description: '记录编号，形如 p-20261004-164512-a3f9。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args, exec) {
      if (!deps.enabled()) return { ok: false, error: '踩坑档案插件已关闭' }
      const library = deps.library()
      const cwd = cwdOf(exec)
      const found = library.get(args.id, cwd)
      if (found === undefined) return { ok: false, error: `两本档案里都没有 ${args.id} 这条记录。可以用 pitfall_search 找找。` }
      const entry = found.entry
      return {
        ok: true,
        id: entry.id,
        title: entry.title,
        status: statusLabel(entry.status),
        tags: entry.tags,
        area: entry.area,
        at: entry.at,
        updatedAt: entry.updatedAt,
        recordedFrom: entry.cwd,
        from: scopeLabel(found.scope),
        symptom: entry.symptom,
        cause: entry.cause,
        solution: entry.solution,
        evidence: entry.evidence,
        notes: entry.notes,
        card: `${found.dir}/cards/${entry.id}.md`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pitfall_update',
    description: '补记一条旧记录：后来发现了更好的解法、当时只绕过没根治、或者状态变了。'
      + '**追加**说明用 `note`，不要用覆盖字段把当时的记录抹掉 —— 两条都留着才对下次有用。'
      + '只有当初真的写错了才用覆盖字段。改动会同步到该项目档案与全局备份。',
    parameters: {
      id: { type: 'string', required: true, description: '要补记的记录编号。' },
      note: { type: 'string', description: '追加一条补充说明（推荐用法）。写清「后来发现了什么」。' },
      solution: { type: 'string', description: '覆盖解法（仅在当初写错时用）。' },
      status: { type: 'string', enum: ['solved', 'workaround', 'open'], description: '更新状态。' },
      tags: { type: 'array', items: { type: 'string' }, description: '覆盖标签。' },
      title: { type: 'string', description: '覆盖标题。' },
      area: { type: 'string', description: '覆盖涉及范围。' },
      evidence: { type: 'string', description: '覆盖证据。' },
      cause: { type: 'string', description: '覆盖根因。' },
      symptom: { type: 'string', description: '覆盖现象。' },
    },
    output: OBJECT_OUTPUT,
    async execute(args, exec) {
      if (!deps.enabled()) return { ok: false, error: '踩坑档案插件已关闭' }
      const library = deps.library()
      const cwd = cwdOf(exec)
      const outcome = library.update(args.id, {
        ...args.note === undefined ? {} : { note: args.note },
        ...args.solution === undefined ? {} : { solution: args.solution },
        ...args.status === undefined ? {} : { status: args.status as PitfallStatus },
        ...args.tags === undefined ? {} : { tags: args.tags as string[] },
        ...args.title === undefined ? {} : { title: args.title },
        ...args.area === undefined ? {} : { area: args.area },
        ...args.evidence === undefined ? {} : { evidence: args.evidence },
        ...args.cause === undefined ? {} : { cause: args.cause },
        ...args.symptom === undefined ? {} : { symptom: args.symptom },
      }, cwd)
      if (outcome === undefined) return { ok: false, error: `两本档案里都没有 ${args.id} 这条记录。` }
      deps.log('update', { id: outcome.entry.id, status: outcome.entry.status, scopes: outcome.scopes })
      const cardHome = outcome.scopes.includes('project') ? outcome.projectDir : outcome.globalDir
      return {
        ok: true,
        id: outcome.entry.id,
        status: statusLabel(outcome.entry.status),
        updatedAt: outcome.entry.updatedAt,
        solution: summarize(outcome.entry, 200),
        from: scopeLabel(outcome.scopes[0] ?? 'global'),
        card: `${cardHome}/cards/${outcome.entry.id}.md`,
      }
    },
  }))
}
