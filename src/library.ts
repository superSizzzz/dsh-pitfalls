/**
 * 档案库：一个工作区一本，外加一本全局备份。
 *
 * 为什么是两本。同一个项目的坑跟着项目走才有用 —— 换机器、交给同事、隔半年
 * 回来，那些「这个目录的路径不能这么拼」「这个接口的字段名跟文档不一样」都还在。
 * 但并非每次干活都在项目目录里（临时目录、只读挂载、根本没 cwd），所以全局
 * 那本既是兜底也当备份。
 *
 * 检索的优先级是明确的、也是这个文件存在的理由：**先当前工作区，不够再全局补**。
 * 项目档案里命中过的条目不会再从全局重复列出（按 id 去重），每条结果都带 scope，
 * 让调用方说得清「这条是项目里的，还是全局备份捞出来的」。
 */
import { isAbsolute, resolve } from 'node:path'
import { PitfallStore } from './store.ts'
import type { PitfallEntry, PitfallInput, PitfallPatch, PitfallStatus } from './store.ts'

/** 条目来自哪本档案。 */
export type PitfallScope = 'project' | 'global'

export interface ScopedHit {
  entry: PitfallEntry
  score: number
  scope: PitfallScope
  /** 条目所在档案目录，便于直接去翻卡片。 */
  dir: string
}

export interface LibraryOptions {
  /** 全局档案目录（同时充当备份）。 */
  globalDir: string
  /** 相对工作区的项目档案目录；空串表示不写项目档案。 */
  projectDir: string
  /** 是否写项目档案。 */
  projectStore: boolean
  /** 写项目档案时是否在全局留备份。 */
  backupToGlobal: boolean
  indexLimit: number
}

/** 检索过滤条件，两本档案用同一套。 */
interface Filters {
  tag?: string
  status?: PitfallStatus
  limit?: number
}

/** 一条记录的落点说明，给工具返回值用。 */
export interface RecordOutcome {
  entry: PitfallEntry
  /** 写进了哪几本（project 在前）。 */
  scopes: PitfallScope[]
  /** 项目档案目录；没写项目档案时为空串。 */
  projectDir: string
  /** 全局档案目录。 */
  globalDir: string
}

export interface FoundEntry {
  entry: PitfallEntry
  scope: PitfallScope
  dir: string
}

export class PitfallLibrary {
  private readonly options: LibraryOptions
  private readonly globalStore: PitfallStore
  /** 按解析后的绝对路径缓存，避免同一工作区反复建对象（缓存失效也没坏处）。 */
  private readonly projects = new Map<string, PitfallStore>()

  constructor(options: LibraryOptions) {
    this.options = options
    this.globalStore = new PitfallStore(options.globalDir, { indexLimit: options.indexLimit })
  }

  globalDir(): string {
    return this.globalStore.location()
  }

  /**
   * 当前工作区对应的项目档案。
   *
   * 拿不到 cwd、关了 projectStore、或者项目目录跟全局目录是同一个（那写两遍
   * 纯属自己跟自己打架）时返回 undefined —— 调用方据此退化成只用全局那本。
   */
  projectOf(cwd: string): PitfallStore | undefined {
    if (!this.options.projectStore || this.options.projectDir.length === 0) return undefined
    const trimmed = cwd.trim()
    if (trimmed.length === 0) return undefined
    const root = isAbsolute(this.options.projectDir)
      ? resolve(this.options.projectDir)
      : resolve(trimmed, this.options.projectDir)
    if (root === this.globalStore.location()) return undefined

    const cached = this.projects.get(root)
    if (cached !== undefined) return cached
    const created = new PitfallStore(root, { indexLimit: this.options.indexLimit })
    this.projects.set(root, created)
    return created
  }

  /** 项目档案目录（没写项目档案时为空串），工具返回值与日志要显示它。 */
  projectDirOf(cwd: string): string {
    return this.projectOf(cwd)?.location() ?? ''
  }

