<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowUpRight,
  Bookmark,
  Copy,
  Expand,
  GitBranch,
  GitPullRequest,
  Library,
  Lightbulb,
  List,
  ListChecks,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  Send,
  Target,
  X,
  ZoomIn
} from 'lucide-vue-next'
import { useFocusRegion } from '../composables/useTerminalFocus'
import {
  keepPaneFocusOnPointer,
  isDoneDebounced,
  mapWalkKey,
  textScaleKey,
  type WalkKeyAction
} from '../lib/walk-keys'
import { createClickGuard, paneHasSelection } from '../lib/walk-selection'
import {
  keyContext,
  paneView,
  shotLightbox,
  type LinkChip,
  type Outcome,
  type OutcomeId,
  type WalkData
} from '../lib/walk-view'
import { useHelpersStore, type AnyHelperPane } from '../stores/helpers'
import { useKeybindingsStore } from '../stores/keybindings'
import { useMissionsStore } from '../stores/missions'
import { useSessionsStore } from '../stores/sessions'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useWalkStore } from '../stores/walk'
import WalkCheck from './WalkCheck.vue'
import WalkCloseOut from './WalkCloseOut.vue'
import WalkCopy from './WalkCopy.vue'
import WalkFailure from './WalkFailure.vue'
import WalkPast from './WalkPast.vue'
import WalkRoadmap from './WalkRoadmap.vue'
import WalkStatus from './WalkStatus.vue'
import WalkTextSize from './WalkTextSize.vue'

/**
 * The guided walk pane (design.md §6 "Guided test walk (helper-stack pane, non-PTY)", spec S-3): a fixed template
 * that walks the operator through a feature, a PR or a mission, ONE check at a time. A non-PTY pane in the
 * helper stack; it mounts and unmounts freely and holds nothing that matters: the walk and its runs live in main
 * (`.harnu/walks/`) and `lib/walk-view.ts` turns them into exactly what this draws. It decides nothing: an outcome
 * is a button that asks main to apply one machine step (`walk:operate`), which writes the `[harnu-walk]` turn that
 * step owes the session in the same file write.
 *
 * Nothing here settles a criterion (D-2): the close-out reads one and links to the Mission, where the operator
 * ticks it. The agent never writes a pixel of this pane; it sends data.
 */
interface Props {
  pane: AnyHelperPane
  worktreePath: string
  /** Whether this pane's header doubles as the resize handle (false for pane 0). */
  resizable?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{ headerMouseDown: [ev: MouseEvent] }>()

const { t, locale } = useI18n()
const helpers = useHelpersStore()
const keybindings = useKeybindingsStore()
const sessions = useSessionsStore()
const ui = useUiStore()
const settings = useSettingsStore()
const walk = useWalkStore()

const payload = computed(
  () =>
    ((props.pane as { payload?: Record<string, unknown> }).payload ?? {}) as Record<string, unknown>
)
const folder = computed(() => props.worktreePath || (props.pane as { cwd: string }).cwd)
const state = computed(() => walk.get(props.pane.id))

// ---- the run ----------------------------------------------------------------------------------------

function attach(): void {
  const walkId = typeof payload.value.walkId === 'string' ? payload.value.walkId : ''
  const runId = typeof payload.value.runId === 'string' ? payload.value.runId : ''
  if (!walkId || !runId) return
  void walk.attach({
    paneId: props.pane.id,
    folder: folder.value,
    walkId,
    runId,
    past: payload.value.past === true
  })
}
onMounted(attach)
watch(
  () => [payload.value.walkId, payload.value.runId, payload.value.past === true],
  () => {
    const s = state.value
    const past = payload.value.past === true
    if (s && (s.walkId !== payload.value.walkId || s.runId !== payload.value.runId))
      void walk.follow(props.pane.id, String(payload.value.runId), String(payload.value.walkId), {
        past
      })
    else if (s) s.ui.past = past
  }
)
onBeforeUnmount(() => {
  walk.detach(props.pane.id)
  if (tickTimer) clearInterval(tickTimer)
})

// the wait of D-7 runs from delivery: a clock the view reads, ticking only while a check is awaiting the agent
const now = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null

const data = computed<WalkData | null>(() => {
  const d = state.value?.data
  return d ? ({ ...d, now: now.value } as WalkData) : null
})
const view = computed(() =>
  paneView(data.value, state.value?.ui ?? emptyUi, (k, p) => t(k, p ?? {}), {
    locale: locale.value
  })
)
const emptyUi = {
  explainOpen: false,
  formOpen: false,
  roadmapOpen: false,
  lightbox: false,
  past: false,
  asking: { explain: [], simpler: [] }
}

watch(
  () => view.value.check?.phase === 'awaiting' || view.value.mode === 'error',
  (waiting) => {
    if (waiting && !tickTimer) {
      now.value = Date.now()
      let beat = 0
      tickTimer = setInterval(() => {
        now.value = Date.now()
        // an outbox that is holding gets offered again: the pane asks, there is no retry timer in main
        if (view.value.mode === 'error') void walk.replay(props.pane.id)
        // whether a turn is held is a matter of time, so a waiting pane reads the run again now and then
        else if (++beat % 2 === 0) void walk.reload(props.pane.id)
      }, 1000)
    } else if (!waiting && tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  },
  { immediate: true }
)

// ---- header -----------------------------------------------------------------------------------------

function onHeaderMouseDown(ev: MouseEvent): void {
  if (props.resizable) emit('headerMouseDown', ev)
}
const isMaximized = computed(() => helpers.maximizedPaneId(props.worktreePath) === props.pane.id)
const isExpanded = computed(() => helpers.expandedPaneId(props.worktreePath) === props.pane.id)

/** V-11: the X asks once, when at least one check is closed, whether to end the walk and read the close-out. */
const endAsk = ref(false)
const closedCount = computed(() => {
  const r = state.value?.data?.run
  return r
    ? r.checks.filter((c) => c.countable && (c.state === 'verified' || c.state === 'caveat')).length
    : 0
})
async function onClose(): Promise<void> {
  const run = state.value?.data?.run
  if (run?.state === 'live' && closedCount.value > 0) {
    endAsk.value = true
    return
  }
  // a run that never started is discarded with its pane (the walk stays); a live one stays live and continues
  if (run?.state === 'ready') await walk.discardIfReady(props.pane.id)
  helpers.removeHelper(props.worktreePath, props.pane.id)
}
async function confirmEnd(): Promise<void> {
  endAsk.value = false
  await walk.operate(props.pane.id, 'end')
}

const rootEl = ref<HTMLDivElement | null>(null)
useFocusRegion(props.pane.id, rootEl, {
  focus: () =>
    (rootEl.value?.querySelector<HTMLElement>('[data-walk-primary]') ?? rootEl.value)?.focus(),
  close: () => void onClose()
})

// ---- source line ------------------------------------------------------------------------------------

const sourceIcons = {
  target: Target,
  'git-pull-request': GitPullRequest,
  'git-branch': GitBranch,
  bookmark: Bookmark,
  lightbulb: Lightbulb
}

async function openUrl(url: string): Promise<void> {
  const wt = folder.value
  const res = await window.api.browserOpen({ folder: wt, url })
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: t('browserPane.openFailed'), description: res.error })
    return
  }
  helpers.addBrowserHelper(wt, {
    paneId: res.paneId,
    name: '',
    url,
    openedBy: 'operator',
    partition: 'operator',
    ownerSessionId: null
  })
}

