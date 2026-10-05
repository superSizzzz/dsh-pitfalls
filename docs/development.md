# 开发与测试

改这份代码需要知道的事：文件都在哪、依赖从哪来、为什么改完必须重启、怎么验证。
README 里面向使用者的部分不重复，这里只讲维护视角。

## 仓库结构

| 路径 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口：`apply()`、事件监听、检测器接线、提醒投递、提示词注入、排查日志 |
| `src/config.ts` | schemastery 配置 schema 与 `resolveConfig()`（默认值、非法值兜底） |
| `src/tools.ts` | 四个 `pitfall_*` 工具的注册与输出契约 |
| `src/store.ts` | **单本**档案：jsonl 折叠读写、检索打分、卡片与索引渲染、原子写 |
| `src/library.ts` | **两层**档案：项目/全局的解析、双写、优先检索、去重、备份同步 |
| `src/detector.ts` | 连续失败状态机（纯逻辑，不碰 dsh / fs） |
| `src/policy.ts` | 系统提示段落与提醒文案 |
| `cordis.patch.yml` | 本插件自带的挂载声明（`package.json` 的 `dsh.bundle.patch` 指向它） |
| `scripts/link-deps.mjs` | 把依赖解析接到 dsh 的依赖目录，可选打印 patch 片段 |
| `scripts/rehearsal.mjs` | 只读排查脚本：在真实目录上试一次检索，不写任何东西 |
| `test/*.mjs` | 四套直跑测试（不依赖 harness） |
| `docs/` | 本目录：工作原理 / 开发与测试 / 排查 |

分层是刻意的：`detector` 与 `store` 都不依赖 dsh，所以能被 `node` 直接测试；
dsh 相关的部分集中在 `index.ts` 与 `tools.ts`。

## 依赖从哪来

插件**不自己装** `@deepseek-ai/*`，那些包由 dsh 提供（`package.json` 里是
`peerDependencies`）。但 Node 解析 `import '@deepseek-ai/dsh-tools'` 时需要一个能落地的
`node_modules`，而 dsh 的 profile 目录下正好有一份完整的：

```powershell
node scripts/link-deps.mjs            # 建 <repo>/node_modules → ~/.dsh/profiles/node_modules
node scripts/link-deps.mjs --patch     # 顺便打印可直接粘贴的 patch 片段
```

Windows 上建的是 **junction**（不需要管理员权限，也不占额外磁盘），其他平台建目录
符号链接。脚本用 `@deepseek-ai/dsh-tools` 当探针确认链接真的能解析。`node_modules/`
已 gitignore。

## 源码加载 vs 编译产物

dsh **直接加载 `src/*.ts`**（`package.json` 的 `main` 与 `exports` 都指向源码），
走的是 Node 的类型擦除（strip-only）—— 它只删类型标注，**不做语法转换**。两条约束：

- 不能用需要「转换」才能跑的语法。典型是 TypeScript 参数属性
  （`constructor(private readonly x: T)`）：类型是参数修饰符不是类型标注，擦除后
  那句就废了。本仓库的类都显式声明字段。
- 相对导入要写 `.ts` 扩展名（类型擦除的要求）。`tsconfig.json` 里的
  `rewriteRelativeImportExtensions: true` 让 `tsc` 输出时把 `.ts` 改写成 `.js`，
  同一份源码同时服务两种加载方式。

`lib/` 只在发布 npm 包时由 `tsc` 产出，已 gitignore。日常改代码只动 `src/`。

类型检查：

```powershell
npm run typecheck        # tsc -p tsconfig.json --noEmit
```

## 热重载的真相

这一节全部来自实际踩过的坑。

**改完源码要重启 dsh。** profile 默认 `patchReload: live`，但它重载的是 **patch
条目**；插件源码从 `file://` URL 加载，URL 没变就走 Node 的 ESM 模块缓存，拿到的还是
第一次加载的那份。「触发了重载」和「加载了新代码」是两件独立的事——这是最容易误判的
地方，表现为「重载成功了，改动却没生效」。

