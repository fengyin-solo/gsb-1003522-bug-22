/* eslint-disable */
// 水位异常处理链路行为测试：esbuild 打包后在 Node + localStorage shim 下运行。
import assert from 'node:assert'
import { listEntries, loadOverview, resetModule } from '@/api/local-service'
import {
  submitWaterlevelAction,
  listWaterlevelRows,
  actionsForStatus,
  WL_STATUS,
} from '@/api/waterlevel-service'
import { listRows, saveRows, __failNextWrite } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

async function main() {
  const KEY = 'waterlevel'
  const op = '测试值班员'
  let passed = 0
  const ok = (name: string) => {
    passed += 1
    console.log(`  ✓ ${name}`)
  }
  const reset = () => resetModule(KEY)
  const find = (id: number) => listRows(KEY).find((r) => Number(r.id) === id)!

  // 1. 列表默认不含已归档，勾选后可见；无重复
  reset()
  let page = listEntries(KEY)
  assert.strictEqual(page.total, 4, '默认列表应为 4 条（归档隐藏）')
  assert.ok(!page.items.some((r) => String(r.status) === WL_STATUS.archived))
  assert.strictEqual(listEntries(KEY, {}, true).total, 5, '显示已归档应为 5 条')
  const dup = [...listRows(KEY), { ...listRows(KEY)[0] }]
  assert.strictEqual(listWaterlevelRows(dup, true).length, 5, '重复 id 去重')
  ok('已归档记录不重复显示，可按需显示全量')

  // 2. 越过警戒水位不得确认通过
  reset()
  let res = await submitWaterlevelAction(2, '确认通过', { operator: op })
  assert.strictEqual(res.ok, false)
  assert.match(res.message, /警戒水位/)
  assert.strictEqual(String(find(2).status), WL_STATUS.pendingReview, '记录状态不变')
  ok('越过警戒水位确认通过被拒绝')

  // 3. 已采集不能直接确认通过；提交审核后 pending 仍为待处理
  reset()
  res = await submitWaterlevelAction(1, '确认通过', { operator: op })
  assert.strictEqual(res.ok, false)
  res = await submitWaterlevelAction(1, '提交审核', { operator: op })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(String(find(1).status), WL_STATUS.pendingReview)
  assert.strictEqual(find(1).pending, true, '待审核标记不残留为 false')
  // 4. 正常水位审核通过：pending/abnormal 全部清掉
  res = await submitWaterlevelAction(1, '确认通过', { operator: op })
  assert.strictEqual(res.ok, true, res.message)
  assert.strictEqual(String(find(1).status), WL_STATUS.approved)
  assert.strictEqual(find(1).pending, false, '已通过不得残留待处理标记')
  assert.strictEqual(find(1).abnormal, false)
  ok('审核流转标志位正确，已通过无待办残留')

  // 5. 无可复核结果（水位无法解析）不得按正常值放行
  reset()
  const broken: EntryRow = {
    ...find(1),
    id: 99,
    status: WL_STATUS.pendingReview,
    '当前水位': '缺测',
    '警戒水位': '45.00',
  }
  saveRows(KEY, [...listRows(KEY), broken])
  res = await submitWaterlevelAction(99, '确认通过', { operator: op })
  assert.strictEqual(res.ok, false)
  assert.match(res.message, /无法解析|无可复核结果/)
  res = await submitWaterlevelAction(99, '标记异常', { operator: op })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(String(find(99).status), WL_STATUS.abnormal)
  assert.match(String(find(99).abnormalReason), /无法解析/)
  ok('暂无可复核结果不得确认通过，只能落异常')

  // 6. 历史异常可重新复核，原判定依据保留，过程追加留痕
  reset()
  const before = String(find(3).abnormalReason)
  const histBefore = (find(3).reviewHistory ?? []).length
  res = await submitWaterlevelAction(3, '发起复核', { operator: op })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(String(find(3).status), WL_STATUS.reviewing)
  assert.strictEqual(find(3).abnormal, true, '复核中仍计入异常待办')
  // 复核通过必须填结论
  res = await submitWaterlevelAction(3, '确认通过', { operator: op, reason: '' })
  assert.strictEqual(res.ok, false)
  res = await submitWaterlevelAction(3, '确认通过', { operator: op, reason: '复测水位 44.60，低于警戒，复核通过' })
  assert.strictEqual(res.ok, true, res.message)
  assert.strictEqual(String(find(3).status), WL_STATUS.approved)
  assert.strictEqual(String(find(3).abnormalReason), before, '首次异常判定依据冻结保留')
  assert.strictEqual((find(3).reviewHistory ?? []).length, histBefore + 2, '发起复核+通过两条留痕')
  ok('历史异常允许重新复核且保留原判定依据')

  // 7. 维持异常必须有意见；维持后允许归档；归档后退出列表/汇总
  reset()
  await submitWaterlevelAction(3, '发起复核', { operator: op })
  res = await submitWaterlevelAction(3, '维持异常', { operator: op, reason: '' })
  assert.strictEqual(res.ok, false)
  res = await submitWaterlevelAction(3, '维持异常', { operator: op, reason: '复测仍超警戒，维持异常判定' })
  assert.strictEqual(res.ok, true)
  assert.strictEqual(String(find(3).status), WL_STATUS.abnormal)
  assert.strictEqual(String(find(3).abnormalReason), before)
  // 未走过复核的异常不能归档
  reset()
  res = await submitWaterlevelAction(3, '归档', { operator: op })
  assert.strictEqual(res.ok, false, '未复核异常不得归档')
  // 走完复核（维持异常）再归档
  await submitWaterlevelAction(3, '发起复核', { operator: op })
  await submitWaterlevelAction(3, '维持异常', { operator: op, reason: '维持' })
  res = await submitWaterlevelAction(3, '归档', { operator: op })
  assert.strictEqual(res.ok, true, res.message)
  assert.strictEqual(String(find(3).status), WL_STATUS.archived)
  assert.ok(find(3).archivedAt)
  assert.strictEqual(listEntries(KEY).total, 3, '归档后退出活动列表（默认另有 1 条已归档）')
  assert.strictEqual(
    listEntries(KEY, {}, true).items.find((r) => Number(r.id) === 3)!.pending,
    false,
    '归档记录不带待办',
  )
  ok('异常只能走复核或归档，归档后列表与汇总同步剔除')

  // 8. 并发审核只落一次
  reset()
  const [a, b] = await Promise.all([
    submitWaterlevelAction(1, '提交审核', { operator: op }),
    submitWaterlevelAction(1, '提交审核', { operator: op }),
  ])
  assert.strictEqual(a.ok, true)
  assert.strictEqual(b.ok, false)
  assert.strictEqual(b.retryable, false, '并发重复提交不是可重试错误')
  assert.match(b.message, /正在审核|重复/)
  assert.strictEqual((find(1).reviewHistory ?? []).length, 1, '只落一次库')
  await new Promise((r) => setTimeout(r, 5))
  res = await submitWaterlevelAction(1, '标记异常', { operator: op, reason: '并发测试后标记' })
  assert.strictEqual(res.ok, true)
  ok('并发审核只落一次，锁正常释放')

  // 9. 落库失败整体回退且可重试
  reset()
  const snapshot = JSON.stringify(find(1))
  __failNextWrite()
  res = await submitWaterlevelAction(1, '提交审核', { operator: op })
  assert.strictEqual(res.ok, false)
  assert.strictEqual(res.retryable, true)
  assert.strictEqual(JSON.stringify(find(1)), snapshot, '内存记录回退')
  assert.strictEqual(String(find(1).status), WL_STATUS.collected)
  res = await submitWaterlevelAction(1, '提交审核', { operator: op })
  assert.strictEqual(res.ok, true, res.message)
  assert.strictEqual(String(find(1).status), WL_STATUS.pendingReview)
  ok('落库失败列表/汇总/待办一起回退，重试成功')

  // 10. 汇总数据与状态派生一致
  reset()
  const wl = loadOverview().modules.find((m) => m.name === '水位监测')!
  const active = listEntries(KEY).items
  assert.strictEqual(wl.created, 4)
  assert.strictEqual(
    wl.pending,
    active.filter((r) =>
      [WL_STATUS.collected, WL_STATUS.pendingReview, WL_STATUS.reviewing, WL_STATUS.abnormal].includes(
        String(r.status) as (typeof WL_STATUS)[keyof typeof WL_STATUS],
      ),
    ).length,
  )
  assert.strictEqual(
    wl.abnormal,
    active.filter((r) =>
      [WL_STATUS.abnormal, WL_STATUS.reviewing].includes(
        String(r.status) as (typeof WL_STATUS)[keyof typeof WL_STATUS],
      ),
    ).length,
  )
  ok('汇总取数与活动列表口径一致（归档剔除）')

  // 11. 按钮按状态收敛
  assert.deepStrictEqual(actionsForStatus(WL_STATUS.archived), [])
  assert.deepStrictEqual([...actionsForStatus(WL_STATUS.abnormal)].sort(), ['发起复核', '归档'].sort())
  assert.deepStrictEqual(actionsForStatus(WL_STATUS.approved), ['归档'])
  ok('终态无动作，异常态只暴露复核/归档')

  reset()
  console.log(`\n全部 ${passed} 项行为测试通过`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
