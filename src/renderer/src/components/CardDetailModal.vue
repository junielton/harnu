<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Archive,
  Check,
  ExternalLink,
  FileText,
  GitBranch,
  Link2,
  Rocket,
  Sparkles,
  Trash2,
  X
} from 'lucide-vue-next'
import MarkdownRenderer from './MarkdownRenderer.vue'
import {
  buildAnswerAppend,
  linkedRefsOf,
  parseCardBody,
  relationOf,
  toggleAcceptanceCriterion,
  type CardAppend,
  type LinkRelation,
  type OpenQuestion
} from '../lib/card-detail'
import { DATA_DIR } from '../../../shared/data-dir'
import { deriveExecutedBranch } from '../lib/board-filters'
import {
  useRoadmapStore,
  lintCardReadiness,
  artifactRequirements,
  type ArtifactKey
} from '../stores/roadmap'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import type { RoadmapCard, ColumnKey, RoadmapWriteCode } from '../../../preload'

/**
 * Card detail modal — the card's dossier (design.md §6, card-detail PRD §2-S1..S4).
 * Renders the fixed single-column anatomy over the parsed body
 * (`lib/card-detail.ts`): header chips → title (click-to-edit, S2) → Goal →
 * Acceptance criteria (checkbox state from `- [x]`, LIVE toggle writes through
 * `replaceBody`, S2) → Open questions (per-question answered/open blocks, LIVE
 * Send → provenance-stamped append, S4) → Docs (state-aware per artifact, S3;
 * Generate on a required-missing row, S4) → Linked cards (deps/parent/[[slug]]
 * — clicking navigates the modal) → Context → Trail (dispatched-with, bound
 * session with the canonical fleet-state dot, evidence, provenance-stamped
 * appends in order, answer-appends excluded — they render inline above) →
 * Actions footer (Edit/Move/Dispatch, S2). Edit mode (S2) swaps the WHOLE
 * dossier body (Goal through Trail — the raw body already carries the Trail's
 * appends as their literal stamped chunks) for one raw-markdown textarea;
 * Save/Cancel live beside it, not in the footer.
 *
 * Maximize is deliberately unspecced (OQ3).
 */

const props = defineProps<{
  card: RoadmapCard
  /** T190: the repo's local branch names — backs the derived-owner fallback (D4). */
  localBranches?: readonly string[]
}>()
const emit = defineEmits<{
  close: []
  /** Navigate the modal to a linked card (its slug on this board). */
  navigate: [slug: string]
  openSession: [card: RoadmapCard]
  /** Open a card doc (spec/prd/adr) in the markdown pane (raw frontmatter value). */
  openDoc: [path: string]
  /** Dispatch this card — the board closes the modal into its own confirm flow. */
  dispatch: [card: RoadmapCard]
  /** T130 S4 (M8-Generate): Generate a required-missing artifact — the board
   *  routes this through the SAME dispatch confirm as `dispatch` above. */
  generate: [card: RoadmapCard, artifact: ArtifactKey]
}>()

const { t } = useI18n()
const roadmap = useRoadmapStore()
const sessions = useSessionsStore()
const ui = useUiStore()

const parsed = computed(() => parseCardBody(props.card.body ?? ''))

/**
 * T190: the "Executed in" row's value — the stamped `executedIn` (owner), else
 * the same runtime-only derived-guess fallback the board card's dashed chip
 * uses (D4, never persisted). `null` when neither is known — the row is
 * omitted entirely rather than showing a placeholder dash.
 */
const executedInInfo = computed<{ branch: string; derived: boolean } | null>(() => {
  if (props.card.executedIn) return { branch: props.card.executedIn, derived: false }
  const derived = deriveExecutedBranch(props.card.id, props.localBranches ?? [])
  return derived ? { branch: derived, derived: true } : null
})

/** Localized steer for a `RoadmapWriteCode` failure — mirrors `RoadmapBoard.writeError`. */
function writeError(code: RoadmapWriteCode): string {
  return t(`roadmap.dispatch.error.${code}`)
}

// ---- Edit mode (S2 — full-replace raw textarea) --------------------------------
const editing = ref(false)
const draft = ref('')
const editTextareaRef = ref<HTMLTextAreaElement | null>(null)

const dirty = computed(() => editing.value && draft.value !== (props.card.body ?? ''))

function startEdit(): void {
  draft.value = props.card.body ?? ''
  editing.value = true
  void nextTick(() => editTextareaRef.value?.focus())
}

/**
 * Run `proceed` unless the editor is dirty — then surface a non-blocking
 * "unsaved changes" toast whose action discards + proceeds (BUG-22 lesson,
 * mirrors `MarkdownPane.withDiscardGuard`; never a blocking `window.confirm`,
 * which would freeze the extension). Reused by Esc, the backdrop, and Cancel.
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

/** Esc / backdrop / header ✕ — close the whole modal, guarded when dirty. */
function attemptCloseModal(): void {
  // A pending title edit commits on close, same as it would on blur — never
  // silently discarded (unlike the body editor, which is gated by the dirty
  // guard below; a single-line title edit is low-stakes enough to just save).
  if (editingTitle.value) void commitTitle()
  withDiscardGuard(() => {
    editing.value = false
    emit('close')
  })
}