判据：看 `logPath` 里 `applied` 那行的**字段集**跟当前源码对不对得上。新代码加了字段，
日志里却没出现，就是旧模块还在。

**只改注释可能不触发重载。** loader 比较的是解析结果；注释变了但 YAML 结果没变时它
不动。想触发重载，改一个配置值。

**别用 PowerShell 的 `Get-Content` / `Set-Content` 批量改 UTF-8 文件。** PS 5.1 默认按
ANSI 读，中文读进来就已经是乱码了，`-Encoding UTF8` 只保证写入侧，救不回来。用编辑器
或读写文件的工具。

## 测试

四个套件都不依赖 harness、不起会话，可以直接 `node` 跑：

| 套件 | 覆盖 |
| --- | --- |
| `test/store.test.mjs` | 存储、同 id 折叠、残行容错、字段清洗上限、检索精度 |
| `test/detector.test.mjs` | 什么时候该出声：连续 / 换工具重算 / 成功清零 / 冷却 / 配额 |
| `test/library.test.mjs` | 两层档案：双写、优先、去重、备份同步、各种退化路径 |
| `test/plugin.smoke.mjs` | 假 ctx 跑通整条链路：事件 → 检测 → 检索历史 → 注入提醒 |

```powershell
npm test                       # test:core（前三） + test:smoke
node test/store.test.mjs       # 也可以单独跑一个
```

写新测试时的约定：

- 自己数断言、失败时打印清单并 `exit 1`（不引测试框架，保持零依赖）。
- 用 `mkdtempSync` 建临时目录，`finally` 里 `rmSync` 清掉。
- **绝不往仓库里的真实档案写东西**：项目档案用绝对路径指到临时目录，或者把
  `projectStore` 关掉。

## 改这些地方之前先想清楚

**`detector.ts` 的判定规则**是这个插件的智力所在，也最容易被改坏：加条件时想清楚
「串行失败」「换工具」「成功后清零」三种交叉情况，并补测试。它是纯状态机，直接在
`test/detector.test.mjs` 里构造 `FailureSignal` 序列就行。

**`store.ts` 的切词与打分**改动必须跑 `store` + `library` 两个套件。这类问题的表现是
「悄悄给错答案」而不是报错 —— 一条无关记录被判成「命中历史」，别的坑的解法就被当作
这次的答案端给模型了。

**存储格式要保持向后兼容**：`read()` 对认不出的字段是忽略、对坏行是跳过，所以旧记录
永远读得回来。真要改格式，加版本字段（现在每行是 `{ v: 1, ...entry }`）而不是直接改
语义。

**`library.ts` 的优先级语义**是有意选择的（项目命中全部在前，不足 limit 才补全局）。
想改成按分数混合排序时，先想清楚代价：自动提醒只取 3 条，混合之后「这个项目有人踩过」
的信号会被稀释。

## 在真实目录上验证

想知道档案到底落在哪、旧记录还能不能捞到，用这个只读脚本（不写任何东西）：

```powershell
node scripts/rehearsal.mjs D:\repos\my-app            # 用默认查询词
node scripts/rehearsal.mjs D:\repos\my-app EPERM      # 顺便换个查询词
```

它会打印项目档案与全局档案的路径、各自的条目数，以及一次检索的命中与来源。

## 收尾：格式检查

提交前把格式收干净：统一 LF（见 `.gitattributes`）、行宽 120 以内、行尾无空白、文件末尾
留一个换行。

本仓库开发时所在的工作区里有一个 `code-format-guard` 技能，用它扫本次改动最省事：

```powershell
node <工作区>/.dsh/skills/code-format-guard/scripts/check_format.mjs --changed
```

要求 0 error；行宽这类 warning 也一并收掉，本仓库一直保持 0 warning。手边没有这个工具，
就按上面那几条自查。
