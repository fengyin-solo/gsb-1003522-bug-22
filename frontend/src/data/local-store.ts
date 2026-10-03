import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydrology-monitor-station:entries'

/** 落库失败：此时内存和存储都保持在调用前的状态，调用方可以放心重试。 */
export class PersistError extends Error {
  constructor(message = '数据落库失败，请重试') {
    super(message)
    this.name = 'PersistError'
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
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
    return { ...fallback, ...parsed }
  } catch {
    writeStorage(fallback)
    return fallback
  }
}

// 仅供验证/演示使用：置为 true 后下一次写入必失败，抛出 PersistError，用完自动复位。
let simulateNextWriteFailure = false
export function __failNextWrite(): void {
  simulateNextWriteFailure = true
}

function writeStorage(data: Record<string, EntryRow[]>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // 先序列化，序列化都过不了就当作落库失败，调用方拿不到半份数据。
  const serialized = JSON.stringify(data)
  if (simulateNextWriteFailure) {
    simulateNextWriteFailure = false
    throw new PersistError()
  }
  window.localStorage.setItem(STORAGE_KEY, serialized)
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

export function saveRows(key: string, rows: EntryRow[]): void {
  const previous = allRows()
  const next = { ...previous, [key]: rows }
  // 先落库后换内存：setItem 抛错（配额满、存储被禁用等）时 cache 完全不动，
  // 列表、汇总、待办读到的仍是上一份已提交数据，天然一起回退；成功才提交内存。
  writeStorage(next)
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
