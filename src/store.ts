/**
 * 档案存储。
 *
 * 一份档案放在一个目录里，三层结构，各有各的用途：
 *
 *   entries.jsonl   事实源。追加式，一行一条**完整快照**，同 id 后写覆盖前写。
 *                   用快照而不是增量补丁：写入被打断最多坏掉最后一行，跳过
 *                   它就能读；补丁流一旦错过一条，后面的解释就全错了。
 *   cards/<id>.md   单条可读卡片。给人看的，直接用编辑器打开就是一篇小记。
 *   INDEX.md        按时间倒序的索引。翻历史时先看它，不用 grep jsonl。
 *
 * 检索在内存里做：把 jsonl fold 成条目表，按 token 命中的字段加权打分。
 * 量级是「一个人几年踩的坑」，不需要索引结构；可读性和可审查性比速度重要。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type PitfallStatus = 'solved' | 'workaround' | 'open'

/** 事后追加的一条补充说明（比如后来发现了更好的解法）。 */
export interface PitfallNote {
  at: string
  text: string
}

export interface PitfallEntry {
  id: string
  /** 首次记录时间（ISO 8601，带时区）。 */
  at: string
  /** 最后一次改动时间。 */
  updatedAt: string
  /** 一句话说清是什么坑。 */
  title: string
  /** 现象：当时看到的是什么（报错、异常行为、和预期的差距）。 */
  symptom: string
  /** 怎么踩进去的：触发条件与根因。这一栏是复现和避免的关键。 */
  cause: string
  /** 怎么解决的：实际做了什么，哪怕是绕过去。 */
  solution: string
  status: PitfallStatus
  tags: string[]
  /** 涉及范围：文件名、命令、模块名之类，检索时权重高于正文。 */
  area: string
  /** 证据：原始报错片段、命令、路径、行号。 */
  evidence: string
  /** 记这条时的工作区。 */
  cwd: string
  /** 记这条时的会话 id，方便回原会话翻上下文。 */
  sessionId: string
  /** 谁记的：model（模型主动记）或 auto / user。 */
  source: string
  notes: PitfallNote[]
}

/** `record()` 的输入。四段正文里只有 title 是必须的，其余留空不该阻塞记录。 */
export interface PitfallInput {
  title: string
  symptom?: string
  cause?: string
  solution?: string
  status?: PitfallStatus
  tags?: string[]
  area?: string
  evidence?: string
  cwd?: string
  sessionId?: string
  source?: string
}

/** `update()` 的补丁。只给要改的字段，其余保持原样。 */
export interface PitfallPatch {
  title?: string
  symptom?: string
  cause?: string
  solution?: string
  status?: PitfallStatus
  tags?: string[]
  area?: string
  evidence?: string
  /** 追加一条补充说明，而不是覆盖正文。 */
  note?: string
}

export interface SearchHit {
  entry: PitfallEntry
  score: number
}

/** 字段权重：范围与标签是「索引词」，正文是「细节」，证据只是兜底命中。 */
const FIELD_WEIGHTS: ReadonlyArray<readonly [keyof PitfallEntry, number]> = [
  ['tags', 6],
  ['title', 5],
  ['area', 3],
  ['symptom', 2],
  ['cause', 2],
  ['solution', 2],
  ['evidence', 1],
]

const TITLE_MAX = 200
const BODY_MAX = 8000
const TAG_MAX = 24
const TAGS_MAX = 16
const NOTES_MAX = 50

const STATUSES: readonly PitfallStatus[] = ['solved', 'workaround', 'open']

/** 归一化状态值：认不出来的当成 solved（绝大多数记录是解决了才写的）。 */
export function normalizeStatus(value: unknown): PitfallStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? value as PitfallStatus
    : 'solved'
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n/g, '\n').trim().slice(0, max)
}

