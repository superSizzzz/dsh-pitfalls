/**
 * pitfalls 的配置 schema。
 *
 * 用 schemastery（dsh 全家的配置校验器）声明，导出名必须是 `Config`：
 * loader 拿它对 profile config 段做校验、填默认值，再把结果传进 `apply`。
 *
 * 保持扁平 —— 嵌套对象在 schemastery 里的 default 语义容易踩坑。
 * 字段注释以「这个旋钮实际改变什么行为」为准，不复述字段名。
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /** 总开关。false 时插件照常挂载，但不注册工具、不装监听、不注入提示词。 */
  enabled: z.boolean().default(true),

  /**
   * 档案目录（全局那本）。留空 = `$DSH_HOME/pitfalls`（dsh 没设 DSH_HOME 时是 `~/.dsh/pitfalls`）。
   *
   * 它同时是备份：项目档案跟着工作区走，这本留着兜底 —— 换个工作区、临时目录里
   * 干活、或者项目档案被删了，都还能捞回来。
   */
  dir: z.string().default(''),

  /**
   * 是否把记录也写进**当前工作区**的档案目录。
   *
   * 开着：一个项目的坑跟着项目走（换机器、交给同事、隔半年回来都还在）。
   * 关掉：只写全局那一本。
   */
  projectStore: z.boolean().default(true),

  /**
   * 项目档案目录（相对当前工作区）。填绝对路径则所有工作区共用同一处。
   *
   * 用 `.dsh/pitfalls` 而不是另起一个隐藏目录，是为了跟工作区里已有的
   * `.dsh/` 约定放在一起。想让它随项目进版本库就别把它加进 .gitignore。
   */
  projectDir: z.string().default('.dsh/pitfalls'),

  /** 写项目档案时，是否在全局目录同时留一份备份。 */
  backupToGlobal: z.boolean().default(true),

  /**
   * 是否自动盯工具失败。
   *
   * 开启后，同一个工具连续失败到阈值就会在会话里注入一条提醒，让模型
   * 「先查历史、解决后记一笔」。关掉只留下模型主动调工具这一条路 ——
   * 模型钻进任务里经常想不起来记录，所以默认开。
   */
  autoDetect: z.boolean().default(true),

  /**
   * 同一个工具连续失败几次算「踩到坑了」。
   *
   * 默认 2：第一次失败可能只是探索（路径猜错、命令拼错），第二次才像是
   * 真撞上了什么。填 1 会很吵，填 3 以上容易漏掉「试了两次就绕开」的坑。
   */
  failureStreak: z.number().default(2),

  /**
   * 命中历史档案时，是否把历史条目连同解法一起带进提醒。
   *
   * 这是「下次遇到问题先翻前面的坑」的自动落地：命中就直接给答案，
   * 没命中才要求模型记一笔。关掉则只提醒「该记录了」。
   */
  matchHistory: z.boolean().default(true),

  /** 同一条会话两次提醒之间的最小间隔（毫秒）。防止连环失败刷屏。 */
  reminderCooldownMs: z.number().default(600000),

  /** 单条会话最多注入几次提醒。到上限就闭嘴，等新会话再说。 */
  maxRemindersPerSession: z.number().default(4),

  /**
   * 是否往系统提示里写一段「踩坑就记、开工先查」的规则。
   *
   * 这是预防层：写进去模型才知道这套档案存在、什么时候该用。关掉就只剩
   * 自动检测那一条路（工具仍然可用，只是模型不会主动用）。
   */
  systemPromptSection: z.boolean().default(true),

  /** INDEX.md 最多列多少条（按时间倒序）。只影响那个可读索引，不影响检索。 */
  indexLimit: z.number().default(200),

  /**
   * 事件日志路径（JSONL）。留空则完全不记。
   *
   * 排查「插件到底装上没有、到底有没有在管事」时开它 —— 一行一次加载、
   * 一次提醒、一次落盘。比在 harness 日志里翻有用。
   */
  logPath: z.string().default(''),
})

export type PitfallsConfig = ReturnType<typeof Config>

/** schemastery 校验后的配置在字段层面已是具体值，这里只做一层防御性读取。 */
export function readConfig(raw: unknown): PitfallsConfig {
  return Config(raw ?? {}) as PitfallsConfig
}

/** 归一化配置：把「非法数字 / 空串」这类关不掉的输入折成安全值，判定处少判一次。 */
export interface ResolvedConfig {
  dir: string
  projectStore: boolean
  projectDir: string
  backupToGlobal: boolean
  autoDetect: boolean
  failureStreak: number
  matchHistory: boolean
  reminderCooldownMs: number
  maxRemindersPerSession: number
  systemPromptSection: boolean
  indexLimit: number
  logPath: string
}

export function resolveConfig(config: PitfallsConfig): ResolvedConfig {
  const positive = (value: number, fallback: number): number =>
    Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
  const nonNegative = (value: number): number => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)

  return {
    dir: config.dir.trim(),
    projectStore: config.projectStore,
    projectDir: config.projectDir.trim(),
    backupToGlobal: config.backupToGlobal,
    autoDetect: config.autoDetect,
    failureStreak: positive(config.failureStreak, 2),
    matchHistory: config.matchHistory,
    reminderCooldownMs: nonNegative(config.reminderCooldownMs),
    maxRemindersPerSession: positive(config.maxRemindersPerSession, 4),
    systemPromptSection: config.systemPromptSection,
    indexLimit: positive(config.indexLimit, 200),
    logPath: config.logPath.trim(),
  }
}
