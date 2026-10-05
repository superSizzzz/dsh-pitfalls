/**
 * 提示词与提醒文案。
 *
 * 分两块，用途不同：
 *
 *   系统提示段落  预防层。会话一开始模型就知道这本档案存在、什么时候该
 *                 查、什么时候该记。规则写死在这里，不指望模型自己想起来。
 *   注入提醒      补救层。真撞上连续失败时，往会话里塞一条 user 消息，
 *                 带上「历史里有没有像的」这个结论，并标清是从哪本档案找到的。
 *
 * 文案的共同要求：说的都是**下一步动作**，不解释插件自己怎么实现的。
 */
import type { PitfallScope } from './library.ts'
import type { PitfallEntry } from './store.ts'
import { statusLabel, summarize } from './store.ts'

/**
 * 系统提示段落的排序位置。
 *
 * 700 是思考节拍，9000 是飞书播报。踩坑档案属于「工作方法」，排在两者之间 ——
 * 比风格类约定靠前，比具体的外部通道靠后。
 */
export const PROMPT_SECTION_ORDER = 750

/** 拼一条提醒时最多带几个历史条目：再多会把提醒本身变成一篇长文。 */
const MAX_HISTORY_IN_REMINDER = 3

/** 一条命中的历史记录，连同它来自哪本档案。 */
export interface ScopedPitfall {
  entry: PitfallEntry
  scope: PitfallScope
}

export interface SectionDirs {
  /** 项目档案目录（相对工作区）；空串表示当前没启用项目档案。 */
  projectDir: string
  /** 全局档案目录（绝对路径）。 */
  globalDir: string
}

export function systemSectionText(dirs: SectionDirs): string {
  const layout = dirs.projectDir.length > 0
    ? `档案分两层：**当前工作区的项目档案**（\`${dirs.projectDir}\`，跟着这个项目走）和**全局档案**（\`${dirs.globalDir}\`，兜底兼备份）。`
    : `档案放在全局目录 \`${dirs.globalDir}\`（当前没启用项目档案）。`

  return [
    '## 踩坑档案',
    '',
    '你有一本「踩坑档案」，记的是工作中真踩过的坑：现象、怎么踩进去的、怎么解决的。后面的活遇到同类问题时，先翻它。',
    '',
    layout,
    '',
    '**动手之前先查**（`pitfall_search`）：',
    '- 撞上报错、构建失败、行为诡异、接口不按预期 —— 试之前先搜一次，别从零猜；',
    '- 检索顺序由工具自己管：**先当前工作区的项目档案，不够再从全局补**。每条结果都标了来自哪本 —— 项目档案里的优先信，全局里捞出来的可能是别的项目踩的坑，先核对这次的现场再套用；',
    '- 线索用「报错关键词 + 涉及的模块/命令/文件名」，不要拿一整句话去搜；',
    '- 两本都搜不到就正常干活，不要为了搜而搜。',
    '',
    '**解决之后必须记**（`pitfall_record`）：',
    '- 判据：这个问题花了力气才搞清（试错两次以上、翻过源码、换过思路），并且**已经解决或已经绕过**；',
    '- 坑要能复现：写清触发条件，不能只写「报了个错」；',
    '- 四栏都要落：现象（看到什么）、怎么踩进去的（根因与触发条件）、怎么解决的（实际动作，绕过去也要写清怎么绕的）、证据（报错原文、命令、路径、行号）；',
    dirs.projectDir.length > 0
      ? '- 地方不用你挑：项目档案与全局备份会同时写，同一编号，两边随时对得上。'
      : '- 记进全局档案即可，不用挑地方。',
    '',
    '**不要记**：手滑拼错、看错路径这类一次性失误；用户明确说不用记的东西。',
    '',
    '**补记**（`pitfall_update`）：后来发现了更好的解法，或当时只是绕过没根治 —— 追加一条说明，不要改掉原来的记录。',
    '',
    '记完不用向用户汇报这件事，除非他问起。',
  ].join('\n')
}

/** 把一条命中的记录压成提醒里的一行，并标出来自哪本档案。 */
function historyLine(match: ScopedPitfall): string {
  const entry = match.entry
  const tags = entry.tags.length === 0 ? '' : ` ｜${entry.tags.join(' ')}`
  const origin = match.scope === 'project' ? '本项目' : '全局'
  const head = `- \`${entry.id}\` ｜${statusLabel(entry.status)} ｜${origin}${tags} ｜${entry.title}`
  const solution = summarize(entry, 160)
  return solution.length === 0 ? head : `${head}\n  当时怎么解决的：${solution}`
}

export interface ReminderInput {
  toolName: string
  count: number
  clue: string
  /** 检索命中的历史条目（项目档案在前）；空数组表示两本档案都没有像的。 */
  matches: readonly ScopedPitfall[]
}

/**
 * 组装要注入会话的提醒。
 *
 * 命中时先给答案，让模型直接复用；没命中才要求它记一笔 —— 顺序很重要，
 * 「先找答案、再补档案」比「先记档」更符合干活的人真实需要。
 *
 * 命中来自哪本档案要明说：项目档案里的多半对症，全局里捞出来的可能是别的
 * 项目踩的坑，直接照搬反而会带偏。
 */
export function reminderText(input: ReminderInput): string {
  const clue = input.clue.length > 200 ? `${input.clue.slice(0, 200)}…` : input.clue
  const head = `【踩坑档案】\`${input.toolName}\` 连续 ${input.count} 次没成功。${clue.length === 0 ? '' : `\n线索：${clue}`}`
  const shown = input.matches.slice(0, MAX_HISTORY_IN_REMINDER)

  if (shown.length === 0) {
    return [
      head,
      '',
      '当前项目档案和全局档案里都没有搜到相关的坑，所以这回可能是新问题。',
      '等你解决或绕过去之后，用 `pitfall_record` 记一笔：现象、怎么踩进去的（根因与触发条件）、怎么解决、证据。',
      '别把这条提醒当成要汇报的事 —— 对用户该说什么还说什么。',
    ].join('\n')
  }

  const fromProject = shown.filter((match) => match.scope === 'project').length
  const lead = fromProject > 0
    ? '当前项目的档案里有像的，先看能不能直接用：'
    : '当前项目档案里没有；下面是从全局档案里捞出来的（可能是别的项目踩的坑，先核对这次的现场再套用）：'

  return [
    head,
    '',
    lead,
    ...shown.map(historyLine),
    '',
    '如果这次的坑跟上面不一样（或者上面那条的解法这次不管用），解决或绕过去之后用 `pitfall_record` 记一笔新坑，必要时用 `pitfall_update` 补记旧条目。',
    '别把这条提醒当成要汇报的事 —— 对用户说什么还说什么。',
  ].join('\n')
}

/** 飞书那类通道把注入消息渲染成卡片时用的摘要。 */
export function reminderSummary(input: ReminderInput): string {
  const fromProject = input.matches.filter((match) => match.scope === 'project').length
  const fromGlobal = input.matches.length - fromProject
  if (input.matches.length === 0) return `踩坑档案：${input.toolName} ×${input.count}（两本都没有）`
  return `踩坑档案：${input.toolName} ×${input.count}（本项目 ${fromProject} 条 / 全局 ${fromGlobal} 条）`
}