/** 标签：去掉空白与重复，防止同一条记录里 tag 写两遍把权重虚高。 */
function cleanTags(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const tag = raw.trim().replace(/^#/, '').slice(0, TAG_MAX)
    if (tag.length === 0 || out.includes(tag)) continue
    out.push(tag)
    if (out.length >= TAGS_MAX) break
  }
  return out
}

/** `p-20261004-164512-a3f9`：按时间可排序，后缀随机防同秒撞号。 */
function newId(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}`
  const time = `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  const stamp = `${date}-${time}`
  const suffix = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
  return `p-${stamp}-${suffix}`
}

/**
 * 检索里没有信息量的英文虚词。
 *
 * 报错文本里满地都是它们（`no such file or directory`），命中率高得离谱却
 * 几乎总是误命中 —— 一条 `no` 就能把「tags 里含 node」的记录拉成相关。
 */
const STOP_WORDS = new Set([
  'no', 'or', 'of', 'to', 'is', 'in', 'at', 'on', 'by', 'it', 'as', 'if', 'an', 'be', 'do', 'so', 'we', 'us',
  'the', 'and', 'for', 'not', 'with', 'from', 'this', 'that', 'are', 'was', 'has', 'had', 'can', 'but',
  'you', 'all', 'any', 'our', 'out', 'its', 'were', 'will', 'would', 'should', 'could', 'into', 'than',
])

/** 只由「像标识符的字符」组成的 token 按词匹配，其余（中文、混合串）按子串匹配。 */
const WORD_TOKEN = /^[a-z0-9_./\\:-]+$/
const WORD_CHAR = /[a-z0-9_]/

/**
 * token 是否命中这段文本。
 *
 * 英文按**词边界**匹配，中文按子串 —— 这条区分是必须的：`no` 作为子串会命中
 * `node`，于是「档案里没有」被判成「有」，提醒就把别的坑的解法当作这次的答案
 * 端给模型。宁可说没有，也不能给错答案。
 */
function matchesToken(haystack: string, token: string): boolean {
  if (!WORD_TOKEN.test(token)) return haystack.includes(token)
  let from = 0
  while (from <= haystack.length) {
    const index = haystack.indexOf(token, from)
    if (index < 0) return false
    const before = index === 0 ? '' : haystack[index - 1]
    const after = index + token.length >= haystack.length ? '' : haystack[index + token.length]
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true
    from = index + 1
  }
  return false
}

/**
 * 把查询串切成检索 token。
 *
 * 英文/数字按词切；中文没有分隔符，所以整串先当一个大 token（保证短语精确
 * 命中能排前面），长串再补 2-gram（保证「上传失败」能命中「文件上传失败」
 * 这种写法差异）。两路都留着，是召回和精度的折中。
 */
export function tokenize(query: string): string[] {
  const lowered = query.toLowerCase()
  const out = new Set<string>()
  for (const matched of lowered.matchAll(/[a-z0-9_./\\:-]{2,}/g)) {
    if (STOP_WORDS.has(matched[0])) continue
    out.add(matched[0])
  }
  for (const matched of lowered.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const run = matched[0]
    out.add(run)
    if (run.length > 4) {
      for (let i = 0; i + 2 <= run.length; i += 1) out.add(run.slice(i, i + 2))
    }
  }
  return [...out]
}

/** 取一个字段的检索文本。数组字段（tags/notes）拼成一行再匹配。 */
function fieldText(entry: PitfallEntry, key: keyof PitfallEntry): string {
  const value = entry[key]
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : item.text))
      .join(' ')
      .toLowerCase()
  }
  return typeof value === 'string' ? value.toLowerCase() : ''
}

/**
 * 给一条记录打分。0 表示跟查询没关系 —— 调用方必须据此过滤，否则「没命中」
 * 会被当成「命中了个弱相关的」，把历史里不相干的坑当成答案推给模型。
 *
 * 多 token 的查询按覆盖率放大：只命中一个词的长查询不该排在前面。
 */
