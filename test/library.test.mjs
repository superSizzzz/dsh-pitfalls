/**
 * 档案库的直跑测试 —— 不依赖 harness，不起会话。
 *
 * 这里钉住的是「两本档案怎么配合」：写的时候是不是真的两份、读的时候是不是
 * 项目优先、全局捞出来的会不会重复出现、补记有没有同步到备份。这些行为错了
 * 不会报错，只会让人慢慢不再信任档案 —— 那比崩溃更难发现。
 *
 *   node test/library.test.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PitfallLibrary } from '../src/library.ts'

let passed = 0
const failures = []

function check(label, condition) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(label)
}

function equal(label, actual, expected) {
  check(`${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`, actual === expected)
}

const parent = mkdtempSync(join(tmpdir(), 'pitfalls-library-'))
const cwd = 'D:/fake/workspace'

/** 每次用例换一组干净目录，避免互相干扰。 */
function freshLibrary(overrides = {}) {
  const dir = mkdtempSync(join(parent, 'case-'))
  return new PitfallLibrary({
    globalDir: join(dir, 'global'),
    projectDir: join(dir, 'project'),
    projectStore: true,
    backupToGlobal: true,
    indexLimit: 50,
    ...overrides,
  })
}

/** 只写全局那本（用来模拟「别的项目/以前记的坑」）。 */
function globalOnlyLibrary(globalDir) {
  return new PitfallLibrary({
    globalDir,
    projectDir: '',
    projectStore: false,
    backupToGlobal: false,
    indexLimit: 50,
  })
}

/** 数 jsonl 里含某个 id 的行数。 */
function countIn(jsonl, id) {
  if (!existsSync(jsonl)) return 0
  return readFileSync(jsonl, 'utf8').split('\n').filter((line) => line.includes(id)).length
}