async function openPr(n: number, known?: string | null): Promise<void> {
  const url = known ?? (await window.api.walkResolvePr({ folder: folder.value, number: n })).url
  if (!url) {
    ui.pushToast({ kind: 'warning', title: t('testWalk.source.openPr') })
    return
  }
  await openUrl(url)
}

async function onSourceLink(): Promise<void> {
  const src = state.value?.data?.script.source
  if (!src) return
  if (src.kind === 'pr') await openPr(src.number, src.url ?? null)
  else if (src.kind === 'mission') openMission()
}

/** The mission the walk is about shows in the dropdown under the Topbar pill (the Mission pane is gone). */
function openMission(): void {
  const src = state.value?.data?.script.source
  useMissionsStore().openMissionDropdown(src?.kind === 'mission' ? src.missionId : undefined)
}

async function onOpenLink(l: LinkChip): Promise<void> {
  if (l.kind === 'file' && l.abs) {
    helpers.addMarkdownHelper(folder.value, l.abs, folder.value)
  } else if (l.kind === 'url') {
    await openUrl(l.target)
  } else if (l.kind === 'pr') {
    await openPr(Number(l.target))
  } else if (l.kind === 'folder') {
    sessions.selectFolder(l.target)
  }
}

// ---- images: a walk's images are files in its own folder; the reader hands back data: URLs ----------
const images = ref<Record<string, string>>({})
function imageUrl(src: string): string {
  return images.value[src] ?? ''
}
watch(
  () => [state.value?.data?.walkDir, view.value.check?.see.images.map((i) => i.src).join('|')],
  async () => {
    const dir = state.value?.data?.walkDir
    for (const im of view.value.check?.see.images ?? []) {
      if (!dir || images.value[im.src] !== undefined) continue
      images.value = { ...images.value, [im.src]: '' }
      const res = await window.api.markdownRead(`${dir}/${im.src}`)
      if (res.ok && res.kind === 'image') images.value = { ...images.value, [im.src]: res.content }
    }
  },
  { immediate: true }
)
// the screenshot the operator pasted (shown as a chip on the retry card) is a file in the run's folder too
watch(
  () => view.value.check?.reported?.shotPath,
  async (p) => {
    if (!p || images.value[p] !== undefined) return
    images.value = { ...images.value, [p]: '' }
    const res = await window.api.markdownRead(p)
    if (res.ok && res.kind === 'image') images.value = { ...images.value, [p]: res.content }
  },
  { immediate: true }
)
const bigImage = ref(false)
watch(
  () => view.value.check?.checkId,
  () => {
    bigImage.value = false
    doorSent.value = false
  }
)
function onZoom(): void {
  const s = state.value
  if (!s) return
  if (!bigImage.value) bigImage.value = true
  else {
    s.ui.lightbox = true
    // focus goes into the lightbox, so Esc (and Tab) stay inside the pane's own key map
    void nextTick(() => rootEl.value?.querySelector<HTMLElement>('.lightbox .lb-x')?.focus())
  }
}
// Explain more opened: bring what it revealed into view (the card sits under the check, maybe below the fold)
watch(
  () => state.value?.ui.explainOpen,
  async (open) => {
    if (!open) return
    await nextTick()
    rootEl.value
      ?.querySelector<HTMLElement>('[data-walk-explain]')
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
)

// the lightbox closed: focus goes back to the pane, so Enter keeps meaning Done
watch(
  () => state.value?.ui.lightbox,
  (open, was) => {
    if (was && !open) void nextTick(() => rootEl.value?.focus())
  }
)
// a screenshot of a past run opened from its notes: the pane's own lightbox shows it (not the Markdown viewer)
const shotOpen = ref<{ path: string; name: string } | null>(null)
watch(
  () => state.value?.ui.lightbox,
  (open) => {
    if (!open) shotOpen.value = null
  }
)
const lightboxImage = computed(() => {
  const im = shotOpen.value ? shotLightbox(shotOpen.value) : view.value.check?.see.images[0]
  return im ? { ...im, url: imageUrl(im.src) } : null
})

// the screenshots of a past run's notes are files in the run's folder too
watch(
  () => view.value.past?.rows.flatMap((r) => r.notes?.shots.map((x) => x.path) ?? []).join('|'),
  async () => {
    for (const row of view.value.past?.rows ?? [])
      for (const sh of row.notes?.shots ?? []) {
        if (images.value[sh.path] !== undefined) continue
        images.value = { ...images.value, [sh.path]: '' }
        const res = await window.api.markdownRead(sh.path)
        if (res.ok && res.kind === 'image')
          images.value = { ...images.value, [sh.path]: res.content }
      }
  },
  { immediate: true }
)

// ---- the library, the history, Re-run and Export (S-4) -----------------------------------------------

/** The library icon of the header, and Open Walks on the close-out card: reveal the repo's Walks. */
function onOpenLibrary(): void {
  helpers.addWalksHelper(props.worktreePath)
}

/** `← Walks` on a past run: the library takes this cell back (a past run is only a viewer). */
function onBackToLibrary(): void {
  helpers.addWalksHelper(props.worktreePath)
  helpers.removeHelper(props.worktreePath, props.pane.id)
}

/** The run selector: an ended run opens read-only, a live one continues. */
async function onSelectRun(runId: string): Promise<void> {
  const s = state.value
  const opt = view.value.past?.run.options.find((o) => o.runId === runId)
  if (!s || !opt) return
  const past = !opt.live
  helpers.setWalkRun(props.worktreePath, props.pane.id, runId, undefined, { past })
  await walk.follow(props.pane.id, runId, undefined, { past })
}

/** A screenshot of a note opens in the viewer, which draws an image inline. */
function onOpenShot(path: string): void {
  const s = state.value
  if (!s) return
  shotOpen.value = { path, name: path.split('/').pop() ?? path }
  s.ui.lightbox = true
  // focus goes into the lightbox, so Esc (and Tab) stay inside the pane's own key map
  void nextTick(() => rootEl.value?.querySelector<HTMLElement>('.lightbox .lb-x')?.focus())
}

/** Re-run: run n + 1 of this walk, or the live run when one is live. This pane follows it. */
async function onRerunWalk(): Promise<void> {
  const s = state.value
  if (!s) return
  const res = await walk.rerun(folder.value, s.walkId)
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: t('walksLibrary.rerunFailed') })
    return
  }
  helpers.setWalkRun(props.worktreePath, props.pane.id, res.runId, undefined, { past: false })
  await walk.follow(props.pane.id, res.runId, undefined, { past: false })
}

/** Export markdown: write the run into the walk's own folder and open the file in the viewer. */
async function onExport(): Promise<void> {
  const s = state.value
  if (!s) return
  const res = await walk.exportRun(folder.value, s.walkId, s.runId)
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: t('walksLibrary.export.failed') })
    return
  }
  helpers.addMarkdownHelper(folder.value, res.path, folder.value)
}

// ---- the operator's outcomes ------------------------------------------------------------------------

const form = ref<{ canSend: boolean; line: string; shot: string | null }>({
  canSend: false,
  line: '',
  shot: null
})
const resuming = ref(false)
const resumeFailed = ref(false)
const doorSent = ref(false)