/** Cancel — exit edit mode back to read mode, guarded when dirty. */
function attemptCancelEdit(): void {
  withDiscardGuard(() => {
    editing.value = false
  })
}

async function doSave(): Promise<void> {
  const res = await roadmap.replaceBody(props.card.slug, draft.value)
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: writeError(res.code) })
    return
  }
  editing.value = false
}

/** Save — a manifest-stamped card warns FIRST (proceed allowed, zero friction). */
function save(): void {
  if (props.card.approved) {
    ui.pushToast({
      kind: 'warning',
      title: t('roadmap.detail.stampVoidTitle'),
      description: t('roadmap.detail.stampVoidBody'),
      action: { label: t('roadmap.detail.saveAnyway'), handler: () => void doSave() }
    })
    return
  }
  void doSave()
}

/**
 * Live AC checkbox toggle (S2): a targeted single-line rewrite through the
 * SAME `replaceBody` door, not a full edit-mode save. A stamp-void from this
 * write surfaces the SAME warning as Save, but AFTER the write — a single
 * checkbox flip is zero-friction, it doesn't warrant a pre-write gate.
 */
async function toggleAc(index: number): Promise<void> {
  const next = toggleAcceptanceCriterion(props.card.body ?? '', index)
  const res = await roadmap.replaceBody(props.card.slug, next)
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: writeError(res.code) })
    return
  }
  if (res.stampVoided) {
    ui.pushToast({
      kind: 'warning',
      title: t('roadmap.detail.stampVoidTitle'),
      description: t('roadmap.detail.stampVoidBody')
    })
  }
}

// ---- Open questions (S4, E7) — per-question answer draft + Send ----------------
/** One draft per OPEN question, keyed by its index in `parsed.questions` — a
 *  question's index is stable within one render (order comes straight off the
 *  body's `## Open questions` section, unaffected by which are answered). */
const answerDrafts = ref<Record<number, string>>({})

/** Count of unanswered questions (E7, PRD OQ1: questions only) — feeds the
 *  section header's `{n} open` badge, same predicate `parseOpenQuestions` uses. */
const openQuestionCount = computed(() => parsed.value.questions.filter((q) => !q.answered).length)

/** Send: compose the `> answers: …` anchor and append it through the human
 *  door — the SAME provenance-stamped write the Trail already renders. */
async function sendAnswer(index: number): Promise<void> {
  const question = parsed.value.questions[index]
  const draft = (answerDrafts.value[index] ?? '').trim()
  if (!question || !draft) return
  const entry = buildAnswerAppend(question.text, draft)
  const res = await roadmap.appendBody(props.card.slug, entry)
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: writeError(res.code) })
    return
  }
  delete answerDrafts.value[index]
  if (res.stampVoided) {
    ui.pushToast({
      kind: 'warning',
      title: t('roadmap.detail.stampVoidTitle'),
      description: t('roadmap.detail.stampVoidBody')
    })
  }
}

// ---- Title inline edit (S2) -----------------------------------------------------
const editingTitle = ref(false)
const titleDraft = ref('')
const titleInputRef = ref<HTMLInputElement | null>(null)

function startTitleEdit(): void {
  titleDraft.value = props.card.title
  editingTitle.value = true
  void nextTick(() => titleInputRef.value?.focus())
}

function cancelTitleEdit(): void {
  editingTitle.value = false
}

async function commitTitle(): Promise<void> {
  if (!editingTitle.value) return
  editingTitle.value = false
  const next = titleDraft.value.trim()
  if (!next || next === props.card.title) return
  const res = await roadmap.setTitle(props.card.slug, next)
  if (!res.ok) ui.pushToast({ kind: 'danger', title: writeError(res.code) })
}

// ---- Copy-link header button (S2) ------------------------------------------------
async function copyLink(): Promise<void> {
  const path = `${DATA_DIR}/memory/roadmap/${props.card.slug}.md`
  try {
    await navigator.clipboard.writeText(path)
    ui.pushToast({ kind: 'success', title: t('roadmap.detail.copyLinkToast') })
  } catch (err) {
    console.warn('[CardDetailModal] copy-link failed:', err)
  }
}

// ---- Actions footer (S2 — Move / readiness hint / Dispatch) ---------------------
const MOVE_TARGETS: readonly ColumnKey[] = ['backlog', 'ready', 'review']

async function moveTo(target: ColumnKey): Promise<void> {
  if (props.card.column === target) return
  const res = await roadmap.setStatus(props.card.slug, target)
  if (!res.ok) ui.pushToast({ kind: 'danger', title: writeError(res.code) })
}

