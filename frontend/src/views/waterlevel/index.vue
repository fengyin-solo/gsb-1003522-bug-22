<template>
  <section class="page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">维护水位记录，围绕记录编号、站点编号、观测时间、当前水位做登记、筛选与状态流转。当前水位达到或越过警戒水位时只能进入异常复核，不得直接确认通过。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水位记录</button>
        <button class="btn" type="button" @click="exportRows">导出水位监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <label class="filter-item filter-check">
        <input v-model="includeArchived" type="checkbox" @change="reload" />
        <span>显示已归档</span>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.abnormalReason" class="reason-tag" :title="String(row.abnormalReason)">异常有依据</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsForStatus(String(row.status))"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无水位监测数据，可先登记水位记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条水位监测记录（不含已归档{{ includeArchived ? '，当前已勾选显示已归档' : '' }}）</span>
      <span class="foot-right">
        <template v-if="lastFailure">
          <span class="error-text">{{ lastFailure }}</span>
          <button v-if="canRetry" class="link retry-link" type="button" @click="retryLast">重试</button>
        </template>
      </span>
    </footer>

    <div v-if="dialog.visible" class="modal-mask" @click.self="closeDialog">
      <div class="modal" role="dialog" aria-modal="true">
        <h3 class="modal-title">{{ dialog.title }}</h3>
        <dl class="modal-facts">
          <div><dt>记录编号</dt><dd>{{ dialog.row?.['记录编号'] }}</dd></div>
          <div><dt>站点编号</dt><dd>{{ dialog.row?.['站点编号'] }}</dd></div>
          <div><dt>观测时间</dt><dd>{{ dialog.row?.['观测时间'] }}</dd></div>
          <div><dt>当前水位</dt><dd>{{ dialog.row?.['当前水位'] }}</dd></div>
          <div><dt>警戒水位</dt><dd>{{ dialog.row?.['警戒水位'] }}</dd></div>
          <div><dt>当前状态</dt><dd>{{ dialog.row?.status }}</dd></div>
        </dl>
        <div v-if="originalReason" class="modal-basis">
          <span>原异常判定依据（保留不可改）：</span>
          <p>{{ originalReason }}</p>
          <ul v-if="historyNotes.length" class="history-list">
            <li v-for="(note, idx) in historyNotes" :key="idx">
              {{ note.at }} · {{ note.operator }} · {{ note.action }}：{{ note.reason }}
            </li>
          </ul>
        </div>
        <label class="dialog-field">
          <span>{{ dialog.reasonLabel }}</span>
          <textarea v-model="dialog.reason" :placeholder="dialog.placeholder" rows="3"></textarea>
        </label>
        <p v-if="dialog.error" class="error-text dialog-error">{{ dialog.error }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" :disabled="dialog.submitting" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" :disabled="dialog.submitting" @click="confirmDialog">
            {{ dialog.submitting ? '处理中…' : dialog.confirmText }}
          </button>
          <button v-if="dialog.retryable" class="btn" type="button" @click="confirmDialog">重试本次操作</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import {
  actionsForStatus,
  parseLevel,
  submitWaterlevelAction,
  WL_STATUS,
} from '@/api/waterlevel-service'
import { useSessionStore } from '@/stores/session'
import type { ActionResult, EntryRow, ReviewNote } from '@/data/types'

const session = useSessionStore()
const meta = moduleMeta('waterlevel')
const columns = ['记录编号', '站点编号', '观测时间', '当前水位', '警戒水位', '保证水位', '水位变幅', '记录状态']
const statuses = meta.statuses

const rows = ref<EntryRow[]>([])
const total = ref(0)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const includeArchived = ref(false)
const lastFailure = ref('')
const canRetry = ref(false)
let lastCall: (() => Promise<ActionResult>) | null = null

type DialogState = {
  visible: boolean
  title: string
  action: string
  confirmText: string
  reasonLabel: string
  placeholder: string
  reason: string
  row: EntryRow | null
  submitting: boolean
  error: string
  retryable: boolean
}

const dialog = reactive<DialogState>({
  visible: false,
  title: '',
  action: '',
  confirmText: '',
  reasonLabel: '',
  placeholder: '',
  reason: '',
  row: null,
  submitting: false,
  error: '',
  retryable: false,
})

const originalReason = computed(() =>
  dialog.row?.abnormalReason ? String(dialog.row.abnormalReason) : '',
)
const historyNotes = computed<ReviewNote[]>(() => dialog.row?.reviewHistory ?? [])

// 需要弹窗补充依据/结论的动作；其余动作（提交审核、发起复核、归档）直接执行。
const DIALOG_ACTIONS: Record<string, { title: string; confirmText: string; reasonLabel: string; placeholder: string }> = {
  确认通过: {
    title: '审核确认',
    confirmText: '确认通过',
    reasonLabel: '审核 / 复核结论',
    placeholder: '复核中记录必须填写复核结论；普通审核可留空由系统记录判定依据',
  },
  标记异常: {
    title: '标记异常值',
    confirmText: '标记异常',
    reasonLabel: '异常判定依据',
    placeholder: '可留空，系统将按当前水位与警戒水位自动生成判定依据',
  },
  维持异常: {
    title: '复核：维持异常',
    confirmText: '维持异常',
    reasonLabel: '复核意见（必填）',
    placeholder: '说明本次复核维持异常判定的依据',
  },
}

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  let overWarning = 0
  for (const row of rows.value) {
    const current = parseLevel(row['当前水位'])
    const warning = parseLevel(row['警戒水位'])
    if (current !== null && warning !== null && current >= warning) {
      overWarning += 1
    }
  }
  return [
    {
      label: '今日采集数',
      value: rows.value.filter((row) => String(row['观测时间']).startsWith(today)).length,
    },
    { label: '超警戒站次', value: overWarning },
    {
      label: '待审核记录',
      value: rows.value.filter((row) => {
        const status = String(row.status)
        return status === WL_STATUS.pendingReview || status === WL_STATUS.reviewing
      }).length,
    },
  ]
})

