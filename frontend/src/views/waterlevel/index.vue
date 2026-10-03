<template>
  <section class="page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">维护水位记录，围绕记录编号、站点编号、观测时间、当前水位做登记、筛选与审核流转；异常只进复核或归档。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出水位监测清单</button>
        <button class="btn ghost" type="button" @click="simulateWriteFailure">模拟落库失败</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">今日采集数</span>
        <strong class="stat-value">{{ summary.collectedToday }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">超警戒站次</span>
        <strong class="stat-value" :class="{ 'warn-value': summary.overWarning > 0 }">{{ summary.overWarning }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">待审核记录</span>
        <strong class="stat-value">{{ summary.reviewing }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">异常 / 待复核</span>
        <strong class="stat-value" :class="{ 'warn-value': summary.abnormal + summary.rechecking > 0 }">
          {{ summary.abnormal }} / {{ summary.rechecking }}
        </strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已归档</span>
        <strong class="stat-value">{{ summary.archived }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <section v-if="todos.length" class="todo-panel">
      <h3 class="panel-title">待办（{{ todos.length }}）</h3>
      <ul class="todo-list">
        <li v-for="todo in todos" :key="todo.id" class="todo-item">
          <button class="link" type="button" @click="openTodo(todo.id)">{{ todo.recordNo }}</button>
          <span class="todo-status">{{ todo.status }}</span>
          <span class="todo-reason">{{ todo.reason }}</span>
        </li>
      </ul>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
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
            <span v-if="basisOf(row).exceedsWarning" class="warn-tag">越警戒</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsOf(row)"
              :key="action"
              class="link"
              type="button"
              :disabled="busyId === row.id"
              @click="openDialog(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无未归档水位记录</td>
        </tr>
      </tbody>
    </table>

    <section class="archive-panel">
      <h3 class="panel-title">归档清单（{{ archivedRows.length }}，不进入活跃列表与待办）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in columns" :key="column">{{ column }}</th>
            <th>当前状态</th>
            <th>归档依据</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in archivedRows" :key="String(row.id)">
            <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
            <td>{{ row.status }}</td>
            <td>{{ lastReason(row) }}</td>
          </tr>
          <tr v-if="!archivedRows.length">
            <td :colspan="columns.length + 2" class="empty-state">暂无归档记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <div v-if="dialog.open" class="modal-mask" @click.self="closeDialog">
      <div class="modal" role="dialog" aria-modal="true">
        <h3 class="modal-title">{{ dialog.action }} · {{ dialog.row?.['记录编号'] }}</h3>
        <dl class="basis-grid">
          <div><dt>当前水位</dt><dd>{{ dialog.row?.['当前水位'] ?? '—' }}</dd></div>
          <div><dt>警戒水位</dt><dd>{{ dialog.row?.['警戒水位'] ?? '—' }}</dd></div>
          <div><dt>保证水位</dt><dd>{{ dialog.row?.['保证水位'] ?? '—' }}</dd></div>
          <div><dt>当前状态</dt><dd>{{ dialog.row?.status }}</dd></div>
        </dl>
        <p class="basis-detail" :class="{ 'warn-value': dialogBasis.exceedsWarning || dialogBasis.level === null }">
          {{ dialogBasis.detail }}
        </p>

        <div v-if="dialog.action === '提交复核结果'" class="form-block">
          <span class="form-label">复核结论（暂无可复核结果时不能按正常值处理）</span>
          <label class="radio-line">
            <input v-model="recheckResult" type="radio" value="复核通过" />
            复核通过（恢复为正常值）
          </label>
          <label class="radio-line">
            <input v-model="recheckResult" type="radio" value="维持异常" />
            维持异常（回到异常值，只能再次复核或归档）
          </label>
        </div>

        <label class="form-block">
          <span class="form-label">处理说明（写入审核轨迹，原判定依据一并保留）</span>
          <textarea v-model="dialogReason" rows="3" placeholder="请填写本次处置说明"></textarea>
        </label>

        <p v-if="dialogBasis.exceedsWarning && dialog.action === '审核确认'" class="error-text">
          当前水位已越过警戒/保证水位，确认通过已被拦截，请改走异常流程。
        </p>
        <p v-if="dialogError" class="error-text">{{ dialogError }}</p>

        <div class="modal-actions">
          <button class="btn ghost" type="button" :disabled="submitting" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="confirmDialog">
            {{ submitting ? '提交中…' : '确认提交' }}
          </button>
        </div>
      </div>
    </div>

    <footer class="page-foot">
      <span>共 {{ total }} 条未归档水位记录，归档 {{ archivedRows.length }} 条</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, filterRows } from '@/api/local-service'
import { setFailNextWrite } from '@/data/local-store'
import {
  STATUS,
  judgeBasis,
  listArchivedWaterLevels,
  listWaterLevelTodos,
  listWaterLevels,
  statusCounts,
  submitWaterLevel,
  waterLevelSummary,
  type RecheckResult,
  type WaterLevelCommand,
  type WaterLevelRow,
} from '@/domains/waterlevel'

const columns = ['记录编号', '站点编号', '观测时间', '当前水位', '警戒水位', '保证水位', '水位变幅', '记录状态']
const filterFields = columns.slice(0, 3)

const rows = ref<WaterLevelRow[]>([])
const archivedRows = ref<WaterLevelRow[]>([])
const todos = ref(listWaterLevelTodos())
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const busyId = ref<number | null>(null)

const summary = computed(() => waterLevelSummary())
const statusSummary = computed(() => statusCounts())

const dialog = reactive<{ open: boolean; action: string; row: WaterLevelRow | null }>({
  open: false,
  action: '',
  row: null,
})
const dialogReason = ref('')
const recheckResult = ref<RecheckResult | ''>('')
const dialogError = ref('')
const submitting = ref(false)

const dialogBasis = computed(() => (dialog.row ? judgeBasis(dialog.row) : judgeBasis({})))

function basisOf(row: WaterLevelRow) {
  return judgeBasis(row)
}

// 按当前状态给出合法动作：异常记录只有「重新复核 / 归档」两个出口。
function actionsOf(row: WaterLevelRow): string[] {
  switch (String(row.status)) {
    case STATUS.collected:
      return ['提交审核']
    case STATUS.reviewing:
      return ['审核确认', '标记异常']
    case STATUS.abnormal:
      return ['发起复核', '归档']
    case STATUS.rechecking:
      return ['提交复核结果', '归档']
    case STATUS.passed:
    case STATUS.archived:
      return []
    default:
      return []
  }
}

function lastReason(row: WaterLevelRow): string {
  const trace = row.reviewTrace[row.reviewTrace.length - 1]
  return trace ? `${trace.verdict}：${trace.reason || trace.basis.detail}` : '—'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries('waterlevel')
}

function simulateWriteFailure() {
  setFailNextWrite(true)
  errorMessage.value = '已注入一次落库故障：下一次审核动作将失败，列表、汇总与待办应保持原样并可重试'
}

function openDialog(action: string, row: WaterLevelRow) {
  dialog.open = true
  dialog.action = action
  dialog.row = row
  dialogReason.value = ''
  recheckResult.value = ''
  dialogError.value = ''
}

function openTodo(id: number) {
  const row = rows.value.find((item) => item.id === id)
  if (!row) {
    return
  }
  const [action] = actionsOf(row)
  if (action) {
    openDialog(action, row)
  }
}

function closeDialog() {
  if (submitting.value) {
    return
  }
  dialog.open = false
  dialog.row = null
}

function buildCommand(): WaterLevelCommand | null {
  if (!dialog.row) {
    return null
  }
  const operator = '值班管理员'
  const reason = dialogReason.value.trim()
  switch (dialog.action) {
    case '提交审核':
      return { type: '提交审核', operator }
    case '审核确认':
      return { type: '审核确认', operator, reason }
    case '标记异常':
      return { type: '标记异常', operator, reason }
    case '发起复核':
      return { type: '发起复核', operator, reason }
    case '提交复核结果':
      if (!recheckResult.value) {
        dialogError.value = '请先取得复核结论；暂无可复核结果时不得按正常值处理'
        return null
      }
      return { type: '提交复核结果', operator, result: recheckResult.value, reason }
    case '归档':
      return { type: '归档', operator, reason }
    default:
      return null
  }
}

async function confirmDialog() {
  if (!dialog.row) {
    return
  }
  const command = buildCommand()
  if (!command) {
    return
  }
  dialogError.value = ''
  submitting.value = true
  busyId.value = dialog.row.id
  try {
    // 并发审核只落一次：动作进行中该行其它按钮禁用，服务层也有同记录在途闸。
    const result = await submitWaterLevel(dialog.row.id, command)
    if (!result.ok) {
      dialogError.value = result.message
      errorMessage.value = result.message
      return
    }
    dialog.open = false
    dialog.row = null
    reload()
  } finally {
    submitting.value = false
    busyId.value = null
  }
}

function reload() {
  errorMessage.value = ''
  // 列表、待办、汇总、归档清单同源读取；落库失败时它们一起停留在旧快照。
  const active = listWaterLevels()
  rows.value = filterRows(active, filters.value) as WaterLevelRow[]
  total.value = rows.value.length
  archivedRows.value = listArchivedWaterLevels()
  todos.value = listWaterLevelTodos()
}

onMounted(reload)
</script>

<style scoped>
.warn-value {
  color: #b42318;
}
.warn-tag {
  margin-left: 6px;
  background: #fef3f2;
  color: #b42318;
  border-radius: 999px;
  padding: 0 8px;
  font-size: 12px;
}
.todo-panel,
.archive-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.panel-title {
  margin: 0 0 8px;
  font-size: 14px;
}
.todo-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.todo-item {
  display: flex;
  gap: 10px;
  font-size: 13px;
  align-items: baseline;
}
.todo-status {
  color: var(--brand);
}
.todo-reason {
  color: var(--muted);
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal {
  background: #fff;
  border-radius: 10px;
  width: 520px;
  max-width: calc(100vw - 32px);
  padding: 18px 20px;
}
.modal-title {
  margin: 0 0 12px;
  font-size: 16px;
}
.basis-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 16px;
  margin: 0 0 8px;
}
.basis-grid dt {
  font-size: 12px;
  color: var(--muted);
}
.basis-grid dd {
  margin: 2px 0 0;
  font-size: 14px;
}
.basis-detail {
  margin: 0 0 12px;
  font-size: 13px;
}
.form-block {
  display: block;
  margin-bottom: 12px;
}
.form-label {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
}
.form-block textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px;
  font: inherit;
}
.radio-line {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 13px;
  margin-bottom: 4px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