/** Same visibility condition as the board row's own Dispatch button. */
const canDispatch = computed(
  () => !props.card.session && (props.card.column === 'backlog' || props.card.column === 'ready')
)

/**
 * T148: Archive/Delete are disabled while a card is actively dispatched — the
 * bound session keeps running either way, but pulling the card out from under
 * it mid-flight would lose the live record. Move it to Review first.
 */
const canManage = computed(() => props.card.column !== 'in-progress')

/**
 * T148: archive — moves the card file into `roadmap-archive/`. Reversible, so
 * no confirm: a toast with Undo (same pattern as `doClose`'s session-archive
 * toast, RoadmapBoard.vue) closes the loop. Closes the modal either way since
 * the card just left the active board. Gated behind the unsaved-edit discard
 * guard so a dirty editor can't be silently dropped by the destructive action.
 */
function archiveCard(): void {
  withDiscardGuard(() => void doArchive())
}

async function doArchive(): Promise<void> {
  const slug = props.card.slug
  // Capture the originating folder BEFORE the archive so a later Undo restores
  // into THIS board, not whatever folder happens to be open when Undo is
  // clicked (the board may have navigated away in the meantime).
  const folder = roadmap.folderPath ?? undefined
  const res = await roadmap.archiveCard(slug)
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: writeError(res.code) })
    return
  }
  emit('close')
  ui.pushToast({
    kind: 'info',
    title: t('roadmap.detail.archivedToast'),
    action: {
      label: t('roadmap.undoArchive'),
      handler: () => void roadmap.restoreCard(slug, folder)
    }
  })
}

/**
 * T148: permanently delete the card file. Irreversible, so gated behind a
 * native confirm — the same precedent `SessionMenu.vue`'s delete uses — and
 * behind the unsaved-edit discard guard, which resolves first so a dirty editor
 * is never lost without the operator's explicit discard.
 */
function deleteCard(): void {
  withDiscardGuard(() => void doDelete())
}

async function doDelete(): Promise<void> {
  if (!window.confirm(t('roadmap.detail.deleteConfirm'))) return
  const res = await roadmap.deleteCard(props.card.slug)
  if (!res.ok) {
    ui.pushToast({ kind: 'danger', title: writeError(res.code) })
    return
  }
  emit('close')
}

const readinessGaps = computed(() => lintCardReadiness(props.card).map((g) => g.code))
const readinessLabel = computed(() => {
  const gaps = readinessGaps.value
  if (gaps.length === 0) return t('roadmap.detail.readinessOk')
  const detail = gaps.map((code) => t(`roadmap.card.readiness.${code}`)).join('; ')
  return t('roadmap.detail.readinessGaps', { count: gaps.length, detail })
})

// ---- Docs (S3, T130 — fully state-aware, ONE predicate: `artifactRequirements`) --
type DocRowState = 'present' | 'missing' | 'na'
interface DocRow {
  key: ArtifactKey
  state: DocRowState
  path?: string
}

function docPathFor(key: ArtifactKey): string | undefined {
  if (key === 'spec') return props.card.spec
  if (key === 'prd') return props.card.prd
  return props.card.adr
}

/** spec/PRD/ADR are technical nouns (design.md §8) — never localized. */
function artifactLabel(key: ArtifactKey): string {
  if (key === 'prd') return 'PRD'
  if (key === 'adr') return 'ADR'
  return 'spec'
}

/**
 * Docs rows (M8): present (field truthy) → path + open-in-pane; required-and-
 * missing → warning row (no Generate yet — PR5); not required → dashed `na`
 * row. Fed by the EXACT same `artifactRequirements` predicate the board badges
 * and the readiness hint above read — they can never disagree.
 */
const artifactRows = computed<DocRow[]>(() =>
  artifactRequirements(props.card).map((req) => {
    const path = docPathFor(req.key)
    if (path) return { key: req.key, state: 'present', path }
    return { key: req.key, state: req.required ? 'missing' : 'na' }
  })
)

/** Hide the whole Docs section when every row is `na` (nothing present, nothing
 *  required) — a trivial/simple card with no artifacts stays uncluttered. */
const hasDocsToShow = computed(() => artifactRows.value.some((row) => row.state !== 'na'))

/**
 * Presence-detection convention scan (E6, PRD §2-S3): DISPLAY-only hint shown
 * on a missing row when `docs/prds/<id>-*.md` / `docs/adr/<id>-*.md` exists —
 * never durable, only the explicit `prd:`/`adr:` field is.
 */
const scanResult = ref<{ prd: string | null; adr: string | null }>({ prd: null, adr: null })

async function refreshScan(): Promise<void> {
  scanResult.value = await roadmap.scanArtifacts(props.card.id)
}

watch(
  () => props.card.slug,
  () => void refreshScan(),
  { immediate: true }
)