async function run(id: OutcomeId): Promise<void> {
  const s = state.value
  if (!s?.data) return
  const paneId = props.pane.id
  // a press while the last step is still on its way to main is dropped: a held or doubled key must never walk
  // through two checks (the 400 ms window after a served check covers the rest)
  if (s.busy && id !== 'failed' && id !== 'cancel-form' && id !== 'explain') return
  switch (id) {
    case 'start':
      await walk.operate(paneId, 'start')
      break
    case 'done':
      if (isDoneDebounced(s.servedAt, Date.now())) return // a second Done a moment after a new check
      await walk.operate(paneId, 'done')
      break
    case 'failed':
      s.ui.formOpen = true
      break
    case 'cancel-form':
      s.ui.formOpen = false
      break
    case 'send': {
      if (!form.value.canSend) return
      const err = await walk.operate(paneId, 'fail', {
        ...(form.value.line ? { line: form.value.line } : {}),
        ...(form.value.shot ? { shot: form.value.shot } : {})
      })
      if (!err) s.ui.formOpen = false
      break
    }
    case 'back':
      await walk.operate(paneId, 'back')
      break
    case 'skip':
      await walk.operate(paneId, 'skip')
      break
    case 'explain':
      await walk.toggleExplain(paneId)
      break
    case 'try-again':
    case 'follow-anyway':
    case 'treat-as-failed':
      await walk.operate(paneId, id)
      break
    case 'continue-without':
      await walk.operate(paneId, 'continue-without', { waitMs: s.data.waitMs })
      break
    case 'pick-skipped':
      await walk.operate(paneId, 'pick-skipped', { checkId: view.value.skipped?.ids[0] })
      break
    case 'close-out':
      await walk.operate(paneId, 'close-out-with-skipped')
      break
    case 'rerun':
      await onRerunWalk()
      break
    case 'export':
      await onExport()
      break
  }
}

// A drag over the selectable content that is released on a control must not press it (BUG-292 AC-2, AC-7).
const clickGuard = createClickGuard()
function onPointerDownCapture(ev: PointerEvent): void {
  clickGuard.press(ev.target)
  keepPaneFocusOnPointer(ev)
}
function onClickCapture(ev: MouseEvent): void {
  if (!clickGuard.shouldSwallow(ev)) return
  ev.preventDefault()
  ev.stopPropagation()
}

async function onKeydown(ev: KeyboardEvent): Promise<void> {
  // Ctrl/Cmd + = / - / 0: the text size (T807). It is the pane's in every mode and in a field, so it comes first.
  const size = textScaleKey(ev)
  if (size) {
    ev.preventDefault()
    ev.stopPropagation()
    settings.stepWalkTextScale(size)
    return
  }
  const s = state.value
  if (!s || endAsk.value) return
  // the content is selectable (BUG-292): a letter typed over a selection is not an outcome, Esc clears it first
  const hit = mapWalkKey(ev, {
    ...keyContext(view.value, s.ui),
    hasSelection: paneHasSelection(rootEl.value)
  })
  if (!hit) return
  ev.preventDefault()
  ev.stopPropagation()
  await act(hit.action)
}

async function act(action: WalkKeyAction): Promise<void> {
  const s = state.value
  if (!s) return
  switch (action) {
    case 'clear-selection':
      window.getSelection()?.removeAllRanges()
      break
    case 'close-lightbox':
      s.ui.lightbox = false
      break
    case 'close-roadmap':
      s.ui.roadmapOpen = false
      break
    case 'close-form':
      s.ui.formOpen = false
      break
    case 'roadmap':
      s.ui.roadmapOpen = !s.ui.roadmapOpen
      break
    default:
      await run(action as OutcomeId)
  }
}

async function onRerun(savedWalkId: string): Promise<void> {
  const res = await walk.rerunSaved(props.pane.id)
  if (!res || !res.includes(':')) return
  const [walkId, runId] = res.split(':')
  void savedWalkId
  helpers.setWalkRun(props.worktreePath, props.pane.id, runId, walkId)
  await walk.follow(props.pane.id, runId, walkId)
}

async function onResume(): Promise<void> {
  const owner = state.value?.data?.ownerSessionId
  resumeFailed.value = false
  resuming.value = true
  try {
    if (owner) sessions.select(owner)
    else resumeFailed.value = true
    await new Promise((r) => setTimeout(r, 1500))
    await walk.replay(props.pane.id)
  } finally {
    resuming.value = false
  }
}

async function onDoor(): Promise<void> {
  const err = await walk.operate(props.pane.id, 'escalate')
  doorSent.value = err === null
}

// Focus follows the primary action when the pane already has it: Enter keeps meaning "go on" after a step. The
// element the operator pressed can leave the page (the action bar empties while the agent checks), so whether the
// pane HAD the focus is read before the update and the focus is put back after it.
const focusSignal = (): unknown[] => [
  view.value.mode,
  view.value.check?.checkId,
  view.value.check?.phase
]
let hadFocus = false
watch(focusSignal, () => (hadFocus = !!rootEl.value?.contains(document.activeElement)), {
  flush: 'pre'
})
watch(focusSignal, async () => {
  await nextTick()
  const root = rootEl.value
  if (!root || !hadFocus) return
  const target =
    view.value.mode === 'failed-form'
      ? root.querySelector<HTMLElement>('#walk-failure-line')
      : root.querySelector<HTMLElement>('[data-walk-primary]')
  ;(target ?? root).focus()
})

// ---- presentation helpers ---------------------------------------------------------------------------
const GLYPH: Record<string, string> = { '✓': 'gl-ok', '✗': 'gl-bad', '!': 'gl-warn', '-': 'gl-off' }
const lookClass = (o: Outcome): string =>
  o.look === 'primary' ? 'btn md primary' : o.look === 'neutral' ? 'btn md' : 'btn ghost'
const tip = (o: Outcome): string =>
  o.shortcut ? `${o.label} (${o.shortcut})` : o.chip ? `${o.label} (${o.chip})` : o.label
const ghostFrom = computed(() => {
  const os = view.value.outcomes
  const i = os.findIndex((o) => o.look === 'ghost')
  return i > 0 ? i : -1
})
const closedCells = computed(
  () => view.value.progress?.cells.filter((c) => c === 'closed').length ?? 0
)
const hasFoot = computed(
  () => endAsk.value || view.value.outcomes.length > 0 || view.value.mode === 'check'
)
</script>

