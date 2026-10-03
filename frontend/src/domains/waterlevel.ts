import { allRows, listRows, saveAllRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 水位审核领域服务：列表、审核弹窗、汇总清单/待办都经此取数与落库，
// 保证「动作 → 持久化 → 取数」链路口径一致。

export const WATERLEVEL_KEY = 'waterlevel'

export const STATUS = {
  collected: '已采集',
  reviewing: '待审核',
  passed: '已通过',
  abnormal: '异常值',
  rechecking: '待复核',
  archived: '已归档',
} as const

const ACTIVE_STATUSES: string[] = [
  STATUS.collected,
  STATUS.reviewing,
  STATUS.passed,
  STATUS.abnormal,
  STATUS.rechecking,
]

export type JudgeBasis = {
  level: number | null
  warning: number | null
  guarantee: number | null
  exceedsWarning: boolean
  exceedsGuarantee: boolean
  detail: string
}

export type ReviewTrace = {
  action: string
  verdict: string
  operator: string
  reason: string
  at: string
  // 判定时的水位快照：异常记录即使重新复核，原判定依据也必须保留。
  basis: JudgeBasis
}

export type WaterLevelRow = EntryRow & {
  archived: boolean
  reviewTrace: ReviewTrace[]
}

export type RecheckResult = '复核通过' | '维持异常'

export type WaterLevelCommand =
  | { type: '提交审核'; operator: string }
  | { type: '审核确认'; operator: string; reason?: string }
  | { type: '标记异常'; operator: string; reason?: string }
  | { type: '发起复核'; operator: string; reason?: string }
  | { type: '提交复核结果'; operator: string; result: RecheckResult; reason?: string }
  | { type: '归档'; operator: string; reason?: string }

// 并发审核闸：同一条记录同一时刻只允许一个审核请求落库。
const inFlight = new Set<number>()

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function judgeBasis(row: { [field: string]: unknown }): JudgeBasis {
  const level = toNumber(row['当前水位'])
  const warning = toNumber(row['警戒水位'])
  const guarantee = toNumber(row['保证水位'])
  const exceedsWarning = level !== null && warning !== null && level > warning
  const exceedsGuarantee = level !== null && guarantee !== null && level > guarantee
  let detail: string
  if (level === null) {
    detail = '当前水位无法解析为数值，不能按正常值判定'
  } else if (exceedsGuarantee) {
    detail = `当前水位 ${level} 已越过保证水位 ${guarantee}`
  } else if (exceedsWarning) {
    detail = `当前水位 ${level} 已越过警戒水位 ${warning}`
  } else {
    detail = `当前水位 ${level} 未越过警戒水位 ${warning ?? '—'}`
  }
  return { level, warning, guarantee, exceedsWarning, exceedsGuarantee, detail }
}

function asWaterLevelRow(row: EntryRow): WaterLevelRow {
  return {
    ...row,
    archived: row.status === STATUS.archived || row.archived === true,
    reviewTrace: Array.isArray(row.reviewTrace) ? (row.reviewTrace as ReviewTrace[]) : [],
  }
}

function tableWith(rows: EntryRow[]): Record<string, EntryRow[]> {
  return { ...allRows(), [WATERLEVEL_KEY]: rows }
}

function findRow(rows: EntryRow[], id: number): WaterLevelRow | null {
  const raw = rows.find((item) => Number(item.id) === id)
  return raw ? asWaterLevelRow(raw) : null
}

function settle(row: WaterLevelRow, patch: Partial<WaterLevelRow>): WaterLevelRow {
  const status = String(patch.status ?? row.status)
  const everAbnormal =
    status === STATUS.abnormal ||
    row.abnormal === true ||
    row.reviewTrace.some((trace) => trace.verdict === '异常' || trace.verdict === '维持异常')
  return {
    ...row,
    ...patch,
    status,
    // pending/abnormal 一律由状态重算，杜绝前一次审核的标记残留。
    pending: !(status === STATUS.passed || status === STATUS.archived),
    // 异常语义：异常值/待复核状态本身为异常；归档时保留「曾被判定异常」的事实。
    abnormal:
      status === STATUS.abnormal || status === STATUS.rechecking ||
      (status === STATUS.archived && everAbnormal),
    archived: status === STATUS.archived,
  }
}

function failure(message: string): ActionResult {
  return { ok: false, message: `${message}；记录保持原状态，可重试本次操作` }
}

function appendTrace(row: WaterLevelRow, command: WaterLevelCommand, verdict: string): ReviewTrace[] {
  const trace: ReviewTrace = {
    action: command.type,
    verdict,
    operator: command.operator || '值班管理员',
    reason: ('reason' in command ? command.reason : '') ?? '',
    at: new Date().toISOString(),
    basis: judgeBasis(row),
  }
  // 只追加不改写：历史判定依据随复核轨迹一并保留。
  return [...row.reviewTrace, trace]
}

// 模拟审核链路的异步性：两次近乎同时的点击必须只有一次真正落库。
function delay(ms: number): Promise<void> {
  const timer = globalThis.setTimeout
  return new Promise((resolve) => timer(resolve, ms))
}

/**
 * 提交水位审核动作。
 * - 超警戒/超保证的记录不能按正常值确认通过；
 * - 异常记录只能进入复核或归档；
 * - 暂无可复核结果时禁止按正常值处理；
 * - 并发审核只落一次；落库失败整体回退，记录仍可重试。
 */
export async function submitWaterLevel(
  id: number,
  command: WaterLevelCommand,
): Promise<ActionResult> {
  if (inFlight.has(id)) {
    return { ok: false, message: '该记录正在审核处理中，请勿重复提交（并发审核只允许落一次）' }
  }

  const rows = listRows(WATERLEVEL_KEY)
  const current = findRow(rows, id)
  if (!current) {
    return { ok: false, message: `没有找到编号为 ${id} 的水位记录` }
  }

  const guard = guardTransition(current, command)
  if (!guard.ok) {
    return guard
  }

  inFlight.add(id)
  try {
    await delay(120)
    // 双重检查：等待期间若已有另一个审核落库，则本次不再落库。
    const freshest = findRow(listRows(WATERLEVEL_KEY), id)
    if (!freshest || String(freshest.status) !== String(current.status)) {
      return { ok: false, message: '该记录的状态已被另一个审核请求更新，本次提交未重复落库' }
    }

    const nextRow = applyTransition(freshest, command)
    const nextRows = listRows(WATERLEVEL_KEY).map((item) =>
      Number(item.id) === id ? nextRow : item,
    )
    try {
      // 落库失败会抛错：缓存保持旧快照，列表、汇总、待办读到的仍是一致的旧状态。
      saveAllRows(tableWith(nextRows))
    } catch (error) {
      return failure(error instanceof Error ? error.message : '水位记录落库失败')
    }
    return { ok: true, message: `水位记录已${command.type.replace('提交复核结果', '提交复核')}，当前状态「${nextRow.status}」` }
  } finally {
    inFlight.delete(id)
  }
}

function guardTransition(row: WaterLevelRow, command: WaterLevelCommand): ActionResult {
  const status = String(row.status)
  const basis = judgeBasis(row)
  switch (command.type) {
    case '提交审核':
      if (status !== STATUS.collected) {
        return { ok: false, message: `当前为「${status}」，不能提交审核` }
      }
      return { ok: true, message: '' }
    case '审核确认':
      if (status !== STATUS.reviewing) {
        return { ok: false, message: `只有「${STATUS.reviewing}」记录可以审核确认，当前为「${status}」` }
      }
      if (basis.exceedsWarning || basis.level === null) {
        return { ok: false, message: `${basis.detail}，不能确认通过为正常值，请标记异常或发起复核` }
      }
      return { ok: true, message: '' }
    case '标记异常':
      if (status !== STATUS.reviewing) {
        return { ok: false, message: `只有「${STATUS.reviewing}」记录可以标记异常，当前为「${status}」` }
      }
      return { ok: true, message: '' }
    case '发起复核':
      // 异常只能进入复核或归档；已归档为终态，历史异常不再重新复核（轨迹已留存）。
      if (status !== STATUS.abnormal) {
        return { ok: false, message: `只有「${STATUS.abnormal}」记录可以发起复核，当前为「${status}」` }
      }
      return { ok: true, message: '' }
    case '提交复核结果':
      if (status !== STATUS.rechecking) {
        return { ok: false, message: `只有「${STATUS.rechecking}」记录可以登记复核结果，当前为「${status}」` }
      }
      // 暂无可复核结果时不得按正常值处理：结果缺失直接拦下。
      if (!command.result) {
        return { ok: false, message: '暂无可复核结果，不能按正常值处理；请等待复核结论或归档该异常记录' }
      }
      return { ok: true, message: '' }
    case '归档':
      if (status !== STATUS.abnormal && status !== STATUS.rechecking) {
        return { ok: false, message: `只有异常或复核中的记录允许归档，当前为「${status}」` }
      }
      return { ok: true, message: '' }
    default:
      return { ok: false, message: '未知的水位审核动作' }
  }
}

function applyTransition(row: WaterLevelRow, command: WaterLevelCommand): WaterLevelRow {
  switch (command.type) {
    case '提交审核':
      return settle(row, { status: STATUS.reviewing, reviewTrace: appendTrace(row, command, '提交审核') })
    case '审核确认':
      return settle(row, { status: STATUS.passed, reviewTrace: appendTrace(row, command, '正常') })
    case '标记异常':
      return settle({ ...row, abnormal: true }, { status: STATUS.abnormal, reviewTrace: appendTrace(row, command, '异常') })
    case '发起复核':
      return settle(row, { status: STATUS.rechecking, reviewTrace: appendTrace(row, command, '进入复核') })
    case '提交复核结果':
      if (command.result === '复核通过') {
        return settle(row, { status: STATUS.passed, reviewTrace: appendTrace(row, command, '复核通过') })
      }
      return settle({ ...row, abnormal: true }, { status: STATUS.abnormal, reviewTrace: appendTrace(row, command, '维持异常') })
    case '归档':
      return settle(row, { status: STATUS.archived, reviewTrace: appendTrace(row, command, '归档') })
  }
}

// ---- 取数：活跃列表不含已归档，归档记录只在归档清单出现一次 ----

export function listWaterLevels(): WaterLevelRow[] {
  return listRows(WATERLEVEL_KEY)
    .map(asWaterLevelRow)
    .filter((row) => !row.archived && ACTIVE_STATUSES.includes(String(row.status)))
}

export function listArchivedWaterLevels(): WaterLevelRow[] {
  return listRows(WATERLEVEL_KEY)
    .map(asWaterLevelRow)
    .filter((row) => row.archived || String(row.status) === STATUS.archived)
}

export type WaterLevelTodo = {
  id: number
  recordNo: string
  status: string
  reason: string
}

// 待办与列表、汇总同源：落库失败三者一起停留在旧状态。
export function listWaterLevelTodos(): WaterLevelTodo[] {
  return listWaterLevels()
    .filter((row) => row.pending)
    .map((row) => ({
      id: row.id,
      recordNo: String(row['记录编号'] ?? row.id),
      status: String(row.status),
      reason: todoReason(row),
    }))
}

function todoReason(row: WaterLevelRow): string {
  switch (String(row.status)) {
    case STATUS.collected:
      return '新采集记录待提交审核'
    case STATUS.reviewing: {
      const basis = judgeBasis(row)
      return basis.exceedsWarning ? `${basis.detail}，需异常处置` : '待审核确认'
    }
    case STATUS.abnormal:
      return '异常值待发起复核或归档'
    case STATUS.rechecking:
      return '等待复核结论，无结论不得按正常值处理'
    default:
      return ''
  }
}

export type WaterLevelSummary = {
  collectedToday: number
  overWarning: number
  reviewing: number
  abnormal: number
  rechecking: number
  archived: number
  todos: number
}

export function waterLevelSummary(today = new Date().toISOString().slice(0, 10)): WaterLevelSummary {
  const active = listWaterLevels()
  const archived = listArchivedWaterLevels()
  return {
    collectedToday: active.filter((row) => String(row['观测时间'] ?? '').startsWith(today)).length,
    overWarning: active.filter((row) => judgeBasis(row).exceedsWarning).length,
    reviewing: active.filter((row) => String(row.status) === STATUS.reviewing).length,
    abnormal: active.filter((row) => String(row.status) === STATUS.abnormal).length,
    rechecking: active.filter((row) => String(row.status) === STATUS.rechecking).length,
    archived: archived.length,
    todos: listWaterLevelTodos().length,
  }
}

export function statusCounts(): { status: string; count: number }[] {
  const active = listWaterLevels()
  return [
    STATUS.collected,
    STATUS.reviewing,
    STATUS.passed,
    STATUS.abnormal,
    STATUS.rechecking,
    STATUS.archived,
  ].map((status) => ({
    status,
    count:
      status === STATUS.archived
        ? listArchivedWaterLevels().length
        : active.filter((row) => String(row.status) === status).length,
  }))
}