export function scoreEntry(entry: PitfallEntry, tokens: readonly string[]): number {
  if (tokens.length === 0) return 1
  let total = 0
  let hits = 0
  for (const token of tokens) {
    let best = 0
    for (const [key, weight] of FIELD_WEIGHTS) {
      if (matchesToken(fieldText(entry, key), token)) best = Math.max(best, weight)
    }
    if (best > 0) hits += 1
    total += best
  }
  if (hits === 0) return 0
  return total * (1 + hits / tokens.length)
}

/** 一条记录压成一句话，给检索结果和提醒用。 */
export function summarize(entry: PitfallEntry, width = 120): string {
  const firstLine = entry.solution.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  const clipped = firstLine.length > width ? `${firstLine.slice(0, width)}…` : firstLine
  return clipped
}

export interface PitfallStoreOptions {
  /** INDEX.md 最多列多少条。只影响那个可读索引，检索不受它限制。 */
  indexLimit?: number
}

export class PitfallStore {
  private readonly root: string
  private readonly indexLimit: number
  private cache: { mtimeMs: number; entries: PitfallEntry[] } | undefined

  constructor(root: string, options: PitfallStoreOptions = {}) {
    this.root = root
    this.indexLimit = options.indexLimit !== undefined && options.indexLimit > 0 ? Math.floor(options.indexLimit) : 200
  }

  /** 档案目录，配置面板与排查日志要显示它。 */
  location(): string {
    return this.root
  }

  /**
   * 用一条完整快照覆盖写入（同 id 后写覆盖前写）。
   *
   * 给「同步到备份档案」用：备份那本要跟项目那本逐字一致，走 `update()` 的
   * 增量语义反而会让 note 追加两次。
   */
  save(entry: PitfallEntry): void {
    this.persist(entry)
  }

  /** 这本档案里有没有这条编号。 */
  has(id: string): boolean {
    return this.get(id) !== undefined
  }

  private get jsonlPath(): string {
    return join(this.root, 'entries.jsonl')
  }

  private get cardsDir(): string {
    return join(this.root, 'cards')
  }

  private get indexPath(): string {
    return join(this.root, 'INDEX.md')
  }

  /** 读全部记录（同 id 取最后一条快照），按时间倒序。带 mtime 缓存。 */
  list(): PitfallEntry[] {
    return this.read().slice().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  }

  get(id: string): PitfallEntry | undefined {
    const wanted = id.trim().toLowerCase()
    return this.read().find((entry) => entry.id.toLowerCase() === wanted)
  }

  /**
   * 记一条新坑。落盘三处：jsonl 追加快照、写一张卡片、重建索引。
   * 任何一步失败都会抛出 —— 记档失败必须让调用方知道，不能静默吞掉。
   */
  record(input: PitfallInput): PitfallEntry {
    const now = new Date()
    const at = now.toISOString()
    const entry: PitfallEntry = {
      id: newId(now),
      at,
      updatedAt: at,
      title: cleanText(input.title, TITLE_MAX) || '（未命名）',
      symptom: cleanText(input.symptom, BODY_MAX),
      cause: cleanText(input.cause, BODY_MAX),
      solution: cleanText(input.solution, BODY_MAX),
      status: normalizeStatus(input.status),
      tags: cleanTags(input.tags),
      area: cleanText(input.area, TITLE_MAX),
      evidence: cleanText(input.evidence, BODY_MAX),
      cwd: cleanText(input.cwd, TITLE_MAX),
      sessionId: cleanText(input.sessionId, TITLE_MAX),
      source: cleanText(input.source, 40) || 'model',
      notes: [],
    }
    this.persist(entry)
    return entry
  }

