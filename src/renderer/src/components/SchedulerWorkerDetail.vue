<script setup lang="ts">
/**
 * Detail pane for the selected worker (T295 Tasks 10-11) — Runs and Settings
 * tabs. Anatomy per `docs/specs/2026-09-07-scheduler-takeover/spec.html`,
 * `data-dsqa` roots `worker-detail-runs`, `worker-detail-settings`,
 * `worker-detail-settings--act`, `worker-delete-confirm`.
 *
 * Editing is inline write-through: every field calls `scheduler.save(id,
 * patch)` directly (300ms debounce, lives in the store — see Task 6), never a
 * local draft + Save button, matching Endpoints/Push/Hibernation panes.
 *
 * AC-6 (the clipping trap): the scroll column is a flex column, so every
 * DIRECT child of it carries `flex-none` — a child left to shrink would
 * silently clip its own body text instead of letting the column scroll.
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Play,
  Square,
  Trash2,
  Clock,
  ListChecks,
  TriangleAlert,
  ChevronRight,
  X as XIcon
} from 'lucide-vue-next'
import { useSchedulerStore } from '../stores/scheduler'
import { useSessionsStore } from '../stores/sessions'
import { relativeTime } from '../composables/useRelativeTime'
import { formatCost, formatDuration } from './scheduler-format'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import SettingHint from './ui/SettingHint.vue'
import FolderCombobox from './ui/FolderCombobox.vue'
import SchedulerPromptField from './SchedulerPromptField.vue'
import MarkdownRenderer from './MarkdownRenderer.vue'
import type { AvailableSkill, Effort, NotifyOn, Run, RunStatus, Worker } from '../../../preload'

const props = defineProps<{
  worker: Worker
  running: boolean
  runningSinceMs?: number
  nowMs: number
}>()

const { t } = useI18n()
const scheduler = useSchedulerStore()
const sessions = useSessionsStore()

const activeTab = ref<'runs' | 'settings'>('runs')
const showDeleteConfirm = ref(false)
const showAdvanced = ref(false)
const nameInputRef = ref<HTMLInputElement | null>(null)

/**
 * T311 — the run-result prose block (`design.md` §6 — Scheduler worker detail).
 * ONE class list, used verbatim by BOTH surfaces that show `Run.result` (the
 * LAST RESULT card and the run-row disclosure), because they show the same
 * field a few pixels apart and used to disagree: the card collapsed every
 * newline, the disclosure kept them but printed `##` and table pipes raw.
 *
 * `overflow-auto` is load-bearing on both axes. Vertically it clamps a long
 * report (a scroll container, so the Runs tab is never pushed off screen);
 * horizontally it is what stops a markdown TABLE inside the disclosure — which
 * nests a `<table>` in the runs `<table>` — from widening the whole panel: a
 * scroll container's min-content contribution in its scrolling axis is zero, so
 * the outer table can still shrink to the column.
 */
const RESULT_PROSE_CLASS = 'result-prose scrollable max-h-[220px] overflow-auto'

watch(
  () => props.worker.id,
  () => {
    showDeleteConfirm.value = false
    showAdvanced.value = Boolean(props.worker.systemPrompt)
    void scheduler.loadRuns(props.worker.id)
  },
  { immediate: true }
)

onMounted(() => {
  void loadSkillsCatalog()
})

/** Switch to Settings and focus the name field — used right after "New worker". */
function openSettingsAndFocusName(): void {
  activeTab.value = 'settings'
  void nextTick().then(() => nameInputRef.value?.focus())
}
defineExpose({ openSettingsAndFocusName })

// ── write-through field helper ──────────────────────────────────────────────
// One computed-with-setter per field: reads the store's own echo (never a
// local draft), writes through `scheduler.save`'s 300ms debounce (AC-7).
function field<K extends keyof Worker>(key: K): ReturnType<typeof computed<Worker[K]>> {
  return computed<Worker[K]>({
    get: () => props.worker[key],
    set: (v) => scheduler.save(props.worker.id, { [key]: v } as Partial<Worker>)
  })
}
const nameField = field('name')
const folderField = field('folder')
const promptField = field('prompt')
const runOnBootField = field('runOnBoot')
const carryLastResultField = field('carryLastResult')
const modelField = field('model')
const effortField = field('effort')
const modeField = field('mode')
/**
 * T304. Written as a plain `field`, not an `allowDefault` tri-state: `silent`
 * IS the default, so it is one of the three real options rather than a fourth
 * neutral pill. A worker persisted before this field resolves to `silent` in
 * main (`resolveNotifyOn`), so the getter never has to guess.
 */
const notifyOnField = field('notifyOn')
const systemPromptField = field('systemPrompt')

