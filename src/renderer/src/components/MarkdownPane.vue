<script lang="ts">
/**
 * Module-level draft cache (BUG-22), keyed by helper pane id — the `liveTerminals`
 * pattern from `TerminalPane`. This block is a plain `<script>` (evaluated ONCE at
 * module import), so the Map is a true singleton SHARED across every mount, unlike
 * `<script setup>` bindings which are per-instance.
 *
 * The edit buffer used to live in component-local refs, so ANY unmount — a
 * `RoadmapBoard` `v-if` takeover, a worktree switch, HMR — discarded a never-saved
 * draft: remount re-read from disk, and an `untitled` file that was never written
 * came back empty. Lifting the buffer to this singleton makes the draft survive
 * unmount/remount by construction. It is NOT auto-save-to-disk: Save stays a
 * deliberate gesture (T74) because the file is shared with agents. Entries are
 * cleared on explicit pane close (`onClose`); pane ids are UUIDs, so they never
 * collide or reappear once removed.
 */
interface MarkdownDraftCacheEntry {
  activeFilePath: string
  draft: string
  savedContent: string
  mode: 'view' | 'edit'
  /** How the read IPC encoded `draft`: UTF-8 text or an image data: URL. */
  kind: 'text' | 'image'
}

const draftCache = new Map<string, MarkdownDraftCacheEntry>()

/**
 * Test-only: empty the module draft cache. Production never reuses a pane id
 * (they're UUIDs, deleted on close), but component tests remount the SAME id and
 * must isolate between cases. Mirrors `resetScopesForTests` (useShortcuts).
 */
export function __resetMarkdownDraftCacheForTests(): void {
  draftCache.clear()
}
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check,
  Copy,
  Eye,
  FileText,
  Maximize2,
  Minimize2,
  Pencil,
  RotateCcw,
  Save,
  X
} from 'lucide-vue-next'
import { useHelpersStore, type AnyHelperPane } from '../stores/helpers'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import MarkdownRenderer from './MarkdownRenderer.vue'
import QuizBlock from './QuizBlock.vue'
import { livePtyIdFor } from './TerminalPane.vue'
import { pasteAndSubmit } from './prompt-inject'
import {
  formatLessonSummary,
  gradeQuiz,
  hasQuiz,
  lessonSessionOverride,
  parseLesson,
  scoreLesson,
  type QuizAnswer,
  type QuizResult,
  type QuizSpec
} from '../lib/lesson-blocks'
import type { HelperPane, MarkdownReadResult } from '../../../preload'

/**
 * File-backed markdown viewer + editor pane (T74). The "skin" over
 * `MarkdownRenderer`: owns the pane chrome (header + toggle/save/close/reload/
 * resize), reads through the confined `markdown:read` IPC (§3.4), browses
 * relative `.md` links in place, and (phase 2) edits through the confined
 * `markdown:write` IPC. NON-PTY — `HelperStack` routes `type:'markdown'` panes
 * here instead of `HelperPane`, so none of the detach/dispose PTY machinery
 * applies; it closes via `removeHelper` like any pane.
 *
 * The reusable `MarkdownRenderer` stays READ-ONLY (string→prose); editing lives
 * ONLY here. Editing is an EXPLICIT-save model (button + ⌘/Ctrl-S), not autosave:
 * writing is the most sensitive surface, so a visible dirty state + a deliberate
 * save keeps the operator in control of a file an agent may have placed. The
 * `draft` buffer previews live in view mode; `savedContent` is the on-disk
 * baseline the dirty flag compares against.
 */
