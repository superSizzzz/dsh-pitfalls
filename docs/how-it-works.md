# 工作原理

面向改这个插件的人：判定规则长什么样、检索怎么打分、两层档案怎么配合、
用到了 dsh 的哪些接口、以及现在有哪些做不到的事。

## 整体形状

插件挂在 dsh 的三个公开扩展点上，互不耦合：

```
tools            四个 pitfall_* 工具          → 模型主动用
systemPrompt     一段「踩坑就记、开工先查」规则  → 预防层
session/event    工具失败事件                  → 补救层（自动出声）
```

一次「自动出声」的完整链路：

```
tool/call        →  pending.set(sessionId:callId, { name, clue })
tool/result      →  isError === true
                 →  detector.observe(...)        判定该不该出声
                 →  library.search(clue)         先项目档案，不足补全局
                 →  reminderText(input)          组装文案
                 →  agent.inject(userMessage)    只往队列里放，不唤醒驱动
```

## 判定规则（`src/detector.ts`）

纯状态机，不碰 dsh、不碰 fs —— 判定规则是这个插件最容易被改坏的地方，所以必须
能脱离 harness 直接跑测试。每个会话一份状态：

```ts
{ toolName, streak, reminders, lastReminderAt }
```

出声的条件，四条全过：

1. `streak >= failureStreak`（默认 2）
2. `reminders < maxPerSession`（默认 4）
3. `now - lastReminderAt >= reminderCooldownMs`（默认 10 分钟）
4. 计数按**同一个工具连续失败**算；换工具就从 0 重新起算

触发后立刻把 `streak` 归零并记账 —— 同一串失败只提醒一次，否则第三次、第四次失败
会继续刷屏。

`observeSuccess()` 只清**同一个工具**的计数：别的工具还在连续失败着，不该被一次
无关的成功抹掉。会话结束（`session/disposed`）时 `forget()` 丢掉状态，否则新会话
的配额会莫名其妙地少掉。

为什么用「连续失败」而不是匹配报错文本：`tool/result` 事件自带结构化的 `isError`，
比正则可靠得多；而「什么算一个坑」需要语义判断，插件不该假装自己能做。信号交给
插件，判断留给模型。

## 检索（`src/store.ts`）

三件事：怎么切词、怎么匹配、怎么打分。

**切词 `tokenize()`**：英文/数字按词切（长度 ≥ 2），过一遍停用词表；中文没有分隔符，
所以整串先当一个大 token（保证短语精确命中能排前面），长度超过 4 时再补 2-gram
（保证「上传失败」能命中「文件上传失败」这种写法差异）。两路都留着，是召回和精度
的折中。

**匹配 `matchesToken()`**：只由标识符字符组成的 token（`WORD_TOKEN`）按**词边界**
匹配，其余（中文、混合串）按**子串**匹配。这条区分是必须的 —— `no` 作为子串会命中
`node`，于是「档案里没有」被判成「有」，提醒就把别的坑的解法当作这次的答案端给模型。

**打分 `scoreEntry()`**：字段权重 `FIELD_WEIGHTS`：

| 字段 | 权重 | 理由 |
| --- | --- | --- |
| `tags` | 6 | 人工索引词，最可信 |
| `title` | 5 | 一句话概括 |
| `area` | 3 | 文件/模块名，定位性强 |
| `symptom` / `cause` / `solution` | 2 | 正文细节 |
| `evidence` | 1 | 报错原文，碎片多，只做兜底 |

每条 token 取它在各字段里的**最高**权重，求和后按覆盖率放大：

```
score = Σ(每 token 的最高权重) × (1 + 命中 token 数 / token 总数)
```

覆盖率那项是给长查询用的：只命中一个词的长查询不该排在前面。

**过滤规则**（都写在 `search()` 里）：

- `score <= 0` 的记录直接丢掉 —— 不能因为「分数低」就把无关记录当成弱相关端出去。
- 空查询 = 按时间列最近的记录。
- 查询非空但切不出任何有信息量的 token（整句都是虚词）：返回**空**，不退化成
  「列出全部」。列出全部会被读成「这些都是相关的」，比说没有更糟。
- `tag` 是精确过滤，在打分之前先筛：按标签找的时候不该混进正文碰巧含这个词的。

## 两层档案（`src/library.ts`）

一个工作区一本，外加一本全局备份。`PitfallLibrary` 是新旧两层的唯一入口。

**解析项目档案 `projectOf(cwd)`**，三种情况退化成 `undefined`（只用全局那本）：

- 关了 `projectStore`，或 `projectDir` 配成空串；
- 拿不到 `cwd`（没有工作区上下文）；
- 解析出来的目录**跟全局目录是同一个**（写两遍纯属自己跟自己打架）。

解析结果按绝对路径缓存，`projectDir` 是相对路径时按 `cwd` 拼。

**写 `record()`**：项目档案里 `record()` 生成条目（编号也在这儿生），然后
`global.save(entry)` 把**同一份快照**覆盖写进全局。两份同编号，这样后来
`pitfall_update` 补记能同时对上，检索去重也只认编号。

**读 `search()`**：项目档案的命中**全部排在前**，不足 `limit` 时才去全局补，
按 id 去重。「优先」是分层而不是按分数混合排序 —— 行为可预测：你在这个项目里记过
的东西永远先出现。代价写在 README 里：`limit` 很小时项目里的弱命中会占满名额。