function scanHintFor(key: ArtifactKey): string | null {
  if (key === 'prd') return scanResult.value.prd
  if (key === 'adr') return scanResult.value.adr
  return null
}

/** Doc row container tokens per state — mockup-canonical (`.docrow`/`.missing`/`.na`). */
function docRowClass(row: DocRow): string {
  if (row.state === 'missing') return 'border-warning bg-red-soft'
  if (row.state === 'na') return 'border-dashed border-border-2 bg-transparent'
  return 'border-border bg-surface'
}

// ---- Header chips ------------------------------------------------------------
function columnLabel(col: ColumnKey): string {
  return t(`roadmap.columns.${col}`)
}

/** Kind chip tokens — mirrors the mockup's bug/feature accents (existing tokens only). */
function kindChipClass(kind: string): string {
  if (kind === 'bug') return 'border-transparent bg-red-soft text-red'
  if (kind === 'feature') return 'border-accent-line bg-accent-soft text-accent'
  return 'border-border-2 bg-surface-2 text-text-3'
}

// ---- Linked cards --------------------------------------------------------------
interface LinkedChip {
  ref: string
  card: RoadmapCard | null
  /** M9: `← blocked-by` / `→ blocks` / `· done` — null when direction doesn't apply. */
  relation: LinkRelation | null
}

/** The open card's own id+slug — what a reverse-dep scan checks the OTHER card's deps against. */
const ownRefs = computed(() => [props.card.id, props.card.slug])

/** deps + parent + [[slug]] refs, resolved against the open board (null = not here),
 *  each carrying its M9 relation label (deps direction only — see `relationOf`). */
const linked = computed<LinkedChip[]>(() =>
  linkedRefsOf(props.card, parsed.value.wikilinks).map((ref) => {
    const card = roadmap.cards.find((c) => c.slug === ref || c.id === ref) ?? null
    return {
      ref,
      card,
      relation: relationOf(ref, card, props.card.deps, ownRefs.value)
    }
  })
)

/** `blocked-by`/`blockedBy`/`blocks`/`done` → the i18n key segment (`roadmap.detail.relation.*`). */
function relationI18nKey(relation: LinkRelation): 'blockedBy' | 'blocks' | 'done' {
  return relation === 'blocked-by' ? 'blockedBy' : relation
}

// ---- Trail ---------------------------------------------------------------------
/** Fold the bound session's CANONICAL fleet-state (same classifier as the board)
 *  onto the four dot kinds — mirror of `RoadmapBoard.dotKindOf`. */
const sessionDotKind = computed<'working' | 'needs-you' | 'stuck' | 'idle' | null>(() => {
  const s = props.card.session ? sessions.fleetStateFor(props.card.session) : null
  if (!s) return null
  if (s === 'working') return 'working'
  if (s === 'stuck') return 'stuck'
  if (s === 'needs-you' || s === 'return-here') return 'needs-you'
  return 'idle'
})

const sessionDotClass = computed(() => {
  switch (sessionDotKind.value) {
    case 'working':
      return 'anim-pulse-dot bg-green'
    case 'needs-you':
      return 'anim-attention-dot bg-warning'
    case 'stuck':
      return 'border border-red bg-surface'
    case 'idle':
      return 'bg-text-4'
    default:
      return 'border border-border-2 bg-surface-2'
  }
})

const sessionShort = computed(() => (props.card.session ?? '').slice(0, 8))
const sessionStateLabel = computed(() =>
  sessionDotKind.value ? t(`roadmap.card.state.${sessionDotKind.value}`) : ''
)

const hasTrail = computed(
  () =>
    Boolean(parsed.value.dispatchedWith) ||
    Boolean(props.card.session) ||
    props.card.evidence.length > 0 ||
    parsed.value.appends.length > 0
)

/** "agent · 2026-07-10" eyebrow for a stamped append ('' = unstamped tail). */
function appendEyebrow(ap: CardAppend): string {
  if (!ap.provenance?.author) return ''
  const author = t(`roadmap.detail.author.${ap.provenance.author}`)
  return ap.provenance.at ? `${author} · ${ap.provenance.at}` : author
}

/** "answered · human · 2026-07-11" eyebrow (S4, mockup-canonical `.ans .eyebrow`). */
function questionEyebrow(q: OpenQuestion): string {
  const author = t(`roadmap.detail.author.${q.provenance?.author ?? 'human'}`)
  return q.provenance?.at
    ? t('roadmap.detail.questionAnsweredWithDate', { author, date: q.provenance.at })
    : t('roadmap.detail.questionAnsweredNoDate', { author })
}

