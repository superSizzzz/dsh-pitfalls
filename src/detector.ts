/**
 * 踩坑检测器。
 *
 * 输入是「一次工具调用失败了」这条事实，输出是「现在该出个声了」或者
 * 「还不到时候」。整个类不碰 dsh、不碰 fs，纯状态机 —— 判定规则是这个
 * 插件的智力所在，也是最容易被改坏的地方，所以必须能脱离 harness 直跑测试。
 *
 * 判据说清楚：
 *  - 计数按「同一个工具连续失败」算，中间任何一次成功都会清零。第一次
 *    失败通常只是探索（命令拼错、路径猜错），第二次才像真撞上了什么。
 *  - 触发后立刻清零，避免第三次、第四次失败继续刷屏。
 *  - 再加一道冷却（时间）和一道配额（次数），防止一整轮里反复打扰。
 */

/** 一次失败的工具调用。clue 是给检索和提醒用的线索文本（命令、报错摘要等）。 */
export interface FailureSignal {
  sessionId: string
  toolName: string
  clue: string
  at: number
}

/** 判定为「值得提醒」时的结论。 */
export interface Verdict {
  sessionId: string
  toolName: string
  /** 这是第几次连续失败。 */
  count: number
  clue: string
}

export interface DetectorOptions {
  /** 连续失败到这个次数才出声。 */
  failureStreak: number
  /** 两次提醒之间的最小间隔（毫秒），0 表示不冷却。 */
  cooldownMs: number
  /** 单条会话的提醒上限。 */
  maxPerSession: number
}

interface SessionState {
  /** 当前正在连续失败的工具名；换工具就重新起算。 */
  toolName: string
  streak: number
  reminders: number
  lastReminderAt: number
}

export class PitfallDetector {
  private readonly options: DetectorOptions
  private readonly states = new Map<string, SessionState>()

  constructor(options: DetectorOptions) {
    this.options = options
  }

  /**
   * 记一次失败。返回非 null 表示「现在该提醒了」，调用方负责组装并注入，
   * 本类不关心提醒长什么样。
   */
  observe(signal: FailureSignal): Verdict | null {
    const state = this.states.get(signal.sessionId) ?? {
      toolName: signal.toolName,
      streak: 0,
      reminders: 0,
      lastReminderAt: 0,
    }

    if (state.toolName !== signal.toolName) {
      state.toolName = signal.toolName
      state.streak = 0
    }
    state.streak += 1
    this.states.set(signal.sessionId, state)

    if (state.streak < this.options.failureStreak) return null
    if (state.reminders >= this.options.maxPerSession) return null
    if (this.options.cooldownMs > 0 && signal.at - state.lastReminderAt < this.options.cooldownMs) return null

    // 出声之后清零 + 记账：同一串失败只提醒一次。
    const count = state.streak
    state.streak = 0
    state.reminders += 1
    state.lastReminderAt = signal.at
    return { sessionId: signal.sessionId, toolName: signal.toolName, count, clue: signal.clue }
  }

  /**
   * 记一次成功。只清同一工具的连续计数 —— 别的工具失败着，不该被这里抹掉。
   * 成功也可能意味着「坑已经绕过去了」，所以顺带允许调用方拿它做别的事。
   */
  observeSuccess(sessionId: string, toolName: string): void {
    const state = this.states.get(sessionId)
    if (state === undefined) return
    if (state.toolName !== toolName) return
    state.streak = 0
  }

  /** 会话结束或换代时丢弃状态：留着只会占内存，也让新会话的配额莫名其妙地少。 */
  forget(sessionId: string): void {
    this.states.delete(sessionId)
  }

  /** 当前连续失败到第几次了（测试与排查用）。 */
  streakOf(sessionId: string, toolName: string): number {
    const state = this.states.get(sessionId)
    if (state === undefined || state.toolName !== toolName) return 0
    return state.streak
  }
}