function onEnabledChange(v: boolean): void {
  scheduler.save(props.worker.id, { enabled: v })
}

function onEveryMinutesChange(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(raw) || raw <= 0) return
  scheduler.save(props.worker.id, { everyMinutes: Math.round(raw) })
}

function onTimeoutChange(e: Event): void {
  const raw = Number((e.target as HTMLInputElement).value)
  if (!Number.isFinite(raw) || raw <= 0) return
  scheduler.save(props.worker.id, { timeoutSeconds: Math.round(raw) })
}

// ── run/stop ─────────────────────────────────────────────────────────────
function onRunNow(): void {
  void scheduler.runNow(props.worker.id)
}
function onStop(): void {
  void scheduler.stop(props.worker.id)
}

// ── delete ───────────────────────────────────────────────────────────────
async function onConfirmDelete(): Promise<void> {
  await scheduler.remove(props.worker.id)
}

// ── folder: "choose another folder" (existing native-dialog + adopt path) ──
async function onChooseAnotherFolder(): Promise<void> {
  const { path } = await window.api.dialogOpenDirectory()
  if (!path) return
  const alias =
    path
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? path
  try {
    await window.api.userProjectsAdd({
      path,
      alias,
      addedAt: new Date().toISOString(),
      worktrees: []
    })
    await sessions.reloadModel()
  } catch {
    // Best-effort — the worker still points at the chosen path even if the
    // sidebar pin failed; the user can re-add it from Settings later.
  }
  scheduler.save(props.worker.id, { folder: path })
}

// ── folder → bundled-skills warning (AC-10) ─────────────────────────────────
// Merges the folder's own overrides with the global defaults the same way
// `stageSkillsForFolder` (src/main/bundled-skills.ts) resolves a tick's
// staged set — a folder-flags-only check would false-positive on a folder
// that inherits a globally-enabled skill with no override of its own.
const skillCatalogNames = ref<string[]>([])
const globalSkillFlags = ref<Record<string, boolean>>({})
const folderSkillFlags = ref<Record<string, boolean>>({})
const skillsKnown = ref(false)

async function loadSkillsCatalog(): Promise<void> {
  try {
    const view = await window.api.bundledSkillsGet()
    skillCatalogNames.value = view.catalog.map((s) => s.name)
    globalSkillFlags.value = view.enabled
    skillsKnown.value = true
  } catch {
    skillsKnown.value = false
  }
}

/**
 * Everything the worker's folder could stage (T305) — bundled ∪ personal ∪
 * project, each tagged with its origin. FOLDER-DEPENDENT: a project skill lives
 * in `<folder>/.claude/skills/`, so the whole union is re-read whenever the
 * Folder field changes, alongside the folder's bundled-skill flags.
 */
const availableSkills = ref<AvailableSkill[]>([])

watch(
  () => props.worker.folder,
  async (folder) => {
    if (!folder) {
      folderSkillFlags.value = {}
      availableSkills.value = []
      return
    }
    try {
      folderSkillFlags.value = await window.api.bundledSkillsGetFolder(folder)
    } catch {
      folderSkillFlags.value = {}
    }
    try {
      availableSkills.value = await window.api.skillsAvailable(folder)
    } catch {
      availableSkills.value = []
    }
  },
  { immediate: true }
)

const folderHasNoSkillEnabled = computed(() => {
  if (!skillsKnown.value || !props.worker.folder || skillCatalogNames.value.length === 0)
    return false
  return !skillCatalogNames.value.some(
    (name) => folderSkillFlags.value[name] ?? globalSkillFlags.value[name] === true
  )
})

// ── extra read commands (observe-only tag field) ────────────────────────────
// Mirrors `isReadCommandRule` in src/main/scheduler-core.ts (a Bash(...) rule
// and nothing else) — duplicated here because that module is main-only per
// the process-boundary rule; the renderer never imports across it.
const READ_COMMAND_RULE = /^Bash\([^)]+\)$/
const newCommandDraft = ref('')

function addExtraReadCommand(): void {
  const value = newCommandDraft.value.trim()
  if (!READ_COMMAND_RULE.test(value)) return
  const next = [...(props.worker.extraReadCommands ?? []), value]
  scheduler.save(props.worker.id, { extraReadCommands: next })
  newCommandDraft.value = ''
}
function removeExtraReadCommand(index: number): void {
  const next = (props.worker.extraReadCommands ?? []).filter((_, i) => i !== index)
  scheduler.save(props.worker.id, { extraReadCommands: next })
}

// ── header badges ────────────────────────────────────────────────────────
const modeBadgeClass = computed(() =>
  props.worker.mode === 'act'
    ? 'bg-red-soft border-red-line text-red'
    : 'bg-accent-soft border-accent-line text-accent'
)

