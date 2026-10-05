# dsh-pitfalls

English | [中文](README.md)

You hit the same wall twice. The root cause you spent two hours digging out last time
is gone the moment the session ends, so you start over from scratch.

This plugin writes those walls down — what you saw, how you walked into it, how you
got out — and hands them back the next time something similar comes up. You don't have
to remember to record anything: when one tool fails enough times in a row, it speaks up
on its own.

## Contents

- [Install](#install)
- [What it does](#what-it-does)
- [In use](#in-use)
- [Where the archives live](#where-the-archives-live)
- [What an archive looks like](#what-an-archive-looks-like)
- [The four tools](#the-four-tools)
- [Configuration](#configuration)
- [Logs](#logs)
- [Permissions](#permissions)
- [Uninstall](#uninstall)
- [FAQ](#faq)
- [More docs](#more-docs)
- [License](#license)

## Install

```powershell
dsh plugin --profile web add github:superSizzzz/dsh-pitfalls
```

One command. dsh reads `dsh.bundle.patch` from the package and merges it into the
current profile, so there is no config to hand-write.

To remove it:

```powershell
dsh plugin --profile web remove dsh-pitfalls
```

| | Requirement |
|---|---|
| dsh | ≥ 0.1.7-rc.2 |
| Node | ≥ 22.6 |
| profile | any — web / tui / headless |
| model | any. It never calls a model; it only counts failures on the event stream |

Install once per profile; change the name after `--profile` for another one.

Nothing else to set up afterwards — it starts working on its own. To confirm it loaded,
turn on a log (see [Logs](#logs)).

### Local checkout (when you are editing the code)

```powershell
# 1. Point dependency resolution at dsh's own dependency directory (creates a junction)
node scripts/link-deps.mjs --patch

# 2. Paste the snippet it prints into the current profile's patch layer
#    Find your profile first: Get-ChildItem env: | Where-Object Name -like 'DSH*'
#    → ~/.dsh/profiles/<profile>/cordis.patch.yml
```

The snippet looks like this:

```yaml
- insert:
    - id: pitfalls
      name: 'file:///D:/repos/dsh-pitfalls/src/index.ts'    # your checkout path
      config:
        enabled: true
```

A profile defaults to `patchReload: live`: **editing the patch file** hot-reloads on save.
Editing the **source** does not — it is loaded from `file://`, and since the URL never
changes, Node's module cache wins. New code needs a dsh restart. To tell whether the new
code actually loaded, check that the fields on the `applied` log line match the current
source. That mistake is written up in [docs/development.md](docs/development.md).

## What it does

| | What | Who triggers it |
|---|---|---|
| **Record** | `pitfall_record` writes a pitfall into the archive | the model, after solving it |
| **Look up** | `pitfall_search` / `pitfall_show` return past entries plus the fix used | the model, before trying |
| **Watch** | one tool failing repeatedly injects a reminder (with matches and origin) | the plugin, off events |

The watching part is what makes the rest usable: models deep in a task routinely forget
to look things up and forget to record them. But it only speaks up on **consecutive
failures** — an objective signal — and **does not decide what counts as a pitfall**.
That judgement stays with the model, which is why the archive doesn't fill up with noise
like "I typed the command wrong".

## In use

It stays quiet and only speaks up on real consecutive failures. The default threshold is
2 failures of the same tool in a row; a single success resets the count. Here is a real
reminder it produced (paths and clues generalized):

```text
【踩坑档案】`npm run build` 连续 2 次没成功。
线索：TS2339 Property 'createReport' does not exist | src/report/export.ts

当前项目的档案里有像的，先看能不能直接用：
- `p-20261004-164512-a3f9` ｜已解决 ｜本项目 ｜tsconfig 的 types 没带上
  当时怎么解决的：把 @types/node 补进 compilerOptions.types，别用 triple-slash

如果这次的坑跟上面不一样（或者上面那条的解法这次不管用），解决或绕过去之后用
`pitfall_record` 记一笔新坑，必要时用 `pitfall_update` 补记旧条目。
别把这条提醒当成要汇报的事 —— 对用户说什么还说什么。
```

The reminder text is Chinese: that is what the plugin actually emits, since its
audience is the model working in a Chinese-language session. In order: the tool that
kept failing along with the clue, then the matching entries from the current project's
archive with the fix used back then, then the ask to record a new entry if this turns
out to be something different, and finally a note that this reminder is not something
to report to the user.

When neither archive has anything close, it says so plainly — "this may be a new
problem" — and asks the model to record it once solved, rather than forcing an
irrelevant entry into the reply. That matters: **a wrong answer is worse than "I don't
know"**, so the search would rather come back empty.

Reminders are rate-limited: no repeats within 10 minutes in a session, at most 4 per
session, then it goes quiet until the next turn.

## Where the archives live

| | Location | Role |
|---|---|---|
| **Project archive** | `<workspace>/.dsh/pitfalls/` | Travels with the project: new machine, colleague, months later |
| **Global archive** | `~/.dsh/pitfalls/` | Fallback + backup: temp dirs, a lost project archive, other projects |

Writes go to **both at once**, under the same id — you never have to pick a location, and
the two can't drift into telling different stories. Reads go **project archive first,
then top up from global**, and every result is labelled with where it came from.

"First" is layered, not a blended score sort: hits from the project archive always come
first. The cost is that with a small limit (the automatic reminder only takes 3) weak
project hits can fill the slots. That is deliberate — first means first; better to read
two extra entries from this project than to let anyone conclude "nobody here has hit
this".

Old entries already sitting in the global archive **do not need migrating**: search falls
back to them automatically (labelled "global"), and an entry found only in global keeps
its updates in global, so it stays clear which project it came from.

## What an archive looks like

```
<workspace>/.dsh/pitfalls/           or   ~/.dsh/pitfalls/
├── entries.jsonl      source of truth: append-only, one full snapshot per line, same id overwrites
├── cards/<id>.md      one readable card per entry — open it in an editor and it reads like a note
└── INDEX.md           reverse-chronological index; check this first
```

An entry has these fields (they map to the `pitfall_record` arguments):

- **symptom** `symptom` — what you saw: the error text, the odd behaviour, the gap from expectations
- **how you walked into it** `cause` — root cause and the conditions that trigger it; this is
  what lets you avoid it next time
- **how you got out** `solution` — what you actually did; a workaround still needs its method written down
- **evidence** `evidence` — error snippets, commands, file paths and line numbers
- **area / tags** `area` / `tags` — highest weight in search, worth the extra ten seconds

Ids look like `p-20261004-164512-a3f9` and are what `pitfall_update` takes. Status is one
of `已解决` (solved) / `已绕过` (worked around) / `未解决` (open).

## The four tools

| Tool | When to use it |
|---|---|
| `pitfall_search` | On an error or odd behaviour — **before trying anything**. Clues: keywords + file names |
| `pitfall_record` | Something took real effort (two or more attempts, source reading, a new approach) |
| `pitfall_show` | One search result looks truly relevant and you want the details |
| `pitfall_update` | A better fix turned up later — **append** a note, don't erase the original |

The criteria for "what counts as a pitfall" live in the tool descriptions, where the
model reads them; the plugin does not decide on its own.

## Configuration

Configuration lives in the same patch entry that mounts the plugin (the `config` block of
`id: pitfalls`). There is no config file and no settings UI.

To change a default, write an entry with the same id in your own patch layer and list only
the fields you want:

```yaml
- id: pitfalls
  config:
    failureStreak: 3
    projectStore: false
```

Saved is applied (`patchReload: live`). A misspelled field fails the reload loudly rather
than silently falling back to the default.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch. When false it registers no tools, no listeners, no prompt section |
| `autoDetect` | `true` | Watch tool failures automatically. Off leaves only the model's own recording |
| `failureStreak` | `2` | Consecutive failures of one tool that count as hitting a wall. `1` is very chatty |
| `matchHistory` | `true` | Include the fix used back then in the reminder |
| `reminderCooldownMs` | `600000` | Minimum gap between reminders in one session, to stop streams of them |
| `maxRemindersPerSession` | `4` | Per-session cap; at the cap it waits for the next turn |
| `systemPromptSection` | `true` | Write the "record pitfalls, look them up first" rule into the system prompt |
| `dir` | `$DSH_HOME/pitfalls` | Global archive directory (also the backup) |
| `projectStore` | `true` | Also write records into the current workspace's project archive |
| `projectDir` | `.dsh/pitfalls` | Relative to the workspace; an absolute path is shared by all workspaces |
| `backupToGlobal` | `true` | Keep a copy in the global archive when writing the project archive |
| `indexLimit` | `200` | Maximum entries listed in each archive's `INDEX.md` |
| `logPath` | `''` | Event log path; empty means no logging |

Setting `projectStore: false` falls back to a single global archive.

## Logs

There is no UI. To see whether it is working, give it a log:

```yaml
- id: pitfalls
  config:
    logPath: 'D:/logs/pitfalls.jsonl'
```

The file immediately gains a load record showing the archive locations and switches that
actually took effect — the thing to check when a config or a project path is not what you
expected:

```json
{"at":"2026-10-05T01:12:03.114Z","event":"applied","globalDir":"C:\\Users\\me\\.dsh\\pitfalls","projectDir":".dsh/pitfalls","backupToGlobal":true,"node":"v24.18.1","autoDetect":true,"failureStreak":2,"headless":false}
```

After that, every record, search, and reminder appends a line:

```json
{"at":"...","event":"record","id":"p-20261005-091530-4b1e","title":"...","sessionId":"...","scopes":["project","global"]}
{"at":"...","event":"search","sessionId":"...","query":"EPERM 命名管道","cwd":"D:/proj/app","hits":2,"fromProject":1}
{"at":"...","event":"reminder","sessionId":"...","toolName":"pwsh","count":2,"matches":1,"fromProject":1}
```

No lines at all means it never loaded — go back and check the install command for errors.

## Permissions

| | |
|---|---|
| Network | makes no requests |
| Commands | runs no commands |
| Tools | adds 4 `pitfall_*` tools; leaves your existing tool list alone |
| System prompt | adds one "record and look up pitfalls" section; off via `systemPromptSection: false` |
| Your messages | never rewritten or deleted |
| Sessions | injects one reminder on consecutive failures; cancels no turns, blocks no steps |
| Disk | plain text in the archive dirs (`entries.jsonl` / `cards/` / `INDEX.md`), plus optional `logPath` |
| Model | calls no model; local search and counting only |

## Uninstall

```powershell
dsh plugin --profile web remove dsh-pitfalls
```

If you installed from a source checkout, delete the `- insert:` block from your patch file.

Recorded archives are not deleted — they are plain text in your workspace and in
`~/.dsh/pitfalls/`. Keep them or remove them yourself. The plugin writes no other
persistent state.

## FAQ

**Installed it and nothing happens?** That is normal. It stays quiet until something fails
consecutively. To watch it work, turn on a log (see [Logs](#logs)).

**Does it slow the session down?** No. It calls no model; it counts failures on tool
results and searches local jsonl.

**Will it clutter my project directory?** It creates one `.dsh/pitfalls/` directory in the
workspace (three text files plus cards). If you want it committed and visible to
colleagues, leave it; if not, add `.dsh/pitfalls/` to `.gitignore`, or set
`projectStore: false` to write only the global archive.

**What if the two archives disagree?** They shouldn't: when the project archive changes,
the backup is overwritten with the same final content rather than having the patch replayed
over it. If a manual edit does scramble them, trust the project archive and delete the
global copy so it can be re-recorded.

**Why whole-word matching for English but substring for Chinese?** As a substring, `no`
matches `node` — and error text is full of fragments like that, so an unrelated entry gets
counted as "matching history" and its old fix gets handed to the model as the answer to
this problem. Better to say "nothing in the archive" than to answer wrongly.

**Do subagent pitfalls get recorded?** Reminders only go to the top-level session (a
subagent's session is discarded when it finishes, so injecting into it is throwing the
message away). What the subagent hit comes back through the main agent's result.

**What if there is no workspace path?** Only the global archive is written. It will not
guess a directory and drop files there.

## More docs

The developer-facing details live in `docs/` (written in Chinese):

- [工作原理](docs/how-it-works.md) — how it works: detection rules, how search tokenizes and
  scores, how the two archives cooperate, the dsh APIs used, known limits
- [开发与测试](docs/development.md) — development and testing: repo layout, dependency
  linking, why a source change needs a restart, the four test suites, format checks
- [排查](docs/troubleshooting.md) — troubleshooting: log fields, symptom → cause (never
  loaded / too quiet / too noisy / wrong archive location / search keeps missing)

Before touching the code, read the "热重载的真相" section of the development doc: a source
change needs a dsh restart, and without one your edit looks like it did nothing.

## License

MIT, see [LICENSE](./LICENSE).
