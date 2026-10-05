/**
 * 检测器的直跑测试 —— 不依赖 harness，不起会话。
 *
 * 这里钉住的是「什么时候该出声」：太早出声是噪音，太晚出声就白搭。规则只有
 * 四条（同工具连续、成功清零、触发后清零、冷却与配额），但它们的组合决定了
 * 插件会不会变成烦人的东西。
 *
 *   node test/detector.test.mjs
 */
import { PitfallDetector } from '../src/detector.ts'

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

/** 默认：连续 2 次、冷却 10 分钟、单会话最多 4 次。 */
function detector(overrides = {}) {
  return new PitfallDetector({ failureStreak: 2, cooldownMs: 600000, maxPerSession: 4, ...overrides })
}

/** 造一次失败。时间按 step 递增，方便测冷却。 */
function fail(instance, { session = 'S', tool = 'pwsh', step = 0, clue = 'command=node build.mjs' } = {}) {
  return instance.observe({ sessionId: session, toolName: tool, clue, at: 1_000_000 + step * 60_000 })
}

// ---------------------------------------------------------------------------
// 1. 第一次失败不算坑，第二次才出声
{
  const instance = detector()
  equal('第一次失败不出声', fail(instance, { step: 0 }), null)
  const verdict = fail(instance, { step: 1 })
  check('第二次失败出声', verdict !== null)
  equal('出声时带上次数', verdict?.count, 2)
  equal('出声时带上工具名', verdict?.toolName, 'pwsh')
  check('出声时带上线索', (verdict?.clue ?? '').includes('build.mjs'))
}

// ---------------------------------------------------------------------------
// 2. 出声之后清零：紧接着的失败不再刷屏
{
  const instance = detector()
  fail(instance, { step: 0 })
  fail(instance, { step: 1 })
  equal('触发后第三次失败不再出声', fail(instance, { step: 2 }), null)
  equal('连续计数已清零', instance.streakOf('S', 'pwsh'), 1)
  // 但持续失败下去，攒够一轮还是应该再说一次
  const again = fail(instance, { step: 30 })
  check('再攒够两次会再提醒一次', again !== null)
}

// ---------------------------------------------------------------------------
// 3. 换工具就重新起算 —— 两个工具各失败一次不是「连续两次」
{
  const instance = detector()
  equal('A 工具第一次失败', fail(instance, { tool: 'pwsh', step: 0 }), null)
  equal('B 工具第一次失败', fail(instance, { tool: 'read', step: 1 }), null)
  const verdict = fail(instance, { tool: 'read', step: 2 })
  check('B 工具第二次失败才出声', verdict !== null)
  equal('出声的是 B 工具', verdict?.toolName, 'read')
}

// ---------------------------------------------------------------------------
// 4. 中间成功一次就清零
{
  const instance = detector()
  fail(instance, { step: 0 })
  instance.observeSuccess('S', 'pwsh')
  equal('成功之后重新起算', fail(instance, { step: 1 }), null)
  check('再失败一次才出声', fail(instance, { step: 2 }) !== null)
}

// ---------------------------------------------------------------------------
// 5. observeSuccess 只清同一工具
{
  const instance = detector()
  fail(instance, { tool: 'pwsh', step: 0 })
  instance.observeSuccess('S', 'other')
  equal('别的工具成功不影响计数', instance.streakOf('S', 'pwsh'), 1)
}

// ---------------------------------------------------------------------------
// 6. 冷却：刚提醒过就别马上再提醒
{
  const instance = detector({ cooldownMs: 600000 })
  fail(instance, { step: 0 })
  check('第一次提醒', fail(instance, { step: 1 }) !== null)
  fail(instance, { step: 2 })
  equal('冷却期内不再提醒', fail(instance, { step: 3 }), null)
  fail(instance, { step: 4 })
  check('冷却过去后可以再提醒', fail(instance, { step: 30 }) !== null)
}

// ---------------------------------------------------------------------------
// 7. 配额：单会话上限到了就闭嘴
{
  const instance = detector({ cooldownMs: 0, maxPerSession: 2 })
  const verdicts = []
  for (let step = 0; step < 20; step += 1) {
    const verdict = fail(instance, { step })
    if (verdict !== null) verdicts.push(verdict)
  }
  equal('配额用完就不再出声', verdicts.length, 2)
  equal('每次出声都带次数', verdicts[0]?.count, 2)
}

// ---------------------------------------------------------------------------
// 8. 多条会话互不干扰，forget 之后重来
{
  const instance = detector()
  fail(instance, { session: 'A', step: 0 })
  fail(instance, { session: 'B', step: 0 })
  check('A 的第二条失败出声', fail(instance, { session: 'A', step: 1 }) !== null)
  equal('B 仍在自己起算', instance.streakOf('B', 'pwsh'), 1)
  instance.forget('B')
  equal('forget 之后计数清空', instance.streakOf('B', 'pwsh'), 0)
  equal('forget 后第一次失败不出声', fail(instance, { session: 'B', step: 2 }), null)
}

// ---------------------------------------------------------------------------
// 9. 阈值可配：设成 1 时第一次失败就提醒
{
  const instance = detector({ failureStreak: 1 })
  check('阈值 1 时首次失败即出声', fail(instance, { step: 0 }) !== null)
}

if (failures.length > 0) {
  console.error(`✗ detector：${passed} 通过，${failures.length} 失败`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`✓ detector：${passed} 项断言全部通过`)
