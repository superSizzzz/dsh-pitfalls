/**
 * 存储与检索的直跑测试 —— 不依赖 harness，不起会话。
 *
 * 这里钉住的是「档案能不能信」：写入是否落全、jsonl 折叠是否正确、残行是否
 * 被容忍、检索会不会把不相干的东西当成命中。最后一条尤其要紧 —— 命中错了，
 * 提醒就会把别的坑的解法当成这次的答案推给模型。
 *
 *   node test/store.test.mjs
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PitfallStore, normalizeStatus, scoreEntry, summarize, tokenize } from '../src/store.ts'

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

const root = mkdtempSync(join(tmpdir(), 'pitfalls-test-'))
const store = new PitfallStore(root, { indexLimit: 3 })

try {
  // -------------------------------------------------------------------------
  // 1. 记一条：三处都要落（jsonl 事实源、卡片、索引）
  const first = store.record({
    title: 'PowerShell 读 UTF-8 文件中文乱码',
    symptom: 'Get-Content 读出来是 鎬濊€冭妭鎷 这样的乱码',
    cause: 'Windows PowerShell 默认按 GBK 解码 UTF-8 文件；同一份代码在 pwsh 7 下正常，所以一开始以为是编码写错了',
    solution: '别用 Get-Content 读源码，改用 read 工具；必须用 shell 时加 -Encoding utf8',
    area: 'pwsh',
    tags: ['#encoding', 'windows', 'encoding'],
    evidence: 'Get-Content src/config.ts → 鎬濊€冭妭鎷',
    cwd: 'D:/tmp/ws',
  })
  check('record 返回带 p- 前缀的编号', first.id.startsWith('p-'))
  equal('状态默认是 solved', first.status, 'solved')
  equal('标签去重且去掉 # 前缀', first.tags.join(','), 'encoding,windows')
  check('entries.jsonl 落了盘', existsSync(join(root, 'entries.jsonl')))
  check('卡片落了盘', existsSync(join(root, 'cards', `${first.id}.md`)))
  check('索引落了盘', existsSync(join(root, 'INDEX.md')))
  check('卡片里写了现象', readFileSync(join(root, 'cards', `${first.id}.md`), 'utf8').includes('## 现象'))

  // -------------------------------------------------------------------------
  // 2. 第二条：换主题，用来验证检索不会串味
  const second = store.record({
    title: 'cordis 插件热重载失效',
    symptom: '改完 src/index.ts 保存，行为没变',
    cause: 'profile 的 patchReload 不是 live，或者插件是通过 package.json 依赖挂载的、需要重装',
    solution: '确认 profile 配置里的 patchReload: live，并用 file:// 形式 insert',
    area: 'cordis',
    tags: ['cordis', 'plugin'],
    status: 'workaround',
  })
  equal('第二条状态可指定', second.status, 'workaround')
  equal('list 按时间倒序，最新的在前', store.list()[0].id, second.id)

  // -------------------------------------------------------------------------
  // 3. 检索：命中的是对的那条
  const hitEncoding = store.search('中文乱码')
  equal('「中文乱码」命中一条', hitEncoding.length, 1)
  equal('命中的是编码那条', hitEncoding[0]?.entry.id, first.id)

  const hitCordis = store.search('cordis 热重载')
  check('「cordis 热重载」命中', hitCordis.length >= 1)
  equal('命中的是 cordis 那条', hitCordis[0]?.entry.id, second.id)

  equal('完全无关的词不命中', store.search('量子纠缠 飞船').length, 0)

  const byTag = store.search('', { tag: 'cordis' })
  equal('按标签精确过滤只留一条', byTag.length, 1)
  equal('按标签过滤命中的是 cordis 那条', byTag[0]?.entry.id, second.id)

  const byStatus = store.search('', { status: 'workaround' })
  equal('按状态过滤只留一条', byStatus.length, 1)

  // -------------------------------------------------------------------------
  // 4. 补记：追加而不是覆盖
  const updated = store.update(first.id, { note: '后来发现 pwsh 7 默认就是 UTF-8，只有 Windows PowerShell 5.1 才有这个问题' })
  equal('补记后状态不变', updated?.status, 'solved')
  equal('补记写入一条 note', updated?.notes.length, 1)
  const reread = store.get(first.id)
  equal('重新读到 note', reread?.notes.length, 1)
  check('note 文本保留', (reread?.notes[0]?.text ?? '').includes('pwsh 7'))
  check('note 不覆盖原解法', (reread?.solution ?? '').includes('read 工具'))

  const statusChanged = store.update(second.id, { status: 'solved' })
  equal('覆盖状态生效', statusChanged?.status, 'solved')
  equal('不存在的编号返回 undefined', store.update('p-nope', { status: 'open' }), undefined)
  equal('show 不存在的编号返回 undefined', store.get('p-nope'), undefined)

  // -------------------------------------------------------------------------
  // 5. jsonl 折叠：同 id 后写覆盖前写
  const third = store.record({ title: '折叠测试', symptom: '初版' })
  store.update(third.id, { symptom: '改过的版本' })
  equal('折叠后只剩一条', store.list().filter((entry) => entry.id === third.id).length, 1)
  equal('折叠取最后一条快照', store.get(third.id)?.symptom, '改过的版本')
  const lines = readFileSync(join(root, 'entries.jsonl'), 'utf8').trim().split('\n')
  check('jsonl 里确实有两行同 id 快照', lines.filter((line) => line.includes(third.id)).length === 2)

  // -------------------------------------------------------------------------
  // 6. 残行容错：写入被打断留下的半行不该毁掉整本档案
  appendFileSync(join(root, 'entries.jsonl'), '{"v":1,"id":"p-broken","at":"2026-', 'utf8')
  equal('残行被跳过，其余记录照常可读', store.list().length, 3)

  // -------------------------------------------------------------------------
  // 7. 归一化与边界
  equal('非法状态折成 solved', normalizeStatus('whatever'), 'solved')
  equal('非字符串状态折成 solved', normalizeStatus(7), 'solved')
  const longTitle = store.record({ title: 'x'.repeat(500), tags: ['a', 'a', 'b'], symptom: '  前后空白  ' })
  equal('标题被截到 200', longTitle.title.length, 200)
  equal('tags 去重', longTitle.tags.join(','), 'a,b')
  equal('正文首尾空白被去掉', longTitle.symptom, '前后空白')
  equal('空标题有兜底', store.record({ title: '   ' }).title, '（未命名）')

  // -------------------------------------------------------------------------
  // 8. 打分与分词
  equal('空查询对任何记录都算命中', scoreEntry(first, []), 1)
  check('无关查询打 0 分', scoreEntry(first, tokenize('quantum spaceship')) === 0)
  check('中文长串会切出 2-gram', tokenize('文件上传失败').includes('上传'))
  check('英文按词切', tokenize('EPERM fs.sandbox').includes('eperm'))
  equal('summarize 取解法第一行', summarize({ ...first, solution: '\n  用 read 工具\n后面还有' }, 50), '用 read 工具')

  // -------------------------------------------------------------------------
  // 9. 索引受 indexLimit 约束，检索不受它约束
  const index = readFileSync(join(root, 'INDEX.md'), 'utf8')
  const rows = index.split('\n').filter((line) => line.startsWith('| `p-'))
  check(`索引最多列 indexLimit 条（实际 ${rows.length}）`, rows.length <= 3)
  check('检索仍能看到全部记录', store.search('').length > 3)
} finally {
  rmSync(root, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`✗ store：${passed} 通过，${failures.length} 失败`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✓ store：${passed} 项断言全部通过`)