<template>
  <div
    ref="rootEl"
    class="wk relative flex h-full w-full flex-col overflow-hidden bg-bg group/pane no-default-ring"
    style="container: wk / inline-size"
    :style="{ '--walk-text-scale': settings.walkTextScale }"
    tabindex="0"
    :data-focus-region="pane.id"
    :data-state="view.mode"
    data-dsqa="walk"
    :aria-label="$t('testWalk.label')"
    @keydown="onKeydown"
    @pointerdown.capture="onPointerDownCapture"
    @click.capture="onClickCapture"
  >
    <!-- the 24px header of §6 "Pane header": non-PTY, so no xterm padding -->
    <header
      class="flex h-6 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2 text-[11px] text-text-2 transition-colors group-focus-within/pane:text-text"
      :class="
        resizable ? 'cursor-row-resize border-t border-t-border-2 hover:border-t-accent-line' : ''
      "
      data-dsqa-part="pane-header"
      @mousedown="onHeaderMouseDown"
    >
      <ListChecks :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
      <span class="min-w-0 flex-1 truncate">
        <b class="font-medium text-text">{{ $t('testWalk.title') }}</b>
        <template v-if="view.title"> · {{ view.title }}</template>
      </span>
      <WalkTextSize />
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('walksLibrary.open')"
        :aria-label="$t('walksLibrary.label')"
        data-test="walk-library-open"
        @mousedown.stop
        @click="onOpenLibrary"
      >
        <Library :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="flex shrink-0 items-center justify-center rounded transition hover:bg-surface-2 hover:text-text"
        :class="isExpanded ? 'text-accent' : 'text-text-3'"
        style="width: 18px; height: 18px"
        :title="
          keybindings.withChord(
            isExpanded ? $t('helperPane.exitExpand') : $t('helperPane.expand'),
            'pane.expandToWindow'
          )
        "
        :aria-label="isExpanded ? $t('helperPane.exitExpand') : $t('helperPane.expand')"
        :aria-pressed="isExpanded"
        data-test="pane-expand"
        @mousedown.stop
        @click="helpers.toggleExpandPane(worktreePath, pane.id)"
      >
        <Expand :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="
          keybindings.withChord(
            isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize'),
            'pane.toggleMaximize'
          )
        "
        :aria-label="isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize')"
        @mousedown.stop
        @click="helpers.toggleMaximizePane(worktreePath, pane.id)"
      >
        <Minimize2 v-if="isMaximized" :size="12" :stroke-width="1.5" />
        <Maximize2 v-else :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="-mr-1 flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="keybindings.withChord($t('helperPane.close'), 'pane.close')"
        :aria-label="$t('helperPane.close')"
        data-test="walk-close"
        @mousedown.stop
        @click="onClose"
      >
        <X :size="12" :stroke-width="1.5" />
      </button>
    </header>

    <!-- the source line: where this walk comes from -->
    <div v-if="view.source" class="src" data-dsqa-part="source" data-test="walk-source">
      <component :is="sourceIcons[view.source.icon]" class="i i10" :size="10" />
      <template v-if="view.source.link">
        <button
          type="button"
          class="open trunc"
          data-walk-chip
          :title="view.source.text"
          @click="onSourceLink"
        >
          <span class="x trunc">{{ view.source.text }}</span>
          <ArrowUpRight class="i i10 ext" :size="10" />
        </button>
        <WalkCopy
          v-if="view.source.copy"
          :value="view.source.copy"
          :what="t('testWalk.source.copyPr')"
        />
      </template>
      <span v-else class="x trunc">{{ view.source.text }}</span>
      <span v-if="view.source.runChip" class="runchip">{{ view.source.runChip }}</span>
    </div>

    <!-- progress: `Check n of N` and a strip of one cell per check; nothing else is written about it -->
    <div
      v-if="view.progress && view.mode !== 'roadmap'"
      class="wk-top"
      data-dsqa-part="progress"
      data-test="walk-progress"
    >
      <div class="wk-top-r">
        <span class="wk-count num">{{ view.progress.label }}</span>
        <button
          type="button"
          class="ib"
          :title="$t('testWalk.roadmapOpen')"
          :aria-label="$t('testWalk.roadmapOpen')"
          data-test="walk-roadmap-open"
          @click="state && (state.ui.roadmapOpen = true)"
        >
          <List class="i i12" :size="12" />
        </button>
      </div>
      <div
        class="rail"
        role="progressbar"
        aria-valuemin="0"
        :aria-valuemax="view.progress.total"
        :aria-valuenow="closedCells"
        :aria-label="view.progress.label"
      >
        <span
          v-for="(c, i) in view.progress.cells"
          :key="i"
          class="cell"
          :class="{ done: c === 'closed', cur: c === 'current' }"
        ></span>
      </div>
    </div>

    <!-- `select-text` opts the content back into selection (body sets `user-select: none`): see §6 Selecting text -->
    <div class="wk-body select-text" tabindex="-1" data-test="walk-body">
      <WalkStatus v-if="view.mode === 'empty' || state?.missing" kind="empty" />
      <WalkStatus
        v-else-if="view.mode === 'error'"
        kind="error"
        :done="view.error?.done"
        :total="view.error?.total"
        :resuming="resuming"
        :failed="resumeFailed"
        @resume="onResume"
      />

      <template v-else-if="view.mode === 'roadmap' && view.roadmap">
        <button
          v-if="view.roadmap.readOnly"
          type="button"
          class="lost back"
          data-test="walk-roadmap-close"
          @click="state && (state.ui.roadmapOpen = false)"
        >
          {{ $t('testWalk.closeRoadmap') }}
        </button>
        <WalkRoadmap :roadmap="view.roadmap" @rerun="onRerun" />
      </template>

      <WalkFailure
        v-else-if="view.mode === 'failed-form' && view.check"
        :pane-id="pane.id"
        :title="view.check.title"
        @ready="form = $event"
      />

      <WalkCheck
        v-else-if="view.mode === 'check' && view.check"
        :check="view.check"
        :folder="folder"
        :image-url="imageUrl"
        :big-image="bigImage"
        @open-link="onOpenLink"
        @zoom-image="onZoom"
        @tick="(c, e) => walk.tick(pane.id, c, e)"
        @lost="walk.askSimpler(pane.id)"
        @ask="walk.toggleExplain(pane.id)"
        @door="onDoor"
      />

      <template v-else-if="view.mode === 'skipped' && view.skipped">
        <div class="wk-head">
          <h2 class="wk-title">
            {{ $t('testWalk.skipped.title', { n: view.skipped.ids.length }) }}
          </h2>
          <div class="sub">{{ $t('testWalk.skipped.sub') }}</div>
        </div>
        <ol class="rm" data-dsqa-part="skipped-list">
          <li
            v-for="r in view.skipped.rows"
            :key="r.id"
            class="rm-row sk"
            data-dsqa-part="skipped-row"
          >
            <span class="g1"><span class="gl gl-off" aria-hidden="true">-</span></span>
            <span class="n num">{{ r.n }}</span>
            <span class="t">{{ r.title }}</span>
            <span class="m">
              <span class="m-k">{{
                r.how.kind === 'check' ? $t('testWalk.roadmap.icheck') : $t('testWalk.roadmap.eyes')
              }}</span>
              <button
                type="button"
                class="btn"
                @click="walk.operate(pane.id, 'pick-skipped', { checkId: r.id })"
              >
                {{ $t('testWalk.skipped.retry') }}
              </button>
            </span>
          </li>
        </ol>
      </template>

      <WalkPast
        v-else-if="view.mode === 'past' && view.past"
        :past="view.past"
        :image-url="imageUrl"
        @back="onBackToLibrary"
        @select-run="onSelectRun"
        @open-shot="onOpenShot"
      />

      <WalkCloseOut
        v-else-if="view.mode === 'closeout' && view.closeout"
        :closeout="view.closeout"
        @open-mission="openMission"
        @open-walks="onOpenLibrary"
        @export="onExport"
      />
      <p v-if="view.waking" class="why waking" role="status" data-test="walk-waking">
        {{ view.waking }}
      </p>
      <p v-if="doorSent && view.mode === 'check'" class="why" role="status">
        {{ $t('testWalk.retry.doorSent') }}
      </p>
    </div>

    <!-- the X's one question (V-11): inline, never a dialog -->
    <div v-if="endAsk" class="wk-foot" data-dsqa-part="actions" data-test="walk-end-ask">
      <span class="end-ask">{{ $t('testWalk.end.title') }}</span>
      <span class="sp2"></span>
      <button type="button" class="btn md primary" data-test="walk-end-confirm" @click="confirmEnd">
        {{ $t('testWalk.end.confirm') }}
      </button>
      <button type="button" class="btn ghost" @click="endAsk = false">
        {{ $t('testWalk.end.cancel') }}
      </button>
    </div>

    <!-- the action bar: the five outcomes whenever a check asks for an answer, and only what the state calls for -->
    <div
      v-else-if="view.outcomes.length > 0"
      class="wk-foot"
      data-dsqa-part="actions"
      data-test="walk-actions"
    >
      <template v-for="(o, i) in view.outcomes" :key="o.id">
        <span v-if="i === ghostFrom" class="sp2"></span>
        <button
          type="button"
          :class="lookClass(o)"
          :data-walk-done="o.id === 'done' ? '' : undefined"
          :data-walk-primary="o.look === 'primary' ? '' : undefined"
          :data-outcome="o.id"
          :aria-keyshortcuts="o.chip === 'Enter' ? 'Enter' : (o.shortcut ?? undefined)"
          :aria-pressed="o.id === 'explain' ? o.pressed : undefined"
          :disabled="o.id === 'send' && !form.canSend"
          :title="tip(o)"
          @click="run(o.id)"
        >
          <span
            v-if="o.glyph && o.glyph !== '+'"
            class="gl"
            :class="GLYPH[o.glyph]"
            aria-hidden="true"
            >{{ o.glyph }}</span
          >
          <Plus v-else-if="o.glyph === '+'" class="i i10" :size="10" />
          <RefreshCw
            v-else-if="o.id === 'try-again' || o.id === 'rerun'"
            class="i i10"
            :size="10"
          />
          <Copy v-else-if="o.id === 'export'" class="i i10" :size="10" />
          <Send v-else-if="o.id === 'send'" class="i i10" :size="10" />
          <span>{{ o.label }}</span>
          <kbd v-if="o.chip">{{ o.chip }}</kbd>
        </button>
      </template>
    </div>
    <div
      v-else-if="view.mode === 'check' && view.check?.phase === 'awaiting'"
      class="wk-foot idle"
      data-dsqa-part="actions-idle"
    >
      <span class="why">{{ $t('testWalk.working.quiet') }}</span>
    </div>
    <div v-else-if="!hasFoot" class="hidden"></div>

    <!-- the lightbox: covers the pane, Esc closes it -->
    <div
      v-if="state?.ui.lightbox && lightboxImage"
      class="lightbox anim-fade-in-scale"
      role="dialog"
      aria-modal="true"
      :aria-label="lightboxImage.caption"
      data-dsqa-part="lightbox"
      @click.self="state && (state.ui.lightbox = false)"
    >
      <button
        type="button"
        class="lb-x ib"
        :aria-label="$t('testWalk.image.close')"
        @click="state && (state.ui.lightbox = false)"
      >
        <X class="i i14" :size="14" />
      </button>
      <img :src="lightboxImage.url" :alt="lightboxImage.alt" />
      <div class="lb-cap">
        <ZoomIn class="i i10" :size="10" /><span>{{ lightboxImage.caption }}</span> <kbd>Esc</kbd
        ><span>{{ $t('testWalk.image.escToClose') }}</span>
      </div>
    </div>
  </div>