function resetFilters() {
  filters.value = {}
  includeArchived.value = false
  reload()
}

function exportRows() {
  downloadEntries(meta.key, includeArchived.value)
}

function openCreate() {
  lastFailure.value = '水位记录登记入口尚未接入审批流'
}

async function invoke(action: string, row: EntryRow, reason: string): Promise<ActionResult> {
  return submitWaterlevelAction(Number(row.id), action, {
    operator: session.operator,
    reason,
    expectedStatus: String(row.status),
  })
}

async function runAction(action: string, row: EntryRow) {
  lastFailure.value = ''
  canRetry.value = false

  const dialogMeta = DIALOG_ACTIONS[action]
  if (dialogMeta) {
    Object.assign(dialog, {
      visible: true,
      title: dialogMeta.title,
      action,
      confirmText: dialogMeta.confirmText,
      reasonLabel: dialogMeta.reasonLabel,
      placeholder: dialogMeta.placeholder,
      reason: '',
      row,
      submitting: false,
      error: '',
      retryable: false,
    })
    return
  }

  const call = () => invoke(action, row, '')
  lastCall = call
  await settle(call)
}

async function confirmDialog() {
  if (!dialog.row) {
    return
  }
  dialog.submitting = true
  dialog.error = ''
  const action = dialog.action
  const row = dialog.row
  const reason = dialog.reason
  const call = () => invoke(action, row, reason)
  lastCall = call
  const result = await call()
  dialog.submitting = false
  dialog.retryable = Boolean(result.retryable)
  if (result.ok) {
    dialog.visible = false
    reload()
  } else {
    dialog.error = result.retryable
      ? `${result.message}。可点击下方"重试本次操作"再试一次`
      : result.message
  }
}

async function settle(call: () => Promise<ActionResult>) {
  const result = await call()
  if (result.ok) {
    reload()
  } else {
    lastFailure.value = result.message
    canRetry.value = Boolean(result.retryable)
  }
}

async function retryLast() {
  if (!lastCall) {
    return
  }
  await settle(lastCall)
}

function closeDialog() {
  if (dialog.submitting) {
    return
  }
  dialog.visible = false
  dialog.row = null
  dialog.error = ''
  dialog.retryable = false
}

function reload() {
  lastFailure.value = ''
  canRetry.value = false
  try {
    const payload = listEntries(meta.key, filters.value, includeArchived.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    lastFailure.value = error instanceof Error ? error.message : '水位监测列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.foot-right {
  display: inline-flex;
  gap: 10px;
  align-items: center;
}
.retry-link {
  font-size: 12px;
}
.filter-check {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
.reason-tag {
  margin-left: 6px;
  font-size: 11px;
  color: #b54708;
  background: #fef3c7;
  border-radius: 999px;
  padding: 0 8px;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal {
  width: 560px;
  max-width: calc(100vw - 32px);
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  box-shadow: 0 18px 50px rgba(15, 23, 42, 0.25);
}
.modal-title {
  margin: 0 0 12px;
  font-size: 16px;
}
.modal-facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
  margin: 0 0 12px;
  font-size: 13px;
}
.modal-facts div {
  display: flex;
  gap: 8px;
}
.modal-facts dt {
  color: var(--muted);
  margin: 0;
}
.modal-facts dd {
  margin: 0;
}
.modal-basis {
  background: #fef7ed;
  border: 1px solid #fed7aa;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  margin-bottom: 12px;
}
.modal-basis span {
  color: #9a3412;
  font-weight: 600;
}
.modal-basis p {
  margin: 4px 0 0;
}
.history-list {
  margin: 6px 0 0;
  padding-left: 18px;
}
.dialog-field span {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
}
.dialog-field textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font: inherit;
  resize: vertical;
}
.dialog-error {
  margin: 8px 0 0;
  font-size: 12px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
</style>