  /**
   * 记一条新坑。先写项目档案，再在全局留一份**逐字一致**的备份。
   *
   * 两份用同一个编号：这样后来 `pitfall_update` 补记时能同时对上，检索去重也
   * 只认编号。备份写失败不影响项目那本 —— 先落地的那份才是主。
   */
  record(input: PitfallInput, cwd: string): RecordOutcome {
    const project = this.projectOf(cwd)
    if (project === undefined) {
      return {
        entry: this.globalStore.record(input),
        scopes: ['global'],
        projectDir: '',
        globalDir: this.globalStore.location(),
      }
    }
    const entry = project.record(input)
    const scopes: PitfallScope[] = ['project']
    if (this.options.backupToGlobal) {
      this.globalStore.save(entry)
      scopes.push('global')
    }
    return { entry, scopes, projectDir: project.location(), globalDir: this.globalStore.location() }
  }

  /**
   * 检索：项目档案优先，数量不够时用全局补齐。
   *
   * 「优先」是**分层**的，不是「按分数混合排序」：项目档案的命中一律排在前面，
   * 只有它们凑不满 limit 时才去全局补位（同一编号不重复列出）。这样行为可预测 ——
   * 你在这个项目里记过的东西，永远先出现在眼前。
   *
   * 代价说清楚：limit 很小时（比如提醒里只要 3 条），项目里的弱命中会占满名额，
   * 全局里更对症的那条挤不进来。这是刻意的取舍 —— 优先就是优先，宁可让模型
   * 多看两条本项目的记录，也不要让它误以为「这个项目没人踩过」。
   */
  search(query: string, options: Filters & { cwd: string }): ScopedHit[] {
    const limit = options.limit !== undefined && options.limit > 0 ? Math.floor(options.limit) : 8
    const filters: Filters = {
      ...options.tag === undefined ? {} : { tag: options.tag },
      ...options.status === undefined ? {} : { status: options.status },
      limit,
    }
    const out: ScopedHit[] = []
    const seen = new Set<string>()

    const project = this.projectOf(options.cwd)
    if (project !== undefined) {
      for (const hit of project.search(query, filters)) {
        out.push({ entry: hit.entry, score: hit.score, scope: 'project', dir: project.location() })
        seen.add(hit.entry.id)
      }
    }

    if (out.length < limit) {
      for (const hit of this.globalStore.search(query, filters)) {
        if (seen.has(hit.entry.id)) continue
        out.push({ entry: hit.entry, score: hit.score, scope: 'global', dir: this.globalStore.location() })
        seen.add(hit.entry.id)
        if (out.length >= limit) break
      }
    }
    return out.slice(0, limit)
  }

  /** 按编号取全文：项目档案里先找，再找全局备份。 */
  get(id: string, cwd: string): FoundEntry | undefined {
    const project = this.projectOf(cwd)
    const inProject = project?.get(id)
    if (inProject !== undefined && project !== undefined) {
      return { entry: inProject, scope: 'project', dir: project.location() }
    }
    const inGlobal = this.globalStore.get(id)
    if (inGlobal !== undefined) return { entry: inGlobal, scope: 'global', dir: this.globalStore.location() }
    return undefined
  }

  /**
   * 补记。在哪本档案里找到就在哪本改；项目那本改了，全局备份跟着覆盖同步，
   * 免得两边讲两套话。
   *
   * 只在全局找到（早期记录、或者别的项目记的）时就地更新，**不**顺手搬进项目
   * 档案：搬了会让人分不清这条到底是哪个项目踩出来的，而检索本来就会兜底找到它。
   */
  update(id: string, patch: PitfallPatch, cwd: string): RecordOutcome | undefined {
    const project = this.projectOf(cwd)
    const inProject = project?.get(id)

    if (project !== undefined && inProject !== undefined) {
      const entry = project.update(id, patch)
      if (entry === undefined) return undefined
      const scopes: PitfallScope[] = ['project']
      if (this.options.backupToGlobal && this.globalStore.has(id)) {
        this.globalStore.save(entry)
        scopes.push('global')
      }
      return { entry, scopes, projectDir: project.location(), globalDir: this.globalStore.location() }
    }

    const entry = this.globalStore.update(id, patch)
    if (entry === undefined) return undefined
    return { entry, scopes: ['global'], projectDir: '', globalDir: this.globalStore.location() }
  }
}