interface Props {
  /** The shared pane union (HelperStack routes only `type:'markdown'` here). */
  pane: AnyHelperPane
  worktreePath: string
  /** Whether this pane's header doubles as the resize handle (false for pane 0). */
  resizable?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{ headerMouseDown: [ev: MouseEvent] }>()

/** The pane's persisted `filePath` (HelperStack guarantees a markdown pane). */
const paneFilePath = computed<string>(() => (props.pane as HelperPane).filePath ?? '')

/**
 * Open straight in edit mode on first mount (T87 — a scaffolded WORKTREE.md
 * proposal opens ready to review-and-save). Distinct from `autoEditIfBlank`,
 * which only edits a *blank* file; this forces edit on a populated template too.
 */
const forceEditOnOpen = computed<boolean>(() => (props.pane as HelperPane).initialMode === 'edit')

const { t } = useI18n()
const helpers = useHelpersStore()
const ui = useUiStore()
const sessions = useSessionsStore()

/** Cross-platform basename/dirname — the renderer has no node `path`. */
function basename(p: string): string {
  return (
    p
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() || p
  )
}
function dirname(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx <= 0 ? trimmed : trimmed.slice(0, idx)
}

/** This pane's id — the {@link draftCache} key (BUG-22). */
const paneId = props.pane.id
/**
 * A cached edit buffer restored from a prior mount of this same pane, if any. When
 * present we hydrate the refs below from it and SKIP the initial disk read — the
 * cached draft (possibly with unsaved edits) is the source of truth; re-reading
 * would clobber it. `undefined` on a genuinely first open.
 */
const cachedDraft = draftCache.get(paneId)

// The file currently shown. Starts at the pane's `filePath` (or the cached one);
// relative-link browsing updates it locally (persistence keeps the original — v1).
const activeFilePath = ref<string>(cachedDraft?.activeFilePath ?? paneFilePath.value)
const fileName = computed<string>(() => basename(activeFilePath.value))
const fileDir = computed<string>(() => dirname(activeFilePath.value))

/**
 * Rendering split (Cluster G — "open/edit ANY file"). `.md`/`.markdown` render
 * as parsed prose (unchanged since T74); every other openable file (`.txt`
 * included, plus anything the Explorer's eye icon can now open) renders as
 * plain monospace text instead — same escape hatch a viewer needs for code,
 * config, or logs it shouldn't try to parse as markdown. Mirrors the main
 * process's pure `isProseExt` (`markdown-core.ts`); duplicated here (a tiny
 * regex) rather than imported, since that module pulls `node:path` and lives
 * on the main-process side of the sandbox boundary.
 */
const isProseFile = computed<boolean>(() => /\.(md|markdown)$/i.test(activeFilePath.value))

/**
 * Image fast-path (design.md §6 — Body (image)): the confined reader
 * classifies common image extensions as `kind: 'image'` and hands back a
 * base64 data: URL instead of UTF-8 text (the CSP allows `img-src data:`).
 * The pane renders it as an `<img>` — including `.svg`, which an `<img>`
 * context neuters (scripts never run) — and hides the edit affordances
 * (editing is a UTF-8 textarea model; an image is not editable here).
 */
const fileKind = ref<'text' | 'image'>(cachedDraft?.kind ?? 'text')
const isImageFile = computed<boolean>(() => fileKind.value === 'image')

// ── Lesson mode (T120 — Harnu Learn) ──────────────────────────────────────
/**
 * A prose file whose markdown carries at least one VALID quiz block renders as an
 * interactive lesson instead of flat prose. Detection is CONTENT-based (not an
 * extension, not a frontmatter flag), so any `.md` an agent writes with a ```quiz
 * fence just works; a file with no quiz is untouched — `segments` is then a single
 * prose chunk and the render path is byte-for-byte the old one. Edit mode is
 * unaffected: a lesson is still a plain file the operator can edit.
 */
const segments = computed(() => (isProseFile.value ? parseLesson(draft.value) : []))
const isLesson = computed<boolean>(() => mode.value === 'view' && hasQuiz(segments.value))

/** questionId → the learner's answer. Reset whenever the file changes. */
const answers = ref<Record<string, QuizAnswer>>({})
/** One submit per EXAM: after grading, exam answers freeze and the key is revealed. */
const graded = ref(false)
/** Ids of checkpoints already individually checked (T123 — `mode: check`). */
const checkedIds = ref<Set<string>>(new Set())

/** Every quiz spec in the lesson, in document order. */
const quizSpecs = computed(() => segments.value.flatMap((s) => (s.kind === 'quiz' ? [s.spec] : [])))
const results = computed<QuizResult[]>(() =>
  quizSpecs.value.map((spec) => gradeQuiz(spec, answers.value[spec.id] ?? null))
)
/** Only EXAM blocks count toward the score — a checkpoint is practice, not assessment. */
const examResults = computed<QuizResult[]>(() => results.value.filter((r) => !r.spec.checkpoint))
const score = computed(() => scoreLesson(examResults.value))
/** EXAM-only specs, reused below — checkpoints never count toward the exam. */
const examSpecs = computed(() => quizSpecs.value.filter((s) => !s.checkpoint))
/** No exam block → nothing to hand in — the submit bar hides (a pure-practice lesson). */
const hasExam = computed<boolean>(() => examSpecs.value.length > 0)
/**
 * CONSTRAINT: only an answered EXAM question may arm the submit button. `answers` is a
 * single id-keyed map shared with checkpoints (T123), so checking `Object.keys(answers)`
 * directly would let checkpoint-only interaction in a mixed lesson enable — and, on a
 * misclick, one-shot-freeze — an exam the learner never touched.
 */
const anyAnswered = computed<boolean>(() => examSpecs.value.some((s) => answers.value[s.id]))

/** A block is graded when the EXAM was submitted, or when it's a checked checkpoint. */
function isGraded(spec: QuizSpec): boolean {
  return spec.checkpoint ? checkedIds.value.has(spec.id) : graded.value
}

function onAnswer(id: string, value: QuizAnswer): void {
  const spec = quizSpecs.value.find((s) => s.id === id)
  if (!spec || isGraded(spec)) return
  answers.value = { ...answers.value, [id]: value }
}

// Browsing to another file (relative link, re-target, reload) starts a NEW exam.
watch(activeFilePath, () => {
  answers.value = {}
  graded.value = false
  checkedIds.value = new Set()
})

/**
 * Deliver a summary to the teacher session through the tested paste+quiescence-submit
 * path (BUG-9/T62). Frontmatter `session:` wins; otherwise the selected session. No
 * live PTY: the learner keeps the local grade and a toast says so — we do NOT queue.
 * The single delivery path used by BOTH a checkpoint's Check and the exam's Submit.
 */
function deliver(summary: string): void {
  const targetSession = lessonSessionOverride(draft.value) ?? sessions.selectedId
  const ptyId = targetSession ? livePtyIdFor(targetSession) : null
  if (!ptyId) {
    ui.pushToast({ kind: 'warning', title: t('markdownPane.lesson.noSession') })
    return
  }
  // Reuses the tested bracketed-paste + quiescence-submit path (BUG-9/T62) — no new
  // timing logic: the lesson result lands like any other injected prompt.
  pasteAndSubmit(ptyId, summary)
  ui.pushToast({ kind: 'success', title: t('markdownPane.lesson.delivered'), timeoutMs: 2500 })
}

/**
 * Check ONE checkpoint: grade only it and deliver its result to the teacher right
 * away — this is what lets the teacher correct a misunderstanding WHILE the learner
 * is still studying. The rest of the lesson stays live (it's practice, not an exam).
 */
function checkOne(spec: QuizSpec): void {
  if (checkedIds.value.has(spec.id)) return
  checkedIds.value = new Set(checkedIds.value).add(spec.id)
  const result = gradeQuiz(spec, answers.value[spec.id] ?? null)
  deliver(formatLessonSummary(fileName.value, [result], 'checkpoint'))
}

/**
 * Submit the exam: grade locally against the key embedded in the file, then deliver
 * ONE summary message to the teacher session.
 *
 * Grading and delivery are deliberately INDEPENDENT — a missing session must never
 * cost the learner their feedback, so we grade first and only then try to deliver.
 * Target resolution (spec §4): frontmatter `session:` wins; otherwise the currently
 * selected session (in practice, the session the learner is studying with). No live
 * PTY → the local grade stands and a toast says so; we do NOT queue. Checkpoints are
 * excluded — they were already graded and delivered individually via `checkOne`.
 */
function submitLesson(): void {
  if (graded.value) return
  if (!anyAnswered.value) {
    ui.pushToast({ kind: 'info', title: t('markdownPane.lesson.unanswered'), timeoutMs: 3000 })
    return
  }
  graded.value = true

  deliver(formatLessonSummary(fileName.value, examResults.value))
}

type ViewState = { status: 'loading' } | { status: 'ready' } | { status: 'error'; code: string }
// A restored draft is already `ready` (no disk read needed); a fresh pane loads.
const state = ref<ViewState>(cachedDraft ? { status: 'ready' } : { status: 'loading' })

// ── Edit state (phase 2) ──────────────────────────────────────────────────
/** view = rendered prose; edit = raw textarea. */
const mode = ref<'view' | 'edit'>(cachedDraft?.mode ?? 'view')
/** The editable buffer — bound to the textarea, previewed in view mode. */
const draft = ref<string>(cachedDraft?.draft ?? '')
/** The last-loaded/saved on-disk content — the dirty baseline. */
const savedContent = ref<string>(cachedDraft?.savedContent ?? '')
/** Unsaved edits present? Drives the dirty dot + the Save enablement + guards. */
const dirty = computed<boolean>(() => draft.value !== savedContent.value)
const editorEl = ref<HTMLTextAreaElement | null>(null)

/**
 * Live-reload (T171): the backing file changed on disk while the pane had
 * unsaved edits. A clean pane just silently re-reads instead — see
 * `handleMarkdownChanged` below and design.md §6 "Stale-on-disk banner".
 */
const staleOnDisk = ref(false)

/** Whitespace-only (a freshly-created "New markdown" file) → drop straight into edit. */
function isBlank(s: string): boolean {
  return s.trim().length === 0
}

/** markdown read/write deny code → i18n subkey under `markdownPane.error`. */
function errorKey(code: string): string {
  const map: Record<string, string> = {
    'outside-roots': 'outsideRoots',
    binary: 'binary',
    'too-large': 'tooLarge',
    'not-found': 'notFound',
    'read-failed': 'readFailed',
    'write-failed': 'writeFailed',
    'invalid-path': 'readFailed'
  }
  return `markdownPane.error.${map[code] ?? 'readFailed'}`
}
const errorMessage = computed<string>(() =>
  state.value.status === 'error' ? t(errorKey(state.value.code)) : ''
)

function applyResult(res: MarkdownReadResult, autoEditIfBlank = false, forceEdit = false): void {
  if (res.ok) {
    activeFilePath.value = res.path
    savedContent.value = res.content
    draft.value = res.content
    fileKind.value = res.kind === 'image' ? 'image' : 'text'
    // An image is never editable — view always wins over auto/forced edit.
    mode.value =
      fileKind.value === 'text' && (forceEdit || (autoEditIfBlank && isBlank(res.content)))
        ? 'edit'
        : 'view'
    state.value = { status: 'ready' }
    if (mode.value === 'edit') void focusEditor()
  } else {
    state.value = { status: 'error', code: res.code }
  }
}

async function load(path: string, autoEditIfBlank = false, forceEdit = false): Promise<void> {
  if (!path) {
    state.value = { status: 'error', code: 'invalid-path' }
    return
  }
  state.value = { status: 'loading' }
  applyResult(await window.api.markdownRead(path), autoEditIfBlank, forceEdit)
}

/**
 * Live-reload (T171): a change pushed for THIS pane's active file. A clean
 * pane re-reads silently (the common case); a dirty one never gets clobbered
 * — it raises the stale banner instead, resolved only through the same
 * discard-guard as the manual reload/close actions (see `reloadFromStaleBanner`).
 */
async function handleMarkdownChanged(payload: { path: string }): Promise<void> {
  if (payload.path !== activeFilePath.value) return
  if (dirty.value) {
    staleOnDisk.value = true
    return
  }
  await load(activeFilePath.value)
}

let unsubscribeMarkdownChanged: (() => void) | undefined

function reloadFromStaleBanner(): void {
  withDiscardGuard(() => {
    staleOnDisk.value = false
    void load(activeFilePath.value)
  })
}

async function startWatch(path: string): Promise<void> {
  await window.api.markdownWatchStart(path)
}

async function stopWatch(path: string): Promise<void> {
  await window.api.markdownWatchStop(path)
}

// Live-reload lifecycle (T171): register/unregister the watch as this pane
// mounts/unmounts, and follow it across a file re-target (see the
// `paneFilePath` watch below) — stopping the OLD path, starting the NEW one.
onMounted(() => {
  unsubscribeMarkdownChanged = window.api.onMarkdownChanged(handleMarkdownChanged)
  void startWatch(activeFilePath.value)
})

onUnmounted(() => {
  unsubscribeMarkdownChanged?.()
  void stopWatch(activeFilePath.value)
})

// On first mount a blank file (the "New markdown" flow just created it) opens
// straight in edit mode; a scaffolded proposal (T87 `initialMode:'edit'`) also
// forces edit on its populated template; any other existing file opens in view.
// A pane restored from the module cache (BUG-22) skips the read entirely — its
// draft is authoritative — and only re-focuses the editor if it was mid-edit.
onMounted(() => {
  if (cachedDraft) {
    if (mode.value === 'edit') void focusEditor()
    return
  }
  void load(activeFilePath.value, true, forceEditOnOpen.value)
})

// Mirror the working buffer into the module cache on every change, so the next
// mount of this pane restores it verbatim (BUG-22). Only cache once `ready` — the
// loading/error placeholder must never overwrite a real draft.
watch([activeFilePath, draft, savedContent, mode, state, fileKind], () => {
  if (state.value.status !== 'ready') return
  draftCache.set(paneId, {
    activeFilePath: activeFilePath.value,
    draft: draft.value,
    savedContent: savedContent.value,
    mode: mode.value,
    kind: fileKind.value
  })
})

// The store may swap the pane's file (an `open_file` re-targeting the same pane
// id, or a dedup hit). Reload when it genuinely changes, guarding unsaved edits.
watch(
  () => paneFilePath.value,
  (next) => {
    if (next && next !== activeFilePath.value) withDiscardGuard(() => void load(next))
  }
)

// Follow the pane's file across a re-target: stop watching the old path, start
// watching the new one. A stale banner from the old file no longer applies.
watch(
  () => paneFilePath.value,
  async (next, prev) => {
    if (prev) await stopWatch(prev)
    if (next) await startWatch(next)
    staleOnDisk.value = false
  }
)

/**
 * Run `proceed` unless there are unsaved edits — then surface a non-blocking
 * "unsaved changes" toast whose action discards + proceeds (mirrors the store's
 * stale-session toast pattern; no blocking `window.confirm`, which would freeze
 * the extension). Reused by reload + relative-link browsing + file re-target.
 */
function withDiscardGuard(proceed: () => void): void {
  if (!dirty.value) {
    proceed()
    return
  }
  ui.pushToast({
    kind: 'warning',
    title: t('markdownPane.unsaved.title'),
    timeoutMs: 0,
    action: { label: t('markdownPane.unsaved.discard'), handler: proceed }
  })
}

/** A relative `.md` link was clicked — resolve it against the current file's
 * dir in main (which re-confines), then browse in place. Out-of-root / binary
 * fails closed with a steer toast, never opening blindly (§3.5). Guards unsaved
 * edits so browsing away never silently drops them. */
function onRelativeLink(href: string): void {
  const raw = href.split('#')[0]
  if (!raw) return
  withDiscardGuard(async () => {
    const res = await window.api.markdownRead(raw, fileDir.value)
    if (res.ok) applyResult(res)
    else ui.pushToast({ kind: 'warning', title: t('markdownPane.relativeSteer') })
  })
}

/** Re-read the file from disk (v1 has no live-reload watcher), guarding edits. */
function reload(): void {
  withDiscardGuard(() => void load(activeFilePath.value))
}

function toggleMode(): void {
  if (isImageFile.value) return // images are view-only (button is hidden too)
  mode.value = mode.value === 'edit' ? 'view' : 'edit'
  if (mode.value === 'edit') void focusEditor()
}

async function focusEditor(): Promise<void> {
  await nextTick()
  editorEl.value?.focus()
}

/**
 * Persist the draft through the confined `markdown:write` IPC (same known-folder
 * containment + extension + size cap as the reader). On success the baseline
 * moves to the draft (dirty clears); on refusal a localized toast names the
 * reason by code. No-op when clean or not ready.
 */
async function save(): Promise<void> {
  if (state.value.status !== 'ready' || !dirty.value) return
  const res = await window.api.markdownWrite(activeFilePath.value, draft.value)
  if (res.ok) {
    savedContent.value = draft.value
    staleOnDisk.value = false
    ui.pushToast({ kind: 'success', title: t('markdownPane.saved'), timeoutMs: 2500 })
  } else {
    ui.pushToast({ kind: 'danger', title: t(errorKey(res.code)) })
  }
}

/** ⌘/Ctrl-S saves from within the editor (preventing the browser Save dialog). */
function onEditorKeydown(ev: KeyboardEvent): void {
  if ((ev.metaKey || ev.ctrlKey) && (ev.key === 's' || ev.key === 'S')) {
    ev.preventDefault()
    void save()
  }
}

/**
 * "Copy file" toolbar action (T121, design.md §6). Copies the **raw `draft` buffer**
 * (unsaved edits included) — never the rendered HTML, so a markdown file copied out of
 * Harnu pastes back into any editor as markdown. Same idle/copied icon-swap idiom (~1.5s)
 * as the per-block copy button in `MarkdownRenderer.vue`.
 */
const COPIED_RESET_MS = 1500
const fileCopied = ref(false)
let fileCopiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyFileContents(): Promise<void> {
  try {
    await navigator.clipboard.writeText(draft.value)
  } catch {
    ui.pushToast({ kind: 'danger', title: t('markdownPane.copyFailed') })
    return
  }
  fileCopied.value = true
  clearTimeout(fileCopiedTimer)
  fileCopiedTimer = setTimeout(() => {
    fileCopied.value = false
  }, COPIED_RESET_MS)
}

onUnmounted(() => clearTimeout(fileCopiedTimer))

/**
 * Close the pane, guarding unsaved edits (BUG-22). A dirty draft surfaces the same
 * non-blocking "unsaved changes" toast as reload/browse — closing is deferred until
 * the operator confirms discard (no blocking `window.confirm`, which would freeze
 * the extension). On an actual close the cached draft is dropped so it can't leak.
 */
function onClose(): void {
  withDiscardGuard(() => {
    draftCache.delete(paneId)
    helpers.removeHelper(props.worktreePath, props.pane.id)
  })
}

/** Begin an inter-pane resize drag when the header (not a button) is pressed. */
function onHeaderMouseDown(ev: MouseEvent): void {
  if (props.resizable) emit('headerMouseDown', ev)
}

/** Whether THIS pane is the one currently maximized in its worktree's stack. */
const isMaximized = computed(() => helpers.maximizedPaneId(props.worktreePath) === props.pane.id)
function onToggleMaximize(): void {
  helpers.toggleMaximizePane(props.worktreePath, props.pane.id)
}
</script>

<template>
  <!-- Mirrors HelperPane's shell: an absolute 24px header over a padded body.
       Unlike HelperPane the body is a normal scroll container (no xterm host),
       so it needs no padding-top hack — the header sits in flow at the top. -->
  <div
    class="flex h-full w-full flex-col overflow-hidden bg-bg"
    :aria-label="$t('markdownPane.label')"
  >
    <header
      class="flex h-6 shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2 text-[11px] text-text-2 transition-colors"
      :class="
        resizable ? 'cursor-row-resize border-t border-t-border-2 hover:border-t-accent-line' : ''
      "
      @mousedown="onHeaderMouseDown"
    >
      <!-- Stale-on-disk banner (T171, design.md §6): replaces the filename row
           when the file changed on disk while the pane has unsaved edits. -->
      <template v-if="staleOnDisk">
        <span
          data-testid="markdown-stale-banner"
          class="anim-fade-in flex min-w-0 flex-1 items-center gap-1.5 rounded bg-warning/10 px-1 text-warning"
        >
          <span class="truncate">{{ $t('markdownPane.changedOnDisk.title') }}</span>
          <button
            class="shrink-0 underline underline-offset-2 hover:no-underline"
            @mousedown.stop
            @click="reloadFromStaleBanner"
          >
            {{ $t('markdownPane.changedOnDisk.reload') }}
          </button>
        </span>
      </template>
      <template v-else>
        <FileText :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
        <span class="min-w-0 flex-1 truncate" :title="activeFilePath">{{ fileName }}</span>
      </template>
      <!-- Dirty indicator: an accent dot when the draft has unsaved edits. -->
      <span
        v-if="dirty"
        class="shrink-0 text-accent"
        style="font-size: 14px; line-height: 1"
        :title="$t('markdownPane.unsaved.title')"
        :aria-label="$t('markdownPane.unsaved.title')"
        >•</span
      >
      <template v-if="state.status === 'ready'">
        <!-- View⇄Edit toggle (pencil in view, eye in edit). Hidden for an
             image (design.md §6 — Body (image)): not editable. -->
        <button
          v-if="!isImageFile"
          class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
          style="width: 18px; height: 18px"
          :title="mode === 'edit' ? $t('markdownPane.viewMode') : $t('markdownPane.editMode')"
          :aria-label="mode === 'edit' ? $t('markdownPane.viewMode') : $t('markdownPane.editMode')"
          @mousedown.stop
          @click="toggleMode"
        >
          <Eye v-if="mode === 'edit'" :size="12" :stroke-width="1.5" />
          <Pencil v-else :size="12" :stroke-width="1.5" />
        </button>
        <!-- Explicit save (edit mode only), disabled while clean. -->
        <button
          v-if="mode === 'edit'"
          class="flex shrink-0 items-center justify-center rounded transition"
          :class="
            dirty
              ? 'text-accent hover:bg-surface-2'
              : 'cursor-default text-text-disabled hover:bg-transparent'
          "
          style="width: 18px; height: 18px"
          :disabled="!dirty"
          :title="$t('markdownPane.save')"
          :aria-label="$t('markdownPane.save')"
          @mousedown.stop
          @click="save"
        >
          <Save :size="12" :stroke-width="1.5" />
        </button>
      </template>
      <!-- Copy file contents (T121, design.md §6): raw draft buffer, hidden for images. -->
      <button
        v-if="state.status === 'ready' && !isImageFile"
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('markdownPane.copyFile')"
        :aria-label="$t('markdownPane.copyFile')"
        @mousedown.stop
        @click="copyFileContents"
      >
        <Check v-if="fileCopied" :size="12" :stroke-width="1.5" class="text-green" />
        <Copy v-else :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('markdownPane.reload')"
        :aria-label="$t('markdownPane.reload')"
        @mousedown.stop
        @click="reload"
      >
        <RotateCcw :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize')"
        :aria-label="isMaximized ? $t('helperPane.restore') : $t('helperPane.maximize')"
        @mousedown.stop
        @click="onToggleMaximize"
      >
        <Minimize2 v-if="isMaximized" :size="12" :stroke-width="1.5" />
        <Maximize2 v-else :size="12" :stroke-width="1.5" />
      </button>
      <button
        class="-mr-1 flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :title="$t('helperPane.close')"
        :aria-label="$t('helperPane.close')"
        @mousedown.stop
        @click="onClose"
      >
        <X :size="12" :stroke-width="1.5" />
      </button>
    </header>