**补记 `update()`**：在哪本里找到就在哪本改；项目那本改完，用最终条目**覆盖**
全局备份 —— 走增量语义会让 `note` 追加两次。只在全局找到的（早期记录、别的项目的）
就地更新，不搬进项目档案：搬了日后就分不清它是哪个项目踩出来的。

## 存储格式

一本档案 = 三个位置：

```
entries.jsonl      事实源：追加式，一行一条完整快照（带 v: 1 版本字段）
cards/<id>.md      单条卡片，整篇重写
INDEX.md           索引页，整篇重写
```

**读**（`read()`）：按行 JSON.parse，坏行（写入被打断的残行）静默跳过；同 id 折叠，
**取最后一条** —— 所以「改一条」= 追加一份新快照。结果按 jsonl 的 mtime 做缓存，
外部手改文件也能被看到。

**写**（`persist()`）：建 `cards/` → 追加 jsonl → 写卡片刻盘 → 清缓存 → 重建索引。
卡片和索引用「先写 `.tmp` 再改名」落盘（`writeAtomically()`）：改名在同一个卷上是
原子的，进程被杀不会留下半篇内容。任何一步失败都会抛出 —— 记档失败必须让调用方
知道，不能静默吞掉。

**为什么用完整快照而不是增量补丁**：写入被打断时最多坏掉最后一行，跳过它其余记录
照常可读；补丁流一旦错过一条，后面的解释全错。

**字段上限**（`cleanText` / `cleanTags` 里）：标题与 `area` 200 字，正文四栏 8000 字，
单个标签 24 字、最多 16 个，`notes` 最多 50 条（超了从最早的开始丢）。标签会去空白
和去重，防止同一条记录里 tag 写两遍把权重虚高。

**编号**：`p-20261004-164512-a3f9` = `p-` + 日期 + 时分秒 + 4 位随机十六进制。
按时间可排序，后缀防同秒撞号。

**状态**：只有 `solved` / `workaround` / `open`，展示时统一走 `statusLabel()`
（`已解决` / `已绕过` / `未解决`）。认不出的值归一化成 `solved` —— 绝大多数记录是
解决了才写的。

## 用到的 dsh 接口

| 接口 | 用途 |
| --- | --- |
| `export const name` / `inject = ['tools']` | 插件身份与依赖声明 |
| `Config`（schemastery）+ `apply(ctx, rawConfig)` | 配置校验；字段填错在加载时报错 |
| `ctx.tools.register(defineTool({...}))` | 四个工具；`output.schema` 是 `object` + 自定义 render |
| `ctx.get('systemPrompt')?.section({...})` | 提示词段落，`order: 750`（在思考节拍 700 与飞书播报 9000 之间）；包在 `ctx.effect()` 里 |
| `ctx.on('session/event', (session, event) => ...)` | `tool/call` 与 `tool/result` |
| `ctx.on('session/disposed', ...)` | 清检测器状态 |
| `ctx.get('agents')?.get(sessionId)?.inject(userMessage)` | 投递提醒 |
| `ctx.logger` | 加载期的 info/warn |

事件形状（实现里按需取字段，全是防御式读取）：

```
tool/call    { callId, name, arguments }            arguments 是 JSON 字符串
tool/result  { message: { toolCallId, isError, content }, error: { name, code, reason } }
```

**线索怎么拼**：`tool/call` 时从参数里按 `CLUE_KEYS`（`command` / `path` /
`file_path` / `pattern` / `query` / `url` / `name` / `cwd`）取最多 3 个键压成一行存进
`pending`；`tool/result` 失败时再拼上 `error.code/name/reason` 和报错正文，总长截到
`CLUE_MAX = 300`。`pending` 上限 500，超了只丢最早的那 100 条 —— 漏掉名字的失败结果
仍会被记成「未知工具」，不至于丢事件。

**为什么提醒走 `agent.inject()` 而不是 `followup()`**：inject 不唤醒驱动、不新开一轮，
只在下一个 pre-step 被取走 —— 正好是「这一步刚失败，下一步该换个思路」的位置。

**只处理顶层会话**（`isTopLevel()`）：`header.origin !== 'subagent'` 且
`delegationDepth === 0`。subagent 的会话用完即弃，提醒注进去等于扔进垃圾桶。

## 已知限制

- **只盯顶层会话**。subagent 踩的坑由主 agent 在结果里带出来。
- **拿不到 cwd 就只写全局**，不猜目录。
- **检索是词法匹配，不是语义匹配**。「同类问题换了说法」捞不到 —— 这是刻意留的边界，
  语义检索要额外调模型，违背「不额外花 token」的前提。
- **单字中文查不到**：切词要求中文 token 长度 ≥ 2。
- **提醒有配额**：单会话 4 条、10 分钟冷却。长时间连续失败的后半段是安静的。
- **两份档案可能都被手工改乱**：插件不校验一致性，以项目档案为准。
- **没有加密、没有网络、不跨机同步**。档案是纯文本，随你放哪。
- **`systemPrompt` 服务缺失时**只降级成「没有预防层」，工具与自动检测照常工作。