  /**
   * 补记一条。只覆盖给出的字段，`note` 是追加而非覆盖 —— 「后来发现更好的
   * 解法」这类信息不该把当时的记录抹掉，两条都留着才对下次有用。
   */
  update(id: string, patch: PitfallPatch): PitfallEntry | undefined {
    const existing = this.get(id)
    if (existing === undefined) return undefined

    const merged: PitfallEntry = {
      ...existing,
      updatedAt: new Date().toISOString(),
      title: patch.title === undefined ? existing.title : cleanText(patch.title, TITLE_MAX) || existing.title,
      symptom: patch.symptom === undefined ? existing.symptom : cleanText(patch.symptom, BODY_MAX),
      cause: patch.cause === undefined ? existing.cause : cleanText(patch.cause, BODY_MAX),
      solution: patch.solution === undefined ? existing.solution : cleanText(patch.solution, BODY_MAX),
      status: patch.status === undefined ? existing.status : normalizeStatus(patch.status),
      tags: patch.tags === undefined ? existing.tags : cleanTags(patch.tags),
      area: patch.area === undefined ? existing.area : cleanText(patch.area, TITLE_MAX),
      evidence: patch.evidence === undefined ? existing.evidence : cleanText(patch.evidence, BODY_MAX),
      notes: existing.notes.slice(),
    }
    if (typeof patch.note === 'string' && patch.note.trim().length > 0) {
      merged.notes.push({ at: merged.updatedAt, text: cleanText(patch.note, BODY_MAX) })
      while (merged.notes.length > NOTES_MAX) merged.notes.shift()
    }
    this.persist(merged)
    return merged
  }

  /**
   * 检索。空查询就是「按时间列最近的」，给了查询则只返回真命中的（score > 0）。
   * tag 是精确过滤，在打分之前先筛 —— 按标签找的时候不该混进正文碰巧含这个词的。
   */
  search(query: string, options: { tag?: string; status?: PitfallStatus; limit?: number } = {}): SearchHit[] {
    const limit = options.limit !== undefined && options.limit > 0 ? Math.floor(options.limit) : 8
    const tokens = tokenize(query)
    const tag = options.tag?.trim()
    let pool = this.list()
    if (tag !== undefined && tag.length > 0) pool = pool.filter((entry) => entry.tags.includes(tag))
    if (options.status !== undefined) pool = pool.filter((entry) => entry.status === options.status)
    // 给了查询却切不出任何有信息量的 token（比如整句都是虚词）：宁可不给答案，
    // 也不要退化成「列出全部记录」，那会被读成「这些都是相关的」。
    if (query.trim().length > 0 && tokens.length === 0) return []

    const hits: SearchHit[] = []
    for (const entry of pool) {
      const score = scoreEntry(entry, tokens)
      if (score <= 0) continue
      hits.push({ entry, score })
    }
    hits.sort((a, b) => (b.score - a.score) || (a.entry.at < b.entry.at ? 1 : -1))
    return hits.slice(0, limit)
  }

