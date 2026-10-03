/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

/** 复核/判定留痕：首次判定依据冻结保留，之后每次复核都只往后追加。 */
export type ReviewNote = {
  action: string
  reason: string
  operator: string
  at: string
}

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  /** 异常判定依据（水位模块使用）：即便重新复核也不覆盖，只追加到 reviewHistory。 */
  abnormalReason?: string
  /** 历史判定与复核记录，按时间先后排列。 */
  reviewHistory?: ReviewNote[]
  /** 归档时间；归档记录默认不进活动列表与汇总。 */
  archivedAt?: string
  [field: string]: string | number | boolean | ReviewNote[] | undefined
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 终态（归档类）状态：命中后 pending/abnormal 都视为已清，且默认不进活动列表。 */
  archivedStatus?: string
  /** 状态 -> 该状态下页面应展示的动作；不配置时沿用 actions 全量展示。 */
  actionsByStatus?: Record<string, string[]>
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
  /** 落库失败等可重试场景为 true：记录未发生任何变化，用户可以原样再试一次。 */
  retryable?: boolean
}

export type ActionOptions = {
  /** 操作人，写入复核留痕。 */
  operator?: string
  /** 异常判定 / 复核维持异常时的依据；确认通过时作为复核结论。 */
  reason?: string
  /** CAS 期望值：当前状态不是该值则拒绝，防止并发审核重复落库。 */
  expectedStatus?: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
