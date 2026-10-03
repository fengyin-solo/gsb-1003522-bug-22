import assert from 'node:assert'

import {
  STATUS,
  judgeBasis,
  listArchivedWaterLevels,
  listWaterLevelTodos,
  listWaterLevels,
  submitWaterLevel,
  waterLevelSummary,
} from '../src/domains/waterlevel'
import { loadOverview } from '../src/api/local-service'
import { setFailNextWrite } from '../src/data/local-store'

const store = new Map<string, string>()
;(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
}

let passed = 0
function ok(name: string) {
  passed += 1
  console.log(`  ✓ ${name}`)
}

async function main() {
  // --- 初始取数：归档记录不重复进入活跃列表 ---
  const active = listWaterLevels()
  const archived = listArchivedWaterLevels()
  assert.strictEqual(active.length, 5, '活跃列表应为 5 条')
  assert.strictEqual(archived.length, 1, '归档清单应为 1 条')
  assert.ok(!active.some((r) => r.status === STATUS.archived), '活跃列表不含已归档')
  ok('已归档记录只在归档清单出现一次')

  const todos = listWaterLevelTodos()
  assert.ok(todos.every((t) => t.status !== STATUS.archived), '待办不含归档')
  assert.ok(!todos.some((t) => t.recordNo === 'WATE-0006'), '归档记录不进待办')
  ok('待办只取活跃记录')

  // --- 越警戒不能确认通过 ---
  const over = active.find((r) => String(r['记录编号']) === 'WATE-0003')!
  assert.ok(judgeBasis(over).exceedsWarning)
  const blocked = await submitWaterLevel(over.id, { type: '审核确认', operator: 'tester' })
  assert.strictEqual(blocked.ok, false)
  assert.match(blocked.message, /不能确认通过/)
  assert.strictEqual(listWaterLevels().find((r) => r.id === over.id)!.status, STATUS.reviewing)
  ok('当前水位越过警戒水位时确认通过被拦截，状态不变')

  // 未越警戒可正常通过
  const normal = listWaterLevels().find((r) => String(r['记录编号']) === 'WATE-0002')!
  const passed1 = await submitWaterLevel(normal.id, { type: '审核确认', operator: 'tester' })
  assert.strictEqual(passed1.ok, true)
  const normalAfter = listWaterLevels().find((r) => r.id === normal.id)!
  assert.strictEqual(normalAfter.status, STATUS.passed)
  assert.strictEqual(normalAfter.pending, false)
  assert.strictEqual(normalAfter.abnormal, false)
  ok('正常值可确认通过，通过后 pending/异常标记清除')

  // 已采集 → 提交审核
  const collected = listWaterLevels().find((r) => String(r['记录编号']) === 'WATE-0001')!
  const submitted = await submitWaterLevel(collected.id, { type: '提交审核', operator: 'tester' })
  assert.strictEqual(submitted.ok, true)
  assert.strictEqual(listWaterLevels().find((r) => r.id === collected.id)!.status, STATUS.reviewing)
  ok('已采集记录可提交审核')

  // 异常记录动作面只有复核/归档；已通过不能再标记异常
  const abnormalRow = listWaterLevels().find((r) => String(r['记录编号']) === 'WATE-0004')!
  assert.strictEqual(abnormalRow.status, STATUS.abnormal)
  const illegal = await submitWaterLevel(abnormalRow.id, { type: '审核确认', operator: 'tester' })
  assert.strictEqual(illegal.ok, false)
  ok('异常值记录不能按正常审核确认')

  // --- 发起复核后必须有复核结论，缺结论不得按正常值处理 ---
  const toRecheck = await submitWaterLevel(abnormalRow.id, { type: '发起复核', operator: 'tester' })
  assert.strictEqual(toRecheck.ok, true)
  const rechecking = listWaterLevels().find((r) => r.id === abnormalRow.id)!
  assert.strictEqual(rechecking.status, STATUS.rechecking)
  assert.strictEqual(rechecking.abnormal, true, '待复核仍挂异常语义')
  const noResult = await submitWaterLevel(rechecking.id, {
    type: '提交复核结果',
    operator: 'tester',
    result: '' as '复核通过',
  })
  assert.strictEqual(noResult.ok, false)
  assert.match(noResult.message, /不能按正常值处理|复核结论/)
  assert.strictEqual(listWaterLevels().find((r) => r.id === rechecking.id)!.status, STATUS.rechecking)
  ok('暂无可复核结果时不得按正常值处理')

  // 维持异常 → 回异常值，可再次复核（历史异常允许重新复核，原判定依据保留）
  const keep = await submitWaterLevel(rechecking.id, { type: '提交复核结果', operator: 'tester', result: '维持异常' })
  assert.strictEqual(keep.ok, true)
  const kept = listWaterLevels().find((r) => r.id === rechecking.id)!
  assert.strictEqual(kept.status, STATUS.abnormal)
  const initialTraceCount = kept.reviewTrace.length
  assert.ok(initialTraceCount >= 3, '原判定依据轨迹仍在')
  const originalBasis = kept.reviewTrace.find((t) => t.verdict === '异常')!.basis
  assert.strictEqual(originalBasis.exceedsGuarantee, true)
  ok('历史异常可重新复核，原判定依据完整保留')

  // 复核通过 → 已通过
  await submitWaterLevel(kept.id, { type: '发起复核', operator: 'tester' })
  const approve = await submitWaterLevel(kept.id, { type: '提交复核结果', operator: 'tester', result: '复核通过' })
  assert.strictEqual(approve.ok, true)
  const approved = listWaterLevels().find((r) => r.id === kept.id)!
  assert.strictEqual(approved.status, STATUS.passed)
  assert.strictEqual(approved.abnormal, false)
  assert.ok(approved.reviewTrace.some((t) => t.verdict === '异常'), '异常历史仍在轨迹中')
  ok('复核通过后转为正常值，异常标记清除但轨迹保留')

  // --- 待复核可归档 ---
  const waiting = listWaterLevels().find((r) => String(r['记录编号']) === 'WATE-0005')!
  assert.strictEqual(waiting.status, STATUS.rechecking)
  const archivedNow = await submitWaterLevel(waiting.id, { type: '归档', operator: 'tester', reason: '长期无比测条件' })
  assert.strictEqual(archivedNow.ok, true)
  assert.strictEqual(listWaterLevels().some((r) => r.id === waiting.id), false)
  const inArchive = listArchivedWaterLevels()
  assert.strictEqual(inArchive.length, 2)
  assert.ok(inArchive.some((r) => r.id === waiting.id))
  ok('复核中的记录归档后从活跃列表移除，仅在归档清单出现')

  // 已归档不能再复核
  const reArchive = await submitWaterLevel(waiting.id, { type: '发起复核', operator: 'tester' })
  assert.strictEqual(reArchive.ok, false)
  ok('已归档为终态，不再重新复核（轨迹保留原判定依据）')

  // --- 汇总/待办/列表同源 ---
  const summary = waterLevelSummary()
  assert.strictEqual(summary.archived, 2)
  assert.strictEqual(summary.abnormal, listWaterLevels().filter((r) => r.status === STATUS.abnormal).length)
  assert.strictEqual(summary.todos, listWaterLevelTodos().length)
  const overview = loadOverview()
  const wlOverview = overview.modules.find((m) => m.name === '水位监测')!
  assert.strictEqual(wlOverview.created, listWaterLevels().length, '概览登记量不含归档')
  assert.strictEqual(wlOverview.pending, listWaterLevelTodos().length, '概览待办与待办清单一致')
  assert.ok(wlOverview.abnormal === summary.abnormal)
  ok('列表、汇总清单、待办口径一致且均排除归档')

  // --- 并发审核只落一次 ---
  const cRow = listWaterLevels().find((r) => String(r['记录编号']) === 'WATE-0001')!
  assert.strictEqual(cRow.status, STATUS.reviewing)
  const [a, b] = await Promise.all([
    submitWaterLevel(cRow.id, { type: '标记异常', operator: 'u1' }),
    submitWaterLevel(cRow.id, { type: '标记异常', operator: 'u2' }),
  ])
  assert.ok(a.ok !== b.ok, '并发两次只应一次成功')
  const afterConcurrent = listWaterLevels().find((r) => r.id === cRow.id)!
  assert.strictEqual(afterConcurrent.status, STATUS.abnormal)
  const markTraces = afterConcurrent.reviewTrace.filter((t) => t.verdict === '异常')
  assert.strictEqual(markTraces.length, 1, '异常轨迹只写一条')
  ok('并发审核只有一次落库')

  // --- 落库失败整体回退，且可重试 ---
  const target = listWaterLevels().find((r) => r.id === cRow.id)!
  const beforeStatus = target.status
  setFailNextWrite(true)
  const failed = await submitWaterLevel(target.id, { type: '发起复核', operator: 'tester' })
  assert.strictEqual(failed.ok, false)
  assert.match(failed.message, /可重试/)
  const afterFail = listWaterLevels().find((r) => r.id === target.id)!
  assert.strictEqual(afterFail.status, beforeStatus, '列表状态回退')
  const todosAfterFail = listWaterLevelTodos()
  assert.ok(todosAfterFail.some((t) => t.id === target.id), '待办回退（仍在）')
  const summaryAfterFail = waterLevelSummary()
  assert.strictEqual(summaryAfterFail.rechecking, listWaterLevels().filter((r) => r.status === STATUS.rechecking).length)
  ok('落库失败：列表/汇总/待办一起回退')

  // 失败后必须可重试成功
  const retry = await submitWaterLevel(target.id, { type: '发起复核', operator: 'tester' })
  assert.strictEqual(retry.ok, true, '失败后可重试')
  assert.strictEqual(listWaterLevels().find((r) => r.id === target.id)!.status, STATUS.rechecking)
  ok('失败记录重试成功')

  console.log(`\n全部 ${passed} 项断言通过`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