    <!-- Edit mode fills the pane with a raw textarea (no inner scroll padding);
         view/loading/error share the padded scroll container. -->
    <textarea
      v-if="state.status === 'ready' && mode === 'edit'"
      ref="editorEl"
      v-model="draft"
      class="md-editor min-h-0 flex-1 resize-none bg-bg text-text-2 outline-none"
      spellcheck="false"
      :aria-label="$t('markdownPane.editMode')"
      @keydown="onEditorKeydown"
    ></textarea>
    <div v-else class="scrollable min-h-0 flex-1 overflow-y-auto" style="padding: 14px 16px">
      <div v-if="state.status === 'loading'" class="text-text-3" style="font-size: 12px">
        {{ $t('markdownPane.loading') }}
      </div>
      <div
        v-else-if="state.status === 'error'"
        class="flex h-full items-center justify-center text-center text-text-3"
        style="font-size: 12px; padding: 24px"
      >
        {{ errorMessage }}
      </div>
      <!-- Image fast-path (design.md §6 — Body (image)): the reader returned a
           data: URL — render it centered as an <img> (which also neuters .svg
           scripts). alt = the filename (a technical noun, no i18n key). -->
      <div v-else-if="isImageFile" class="image-host">
        <img class="image-view" :src="draft" :alt="fileName" />
      </div>
      <!-- Lesson mode (T120): alternating prose + interactive quiz widgets. The prose
           chunks still go through the SAME sanitized MarkdownRenderer seam; the quiz
           fences render as components (which a v-html string could never host). -->
      <template v-else-if="isProseFile && isLesson">
        <template v-for="(seg, i) in segments" :key="i">
          <MarkdownRenderer
            v-if="seg.kind === 'prose'"
            :source="seg.markdown"
            :link-base="fileDir"
            @relative-link="onRelativeLink"
          />
          <QuizBlock
            v-else
            :spec="seg.spec"
            :answer="answers[seg.spec.id] ?? null"
            :graded="isGraded(seg.spec)"
            @answer="onAnswer(seg.spec.id, $event)"
            @check="checkOne(seg.spec)"
          />
        </template>
        <!-- One submit per LESSON (design.md §6 — Barra de submit); after grading the
             button is replaced by the score and the answers freeze. Hidden entirely
             when the lesson has no exam block (§6 — Checkpoint): pure practice, no
             prova to hand in. -->
        <div v-if="hasExam" class="lesson-bar">
          <button
            v-if="!graded"
            class="lesson-submit"
            :disabled="!anyAnswered"
            @click="submitLesson"
          >
            {{ $t('markdownPane.lesson.submit') }}
          </button>
          <span v-else class="lesson-score anim-fade-in">
            {{ $t('markdownPane.lesson.score', { correct: score.correct, total: score.gradable }) }}
          </span>
        </div>
      </template>
      <!-- .md/.markdown → parsed prose (unchanged); every other openable file
           (Cluster G) → plain monospace text, not run through the markdown parser. -->
      <MarkdownRenderer
        v-else-if="isProseFile"
        :source="draft"
        :link-base="fileDir"
        @relative-link="onRelativeLink"
      />
      <pre v-else class="plain-text-view">{{ draft }}</pre>
    </div>
  </div>
</template>

<style scoped>
/* Raw editor surface (design.md §6 — Markdown pane · edit mode): monospace,
   the same prose scale as the rendered `pre`, mapped only to §9 tokens. */
.md-editor {
  width: 100%;
  border: 0;
  padding: 14px 16px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  tab-size: 2;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

/* View-mode plain-text render (Cluster G — any non-prose openable file): the
   SAME monospace scale/tokens as `.md-editor`, just read-only and un-padded
   (the `.scrollable` container already carries the 14px/16px padding). No new
   §9 token — reuses --font-mono + --color-text-2. */
.plain-text-view {
  margin: 0;
  width: 100%;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  tab-size: 2;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--color-text-2);
}

/* Image preview (design.md §6 — Body (image)): centered on both axes inside
   the padded scroll container; the img never overflows the pane's width and a
   --color-surface backdrop grounds transparent PNGs/SVGs. No new §9 token. */
.image-host {
  display: flex;
  min-height: 100%;
  align-items: center;
  justify-content: center;
}
.image-view {
  max-width: 100%;
  border-radius: var(--radius-sm);
  background: var(--color-surface);
}

/* Lesson submit bar (design.md §6 — Quiz block · Barra de submit). ONE submit per
   lesson; after grading the button is replaced by the score. Tokens only. */
.lesson-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px solid var(--color-border);
}
.lesson-submit {
  background: var(--color-accent);
  color: var(--color-accent-ink);
  border-radius: var(--radius-sm);
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 600;
  transition: opacity var(--dur-fast) var(--ease);
}
.lesson-submit:hover:not(:disabled) {
  opacity: 0.9;
}
.lesson-submit:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.lesson-score {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}
</style>