try {
  // -------------------------------------------------------------------------
  // 1. 记一条：项目档案 + 全局备份，同一编号
  {
    const library = freshLibrary()
    const outcome = library.record({
      title: '存档时同 id 快照覆盖',
      symptom: '改了两遍，读出来还是第一版',
      cause: '折叠取的是最后一条，写入没走到最后一行',
      solution: '每次改动都追加完整快照，读取按 id 取最后一条',
      tags: ['storage'],
    }, cwd)

    const projectDir = library.projectDirOf(cwd)
    equal('两份都写了', outcome.scopes.join(','), 'project,global')
    check('项目档案在临时目录内', projectDir.startsWith(parent))
    check('项目档案的 jsonl 里有这条', countIn(join(projectDir, 'entries.jsonl'), outcome.entry.id) === 1)
    check('全局备份的 jsonl 里也有这条', countIn(join(library.globalDir(), 'entries.jsonl'), outcome.entry.id) === 1)
    check('卡片落在项目档案里', existsSync(join(projectDir, 'cards', `${outcome.entry.id}.md`)))
    check('索引也落在项目档案里', existsSync(join(projectDir, 'INDEX.md')))
    equal('拿到的编号能取回这条', library.get(outcome.entry.id, cwd)?.entry.id, outcome.entry.id)
    equal('取回时标明来自项目', library.get(outcome.entry.id, cwd)?.scope, 'project')
  }

  // -------------------------------------------------------------------------
  // 2. 检索：项目优先，全局兜底，同一条不重复出现
  {
    const library = freshLibrary()
    const old = globalOnlyLibrary(library.globalDir()).record({
      title: '旧记录：沙箱里 spawn 抓不到子进程输出',
      symptom: 'EPERM operation not permitted',
      cause: '沙箱禁止命名管道',
      solution: 'stdio 改成 inherit',
      tags: ['sandbox'],
    }, '').entry

    const mine = library.record({
      title: '本项目：沙箱里读文件被拒',
      symptom: 'read 工具报 EPERM',
      cause: '工作区 ACL 丢了继承',
      solution: '重设 ACL',
      tags: ['sandbox'],
    }, cwd).entry

    // 「命名管道」只出现在全局那条的根因里，项目档案里没有 → 应该走全局兜底
    const byGlobalOnly = library.search('命名管道', { cwd })
    equal('项目档案里没有时，全局兜底捞出别的项目的坑', byGlobalOnly[0]?.entry.id, old.id)
    equal('并标明来自全局', byGlobalOnly[0]?.scope, 'global')

    const both = library.search('沙箱 EPERM', { cwd })
    check('两条都命中', both.length >= 2)
    equal('项目档案的排在前面', both[0]?.scope, 'project')
    equal('项目那条第一个出现', both[0]?.entry.id, mine.id)
    equal('同一条不重复出现', both.filter((hit) => hit.entry.id === mine.id).length, 1)
    equal('全局那条也没重复', both.filter((hit) => hit.entry.id === old.id).length, 1)

    const limited = library.search('沙箱', { cwd, limit: 1 })
    equal('limit=1 时只给一条', limited.length, 1)
    equal('limit=1 时取的是项目那条', limited[0]?.scope, 'project')
  }

  // -------------------------------------------------------------------------
  // 3. 补记：改项目那本，全局备份跟着覆盖（note 不会写两遍）
  {
    const library = freshLibrary()
    const entry = library.record({ title: '备份同步', symptom: 'a', cause: 'b', solution: 'c' }, cwd).entry
    const outcome = library.update(entry.id, { note: '后来发现根因是缓存', status: 'workaround' }, cwd)

    equal('update 报了两本', outcome?.scopes.join(','), 'project,global')
    const inGlobal = globalOnlyLibrary(library.globalDir()).get(entry.id, '')
    equal('备份里的状态也变了', inGlobal?.entry.status, 'workaround')
    equal('备份里那条补记只有一份', inGlobal?.entry.notes.length, 1)
    check('补记内容一致', inGlobal?.entry.notes[0]?.text.includes('缓存'))
    equal('未知编号返回 undefined', library.update('p-nope', { note: 'x' }, cwd), undefined)
  }

  // -------------------------------------------------------------------------
  // 4. 只在全局找到（早期记录）时就地更新，不搬进项目档案
  {
    const library = freshLibrary()
    const old = globalOnlyLibrary(library.globalDir())
      .record({ title: '早期全局记录', symptom: 's', cause: 'c', solution: 'sol' }, '').entry

    const outcome = library.update(old.id, { note: '几年后补一句' }, cwd)
    equal('更新落在全局', outcome?.scopes.join(','), 'global')
    check(
      '没被搬进项目档案',
      !existsSync(join(library.projectDirOf(cwd), 'cards', `${old.id}.md`)),
    )
    equal('全局里能读到补记', library.get(old.id, cwd)?.entry.notes.length, 1)
    equal('来源标为全局', library.get(old.id, cwd)?.scope, 'global')
  }

  // -------------------------------------------------------------------------
  // 5. 退化路径：没有 cwd / 关掉项目档案 / 关掉备份
  {
    const noCwd = freshLibrary()
    const outcome = noCwd.record({ title: '没有 cwd 时记的', symptom: 's', cause: 'c', solution: 'sol' }, '')
    equal('没有 cwd 时只写全局', outcome.scopes.join(','), 'global')
    equal('没有 cwd 时项目目录为空', noCwd.projectDirOf(''), '')
    equal('没有 cwd 时也能检索到', noCwd.search('没有 cwd 时记的', { cwd: '' }).length, 1)

    const off = freshLibrary({ projectStore: false })
    const offOutcome = off.record({ title: 'x', symptom: 's', cause: 'c', solution: 'sol' }, cwd)
    equal('关掉项目档案后只写全局', offOutcome.scopes.join(','), 'global')

    const noBackup = freshLibrary({ backupToGlobal: false })
    const onlyProject = noBackup.record({ title: '只在项目', symptom: 's', cause: 'c', solution: 'sol' }, cwd)
    equal('关掉备份后只写项目', onlyProject.scopes.join(','), 'project')
    check('全局里确实没有', countIn(join(noBackup.globalDir(), 'entries.jsonl'), onlyProject.entry.id) === 0)
  }

  // -------------------------------------------------------------------------
  // 6. 两个目录配成同一个时不重复写；相对路径按工作区解析
  {
    const dir = mkdtempSync(join(parent, 'same-'))
    const shared = join(dir, 'shared')
    const same = new PitfallLibrary({
      globalDir: shared,
      projectDir: shared,
      projectStore: true,
      backupToGlobal: true,
      indexLimit: 50,
    })
    const sameOutcome = same.record({ title: 'y', symptom: 's', cause: 'c', solution: 'sol' }, cwd)
    equal('项目目录 = 全局目录时只写一次', sameOutcome.scopes.join(','), 'global')
    check(
      '那条快照只写了一遍',
      countIn(join(shared, 'entries.jsonl'), '"title":"y"') === 1,
    )

    const relative = freshLibrary({ projectDir: '.dsh/pitfalls' })
    check('相对路径拼在工作区里', relative.projectDirOf('D:/fake/ws').includes('.dsh'))
    check(
      '不同工作区对应不同项目档案',
      relative.projectDirOf('D:/fake/ws') !== relative.projectDirOf('D:/fake/other'),
    )
    equal('相对路径下也返回了项目目录', relative.projectDirOf('/tmp/elsewhere').length > 0, true)
  }
} finally {
  rmSync(parent, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`✗ library：${passed} 通过，${failures.length} 失败`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✓ library：${passed} 项断言全部通过`)
