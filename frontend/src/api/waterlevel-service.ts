import { MODULE_BY_KEY } from '@/data/modules'
import { PersistError, listRows, saveRows } from '@/data/local-store'
import type { ActionOptions, ActionResult, EntryRow, ReviewNote } from '@/data/types'

// 水位模块专属流转规则：页面不做业务判断，全部集中在这一层。
//
// 状态机：
//   已采集 ─提交审核→ 待审核 ─确认通过→ 已通过 ─归档→ 已归档
//     │                 └─标记异常→ 异常值
//     └─标记异常→ 异常值
//   异常值 ─发起复核→ 复核中 ─确认通过→ 已通过（保留首次异常依据）
//                          └─维持异常→ 异常值（追加复核留痕）
//   异常值须先复核才能归档；已归档不再进活动列表与汇总。
export const WATERLEVEL_KEY = 'waterlevel'

export const WL_STATUS = {
  collected: '已采集',
  pendingReview: '待审核',
  reviewing: '复核中',
  approved: '已通过',
  abnormal: '异常值',
  archived: '已归档',
} as const

const PENDING_STATUSES = new Set<string>([
  WL_STATUS.collected,
  WL_STATUS.pendingReview,
  WL_STATUS.reviewing,
  WL_STATUS.abnormal,
])
const ABNORMAL_STATUSES = new Set<string>([WL_STATUS.abnormal, WL_STATUS.reviewing])

type Failure = { message: string; retryable?: boolean }
type Plan = { status: string; pending: boolean; abnormal: boolean; reason: string; archive?: boolean }

// 正在落库的记录锁：同一记录的审核动作串行，重复提交只落一次。
const inFlight = new Set<number>()

function meta() {
  return MODULE_BY_KEY.get(WATERLEVEL_KEY)!
}

export function isArchivedStatus(status: string): boolean {
  return status === meta().archivedStatus
}

export function isPendingStatus(status: string): boolean {
  return PENDING_STATUSES.has(status)
}

export function isAbnormalStatus(status: string): boolean {
  return ABNORMAL_STATUSES.has(status)
}

/** 当前状态下允许的动作（供页面渲染按钮）。 */
export function actionsForStatus(status: string): string[] {
  return meta().actionsByStatus?.[status] ?? []
}

/** 取活动记录（默认排除归档并按 id 去重，归档记录不重复显示）；includeArchived=true 时全量返回。 */
export function listWaterlevelRows(
  rows: EntryRow[],
  includeArchived: boolean,
): EntryRow[] {
  const seen = new Set<number>()
  const result: EntryRow[] = []
  for (const row of rows) {
    const id = Number(row.id)
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    if (!includeArchived && isArchivedStatus(String(row.status))) {
      continue
    }
    result.push(row)
  }
  return result
}

export function parseLevel(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }
  const matched = value.match(/-?\d+(\.\d+)?/)
  if (!matched) {
    return null
  }
  const num = Number(matched[0])
  return Number.isFinite(num) ? num : null
}