// ── runs tab ─────────────────────────────────────────────────────────────
const runs = computed<Run[]>(() => scheduler.runsByWorker[props.worker.id] ?? [])
const lastRun = computed<Run | undefined>(() => runs.value[runs.value.length - 1])
/** Newest first — the store/JSONL order is chronological (oldest first). */
const orderedRuns = computed<Run[]>(() => [...runs.value].reverse())
const elapsedMs = computed(() => Math.max(0, props.nowMs - (props.runningSinceMs ?? props.nowMs)))

function formatTimeOfDay(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const STATUS_TEXT_CLASS: Record<RunStatus, string> = {
  ok: 'text-text-2',
  error: 'text-red',
  timeout: 'text-red',
  skipped: 'text-text-4',
  stopped: 'text-text-4'
}

/**
 * T303 — which run's detail is open, keyed by `startedAt` (unique per worker:
 * a worker never overlaps itself, so no two of its runs share a start).
 *
 * ONE at a time. The stored history is 200 runs deep and every one of them
 * carries its full `result`, `terminalReason` and `denials` — the table showed
 * five numbers of that and the newest result, so 199 results were persisted and
 * unreachable. Opening a second row closes the first because this is a reading
 * surface: two open bodies at 12px/1.55 push the row you were comparing against
 * off-screen anyway.
 */
const expandedRunAt = ref<number | null>(null)

function toggleRun(r: Run): void {
  expandedRunAt.value = expandedRunAt.value === r.startedAt ? null : r.startedAt
}

/** Selecting another worker must not carry the open row into its history. */
watch(
  () => props.worker.id,
  () => {
    expandedRunAt.value = null
  }
)

/** Runs with nothing to show (never actually executed) render every numeric column as an em-dash. */
function runCells(r: Run): { turns: string; cost: string; duration: string } {
  if (r.status === 'skipped' || r.status === 'stopped') {
    return { turns: '—', cost: '—', duration: '—' }
  }
  return {
    turns: r.numTurns > 0 ? String(r.numTurns) : '—',
    cost: formatCost(r.costUsd),
    duration: formatDuration(r.durationMs)
  }
}

const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku', 'fable'].map((v) => ({
  value: v,
  label: v,
  mono: true
}))
const EFFORT_OPTIONS: { value: Effort; label: string }[] = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' }
]
const NOTIFY_OPTIONS = computed<{ value: NotifyOn; label: string }[]>(() => [
  { value: 'silent', label: t('scheduler.settings.notifySilent') },
  { value: 'failure', label: t('scheduler.settings.notifyFailure') },
  { value: 'every', label: t('scheduler.settings.notifyEvery') }
])
</script>

