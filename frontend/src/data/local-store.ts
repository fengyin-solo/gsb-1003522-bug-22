import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'
// 结构调整（水位新增复核/归档字段）时递增；旧缓存会先迁移再使用，避免脏标记残留。
const STORAGE_VERSION = 2
const VERSION_KEY = 'hydrology-monitor-station:version'

// 测试钩子：置为 true 后下一次落库必然失败，用于验证列表、汇总、待办的整体回退。
let failNextWrite = false

export function setFailNextWrite(value = true): void {
  failNextWrite = value
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedData(): Record<string, EntryRow[]> {
  return clone(SEED_ROWS)
}

// 老版本缓存的结构修正：只做可安全推断的改动，业务值不猜、不覆盖。
function migrate(data: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const next = seedData()
  for (const key of Object.keys(next)) {
    const stored = Array.isArray(data[key]) ? data[key] : []
    if (stored.length > 0) {
      // pending/abnormal 旧版本可能与状态脱节（残留标记），一律以状态重算。
      next[key] = stored.map((row) => ({
        ...row,
        pending: recomputePending(String(row.status)),
        abnormal: row.status === '异常值',
      }))
    }
  }
  return next
}

// 状态是否仍需处理：终态（已通过 / 已归档）不再进待办。
export function recomputePending(status: string): boolean {
  return status !== '已通过' && status !== '已归档'
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = seedData()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    writeStorage(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const version = Number(window.localStorage.getItem(VERSION_KEY) ?? 1)
    const data = version < STORAGE_VERSION ? migrate(parsed) : { ...fallback, ...parsed }
    // 迁移结果立即回写，避免每次读取都重复修正。
    writeStorage(data)
    return data
  } catch (error) {
    // JSON 损坏时回到种子数据；若是写入失败则保留内存中的种子，不再二次抛错。
    try {
      writeStorage(fallback)
    } catch {
      /* 忽略：种子数据仍可用于本次会话 */
    }
    void error
    return fallback
  }
}

function writeStorage(data: Record<string, EntryRow[]>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  if (failNextWrite) {
    failNextWrite = false
    throw new Error('本地存储写入失败（模拟落库故障）')
  }
  // 序列化本身也可能失败（配额溢出），必须在切缓存之前抛出。
  const serialized = JSON.stringify(data)
  window.localStorage.setItem(STORAGE_KEY, serialized)
  window.localStorage.setItem(VERSION_KEY, String(STORAGE_VERSION))
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 整表落库：调用方基于旧快照算出 next，落库成功前缓存不动；
// 任何一步抛错，缓存保持旧值，列表、汇总、待办读到的仍是一致的旧状态（整体回退）。
export function saveAllRows(next: Record<string, EntryRow[]>): void {
  // 落库成功前 cache 不动；抛错时列表、汇总、待办读到的仍是一致的旧状态（整体回退）。
  writeStorage(next)
  cache = next
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveAllRows({ ...allRows(), [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