</template>

<style>
/* === the walk pane's anatomy, ported from the approved mockup (docs/design/guided-walks/mockup.css) ===
   Tokens only (themes.css). The off-grid sizes (a 300x132 thumbnail, a 40x28 attachment, a 76 px copy gutter, a
   340 px measure) are documented in design.md §6 "Guided test walk" as §4 allows. Every rule is under `.wk`. */
.wk {
  font-family: var(--font-sans);
  font-size: calc(13.5px * var(--walk-text-scale, 1));
  color: var(--color-text);
}
.wk button {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-align: left;
}
.wk button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.wk button:focus-visible,
.wk [tabindex]:focus-visible,
.wk a:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
  border-radius: var(--radius-sm);
}
.wk svg.i.i10 {
  width: 10px;
  height: 10px;
}
.wk svg.i.i12 {
  width: 12px;
  height: 12px;
}
.wk svg.i.i14 {
  width: 14px;
  height: 14px;
}
.wk svg.i {
  width: 12px;
  height: 12px;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex-shrink: 0;
}
.wk .mono {
  font-family: var(--font-mono);
}
.wk .num {
  font-variant-numeric: tabular-nums;
}
.wk .eyebrow {
  font-size: calc(11.5px * var(--walk-text-scale, 1));
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--color-text-4);
}
.wk .trunc {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.wk .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 20px;
  padding: 0 7px;
  border-radius: var(--radius-sm);
  font-size: calc(12.5px * var(--walk-text-scale, 1));
  line-height: 1;
  font-weight: 500;
  white-space: nowrap;
  border: 1px solid var(--color-border-2);
  background: var(--color-surface-2);
  color: var(--color-text);
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.wk .btn svg.i {
  display: block;
}
.wk .btn:hover {
  border-color: var(--color-text-4);
}
.wk .btn.primary {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-accent-ink);
}
.wk .btn.primary:hover {
  filter: brightness(1.1);
}
.wk .btn.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--color-text-3);
}
.wk .btn.ghost:hover {
  color: var(--color-text);
  background: var(--color-surface-2);
}
.wk .btn.lg {
  height: 26px;
  padding: 0 10px;
  font-size: calc(13.5px * var(--walk-text-scale, 1));
  gap: 6px;
}
.wk .btn.danger {
  color: var(--color-red);
}
.wk .card {
  margin: 0 14px 12px;
  border: 1px solid var(--color-border-2);
  border-radius: var(--radius);
  background: var(--color-surface-2);
  padding: 10px 12px;
}
.wk .card.you {
  border-color: var(--color-warning-line);
  background: var(--color-warning-soft);
}
.wk .card.ok {
  border-color: var(--color-green-line);
  background: var(--color-green-soft);
}
.wk .card.acc {
  border-color: var(--color-accent-line);
  background: var(--color-accent-soft);
}
.wk .card .eb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(11.5px * var(--walk-text-scale, 1));
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--color-text-4);
}
.wk .card.you .eb {
  color: var(--color-warning);
}
.wk .card.ok .eb {
  color: var(--color-green);
}
.wk .card.acc .eb {
  color: var(--color-accent);
}
.wk .card .ask {
  font-size: calc(14.5px * var(--walk-text-scale, 1));
  line-height: 1.4;
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.wk .card .why {
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
  margin-top: 4px;
  overflow-wrap: anywhere;
}
.wk .card .acts {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: flex-start;
}
.wk .card .hint {
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
  margin-top: 4px;
}
.wk .linkbtn {
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
  display: inline-flex;
  gap: 4px;
  align-items: center;
  margin-top: 6px;
}
.wk .linkbtn:hover {
  color: var(--color-text);
}
.wk .card .ask.sm {
  font-size: calc(13.5px * var(--walk-text-scale, 1));
}
.wk .chev {
  color: var(--color-text-4);
}
.wk .links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.wk .lk {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--color-border-2);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
  font-size: calc(12.5px * var(--walk-text-scale, 1));
  color: var(--color-accent);
  max-width: 100%;
}
.wk .lk:hover {
  border-color: var(--color-accent-line);
}
.wk .lk .x {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wk .lk.split {
  padding: 0;
  gap: 0;
}
.wk .lk.split > button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  color: var(--color-accent);
  min-width: 0;
}
.wk .lk.split > .cp {
  padding: 1px 5px;
  color: var(--color-text-4);
  border-left: 1px solid var(--color-border-2);
}
.wk .lk.split > .cp:hover {
  color: var(--color-text);
}
@keyframes wk-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.wk .ib {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--color-text-3);
  flex-shrink: 0;
  transition:
    color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.wk .ib:hover {
  color: var(--color-text);
  background: var(--color-surface-2);
}
.wk .wk-top {
  flex-shrink: 0;
  padding: 10px 16px 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.wk .wk-top-r {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.wk .wk-count {
  font-size: calc(14px * var(--walk-text-scale, 1));
  font-weight: 600;
  color: var(--color-text);
}
.wk .rail {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 3px;
}
.wk .rail .cell {
  height: 4px;
  border-radius: var(--radius-xs);
  background: var(--color-surface-2);
  border: 1px solid var(--color-border);
}
.wk .rail .cell.done {
  background: var(--color-green);
  border-color: var(--color-green);
}
.wk .rail .cell.cur {
  background: var(--color-accent);
  border-color: var(--color-accent);
}
.wk .wk-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 16px 14px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border-2) transparent;
}
/* the content is selectable (`select-text` on .wk-body), the controls inside it are not: a press on a button, a
   chip or a run-selector option never starts a selection, and a key hint is not text to copy */