// ---- Close (Esc / backdrop / ✕) — guarded when the editor is dirty (BUG-22) ----
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    attemptCloseModal()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <div
      class="anim-overlay-fade fixed inset-0 z-[65] flex items-center justify-center bg-black/40"
      @click.self="attemptCloseModal"
    >
      <div
        class="anim-fade-in-scale flex max-h-[88vh] w-[min(760px,94vw)] flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-pop"
        role="dialog"
        aria-modal="true"
        :aria-label="card.title"
      >
        <!-- 1 · Header: status chip · id · kind/complexity/priority chips · close -->
        <div class="flex shrink-0 items-center gap-2 px-3.5 pt-3">
          <span
            class="inline-flex items-center gap-1.5 rounded-full border border-border-2 bg-surface-2 px-2 py-0.5 text-[11px] text-text-2"
          >
            <span class="h-1.5 w-1.5 rounded-full border border-text-4" />
            {{ columnLabel(card.column) }}
          </span>
          <span class="min-w-0 truncate font-mono text-[11.5px] text-text-3">{{ card.id }}</span>
          <span
            v-if="card.kind"
            class="rounded-sm border px-1.5 py-px text-[10px]"
            :class="kindChipClass(card.kind)"
            :title="$t('roadmap.card.kindHint')"
          >
            {{ card.kind }}
          </span>
          <span
            v-if="card.complexity"
            class="rounded-sm border border-border-2 bg-surface-2 px-1.5 py-px text-[10px] text-text-3"
            :title="$t('roadmap.card.complexityHint')"
          >
            {{ card.complexity }}
          </span>
          <span
            v-if="card.priority"
            class="rounded-sm bg-red-soft px-1.5 py-px text-[10px] font-medium text-warning"
          >
            {{ card.priority }}
          </span>
          <span class="flex-1" />
          <button
            class="flex shrink-0 items-center justify-center rounded p-1 text-text-4 transition hover:bg-surface-2 hover:text-text-2"
            :title="$t('roadmap.detail.copyLink')"
            :aria-label="$t('roadmap.detail.copyLink')"
            @click="copyLink"
          >
            <Link2 :size="14" :stroke-width="1.7" />
          </button>
          <button
            class="flex shrink-0 items-center justify-center rounded p-1 text-text-4 transition hover:bg-surface-2 hover:text-text-2"
            :title="$t('roadmap.detail.close')"
            :aria-label="$t('roadmap.detail.close')"
            @click="attemptCloseModal"
          >
            <X :size="14" :stroke-width="1.7" />
          </button>
        </div>

        <!-- T190: Born in / Executed in — two compact rows directly below the header
             chip line, each omitted (no placeholder) when its fact is unknown. -->
        <div
          v-if="card.provenance.branch || executedInInfo"
          class="flex flex-col gap-1 px-3.5 pt-1.5"
        >
          <div v-if="card.provenance.branch" class="flex items-center gap-1.5 text-[11px]">
            <GitBranch :size="11" :stroke-width="1.6" class="shrink-0 text-text-4" />
            <span class="text-text-4">{{ $t('roadmap.detail.bornIn') }}</span>
            <span class="font-mono text-text-3">{{ card.provenance.branch }}</span>
          </div>
          <div v-if="executedInInfo" class="flex items-center gap-1.5 text-[11px]">
            <GitBranch :size="11" :stroke-width="1.6" class="shrink-0 text-text-4" />
            <span class="text-text-4">{{ $t('roadmap.detail.executedIn') }}</span>
            <span
              class="font-mono text-text-3"
              :class="executedInInfo.derived ? 'border-b border-dashed border-border-2' : ''"
              :title="executedInInfo.derived ? $t('roadmap.detail.executedInDerivedHint') : ''"
            >
              {{ executedInInfo.branch }}
            </span>
          </div>
        </div>

        <!-- Scrollable dossier body -->
        <div class="scrollable min-h-0 flex-1 overflow-y-auto px-[18px] pb-5 pt-2">
          <!-- 2 · Title (click-to-edit, S2) -->
          <h1
            v-if="!editingTitle"
            class="mb-[18px] mt-1.5 cursor-text border-b border-transparent pb-0.5 text-[16px] font-medium leading-snug text-text transition hover:border-border-2"
            :title="$t('roadmap.detail.editTitleHint')"
            @click="startTitleEdit"
          >
            {{ card.title }}
          </h1>
          <input
            v-else
            ref="titleInputRef"
            v-model="titleDraft"
            type="text"
            class="mb-[18px] mt-1.5 w-full border-b border-accent-line bg-transparent text-[16px] font-medium leading-snug text-text outline-none"
            @keydown.enter="commitTitle"
            @keydown.esc="cancelTitleEdit"
            @blur="commitTitle"
          />

          <!-- Edit mode (S2): the whole dossier body (3-9) collapses into one raw textarea -->
          <div v-if="editing">
            <textarea
              ref="editTextareaRef"
              v-model="draft"
              spellcheck="false"
              class="min-h-[320px] w-full rounded-md border border-border-2 bg-surface p-2.5 font-mono text-[12px] leading-relaxed text-text-2 outline-none transition focus:border-accent-line"
            />
            <div class="mt-2 text-[10.5px] text-text-4">{{ $t('roadmap.detail.editHint') }}</div>
            <div class="mt-2.5 flex gap-2">
              <button
                class="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink transition hover:brightness-110"
                @click="save"
              >
                {{ $t('roadmap.detail.save') }}
              </button>
              <button
                class="rounded-sm border border-border-2 bg-surface-2 px-2.5 py-1 text-[11px] text-text-2 transition hover:border-text-4 hover:text-text"
                @click="attemptCancelEdit"
              >
                {{ $t('roadmap.detail.cancel') }}
              </button>
            </div>
          </div>

          <template v-else>
            <!-- 3 · Goal -->
            <section v-if="parsed.sections.goal" class="mb-[18px]">
              <div class="eyebrow mb-1.5 text-text-4">{{ $t('roadmap.detail.goal') }}</div>
              <div class="border-l-2 border-accent-line pl-2.5">
                <MarkdownRenderer :source="parsed.sections.goal" />
              </div>
            </section>

            <!-- 4 · Acceptance criteria (checkbox state from markdown; LIVE toggle, S2) -->
            <section
              v-if="parsed.sections.acceptance.length || parsed.sections.acceptanceExtra"
              class="mb-[18px]"
            >
              <div class="eyebrow mb-1.5 text-text-4">{{ $t('roadmap.detail.acceptance') }}</div>
              <div
                v-for="(item, i) in parsed.sections.acceptance"
                :key="i"
                class="flex cursor-pointer select-none items-start gap-2 py-1 text-[12.5px] leading-relaxed"
                @click="toggleAc(i)"
              >
                <span
                  class="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border"
                  :class="
                    item.checked
                      ? 'border-green bg-green-soft text-green'
                      : 'border-border-2 bg-surface text-transparent'
                  "
                >
                  <Check :size="10" :stroke-width="3" />
                </span>
                <span :class="item.checked ? 'text-text-4 line-through' : 'text-text-2'">
                  {{ item.text }}
                </span>
              </div>
              <div v-if="parsed.sections.acceptanceExtra" class="mt-1">
                <MarkdownRenderer :source="parsed.sections.acceptanceExtra" />
              </div>
            </section>

            <!-- 5 · Open questions (S4, E7): answered blocks + inline Send for open ones -->
            <section v-if="parsed.questions.length" class="mb-[18px]">
              <div class="mb-1.5 flex items-center gap-1.5">
                <div class="eyebrow text-text-4">{{ $t('roadmap.detail.openQuestions') }}</div>
                <span
                  v-if="openQuestionCount > 0"
                  class="rounded-full bg-red-soft px-1.5 py-px text-[10px] text-warning"
                >
                  {{ $t('roadmap.detail.openBadge', { count: openQuestionCount }) }}
                </span>
              </div>
              <div v-for="(q, i) in parsed.questions" :key="i" class="mb-2.5 last:mb-0">
                <div
                  v-if="q.answered"
                  class="rounded-r-sm border-l-2 border-green bg-surface px-2.5 py-1.5"
                >
                  <div class="mb-0.5 font-mono text-[10.5px] text-text-4">
                    {{ questionEyebrow(q) }}
                  </div>
                  <p class="text-[12.5px] leading-relaxed text-text-2">{{ q.answerText }}</p>
                </div>
                <template v-else>
                  <p class="mb-1.5 text-[12.5px] leading-relaxed text-text-2">{{ q.text }}</p>
                  <div class="flex gap-1.5">
                    <input
                      v-model="answerDrafts[i]"
                      type="text"
                      class="flex-1 rounded-sm border border-border-2 bg-surface px-2 py-1 text-[11.5px] text-text outline-none transition focus:border-accent-line"
                      :placeholder="$t('roadmap.detail.answerPlaceholder')"
                      @keydown.enter="sendAnswer(i)"
                    />
                    <button
                      class="rounded-sm border border-border-2 bg-surface-2 px-2.5 py-1 text-[11px] text-text-2 transition hover:border-text-4 hover:text-text"
                      @click="sendAnswer(i)"
                    >
                      {{ $t('roadmap.detail.send') }}
                    </button>
                  </div>
                </template>
              </div>
            </section>

            <!-- 6 · Docs (M8, T130 S3/S4 — fully state-aware per artifact; Generate on a missing row) -->
            <section v-if="hasDocsToShow" class="mb-[18px]">
              <div class="eyebrow mb-1.5 text-text-4">{{ $t('roadmap.detail.docs') }}</div>
              <template v-for="row in artifactRows" :key="row.key">
                <div
                  class="mb-1.5 flex items-center gap-2 rounded-md border px-2.5 py-1.5"
                  :class="docRowClass(row)"
                >
                  <FileText
                    :size="12"
                    :stroke-width="1.7"
                    class="shrink-0"
                    :class="row.state === 'missing' ? 'text-warning' : 'text-text-4'"
                  />
                  <span
                    class="shrink-0 text-[11.5px]"
                    :class="row.state === 'missing' ? 'text-warning' : 'text-text-2'"
                  >
                    {{ artifactLabel(row.key) }}
                  </span>
                  <span
                    v-if="row.state === 'present'"
                    class="min-w-0 truncate font-mono text-[10.5px] text-text-3"
                  >
                    {{ row.path }}
                  </span>
                  <span v-else-if="row.state === 'missing'" class="text-[10.5px] text-warning">
                    {{ $t('roadmap.detail.docMissing') }}
                    <template v-if="scanHintFor(row.key)">
                      — {{ $t('roadmap.detail.docFoundHint', { path: scanHintFor(row.key) }) }}
                    </template>
                  </span>
                  <span v-else class="text-[10.5px] text-text-4">
                    {{
                      row.key === 'adr'
                        ? $t('roadmap.detail.docAdrNotDeclared')
                        : $t('roadmap.detail.docNotRequired', { tier: card.complexity })
                    }}
                  </span>
                  <Check
                    v-if="row.state === 'present'"
                    :size="11"
                    :stroke-width="2.5"
                    class="shrink-0 text-green"
                  />
                  <span class="flex-1" />
                  <button
                    v-if="row.state === 'present'"
                    class="flex shrink-0 items-center justify-center rounded-sm p-1 text-text-4 transition hover:bg-surface-2 hover:text-accent"
                    :title="$t('roadmap.detail.openInPane')"
                    :aria-label="$t('roadmap.detail.openInPane')"
                    @click="emit('openDoc', row.path!)"
                  >
                    <ExternalLink :size="12" :stroke-width="1.7" />
                  </button>
                  <button
                    v-if="row.state === 'missing'"
                    class="inline-flex shrink-0 items-center gap-1 rounded-sm border border-border-2 bg-surface-2 px-2 py-1 text-[11px] text-accent transition hover:border-accent-line"
                    @click="emit('generate', card, row.key)"
                  >
                    <Sparkles :size="12" :stroke-width="1.7" />{{ $t('roadmap.detail.generate') }}
                  </button>
                </div>
                <p
                  v-if="row.state === 'missing'"
                  class="mb-1.5 pl-0.5 text-[10px] leading-relaxed text-text-4 last:mb-0"
                >
                  {{ $t('roadmap.detail.generateHint') }}
                </p>
              </template>
            </section>

            <!-- 7 · Linked cards (deps/parent/[[slug]]; click navigates the modal) -->
            <section v-if="linked.length" class="mb-[18px]">
              <div class="eyebrow mb-1.5 text-text-4">{{ $t('roadmap.detail.linked') }}</div>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="l in linked"
                  :key="l.ref"
                  class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-[10.5px] transition"
                  :class="
                    l.card
                      ? 'text-text-2 hover:border-border-2 hover:bg-surface-2'
                      : 'cursor-default text-text-4'
                  "
                  :disabled="!l.card"
                  :title="l.card ? l.card.title : $t('roadmap.detail.linkedUnknown')"
                  @click="l.card && emit('navigate', l.card.slug)"
                >
                  <span
                    class="h-1.5 w-1.5 shrink-0 rounded-full"
                    :class="l.card?.column === 'done' ? 'bg-green' : 'border border-text-4'"
                  />
                  <span>{{ l.card?.id ?? l.ref }}</span>
                  <!-- M9: relation label — blocked-by/blocks are warning-tinted, done is quiet -->
                  <span
                    v-if="l.relation"
                    class="font-sans text-[10px]"
                    :class="l.relation === 'done' ? 'text-text-4' : 'text-warning'"
                  >
                    {{ $t(`roadmap.detail.relation.${relationI18nKey(l.relation)}`) }}
                  </span>
                  <span v-else-if="l.card" class="font-sans text-[10px] text-text-4">
                    · {{ columnLabel(l.card.column) }}
                  </span>
                </button>
              </div>
            </section>

            <!-- 8 · Context (everything unstructured — never a blank modal) -->
            <section v-if="parsed.sections.context" class="mb-[18px]">
              <div class="eyebrow mb-1.5 text-text-4">{{ $t('roadmap.detail.context') }}</div>
              <MarkdownRenderer :source="parsed.sections.context" />
            </section>

            <!-- 9 · Trail: dispatched-with → bound session → evidence → appends -->
            <section v-if="hasTrail" class="mb-1">
              <div class="eyebrow mb-1.5 text-text-4">{{ $t('roadmap.detail.trail') }}</div>
              <div class="ml-1 flex flex-col gap-3 border-l border-border pl-4">
                <div v-if="parsed.dispatchedWith" class="relative">
                  <span
                    class="absolute -left-[20px] top-[5px] h-[7px] w-[7px] rounded-full border border-border-2 bg-surface-2"
                  />
                  <p class="font-mono text-[11px] leading-relaxed text-text-3">
                    {{ parsed.dispatchedWith }}
                  </p>
                </div>

                <div v-if="card.session" class="relative">
                  <span
                    class="absolute -left-[20px] top-[5px] h-[7px] w-[7px] rounded-full [--pulse-from:0.47]"
                    :class="sessionDotClass"
                  />
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-mono text-[11.5px] text-text-2">
                      {{ $t('roadmap.detail.session', { id: sessionShort })
                      }}<template v-if="sessionStateLabel"> · {{ sessionStateLabel }}</template>
                    </span>
                    <button
                      class="rounded-sm border border-border-2 bg-surface-2 px-2 py-0.5 text-[11px] text-text-2 transition hover:border-text-4 hover:text-text"
                      @click="emit('openSession', card)"
                    >
                      {{ $t('roadmap.card.openSession') }}
                    </button>
                  </div>
                </div>

                <div v-if="card.evidence.length" class="relative">
                  <span
                    class="absolute -left-[20px] top-[5px] h-[7px] w-[7px] rounded-full border border-border-2 bg-surface-2"
                  />
                  <div class="flex flex-wrap gap-1.5">
                    <span
                      v-for="ev in card.evidence"
                      :key="ev"
                      class="inline-flex items-center rounded-sm border border-border-2 bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-text-3"
                    >
                      {{ ev }}
                    </span>
                  </div>
                </div>

                <div v-for="(ap, i) in parsed.appends" :key="i" class="relative">
                  <span
                    class="absolute -left-[20px] top-[5px] h-[7px] w-[7px] rounded-full border border-border-2 bg-surface-2"
                  />
                  <div class="rounded-md border border-border bg-surface px-2.5 py-2">
                    <div
                      v-if="appendEyebrow(ap)"
                      class="mb-1 font-mono text-[10.5px]"
                      :class="ap.provenance?.author === 'agent' ? 'text-warning' : 'text-text-4'"
                    >
                      {{ appendEyebrow(ap) }}
                    </div>
                    <MarkdownRenderer :source="ap.text" />
                  </div>
                </div>
              </div>
            </section>
          </template>
        </div>

        <!-- 10 · Actions footer (sticky; hidden while editing, S2) -->
        <div
          v-if="!editing"
          class="flex shrink-0 items-center gap-2.5 border-t border-border bg-sidebar px-3.5 py-2.5"
        >
          <!-- The disabled-state hint rides on the enabled wrapper span: a
               `disabled` button gets no pointer/focus events (and here also
               `pointer-events-none`), so a `:title` on the button itself would
               never fire while disabled. The enabled button keeps its own hint. -->
          <span
            class="inline-flex"
            :title="!canManage ? $t('roadmap.detail.manageDisabledHint') : undefined"
          >
            <button
              class="rounded-sm border border-border-2 bg-surface-2 px-2 py-1 text-text-3 transition hover:border-text-4 hover:text-text disabled:pointer-events-none disabled:opacity-40"
              :disabled="!canManage"
              :title="canManage ? $t('roadmap.detail.archiveHint') : undefined"
              :aria-label="$t('roadmap.detail.archive')"
              @click="archiveCard"
            >
              <Archive :size="12" :stroke-width="1.8" />
            </button>
          </span>
          <span
            class="inline-flex"
            :title="!canManage ? $t('roadmap.detail.manageDisabledHint') : undefined"
          >
            <button
              class="rounded-sm border border-red/30 px-2 py-1 text-red transition disabled:pointer-events-none disabled:opacity-40"
              :disabled="!canManage"
              :title="canManage ? $t('roadmap.detail.deleteHint') : undefined"
              :aria-label="$t('roadmap.detail.delete')"
              @click="deleteCard"
            >
              <Trash2 :size="12" :stroke-width="1.8" />
            </button>
          </span>
          <button
            class="rounded-sm border border-border-2 bg-surface-2 px-2.5 py-1 text-[11px] text-text-2 transition hover:border-text-4 hover:text-text"
            @click="startEdit"
          >
            {{ $t('roadmap.detail.edit') }}
          </button>
          <span class="flex-1" />
          <div class="inline-flex overflow-hidden rounded-sm border border-border-2 bg-surface">
            <button
              v-for="target in MOVE_TARGETS"
              :key="target"
              class="px-2.5 py-1 text-[11px] transition"
              :class="
                card.column === target ? 'bg-surface-2 text-text' : 'text-text-3 hover:text-text-2'
              "
              @click="moveTo(target)"
            >
              {{ columnLabel(target) }}
            </button>
          </div>
          <span class="flex-1" />
          <span
            class="flex items-center gap-1 text-[10.5px]"
            :class="readinessGaps.length ? 'text-warning' : 'text-green'"
          >
            {{ readinessLabel }}
          </span>
          <button
            v-if="canDispatch"
            class="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-accent-ink transition hover:brightness-110"
            @click="emit('dispatch', card)"
          >
            <Rocket :size="12" :stroke-width="1.8" />{{ $t('roadmap.card.dispatch') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
