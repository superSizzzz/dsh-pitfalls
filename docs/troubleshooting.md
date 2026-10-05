# 排查

按「先看日志 → 对症状找原因」的顺序走。这里的每条都来自实际遇到过的情形。

## 先开日志

插件没有界面，出问题第一步是让它说话：

```yaml
- id: pitfalls
  config:
    logPath: 'D:/logs/pitfalls.jsonl'
```

保存即生效。日志是 JSONL，一行一个事件。字段含义：

| `event` | 什么时候写 | 关键字段 |
| --- | --- | --- |
| `applied` | 插件加载成功 | `globalDir` / `projectDir` / `backupToGlobal` / `autoDetect` / `failureStreak` |
| `disabled` | `enabled: false` | — |
| `prompt-section-registered` | 提示词段落注入成功 | — |
| `record` | 记了一条新坑 | `id` / `title` / `scopes`（写进了哪几本） |
| `search` | 模型主动检索 | `query` / `cwd` / `hits` / `fromProject` |
| `update` | 补记了一条 | `id` / `status` / `scopes` |
| `reminder` | 自动提醒投出去了 | `toolName` / `count` / `matches` / `fromProject` |
| `reminder-failed` | 投递失败（agent 已退出等） | `detail` |
| `search-failed` | 检索抛异常 | `detail` |
| `observe-failed` | 事件处理抛异常 | `detail` |
| `prompt-section-failed` | 提示词注入失败（降级，其余功能正常） | `detail` |

日志写失败会被静默吞掉 —— 排查日志本身不该打断会话。所以「文件没建出来」也说明不了
什么，先确认 `logPath` 目录能写。

## 症状 → 原因 → 动作

**一行日志都没有。** 插件没加载。回去看安装命令的报错；源码方式装的，先确认挂在了
正确的 profile 上（`Get-ChildItem env: | Where-Object Name -like 'DSH*'` 看
`DSH_PROFILE`）——改错 profile 的 patch 层不会有任何提示，插件就是不生效。

**有 `applied`，但字段是旧的**（比如只有 `root`、没有 `globalDir`）。加载的是**旧模块**：
patch 重载不会重新读取 `file://` 的插件源码，要重启 dsh。细节见
[开发与测试](development.md) 的「热重载的真相」。

**该提醒却不提醒。** 逐个排除：

1. `autoDetect` 是不是被关了；
2. 失败次数够不够 —— 默认要**同一个工具连续** 2 次，换工具会重新起算，中间成功一次
   也会清零；
3. 是不是撞上了冷却（`reminderCooldownMs`，默认 10 分钟）或配额
   （`maxRemindersPerSession`，默认 4）；
4. 会话是不是**顶层会话** —— subagent 的会话不提醒。

**提醒太吵。** 把 `failureStreak` 调到 3，或拉长 `reminderCooldownMs`、压低
`maxRemindersPerSession`。只想让模型自己记、不要自动出声，就 `autoDetect: false`。

**档案没写进项目目录。** 按顺序查：

1. `projectStore` 是否为 `true`（默认是）；
2. 那一刻拿不拿得到工作区路径 —— 没有 `cwd` 时只写全局，不会瞎猜一个目录；
3. `projectDir` 会不会跟 `dir`（全局目录）解析成了同一个路径 —— 相同时只写一遍。

用 `node scripts/rehearsal.mjs <你的工作区>` 看解析结果最直观：它会把两本档案的路径
和条目数都打出来，且不写任何东西。

**检索总说「没有」。** 检索是词法匹配，几个常见原因：

- token 太短：英文与中文都要求长度 ≥ 2，单字查不到；
- 整句都是虚词（`no such file or directory` 这种）：切不出有信息量的 token 时**故意**
  返回空，不退化成「列出全部」；
- 英文按**词边界**匹配：`no` 不会命中 `node`（这是有意的，见
  [工作原理](how-it-works.md#检索srcstorets)）；
- 用了 `tag` 参数：它是**精确**匹配，对不上就是空。

换成「报错关键词 + 模块/命令/文件名」的线索再试。

**两份档案不一致。** 正常不会：改项目那本时，全局备份是被同一份最终内容**覆盖**的，
不是把补丁重跑一遍。真被手工改乱了，以项目档案为准，把全局那条删掉重记。

**提醒翻了倍、档案各写一份。** 同一个插件挂在了两个 profile 上（比如 desktop 和 web
同时有 `id: pitfalls` 的 insert）。dsh 按 profile 加载，两边都会跑。留一个，删掉另一个
patch 层里的条目。

**插件加载报错 / 配置不生效。** 配置字段名或类型写错时，schemastery 会在加载时直接
报错，不会悄悄退回默认值 —— 这是有意的。对照 README 的配置表逐字检查字段名；嵌套
缩进错了也算。

**提醒注进去了但模型没反应。** `agent.inject()` 只是把消息放进队列，在**下一个
pre-step** 才被取走。如果那个会话已经结束（或本来就没人继续），它就只是躺在那里。
这是有意的：不唤醒驱动、不新开一轮，插件不该替用户续跑。
