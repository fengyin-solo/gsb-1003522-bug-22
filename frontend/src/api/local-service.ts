import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  isAbnormalStatus as isWaterlevelAbnormal,
  isArchivedStatus as isWaterlevelArchived,
  isPendingStatus as isWaterlevelPending,
  listWaterlevelRows,
  WATERLEVEL_KEY,
} from '@/api/waterlevel-service'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

function isArchived(meta: ModuleMeta, row: EntryRow): boolean {
  if (meta.key === WATERLEVEL_KEY) {
    return isWaterlevelArchived(String(row.status))
  }
  return meta.archivedStatus !== undefined && String(row.status) === meta.archivedStatus
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

/**
 * 列表取数：默认只返回活动记录（归档记录不重复显示），按 id 去重。
 * 水位模块的状态判定走专属规则；其余模块沿用各自的 archivedStatus 配置。
 */
export function listEntries(
  key: string,
  filters: Record<string, string> = {},
  includeArchived = false,
): PageResult {
  const meta = moduleMeta(key)
  const source = listRows(key)
  const visible =
    key === WATERLEVEL_KEY
      ? listWaterlevelRows(source, includeArchived)
      : dedupeRows(source).filter((row) => includeArchived || !isArchived(meta, row))
  const matched = filterRows(visible, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function dedupeRows(rows: EntryRow[]): EntryRow[] {
  const seen = new Set<number>()
  const result: EntryRow[] = []
  for (const row of rows) {
    const id = Number(row.id)
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    result.push(row)
  }
  return result
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
  } catch (error) {
    // 落库失败时内存与存储都停在旧值，列表/汇总/待办一起回退，允许原样重试。
    return {
      ok: false,
      retryable: true,
      message: `落库失败：${error instanceof Error ? error.message : '未知错误'}，${meta.entity}保持原状，可重试`,
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

/** 导出活动清单：归档记录默认不重复导出，勾选「显示已归档」导出全量。 */
export function exportEntries(key: string, includeArchived = false): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listEntries(key, {}, includeArchived).items) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string, includeArchived = false): void {
  const { filename, content } = exportEntries(key, includeArchived)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function pendingOf(meta: ModuleMeta, row: EntryRow): boolean {
  if (meta.key === WATERLEVEL_KEY) {
    return isWaterlevelPending(String(row.status))
  }
  return Boolean(row.pending)
}

function abnormalOf(meta: ModuleMeta, row: EntryRow): boolean {
  if (meta.key === WATERLEVEL_KEY) {
    return isWaterlevelAbnormal(String(row.status))
  }
  return Boolean(row.abnormal)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    // 汇总取数同样剔除归档记录，已归档记录不再计入今日新增、待处理与异常量。
    const source =
      meta.key === WATERLEVEL_KEY
        ? listWaterlevelRows(rows[WATERLEVEL_KEY] ?? [], false)
        : dedupeRows(rows[meta.key] ?? []).filter((row) => !isArchived(meta, row))
    return {
      name: meta.name,
      created: source.length,
      pending: source.filter((row) => pendingOf(meta, row)).length,
      abnormal: source.filter((row) => abnormalOf(meta, row)).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