function nowLabel(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function pushNote(row: EntryRow, action: string, reason: string, operator: string): ReviewNote[] {
  const note: ReviewNote = { action, reason, operator, at: nowLabel() }
  return [...(row.reviewHistory ?? []), note]
}

function autoReason(current: number | null, warning: number | null): string {
  if (current === null || warning === null) {
    return '当前水位或警戒水位无法解析，缺少可复核结果，按异常处理'
  }
  return `当前水位 ${current} 已达到/超过警戒水位 ${warning}，不允许确认通过`
}

/**
 * 计算一次水位动作的目标结果。返回 failure 表示业务校验未通过，记录原样不动。
 */
function planAction(row: EntryRow, action: string, options: ActionOptions): Plan | { failure: Failure } {
  const status = String(row.status)
  const allowed = new Set(actionsForStatus(status))
  if (!allowed.has(action)) {
    return { failure: { message: `当前状态「${status}」下不允许执行「${action}」，请先刷新列表` } }
  }
  if (options.expectedStatus && status !== options.expectedStatus) {
    return { failure: { message: `记录已被其他人处理（当前状态「${status}」），本次${action}未生效` } }
  }

  const reason = (options.reason ?? '').trim()
  const current = parseLevel(row['当前水位'])
  const warning = parseLevel(row['警戒水位'])

  switch (action) {
    case '提交审核':
      return { status: WL_STATUS.pendingReview, pending: true, abnormal: false, reason: reason || '提交审核' }

    case '标记异常': {
      // 无可复核结果（数值无法解析）时不得按正常值处理：直接落到异常值。
      const basis = reason || autoReason(current, warning)
      return { status: WL_STATUS.abnormal, pending: true, abnormal: true, reason: basis }
    }

    case '确认通过': {
      const reviewing = status === WL_STATUS.reviewing
      // 复核通过必须给出书面复核结论，人工结论可以覆盖越警戒的自动拦截。
      if (reviewing && reason === '') {
        return { failure: { message: '复核通过必须填写复核结论，不能留空' } }
      }
      // 初审（待审核）严格执行自动核对：越过警戒水位或暂无可复核结果都不得放行。
      if (!reviewing) {
        if (current === null || warning === null) {
          return {
            failure: { message: '当前水位或警戒水位无法解析，暂无可复核结果，不能确认通过，请先标记异常' },
          }
        }
        if (current >= warning) {
          return {
            failure: { message: `当前水位 ${current} 已达到/超过警戒水位 ${warning}，只能标记异常或发起复核` },
          }
        }
      }
      return {
        status: WL_STATUS.approved,
        pending: false,
        abnormal: false,
        reason:
          reason ||
          (current !== null && warning !== null
            ? `当前水位 ${current} 低于警戒水位 ${warning}，审核通过`
            : '审核通过'),
      }
    }

    case '发起复核': {
      if (status !== WL_STATUS.abnormal) {
        return { failure: { message: '只有异常值记录才能发起复核' } }
      }
      return {
        status: WL_STATUS.reviewing,
        pending: true,
        abnormal: true,
        reason: reason || '发起重新复核',
      }
    }

    case '维持异常': {
      if (reason === '') {
        return { failure: { message: '维持异常必须填写复核意见（判定依据）' } }
      }
      return { status: WL_STATUS.abnormal, pending: true, abnormal: true, reason }
    }

    case '归档': {
      // 异常值未复核不得归档：异常只能先进入复核；至少完成过一次复核（含维持异常的结论）后才允许归档。
      if (status === WL_STATUS.abnormal) {
        const rechecked = (row.reviewHistory ?? []).some((note) => note.action === '发起复核')
        if (!rechecked) {
          return { failure: { message: '异常值记录需先发起复核并得出结论，才能归档' } }
        }
      }
      return {
        status: WL_STATUS.archived,
        pending: false,
        abnormal: false,
        reason: reason || '记录归档',
        archive: true,
      }
    }

    default:
      return { failure: { message: `水位记录不支持「${action}」这个动作` } }
  }
}

/**
 * 执行水位动作（异步串行）。
 * - 同一记录并发只落一次，重复提交返回非可重试失败；
 * - 落库失败时内存/存储都不动，返回 retryable，允许原样重试；
 * - 历史异常重新复核时，首次判定依据 abnormalReason 冻结保留，过程只追加 reviewHistory。
 */
export function submitWaterlevelAction(
  id: number,
  action: string,
  options: ActionOptions = {},
): Promise<ActionResult> {
  // 并发门禁：同一记录前一次审核还没落地，后来的调用直接拒绝（非可重试，不算重复落库）。
  if (inFlight.has(id)) {
    return Promise.resolve({
      ok: false,
      message: '该记录正在审核处理中，请勿重复提交',
      retryable: false,
    })
  }

  const rows = listRows(WATERLEVEL_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return Promise.resolve({ ok: false, message: `没有找到编号为 ${id} 的水位记录` })
  }
  const row = rows[index]
  const plan = planAction(row, action, options)
  if ('failure' in plan) {
    return Promise.resolve({ ok: false, message: plan.failure.message, retryable: plan.failure.retryable })
  }

  // 校验全部通过才加锁；加锁后到 setTimout 回调之间是该记录唯一的落库窗口。
  inFlight.add(id)
  const operator = options.operator || '值班管理员'
  const updated: EntryRow = {
    ...row,
    status: plan.status,
    pending: plan.pending,
    abnormal: plan.abnormal,
    reviewHistory: pushNote(row, action, plan.reason, operator),
    archivedAt: plan.archive ? nowLabel() : row.archivedAt,
  }
  // 首次判定为异常时写入判定依据；重新复核或后续动作永不覆盖它。
  if (plan.abnormal && row.abnormalReason === undefined) {
    updated.abnormalReason = plan.reason
  } else if (row.abnormalReason !== undefined) {
    // 复核通过 / 归档 / 再次复核：历史依据原样保留，只追加新的复核留痕。
    updated.abnormalReason = row.abnormalReason
  }

  const nextRows = [...rows]
  nextRows[index] = updated

  return new Promise((resolve) => {
    // 让出当前调用栈，使同一事件循环里的并发点击能命中上面的 inFlight 门禁。
    setTimeout(() => {
      try {
        saveRows(WATERLEVEL_KEY, nextRows)
        resolve({ ok: true, message: `水位记录已${action}，当前状态「${plan.status}」` })
      } catch (error) {
        // saveRows 保证失败时 cache 与 localStorage 一起停在旧值，列表/汇总/待办天然一起回退。
        resolve({
          ok: false,
          message:
            error instanceof PersistError
              ? `${error.message}（${action}未落库，记录保持原状）`
              : `落库失败：${error instanceof Error ? error.message : '未知错误'}，记录保持原状`,
          retryable: true,
        })
      } finally {
        inFlight.delete(id)
      }
    }, 0)
  })
}