.wk .wk-body button,
.wk .wk-body [data-walk-chip],
.wk .wk-body [role='option'],
.wk .wk-body kbd {
  user-select: none;
}
.wk .wk-title {
  margin: 0;
  font-size: calc(15px * var(--walk-text-scale, 1));
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.wk .wk-head .sub {
  margin-top: 3px;
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
}
.wk .blocks {
  font-size: calc(12.5px * var(--walk-text-scale, 1));
  color: var(--color-text-4);
  margin-top: -8px;
}
.wk .sec {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.wk .sec > .eyebrow {
  color: var(--color-text-4);
}
.wk label.eyebrow {
  display: block;
}
.wk ol.do {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wk ol.do li {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  gap: 6px;
  font-size: calc(14px * var(--walk-text-scale, 1));
  line-height: 1.45;
  color: var(--color-text);
}
.wk ol.do .n {
  color: var(--color-text-4);
  font-size: calc(12.5px * var(--walk-text-scale, 1));
  text-align: right;
  padding-top: 1px;
}
.wk ol.do .li {
  min-width: 0;
  overflow-wrap: anywhere;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wk .code {
  position: relative;
  border: 1px solid var(--color-border-2);
  background: var(--color-surface);
  border-radius: var(--radius);
  padding: 8px 10px;
  padding-right: 76px;
}
.wk .code pre {
  margin: 0;
  font-family: var(--font-mono);
  font-size: calc(13.5px * var(--walk-text-scale, 1));
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--color-text);
}
.wk .code .cp {
  position: absolute;
  top: 5px;
  right: 5px;
}
.wk .val {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  vertical-align: baseline;
}
.wk .val code {
  font-family: var(--font-mono);
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-border-2);
  border-radius: var(--radius-xs);
  padding: 0 5px;
  overflow-wrap: anywhere;
}
.wk .cp {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 18px;
  height: 18px;
  padding: 0 3px;
  border-radius: var(--radius-sm);
  color: var(--color-text-4);
  font-size: calc(12.5px * var(--walk-text-scale, 1));
  flex-shrink: 0;
  transition:
    color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.wk .cp:hover {
  color: var(--color-text);
  background: var(--color-surface-2);
}
.wk .cp.cp-l {
  height: 20px;
  padding: 0 6px;
  border: 1px solid var(--color-border-2);
  background: var(--color-surface-2);
  color: var(--color-text-2);
}
.wk .cp .cp-ack {
  display: none;
}
.wk .cp[data-copied],
.wk .btn[data-copied] {
  color: var(--color-green);
}
.wk .cp[data-copied] svg.i {
  display: none;
}
.wk .cp[data-copied]::before {
  content: '';
  width: 8px;
  height: 5px;
  border-left: 2px solid var(--color-green);
  border-bottom: 2px solid var(--color-green);
  transform: rotate(-45deg) translateY(-1px);
  display: inline-block;
}
.wk .cp[data-copied] .cp-ack {
  display: inline;
}
.wk .cp:not(.cp-l)[data-copied] .cp-ack {
  position: absolute;
  bottom: calc(100% + 4px);
  right: 0;
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-2);
  border: 1px solid var(--color-green-line);
  color: var(--color-green);
  font-size: calc(12px * var(--walk-text-scale, 1));
  white-space: nowrap;
  box-shadow: var(--shadow-pop);
}
.wk .cp.cp-l[data-copied] .cp-t {
  display: none;
}
.wk .btn[data-copied] .cp-t {
  display: none;
}
.wk .btn[data-copied] .cp-ack {
  display: inline;
}
.wk .btn[data-copied] svg.i {
  display: none;
}
.wk .links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.wk .lk.wl {
  font-size: calc(13.5px * var(--walk-text-scale, 1));
  min-height: 22px;
  border-color: var(--color-accent-line);
  background: var(--color-accent-soft);
  align-items: stretch;
}
.wk .lk.wl > .open {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  color: var(--color-accent);
  min-width: 0;
  text-decoration: underline;
  text-decoration-color: var(--color-accent-line);
  text-underline-offset: 2px;
}
.wk .lk.wl > .open:hover {
  text-decoration-color: var(--color-accent);
}
.wk .lk.wl .ext {
  opacity: 0.75;
}
.wk .lk.wl > .cp {
  border-left: 1px solid var(--color-accent-line);
  border-radius: 0;
  height: auto;
  padding: 0 6px;
}
.wk .lk.wl .x.mono {
  font-family: var(--font-mono);
  font-size: calc(13px * var(--walk-text-scale, 1));
}
.wk .approx {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  font-size: calc(12px * var(--walk-text-scale, 1));
  color: var(--color-warning);
}
.wk .see p {
  margin: 0;
  font-size: calc(14px * var(--walk-text-scale, 1));
  line-height: 1.5;
  color: var(--color-text);
}
.wk .see p + p {
  margin-top: 5px;
}
.wk .see p.not {
  display: flex;
  gap: 6px;
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
}
.wk .see.tight p {
  color: var(--color-text-2);
}
.wk .shot {
  margin: 0;
  position: relative;
  border: 1px solid var(--color-border-2);
  border-radius: var(--radius);
  overflow: hidden;
  background: var(--color-surface);
}
.wk .shot .zoom-hit {
  display: block;
  width: 100%;
  cursor: zoom-in;
}
.wk .shot img {
  display: block;
  width: 100%;
  height: auto;
}
.wk .shot.thumb {
  max-width: 300px;
}
.wk .shot.thumb .zoom-hit {
  height: 132px;
  overflow: hidden;
}
.wk .shot.thumb img {
  object-fit: cover;
  object-position: left top;
}
.wk .shot .zoom {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: calc(12.5px * var(--walk-text-scale, 1));
  color: var(--color-accent);
  pointer-events: none;
}
.wk .shot figcaption {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: calc(12px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
}
.wk .chk {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
}
.wk .chk .k {
  font-weight: 500;
  color: var(--color-text-2);
}
.wk .chk .arrow {
  color: var(--color-text-4);
}
.wk .chk.quiet {
  color: var(--color-text-4);
}
.wk .lost {
  align-self: flex-start;
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
  text-decoration: underline;
  text-decoration-color: var(--color-border-2);
  text-underline-offset: 2px;
}
.wk .lost:hover {
  color: var(--color-text);
  text-decoration-color: var(--color-text-3);
}
.wk .wk-foot {
  flex-shrink: 0;
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
  padding: 10px 16px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.wk .wk-foot .sp2 {
  flex: 1 1 0;
}
@container wk (max-width: 479px) {
  .wk .wk-foot .sp2 {
    flex-basis: 100%;
    height: 0;
  }
}
.wk .wk-foot.idle {
  color: var(--color-text-4);
  font-size: calc(13px * var(--walk-text-scale, 1));
}
.wk .btn.md {
  height: 28px;
  padding: 0 12px;
  font-size: calc(14px * var(--walk-text-scale, 1));
  gap: 6px;
}
.wk .btn kbd {
  font-family: var(--font-mono);
  font-size: calc(11.5px * var(--walk-text-scale, 1));
  line-height: 14px;
  padding: 0 4px;
  border: 1px solid currentColor;
  border-radius: var(--radius-xs);
  opacity: 0.7;
  margin-left: 2px;
}
.wk .kbd2 {
  font-family: var(--font-mono);
  font-size: calc(12px * var(--walk-text-scale, 1));
  color: var(--color-text-4);
  border: 1px solid var(--color-border-2);
  border-radius: var(--radius-xs);
  padding: 0 4px;
}
.wk .gl {
  font-family: var(--font-mono);
  font-weight: 700;
  display: inline-block;
  width: 1ch;
  text-align: center;
  flex-shrink: 0;
}
.wk .gl-ok {
  color: var(--color-green);
}
.wk .gl-bad {
  color: var(--color-red);
}
.wk .gl-warn {
  color: var(--color-warning);
}
.wk .gl-off {
  color: var(--color-text-4);
}
.wk .gl-you {
  color: var(--color-accent);
}
.wk .gl-ask {
  color: var(--color-text-3);
}
.wk .btn.primary .gl {
  color: inherit;
}
.wk ol.rm {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.wk .rm-row {
  display: grid;
  grid-template-columns: 14px 14px minmax(0, 1fr);
  column-gap: 8px;
  row-gap: 2px;
  padding: 8px 0;
  border-top: 1px solid var(--color-border);
  font-size: calc(14px * var(--walk-text-scale, 1));
  align-items: baseline;
}
.wk .rm-row:first-child {
  border-top: 0;
}
.wk .rm-row .n {
  color: var(--color-text-4);
  font-size: calc(12.5px * var(--walk-text-scale, 1));
  text-align: right;
}
.wk .rm-row .t {
  overflow-wrap: anywhere;
}
.wk .rm-row .m {
  grid-column: 3;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 6px;
  font-size: calc(12.5px * var(--walk-text-scale, 1));
  color: var(--color-text-4);
}
.wk .rm-row .m .m-k {
  color: var(--color-text-3);
}
.wk .rm-row .warnt {
  color: var(--color-warning);
}
.wk .rm-row.sk .m {
  justify-content: space-between;
}
.wk details.left {
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
}
.wk details.left summary {
  list-style: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.wk details.left summary::-webkit-details-marker {
  display: none;
}
.wk details.left[open] .chev {
  transform: rotate(90deg);
}
.wk details.left p {
  margin: 6px 0 0 14px;
  color: var(--color-text-4);
}
.wk .card.warn {
  border-color: var(--color-warning-line);
  background: var(--color-warning-soft);
  margin: 0;
}
.wk .card.warn .eb {
  display: flex;
  gap: 6px;
  align-items: center;
  color: var(--color-warning);
}
.wk .card.acc.fix,
.wk .card.acc.simple,
.wk .card.you.owed {
  margin: 0;
}
.wk .card .ask {
  margin: 4px 0 0;
}
.wk .fixv {
  margin-top: 8px;
}
.wk .card.evid dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 6px 12px;
  margin: 8px 0 0;
  font-size: calc(13px * var(--walk-text-scale, 1));
  align-items: baseline;
}
.wk .card.evid dt {
  color: var(--color-text-3);
}
.wk .card.evid dd {
  margin: 0;
  min-width: 0;
}
.wk .card.evid .why,
.wk .card.owed .why {
  margin-top: 8px;
}
.wk .card.owed .acts {
  margin-top: 8px;
}
.wk .reported {
  border-left: 2px solid var(--color-border-2);
  padding: 0 0 0 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wk .reported p {
  margin: 0;
  font-size: calc(14px * var(--walk-text-scale, 1));
  color: var(--color-text-2);
}
.wk input.line {
  font: inherit;
  font-size: calc(14px * var(--walk-text-scale, 1));
  height: 28px;
  width: 100%;
  padding: 0 8px;
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-border-2);
  border-radius: var(--radius-sm);
}
.wk input.line:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: 0;
}
.wk .paste {
  margin-top: 8px;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px 10px;
  align-items: center;
  border: 1px dashed var(--color-border-2);
  border-radius: var(--radius);
  padding: 10px 12px;
  color: var(--color-text-3);
  font-size: calc(13.5px * var(--walk-text-scale, 1));
}
.wk .paste .pt {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.wk .paste .pt b {
  font-weight: 500;
  color: var(--color-text-2);
}
.wk .att {
  grid-column: 1 / -1;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border: 1px solid var(--color-border-2);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-2);
  min-width: 0;
}
.wk .att img {
  width: 40px;
  height: 28px;
  object-fit: cover;
  border-radius: var(--radius-xs);
  flex-shrink: 0;
}
.wk .att .trunc {
  flex: 1;
}
.wk .att.small {
  align-self: flex-start;
}
.wk .why-box {
  border-top: 1px solid var(--color-border);
  padding-top: 12px;
}
.wk .why-box p {
  margin: 6px 0 0;
  font-size: calc(14px * var(--walk-text-scale, 1));
  line-height: 1.5;
  color: var(--color-text-2);
}
.wk .extra ul {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wk .ex {
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
}
.wk .ex .bx {
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--color-text-3);
  border-radius: var(--radius-sm);
  margin-top: 1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.wk .ex .bx.on {
  background: var(--color-green);
  border-color: var(--color-green);
  color: var(--color-bg);
}
.wk .ex .et {
  font-size: calc(14px * var(--walk-text-scale, 1));
  color: var(--color-text);
}
.wk .ex .ed {
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
  margin-top: 1px;
}
.wk .extra .hint {
  margin-top: 8px;
  font-size: calc(12.5px * var(--walk-text-scale, 1));
  color: var(--color-text-4);
}
.wk .quietbox {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-top: 6px;
}
.wk .quietbox .trace {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: calc(13.5px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
}
.wk .busy {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  font-size: calc(14px * var(--walk-text-scale, 1));
}
.wk .busy b {
  font-weight: 500;
}
.wk .busy .why {
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-4);
  margin-top: 6px;
}
.wk .busy .vrow {
  margin-top: 6px;
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.wk .busy .vrow.nx .m-k {
  color: var(--color-text-4);
}
.wk .pdot {
  width: 8px;
  height: 8px;
  margin-top: 4px;
  border-radius: 999px;
  background: var(--color-accent);
  animation: pdot 1.6s var(--ease) infinite;
}
@keyframes pdot {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
@media (prefers-reduced-motion: reduce) {
  .wk .pdot {
    animation: none;
  }
}
.wk .center {
  margin: auto;
  max-width: 340px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--color-text-4);
  padding: 24px 0;
}
.wk .center b {
  font-size: calc(14.5px * var(--walk-text-scale, 1));
  font-weight: 500;
  color: var(--color-text);
}
.wk .center p {
  margin: 0;
  font-size: calc(13.5px * var(--walk-text-scale, 1));
  line-height: 1.5;
  color: var(--color-text-3);
}
.wk .center.err svg.i {
  color: var(--color-red);
}
.wk .center .errv {
  margin-top: 2px;
}
.wk .center .acts2 {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-top: 8px;
}
.wk .lightbox {
  position: absolute;
  inset: 0;
  z-index: var(--z-dialog);
  background: var(--color-scrim-strong);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
  animation: wk-fade var(--dur) var(--ease) both;
}
.wk .lightbox img {
  max-width: 100%;
  max-height: calc(100% - 40px);
  border-radius: var(--radius);
  border: 1px solid var(--color-border-2);
}
.wk .lightbox .lb-x {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 26px;
  height: 26px;
  color: var(--color-text);
  background: var(--color-surface);
  border: 1px solid var(--color-border-2);
}
.wk .lb-cap {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: calc(12.5px * var(--walk-text-scale, 1));
  color: var(--color-text-2);
}
.wk .lb-cap kbd {
  font-family: var(--font-mono);
  font-size: calc(11.5px * var(--walk-text-scale, 1));
  border: 1px solid var(--color-border-2);
  border-radius: var(--radius-xs);
  padding: 0 4px;
}
.wk .btn.ghost[aria-pressed='true'] {
  color: var(--color-accent);
  background: var(--color-accent-soft);
}
.wk .src {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding: 0 16px;
  border-bottom: 1px solid var(--color-border);
  font-size: calc(12.5px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
}
.wk .src > svg.i {
  color: var(--color-text-4);
}
.wk .src .open {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--color-accent);
  text-decoration: underline;
  text-decoration-color: var(--color-accent-line);
  text-underline-offset: 2px;
}
.wk .src .open:hover {
  text-decoration-color: var(--color-accent);
}
.wk .src .x {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wk .src .ext {
  opacity: 0.75;
}
.wk .src .runchip {
  margin-left: auto;
  flex-shrink: 0;
  border: 1px solid var(--color-accent-line);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  border-radius: var(--radius-sm);
  padding: 0 6px;
  line-height: 16px;
  font-size: calc(12px * var(--walk-text-scale, 1));
}
.wk .src + .wk-top {
  padding-top: 8px;
}
.wk .lt {
  margin-left: auto;
  font-size: calc(12px * var(--walk-text-scale, 1));
  color: var(--color-text-4);
  white-space: nowrap;
}
.wk .lt-hint {
  margin-top: -8px;
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-4);
}
.wk .waking {
  margin: 0;
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
}
.wk .lt.failed,
.wk .lt-hint.failed {
  color: var(--color-warning);
}
.wk .redt {
  color: var(--color-red);
}
.wk .teach {
  border: 1px solid var(--color-accent-line);
  background: var(--color-accent-soft);
  border-radius: var(--radius);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wk .teach .eb {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: calc(11.5px * var(--walk-text-scale, 1));
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--color-accent);
}
.wk .teach .tc {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.wk .teach .tc p {
  margin: 0;
  font-size: calc(14px * var(--walk-text-scale, 1));
  line-height: 1.5;
  color: var(--color-text);
  overflow-wrap: anywhere;
}
.wk .teach .tc .eyebrow {
  color: var(--color-text-3);
}
.wk details.extra-fold ul.xl {
  margin: 6px 0 0 14px;
  padding: 0 0 0 14px;
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.wk .lost.back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  text-decoration: none;
  margin-bottom: -6px;
}
.wk .chipro {
  font-size: calc(12px * var(--walk-text-scale, 1));
  line-height: 16px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border-2);
  color: var(--color-text-3);
}
.wk .card.saved {
  margin: 0;
}
.wk .card.saved .acts {
  margin-top: 8px;
}
.wk .center .cmd {
  width: 100%;
  text-align: left;
  margin-top: 4px;
}
.wk .center .hint {
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-4);
}

/* --- what the build adds to the mockup's anatomy (each from a rule of the spec, not a new token) --- */
.wk .btn.md,
.wk .btn.primary {
  /* the mockup's buttons carry their own fill; the app's preflight resets it */
  background-clip: padding-box;
}
.wk .btn {
  border: 1px solid var(--color-border-2);
  background: var(--color-surface-2);
  color: var(--color-text);
}
.wk .btn.primary {
  background: var(--color-accent);
  border-color: transparent;
  color: var(--color-accent-ink);
}
.wk .btn.ghost {
  background: transparent;
  border-color: transparent;
  color: var(--color-text-2);
}
.wk .btn.ghost:hover {
  background: var(--color-surface-2);
}
.wk .where-text {
  font-size: calc(14px * var(--walk-text-scale, 1));
  color: var(--color-text-2);
}
.wk .link-row,
.wk .path-row {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  max-width: 100%;
}
.wk .blocks.undo {
  color: var(--color-warning);
}
.wk .exp-table {
  border-collapse: collapse;
  width: 100%;
  font-size: calc(13px * var(--walk-text-scale, 1));
}
.wk .exp-table th {
  text-align: left;
  font-weight: 500;
  color: var(--color-text-3);
  padding: 3px 6px 3px 0;
  border-bottom: 1px solid var(--color-border);
}
.wk .exp-table td {
  padding: 3px 6px 3px 0;
  vertical-align: top;
  overflow-wrap: anywhere;
}
.wk button.bx {
  width: 14px;
  height: 14px;
  padding: 0;
  border: 1.5px solid var(--color-text-3);
  border-radius: var(--radius-sm);
  margin-top: 1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
}
.wk button.bx.on {
  background: var(--color-green);
  border-color: var(--color-green);
}
.wk button.bx .tick {
  width: 7px;
  height: 4px;
  border-left: 2px solid var(--color-bg);
  border-bottom: 2px solid var(--color-bg);
  transform: rotate(-45deg) translateY(-1px);
}
.wk .secret-flag {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-warning);
}
.wk .rerun-offer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--color-accent-line);
  background: var(--color-accent-soft);
  border-radius: var(--radius);
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text);
}
.wk .rm-row .added {
  margin-left: 8px;
  font-size: calc(12px * var(--walk-text-scale, 1));
  color: var(--color-accent);
}
.wk .end-ask {
  font-size: calc(13.5px * var(--walk-text-scale, 1));
  color: var(--color-text);
}
.wk .crit-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wk .crit-list li {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.wk .quiet-owed {
  margin: 0;
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-4);
}
.wk ul.xl.plain {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: calc(13.5px * var(--walk-text-scale, 1));
  color: var(--color-text-2);
}
.wk .xl .xl {
  margin: 2px 0 0 14px;
  padding-left: 12px;
  list-style: disc;
  font-size: calc(13px * var(--walk-text-scale, 1));
  color: var(--color-text-3);
}
.wk .lost:disabled {
  text-decoration: none;
}
.wk .card.you.owed .crit-list .ask {
  font-size: calc(13.5px * var(--walk-text-scale, 1));
}
.wk .secret-flag + .paste {
  margin-top: 8px;
}
</style>