<template>
  <div class="flex h-full min-w-0 flex-1 flex-col bg-bg">
    <div class="flex flex-none flex-col gap-2 px-3.5 pt-3">
      <div class="flex items-center gap-2">
        <span class="truncate text-[13px] font-semibold text-text">
          {{ worker.name || t('scheduler.settings.namePlaceholder') }}
        </span>
        <span
          class="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px]"
          :class="modeBadgeClass"
        >
          {{
            worker.mode === 'act'
              ? t('scheduler.settings.modeAct')
              : t('scheduler.settings.modeObserve')
          }}
        </span>
        <span
          class="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-text-3"
        >
          {{ worker.model }} · {{ worker.effort }}
        </span>
        <span class="flex-1" />
        <button
          v-if="!running"
          type="button"
          class="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm border border-border bg-surface px-2.5 text-[11.5px] font-medium text-text transition hover:bg-surface-2"
          @click="onRunNow"
        >
          <Play :size="11" :stroke-width="1.6" />
          {{ t('scheduler.detail.runNow') }}
        </button>
        <button
          v-else
          type="button"
          class="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm border border-red-line bg-transparent px-2.5 text-[11.5px] font-medium text-red transition hover:bg-red-soft"
          @click="onStop"
        >
          <Square :size="11" :stroke-width="1.6" />
          {{ t('scheduler.detail.stop') }}
        </button>
        <ToggleSwitch
          :model-value="worker.enabled"
          :aria-label="worker.name"
          @update:model-value="onEnabledChange"
        />
      </div>
      <div class="flex gap-3.5 border-b border-border">
        <button
          type="button"
          class="-mb-px border-b pb-1.5 text-[12px] transition"
          :class="
            activeTab === 'runs'
              ? 'border-accent text-text'
              : 'border-transparent text-text-3 hover:text-text-2'
          "
          @click="activeTab = 'runs'"
        >
          {{ t('scheduler.tabs.runs') }}
        </button>
        <button
          type="button"
          class="-mb-px border-b pb-1.5 text-[12px] transition"
          :class="
            activeTab === 'settings'
              ? 'border-accent text-text'
              : 'border-transparent text-text-3 hover:text-text-2'
          "
          @click="activeTab = 'settings'"
        >
          {{ t('scheduler.tabs.settings') }}
        </button>
      </div>
    </div>

    <!-- ══════════════════════════ RUNS TAB ══════════════════════════ -->
    <div
      v-if="activeTab === 'runs'"
      class="scrollable flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 pb-4 pt-3"
      data-dsqa="worker-detail-runs"
    >
      <div
        v-if="running"
        class="flex flex-none items-center gap-[7px] rounded-[7px] border border-green-line bg-green-soft px-2.5 py-2 text-[11.5px] text-green"
      >
        <span class="anim-pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-green" />
        <span>{{
          t('scheduler.detail.runningNow', {
            started: formatDuration(elapsedMs),
            timeout: formatDuration(worker.timeoutSeconds * 1000)
          })
        }}</span>
        <span class="flex-1" />
        <button
          type="button"
          class="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-sm border border-red-line bg-transparent px-2.5 text-[11.5px] font-medium text-red transition hover:bg-red-soft"
          @click="onStop"
        >
          <Square :size="11" :stroke-width="1.6" />
          {{ t('scheduler.detail.stop') }}
        </button>
      </div>

      <div
        v-if="lastRun"
        class="flex-none overflow-hidden rounded-[7px] border border-border bg-surface"
      >
        <div
          class="flex items-center gap-1.5 border-b border-border px-2.5 py-2 text-[11px] uppercase tracking-wide text-text-3"
        >
          <ListChecks :size="12" :stroke-width="1.6" />
          {{
            t('scheduler.detail.lastResult', {
              ago: relativeTime(new Date(lastRun.startedAt).toISOString())
            })
          }}
        </div>
        <div class="px-2.5 py-2.5" data-dsqa="last-result-body">
          <div
            v-if="lastRun.result.trim()"
            :class="RESULT_PROSE_CLASS"
            data-dsqa="run-result-prose"
          >
            <MarkdownRenderer :source="lastRun.result" />
          </div>
          <div v-else class="text-[11.5px] leading-[1.5] text-text-4">
            {{ t('scheduler.detail.runDetail.noResult') }}
          </div>
        </div>
      </div>

      <div class="flex-none overflow-hidden rounded-[7px] border border-border bg-surface">
        <div
          class="flex items-center gap-1.5 border-b border-border px-2.5 py-2 text-[11px] uppercase tracking-wide text-text-3"
        >
          <Clock :size="12" :stroke-width="1.6" />
          {{ t('scheduler.detail.recentRuns') }}
        </div>
        <div
          v-if="orderedRuns.length === 0 && !running"
          class="px-2.5 py-4 text-center text-[12px] text-text-3"
        >
          {{ t('scheduler.detail.noRuns') }}
        </div>
        <table v-else class="w-full border-collapse text-[11.5px]">
          <thead>
            <tr>
              <th
                class="border-b border-border bg-surface px-2 py-1.5 text-left text-[11px] uppercase tracking-wide text-text-3"
              >
                {{ t('scheduler.detail.table.time') }}
              </th>
              <th
                class="border-b border-border bg-surface px-2 py-1.5 text-left text-[11px] uppercase tracking-wide text-text-3"
              >
                {{ t('scheduler.detail.table.status') }}
              </th>
              <th
                class="border-b border-border bg-surface px-2 py-1.5 text-right text-[11px] uppercase tracking-wide text-text-3"
              >
                {{ t('scheduler.detail.table.turns') }}
              </th>
              <th
                class="border-b border-border bg-surface px-2 py-1.5 text-right text-[11px] uppercase tracking-wide text-text-3"
              >
                {{ t('scheduler.detail.table.cost') }}
              </th>
              <th
                class="border-b border-border bg-surface px-2 py-1.5 text-right text-[11px] uppercase tracking-wide text-text-3"
              >
                {{ t('scheduler.detail.table.duration') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="running">
              <td class="border-b border-border px-2 py-1.5 text-text-2">
                {{ formatTimeOfDay(runningSinceMs ?? nowMs) }}
              </td>
              <td class="border-b border-border px-2 py-1.5">
                <span class="inline-flex items-center gap-1.5 text-green">
                  <span class="anim-pulse-dot h-1.5 w-1.5 shrink-0 rounded-full bg-green" />
                  {{ t('scheduler.detail.status.running') }}
                </span>
              </td>
              <td class="border-b border-border px-2 py-1.5 text-right tabular-nums text-text-3">
                —
              </td>
              <td class="border-b border-border px-2 py-1.5 text-right tabular-nums text-text-3">
                —
              </td>
              <td class="border-b border-border px-2 py-1.5 text-right tabular-nums text-text-3">
                {{ formatDuration(elapsedMs) }}
              </td>
            </tr>
            <template v-for="r in orderedRuns" :key="r.startedAt">
              <!--
                T306 — the row keeps its TABLE semantics (`role="row"`, so its
                cells keep a row ancestor and a screen reader announces "row 3
                of 12", not "button"); the disclosure control is a real
                `<button>` inside the Time cell, carrying `aria-expanded` and
                `aria-controls`. The whole row stays clickable for the mouse —
                that is the affordance `design.md` specifies — but the pointer
                convenience is no longer what defines the control.
              -->
              <tr
                role="row"
                class="cursor-pointer transition hover:bg-surface-2"
                data-dsqa="run-row"
                @click="toggleRun(r)"
              >
                <td class="border-b border-border px-2 py-1.5 text-text-2">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 text-left"
                    :aria-expanded="expandedRunAt === r.startedAt"
                    :aria-controls="`run-detail-${r.startedAt}`"
                    :aria-label="
                      t('scheduler.detail.openRun', { time: formatTimeOfDay(r.startedAt) })
                    "
                    data-dsqa="run-row-toggle"
                    @click.stop="toggleRun(r)"
                  >
                    <ChevronRight
                      :size="10"
                      :stroke-width="1.8"
                      class="shrink-0 text-text-4 transition-transform"
                      :class="expandedRunAt === r.startedAt ? 'rotate-90' : ''"
                    />
                    {{ formatTimeOfDay(r.startedAt) }}
                  </button>
                </td>
                <td class="border-b border-border px-2 py-1.5">
                  <span :class="STATUS_TEXT_CLASS[r.status]">{{
                    t(`scheduler.detail.status.${r.status}`)
                  }}</span>
                </td>
                <td class="border-b border-border px-2 py-1.5 text-right tabular-nums text-text-3">
                  {{ runCells(r).turns }}
                </td>
                <td class="border-b border-border px-2 py-1.5 text-right tabular-nums text-text-3">
                  {{ runCells(r).cost }}
                </td>
                <td class="border-b border-border px-2 py-1.5 text-right tabular-nums text-text-3">
                  {{ runCells(r).duration }}
                </td>
              </tr>
              <tr
                v-if="expandedRunAt === r.startedAt"
                :id="`run-detail-${r.startedAt}`"
                data-dsqa="run-detail"
              >
                <td colspan="5" class="border-b border-border bg-surface-2 p-2.5">
                  <div class="run-detail-body flex flex-col gap-2">
                    <div
                      v-if="r.result.trim()"
                      :class="RESULT_PROSE_CLASS"
                      data-dsqa="run-result-prose"
                    >
                      <MarkdownRenderer :source="r.result" />
                    </div>
                    <div v-else class="text-[11.5px] leading-[1.5] text-text-4">
                      {{ t('scheduler.detail.runDetail.noResult') }}
                    </div>
                    <div v-if="r.terminalReason" class="text-[11px] text-text-4">
                      {{ t('scheduler.detail.runDetail.ended', { reason: r.terminalReason }) }}
                    </div>
                    <div v-if="r.denials.length > 0" class="flex flex-col gap-1.5">
                      <div class="text-[11px] uppercase tracking-wide text-text-3">
                        {{ t('scheduler.detail.triedAndCouldnt') }}
                      </div>
                      <div class="flex flex-wrap gap-1.5">
                        <span
                          v-for="d in r.denials"
                          :key="d"
                          class="inline-flex items-center rounded-full border border-border-2 bg-surface px-2 py-0.5 font-mono text-[11px] text-text-2"
                        >
                          {{ d }}
                        </span>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <div
        v-if="lastRun && lastRun.denials.length > 0"
        class="flex-none overflow-hidden rounded-[7px] border border-border bg-surface"
      >
        <div
          class="flex items-center gap-1.5 border-b border-border px-2.5 py-2 text-[11px] uppercase tracking-wide text-text-3"
        >
          <TriangleAlert :size="12" :stroke-width="1.6" />
          {{ t('scheduler.detail.triedAndCouldnt') }}
        </div>
        <div class="flex flex-wrap gap-1.5 p-2.5">
          <span
            v-for="d in lastRun.denials"
            :key="d"
            class="inline-flex items-center rounded-full border border-border-2 bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-text-2"
          >
            {{ d }}
          </span>
        </div>
        <div class="px-2.5 pb-2.5 text-[11px] leading-[1.5] text-text-4">
          <i18n-t keypath="scheduler.detail.deniedHint" scope="global">
            <template #act
              ><b class="text-text-2">{{ t('scheduler.settings.modeAct') }}</b></template
            >
          </i18n-t>
        </div>
      </div>
    </div>

    <!-- ══════════════════════════ SETTINGS TAB ══════════════════════════ -->
    <div
      v-else
      class="scrollable flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3.5 pb-4 pt-3"
      :data-dsqa="worker.mode === 'act' ? 'worker-detail-settings--act' : 'worker-detail-settings'"
    >
      <div class="flex-none">
        <div class="mb-2.5 text-[11px] uppercase tracking-wide text-text-3">
          {{ t('scheduler.settings.identity') }}
        </div>
        <div class="flex flex-col gap-2.5">
          <div class="flex items-start gap-3">
            <div class="w-[132px] flex-none pt-2 text-[12px] text-text-2">
              {{ t('scheduler.settings.name') }}
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <input
                ref="nameInputRef"
                v-model="nameField"
                type="text"
                class="h-8 rounded-sm border border-border-2 bg-surface px-2.5 text-[12px] text-text"
                :placeholder="t('scheduler.settings.namePlaceholder')"
              />
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-[132px] flex-none pt-2 text-[12px] text-text-2">
              {{ t('scheduler.settings.folder') }}
              <SettingHint>{{ t('scheduler.settings.folderHint') }}</SettingHint>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <FolderCombobox
                v-model="folderField"
                :folders="sessions.folders"
                :placeholder="t('scheduler.folderCombobox.placeholder')"
                :search-placeholder="t('scheduler.folderCombobox.searchPlaceholder')"
                :no-match-label="t('scheduler.folderCombobox.noMatch')"
                :choose-another-label="t('scheduler.folderCombobox.chooseAnother')"
                @choose-folder="onChooseAnotherFolder"
              />
              <p
                v-if="folderHasNoSkillEnabled"
                class="flex items-start gap-1.5 text-[11px] leading-[1.5] text-warning"
              >
                <TriangleAlert :size="12" :stroke-width="1.7" class="mt-[1px] shrink-0" />
                {{ t('scheduler.settings.folderNoSkillsWarning') }}
              </p>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-[132px] flex-none pt-2 text-[12px] text-text-2">
              {{ t('scheduler.settings.prompt') }}
              <SettingHint>{{ t('scheduler.settings.promptHint') }}</SettingHint>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <SchedulerPromptField
                v-model="promptField"
                :skills="availableSkills"
                :placeholder="t('scheduler.settings.promptPlaceholder')"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="h-px flex-none bg-border" />

      <div class="flex-none">
        <div class="mb-2.5 text-[11px] uppercase tracking-wide text-text-3">
          {{ t('scheduler.settings.schedule') }}
        </div>
        <div class="flex flex-col gap-2.5">
          <div class="flex items-start gap-3">
            <div class="w-[132px] flex-none pt-2 text-[12px] text-text-2">
              {{ t('scheduler.settings.every') }}
            </div>
            <div class="flex min-w-0 flex-1 items-center gap-2">
              <input
                type="number"
                min="1"
                class="h-8 w-[84px] rounded-sm border border-border-2 bg-surface px-2.5 text-[12px] text-text"
                :value="worker.everyMinutes"
                @change="onEveryMinutesChange"
              />
              <span class="text-[12px] text-text-3">{{ t('scheduler.settings.everyUnit') }}</span>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-[132px] flex-none pt-2 text-[12px] text-text-2">
              {{ t('scheduler.settings.runOnBoot') }}
              <SettingHint>{{ t('scheduler.settings.runOnBootHint') }}</SettingHint>
            </div>
            <div class="flex min-w-0 flex-1 items-center">
              <ToggleSwitch
                v-model="runOnBootField"
                :aria-label="t('scheduler.settings.runOnBoot')"
              />
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-[132px] flex-none pt-2 text-[12px] text-text-2">
              {{ t('scheduler.settings.carryLastResult') }}
              <SettingHint>{{ t('scheduler.settings.carryLastResultHint') }}</SettingHint>
            </div>
            <div class="flex min-w-0 flex-1 items-center">
              <ToggleSwitch
                v-model="carryLastResultField"
                :aria-label="t('scheduler.settings.carryLastResult')"
              />
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-[132px] flex-none pt-2 text-[12px] text-text-2">
              {{ t('scheduler.settings.notify') }}
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <SegmentedControl
                v-model="notifyOnField"
                :options="NOTIFY_OPTIONS"
                size="sm"
                :aria-label="t('scheduler.settings.notify')"
              />
              <p class="text-[11px] leading-[1.5] text-text-4">
                {{ t('scheduler.settings.notifyHint') }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div class="h-px flex-none bg-border" />

      <div class="flex-none">
        <div class="mb-2.5 text-[11px] uppercase tracking-wide text-text-3">
          {{ t('scheduler.settings.execution') }}
        </div>
        <div class="flex flex-col gap-2.5">
          <div class="flex items-start gap-3">
            <div class="w-[132px] flex-none pt-2 text-[12px] text-text-2">
              {{ t('scheduler.settings.model') }}
            </div>
            <div class="flex min-w-0 flex-1 items-center">
              <SegmentedControl v-model="modelField" :options="MODEL_OPTIONS" size="sm" />
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-[132px] flex-none pt-2 text-[12px] text-text-2">
              {{ t('scheduler.settings.effort') }}
            </div>
            <div class="flex min-w-0 flex-1 items-center">
              <SegmentedControl v-model="effortField" :options="EFFORT_OPTIONS" size="sm" />
            </div>
          </div>
          <div class="flex items-start gap-3">
            <div class="w-[132px] flex-none pt-2 text-[12px] text-text-2">
              {{ t('scheduler.settings.timeout') }}
            </div>
            <div class="flex min-w-0 flex-1 items-center gap-2">
              <input
                type="number"
                min="1"
                class="h-8 w-[84px] rounded-sm border border-border-2 bg-surface px-2.5 text-[12px] text-text"
                :value="worker.timeoutSeconds"
                @change="onTimeoutChange"
              />
              <span class="text-[12px] text-text-3">{{ t('scheduler.settings.timeoutUnit') }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="h-px flex-none bg-border" />

      <div class="flex-none">
        <div class="mb-2.5 text-[11px] uppercase tracking-wide text-text-3">
          {{ t('scheduler.settings.permission') }}
        </div>
        <div class="flex flex-col gap-2.5">
          <div class="flex items-start gap-3">
            <div class="w-[132px] flex-none pt-2 text-[12px] text-text-2">
              {{ t('scheduler.settings.mode') }}
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-2">
              <SegmentedControl
                v-model="modeField"
                :options="[
                  { value: 'observe', label: t('scheduler.settings.modeObserve') },
                  { value: 'act', label: t('scheduler.settings.modeAct'), danger: true }
                ]"
                size="sm"
              />
              <p v-if="worker.mode === 'observe'" class="text-[11px] leading-[1.5] text-text-4">
                {{ t('scheduler.settings.modeObserveHint') }}
              </p>
              <div
                v-else
                class="flex gap-2 rounded-sm border border-red-line bg-red-soft px-2.5 py-2.5 text-[11.5px] leading-[1.5] text-text-2"
              >
                <TriangleAlert :size="13" :stroke-width="1.7" class="mt-[1px] shrink-0 text-red" />
                <span>
                  <b class="font-semibold text-red">{{
                    t('scheduler.settings.modeActWarningLead', { n: worker.everyMinutes })
                  }}</b>
                  {{ t('scheduler.settings.modeActWarningRest') }}
                </span>
              </div>
            </div>
          </div>
          <div v-if="worker.mode === 'observe'" class="flex items-start gap-3">
            <div class="w-[132px] flex-none pt-2 text-[12px] text-text-2">
              {{ t('scheduler.settings.extraReadCommands') }}
              <SettingHint>{{ t('scheduler.settings.extraReadCommandsHint') }}</SettingHint>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <div
                class="flex min-h-8 flex-wrap items-center gap-1.5 rounded-sm border border-border-2 bg-surface px-2 py-1.5"
              >
                <span
                  v-for="(cmd, i) in worker.extraReadCommands ?? []"
                  :key="cmd"
                  class="inline-flex items-center gap-1 rounded-full border border-border-2 bg-surface-2 py-0.5 pl-2 pr-1 font-mono text-[11px] text-text-2"
                >
                  {{ cmd }}
                  <button
                    type="button"
                    class="flex items-center text-text-4 transition hover:text-text"
                    :aria-label="t('scheduler.row.delete')"
                    @click="removeExtraReadCommand(i)"
                  >
                    <XIcon :size="11" :stroke-width="1.8" />
                  </button>
                </span>
                <input
                  v-model="newCommandDraft"
                  type="text"
                  class="h-5 min-w-[110px] flex-1 border-0 bg-transparent text-[12px] text-text outline-none"
                  :placeholder="t('scheduler.settings.extraReadCommandsPlaceholder')"
                  @keydown.enter.prevent="addExtraReadCommand"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="h-px flex-none bg-border" />

      <div class="flex-none">
        <button
          type="button"
          class="flex items-center gap-1 text-[11.5px] text-text-3 transition hover:text-text-2"
          @click="showAdvanced = !showAdvanced"
        >
          <ChevronRight
            :size="12"
            :stroke-width="1.8"
            :class="showAdvanced ? 'rotate-90' : ''"
            class="transition-transform"
          />
          {{ t('scheduler.settings.advanced') }}
        </button>
        <div v-if="showAdvanced" class="mt-2.5 flex items-start gap-3">
          <div class="w-[132px] flex-none pt-2 text-[12px] text-text-2">
            {{ t('scheduler.settings.systemPrompt') }}
            <SettingHint>{{ t('scheduler.settings.systemPromptHint') }}</SettingHint>
          </div>
          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <textarea
              v-model="systemPromptField"
              rows="3"
              class="w-full resize-y rounded-sm border border-border-2 bg-surface px-2.5 py-2 text-[12px] leading-[1.55] text-text"
            />
          </div>
        </div>
      </div>

      <div class="h-px flex-none bg-border" />

      <div class="flex-none">
        <button
          v-if="!showDeleteConfirm"
          type="button"
          class="inline-flex h-6 items-center gap-1.5 rounded-sm border border-red-line bg-transparent px-2.5 text-[11.5px] font-medium text-red transition hover:bg-red-soft"
          @click="showDeleteConfirm = true"
        >
          <Trash2 :size="11" :stroke-width="1.6" />
          {{ t('scheduler.settings.deleteWorker') }}
        </button>
        <div
          v-else
          class="flex flex-col gap-2.5 rounded-[7px] border border-red-line bg-red-soft p-3"
          data-dsqa="worker-delete-confirm"
        >
          <div class="text-[12px] font-medium text-text">
            {{
              t('scheduler.delete.title', {
                name: worker.name || t('scheduler.settings.namePlaceholder')
              })
            }}
          </div>
          <div class="text-[11.5px] leading-[1.5] text-text-2">
            {{ t('scheduler.delete.body', { n: runs.length }) }}
          </div>
          <div class="flex gap-1.5">
            <button
              type="button"
              class="inline-flex h-6 items-center gap-1.5 rounded-sm bg-red px-2.5 text-[11.5px] font-medium text-accent-ink transition hover:opacity-90"
              @click="onConfirmDelete"
            >
              {{ t('scheduler.delete.confirm') }}
            </button>
            <button
              type="button"
              class="inline-flex h-6 items-center gap-1.5 rounded-sm px-2.5 text-[11.5px] font-medium text-text-2 transition hover:bg-surface-2"
              @click="showDeleteConfirm = false"
            >
              {{ t('scheduler.delete.cancel') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/**
 * A run's `result` is whatever the model wrote — often markdown, but just as
 * often a stack trace, a JSON blob, or a bare sentence. markdown-it runs with
 * `breaks: false` (the seam's setting, shared with six other consumers and not
 * ours to change), so a paragraph's own newlines survive into the HTML but
 * collapse to spaces at render time — which turns a stack trace into one
 * run-on line. `pre-wrap` on the block's PARAGRAPHS restores those newlines
 * without touching how headings, lists, tables or fenced code render.
 * (`design.md` §6 — Scheduler worker detail, run-result prose block.)
 */
.result-prose :deep(p) {
  white-space: pre-wrap;
}

/**
 * The disclosure cell must not size the runs table. `table-layout: auto` sizes a
 * column from its cell's MAX-content, and a `colspan="5"` cell holding a wide
 * markdown table has a max-content of whatever that table wants — measured on
 * the running app: the runs table grew to 716px inside a 610px column and the
 * Duration column was silently clipped off by the card's `overflow-hidden`.
 * `width: 0` drops the cell's max-content contribution to nothing;
 * `min-width: 100%` renders it at the cell's real width anyway. The result block
 * inside then scrolls, which is the behaviour we actually want.
 */
.run-detail-body {
  width: 0;
  min-width: 100%;
}

/* Two local overrides that used to close this block are GONE (BUG-119), because
   the shared seam (`MarkdownRenderer.vue`) now says both things for all seven of
   its consumers, and a copy here would only be a second place to keep in sync:

     - `list-style: disc`/`decimal` — markers Tailwind's preflight strips;
     - `min-width: max-content` on a table — which still keeps a 7-column triage
       table from compressing into the panel and breaking its own header words
       mid-word ("Owne r" at 560px, measured on the running app). What changed is
       WHERE that width overflows: the seam wraps every table in its own
       `.md-table-scroll` container, so it widens THAT wrapper's scroll rather
       than this block's, and the result's paragraphs no longer slide sideways
       with the table. */
</style>