  /** 把一条记录渲染成可读 Markdown 卡片。给人看的，所以用中文小标题。 */
  renderCard(entry: PitfallEntry): string {
    const lines: string[] = [
      `# ${entry.title}`,
      '',
      `- 编号：\`${entry.id}\``,
      `- 状态：${statusLabel(entry.status)}　记录：${entry.at}　最后改动：${entry.updatedAt}`,
      ...entry.tags.length === 0 ? [] : [`- 标签：${entry.tags.map((tag) => `\`${tag}\``).join(' ')}`],
      ...entry.area.length === 0 ? [] : [`- 范围：${entry.area}`],
      ...entry.cwd.length === 0 ? [] : [`- 工作区：\`${entry.cwd}\``],
      '',
      '## 现象',
      '',
      entry.symptom.length > 0 ? entry.symptom : '（没写）',
      '',
      '## 怎么踩进去的',
      '',
      entry.cause.length > 0 ? entry.cause : '（没写）',
      '',
      '## 怎么解决的',
      '',
      entry.solution.length > 0 ? entry.solution : '（没写）',
    ]
    if (entry.evidence.length > 0) {
      lines.push('', '## 证据', '', '```text', entry.evidence, '```')
    }
    if (entry.notes.length > 0) {
      lines.push('', '## 后续补充', '')
      for (const note of entry.notes) lines.push(`- ${note.at}：${note.text}`)
    }
    lines.push('')
    return lines.join('\n')
  }

  /** 索引页。翻历史先看它：一行一条，带编号、状态、标签和一句话解法。 */
  renderIndex(entries: readonly PitfallEntry[], limit: number): string {
    const lines: string[] = [
      '# 踩坑档案',
      '',
      `共 ${entries.length} 条，按时间倒序。正文在 \`cards/<编号>.md\`。`,
      '',
      '| 编号 | 时间 | 状态 | 标签 | 标题 | 一句话解法 |',
      '| --- | --- | --- | --- | --- | --- |',
    ]
    for (const entry of entries.slice(0, limit)) {
      const tags = entry.tags.join(' ')
      const summary = summarize(entry, 60).replace(/\|/g, '\\|')
      const cells = [
        `\`${entry.id}\``,
        entry.at.slice(0, 16).replace('T', ' '),
        statusLabel(entry.status),
        tags,
        entry.title.replace(/\|/g, '\\|'),
        summary,
      ]
      lines.push(`| ${cells.join(' | ')} |`)
    }
    lines.push('')
    return lines.join('\n')
  }

  /** 读 jsonl 并折叠。缓存按 mtime 失效，外部手改文件也能被看到。 */
  private read(): PitfallEntry[] {
    if (!existsSync(this.jsonlPath)) return []
    const mtimeMs = statSync(this.jsonlPath).mtimeMs
    if (this.cache !== undefined && this.cache.mtimeMs === mtimeMs) return this.cache.entries

    const entries = new Map<string, PitfallEntry>()
    const raw = readFileSync(this.jsonlPath, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = JSON.parse(trimmed) as Partial<PitfallEntry>
        if (typeof parsed.id !== 'string' || typeof parsed.at !== 'string') continue
        entries.set(parsed.id, {
          ...parsed,
          tags: cleanTags(parsed.tags),
          notes: Array.isArray(parsed.notes)
            ? parsed.notes.filter((note): note is PitfallNote =>
              typeof note === 'object' && note !== null && typeof (note as PitfallNote).text === 'string')
            : [],
        } as PitfallEntry)
      } catch {
        // 写入被打断留下的残行：跳过它，其余记录照常可用。
      }
    }
    const list = [...entries.values()]
    this.cache = { mtimeMs, entries: list }
    return list
  }

  /** 追加快照 + 重写卡片 + 重建索引。 */
  private persist(entry: PitfallEntry): void {
    mkdirSync(this.cardsDir, { recursive: true })
    appendFileSync(this.jsonlPath, `${JSON.stringify({ v: 1, ...entry })}\n`, 'utf8')
    writeAtomically(join(this.cardsDir, `${entry.id}.md`), this.renderCard(entry))
    this.cache = undefined
    writeAtomically(this.indexPath, this.renderIndex(this.list(), this.indexLimit))
  }
}

/** 状态的中文说法。索引、卡片、提醒都用它，避免同一状态三种写法。 */
export function statusLabel(status: PitfallStatus): string {
  if (status === 'solved') return '已解决'
  if (status === 'workaround') return '已绕过'
  return '未解决'
}

/**
 * 先写临时文件再改名。
 *
 * 卡片和索引是整篇重写的，直接覆盖时若进程被杀，会留下半篇内容；改名在同
 * 一个卷上是原子的，读到的一半新一半旧这种情况就不会发生。
 */
function writeAtomically(path: string, content: string): void {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, content, 'utf8')
  renameSync(temporary, path)
}

/** 档案目录名：留给需要「跟 dsh 家目录同源」的调用方。 */
export function defaultStoreDir(dshHome: string): string {
  return join(dshHome, 'pitfalls')
}
