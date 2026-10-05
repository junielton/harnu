<script setup lang="ts">
/**
 * T164 U3 — Review pane takeover.
 *
 * The surface that turns "an agent says it's done" into a decision the operator
 * can defend: the branch-vs-base diff, the receipts that back it, and the card's
 * own intent beside it. Sixth main-pane takeover; same shell as PrStackCanvas /
 * UsageDashboard / SystemMonitor / CleanupView / RoadmapBoard.
 *
 * Visual contract: `docs/specs/2026-08-25-t164-review-pane/spec.html`
 * (approved 2026-08-25, frozen) · design.md §6 "Review pane" ·
 * PRD `docs/prds/T164-review-pane.md`.
 *
 * Three rules constrain everything below, and they are accountability
 * guarantees rather than style preferences (PRD §3.2):
 *
 *  - **R1 — agents report, humans conclude.** Nothing here renders an
 *    agent-produced claim, and no model is called on this path. The only text
 *    the pane shows that a machine wrote is `git`'s own output and the card's
 *    body, which is the human's own brief coming back.
 *  - **R2 — no green means safe.** There is no "all clear" state at any data
 *    combination: with nothing to report the discrepancy strip is ABSENT, never
 *    a badge saying so, and every status dot is rendered together with the word
 *    it encodes.
 *  - **R3 — sensitive paths force the human read.** A blast-radius file opens
 *    expanded and is exempt from the size-driven auto-collapse.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  GitBranch,
  MessageSquare,
  RefreshCw
} from 'lucide-vue-next'
import { REVIEW_VERDICTS, type ReviewVerdict } from '../../../main/review-submit-core'
import { useUiStore } from '../stores/ui'
import { useHelpersStore } from '../stores/helpers'
import { useReviewStore } from '../stores/review'
import { useRoadmapStore } from '../stores/roadmap'
import { useSessionsStore } from '../stores/sessions'
import MarkdownRenderer from './MarkdownRenderer.vue'
import Button from './ui/Button.vue'
import {
  CONTRACT_LINE_SEVERITY,
  HIGHLIGHT_ROW_BUDGET,
  SEVERITY_GLYPH,
  contractLineParts,
  flagLinesFor,
  gapBefore,
  grammarFor,
  hunkLabel,
  receiptsFor,
  rowSegments,
  sessionEndStateOf,
  splitPath
} from './review-format'
import type { DiffFile, DiffHunk, DiffRow } from '../../../main/review-core'
import { correctiveFromSnapshot, UNKNOWN_CORRECTIVE } from '../../../main/review-corrective'

const { t } = useI18n()
const ui = useUiStore()
const store = useReviewStore()
const roadmap = useRoadmapStore()
const sessions = useSessionsStore()
const helpers = useHelpersStore()

const folderPath = computed(() => ui.review.folderPath ?? '')
const cardSlug = computed(() => ui.review.cardSlug ?? '')
/** Set when a PR Stack card asked for a PR whose branch is nowhere on disk. */
const prNumber = computed(() => ui.review.prNumber)

const snapshot = computed(() => store.snapshot)
const evidence = computed(() => snapshot.value?.evidence ?? null)

// ── The bound card (optional enrichment, never the anchor — PRD D2) ─────────

/**
 * The card whose intent the rail renders.
 *
 * Read from the roadmap store rather than through a fresh IPC read, so the pane
 * and the board can never disagree about the same card. When the board is
 * pointed at a different repo we re-point it — the operator asked to review a
 * card of THIS repo, which is the same intent opening its board carries — but
 * only when a slug was actually passed: peeking at a folder must never steal
 * the single roadmap watcher from another repo's open board.
 */
const card = computed(() => (cardSlug.value ? (roadmap.findCard(cardSlug.value) ?? null) : null))
const hasCard = computed(() => card.value !== null)

const subject = computed(() => card.value?.id || snapshot.value?.branch || folderPath.value)

/**
 * The bound session's end state, or `null`. Deliberately conservative: t125 is
 * not built (PRD D3), so this reports only what the live task-state actually
 * says and never invents a "done" the receipts would then present as evidence.
 */
const sessionEndState = computed(() => {
  const id = card.value?.session
  const bound = id ? sessions.findSessionById(id) : null
  if (bound) return sessionEndStateOf(bound)
  const folder = folderPath.value ? sessions.findFolderByPath(folderPath.value) : null
  const only = folder?.sessions.filter((s) => !s.isShellTerminal) ?? []
  return only.length === 1 ? sessionEndStateOf(only[0]) : null
})

// ── Evidence header ────────────────────────────────────────────────────────

const receipts = computed(() =>
  evidence.value ? receiptsFor(evidence.value, hasCard.value, now.value) : []
)
const flagLines = computed(() => (evidence.value ? flagLinesFor(evidence.value) : []))
const contractParts = computed(() =>
  evidence.value ? contractLineParts(evidence.value.contracts) : []
)
/**
 * R2 lives here. The strip renders only what there is to say; with nothing to
 * report it does not render at all, because the alternative — a row announcing
 * that nothing is wrong — is precisely the completion-looking state the rule
 * forbids. There is no `else` branch below, and that absence is the feature.
 */
const showFlags = computed(() => flagLines.value.length > 0 || contractParts.value.length > 0)

/**
 * Why there is no diff, when there is none (T246).
 *
 * This is checked BEFORE the `files.length === 0` empty state, and that order is
 * the whole point of the card: a head that was never fetched produces exactly
 * the same zero counts and empty file list as a branch with nothing on it, and
 * an operator who reads "no commits" on someone else's PR concludes nothing
 * happened and Closes. Each of these states says what actually went wrong, and
 * `notFetched` offers the one gesture that fixes it.
 */
const headState = computed(() => evidence.value?.head.state ?? 'ready')
const headBlocked = computed(() => headState.value !== 'ready')
/** `not-fetched` → `notFetched`: the state is a git fact, the key is i18n's. */
const HEAD_STATE_KEY: Record<string, string> = {
  'not-fetched': 'notFetched',
  'fetch-failed': 'fetchFailed',
  'base-unresolved': 'baseUnresolved'
}
const headKey = computed(() => HEAD_STATE_KEY[headState.value] ?? 'notFetched')

// ── Diff ───────────────────────────────────────────────────────────────────

const files = computed<DiffFile[]>(() => snapshot.value?.files ?? [])

/** Grammar per file, resolved once instead of per row. */
const grammars = computed<Record<string, string | null>>(() => {
  const out: Record<string, string | null> = {}
  for (const f of files.value) out[f.path] = grammarFor(f.path)
  return out
})

/**
 * How many rows still have a highlight budget, walked in file order so the top
 * of the diff — the part actually on screen — is the part that gets coloured.
 * Past the budget rows render as plain text; the word-level marks keep working,
 * because §4.3 ranks them above syntax colour and they cost a slice, not a
 * tokenise.
 */
const highlightUntil = computed<Record<string, boolean>>(() => {
  const out: Record<string, boolean> = {}
  let spent = 0
  for (const f of files.value) {
    const rows = f.hunks.reduce((n, h) => n + h.rows.length, 0)
    out[f.path] = spent + rows <= HIGHLIGHT_ROW_BUDGET
    spent += rows
  }
  return out
})

function isSensitive(path: string): boolean {
  return store.sensitivePaths.has(path)
}

// ── The viewed mark (T243) ─────────────────────────────────────────────────

/**
 * The checkbox's own appearance per state.
 *
 * `pending` — read here, not yet reflected on GitHub — is deliberately NEUTRAL
 * rather than a warning hue: an unsynced write is not an alarm, and the warning
 * colour on this row already belongs to the blast-radius bar. It must not be
 * green either, because green here would be the claim `pending` exists to
 * refuse (AC-6).
 */
const VIEWED_BOX_CLASS: Record<string, string> = {
  unviewed: 'border-border-2 bg-surface text-transparent hover:border-text-4 hover:text-text-4',
  dismissed: 'border-border-2 bg-surface text-transparent hover:border-text-4 hover:text-text-4',
  pending: 'border-border-2 bg-surface-2 text-text-3 hover:border-text-4',
  viewed: 'border-green/40 bg-green-soft text-green'
}

/** Has this file been read? `dismissed` has not — it moved after it was read. */
function isRead(path: string): boolean {
  const state = store.viewedOf(path)
  return state === 'viewed' || state === 'pending'
}

function viewedBoxClass(path: string): string {
  return VIEWED_BOX_CLASS[store.viewedOf(path)] ?? VIEWED_BOX_CLASS.unviewed
}

function viewedLabel(path: string): string {
  const state = store.viewedOf(path)
  if (state === 'pending') return t('review.viewedPending')
  return isRead(path) ? t('review.markUnviewed') : t('review.markViewed')
}

/**
 * Toggle one file's mark. A point patch through the store — nothing reloads,
 * and no other file's expand/collapse state moves (AC-3).
 *
 * A failure is TOLD, not swallowed: with a PR that does exist, a mutation that
 * did not go through leaves the mark visibly unsynced and says why (AC-6).
 */
async function onToggleViewed(file: DiffFile): Promise<void> {
  const error = await store.markViewed(file.path, !isRead(file.path))
  if (error) ui.pushToast({ kind: 'danger', title: t('review.viewedFailed'), description: error })
}

function segmentsFor(file: DiffFile, row: DiffRow): ReturnType<typeof rowSegments> {
  const grammar = highlightUntil.value[file.path] ? grammars.value[file.path] : null
  const mark = row.kind === 'add' ? 'add' : row.kind === 'del' ? 'del' : null
  return rowSegments(row.text, row.spans, mark, grammar)
}

function gapFor(hunks: readonly DiffHunk[], index: number): number {
  return gapBefore(hunks, index)
}

// ── Intent rail + the ~1000px breakpoint (AC-8) ─────────────────────────────

/**
 * Measured on the pane's own body, not on the window: the pane can be narrower
 * than the viewport, and the rail's affordability is a function of the space it
 * actually has. 1000px is the measured threshold from the approved spec — below
 * it the diff column starts truncating code mid-line, which breaks the one
 * thing the pane exists for.
 */
/**
 * Wall clock for the `fetched Nh` receipt — the age fallback for a ref with no
 * `headRefOid` to compare against. Ticked rather than read once: the pane stays
 * open while an operator reads a long diff, and a frozen "now" would quietly
 * become wrong.
 */
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | null = null

const NARROW_PX = 1000
const body = ref<HTMLElement | null>(null)
const narrow = ref(false)
let ro: ResizeObserver | null = null

function measure(): void {
  if (body.value) narrow.value = body.value.clientWidth < NARROW_PX
}

const showRail = computed(() => hasCard.value && (!narrow.value || store.railOpen))
const showRailStrip = computed(() => hasCard.value && narrow.value && !store.railOpen)

// ── Actions ────────────────────────────────────────────────────────────────

const bouncing = ref(false)
const bounceNote = ref('')
const bounceInput = ref<HTMLTextAreaElement | null>(null)
const busy = ref(false)

function startBounce(): void {
  bouncing.value = true
  bounceNote.value = ''
  void nextTick(() => bounceInput.value?.focus())
}

function cancelBounce(): void {
  bouncing.value = false
  bounceNote.value = ''
}

/**
 * Close (Review → Done).
 *
 * Calls the roadmap store's `closeCard`, which is the ONLY door onto
 * `roadmap:closeCard` — the single writer of `status: done` in the whole main
 * process (AC-9). This pane deliberately adds no second path: the Close that
 * happens here and the Close that happens on the board are the same write, with
 * the same memory append behind it.
 */
async function onClose(): Promise<void> {
  const slug = cardSlug.value
  if (!slug || busy.value) return
  busy.value = true
  try {
    const res = await roadmap.closeCard(slug)
    if (!res.ok) {
      ui.pushToast({ kind: 'danger', title: t('review.closeFailed'), description: res.code })
      return
    }
    ui.pushToast({ kind: 'success', title: t('review.closed', { id: card.value?.id ?? slug }) })
    ui.closeReview()
  } finally {
    busy.value = false
  }
}

/**
 * Bounce back (Review → Ready, with a note).
 *
 * The note lands FIRST and the move only follows a successful append: a card
 * that returned to Ready carrying no reason is a bounce whose whole point was
 * discarded, and AC-7/AC-10 forbid losing it silently. `roadmap:appendBody`
 * stamps the provenance itself (`author: human`, dated) — the pane does not
 * hand-write a provenance line, because a stamp the renderer composes is a
 * stamp that can disagree with every other one on the card.
 */
async function onBounce(): Promise<void> {
  const slug = cardSlug.value
  const note = bounceNote.value.trim()
  if (!slug || !note || busy.value) return
  busy.value = true
  try {
    const appended = await roadmap.appendBody(slug, `**${t('review.bounceHeading')}**\n\n${note}`)
    if (!appended.ok) {
      ui.pushToast({
        kind: 'danger',
        title: t('review.bounceFailed'),
        description: appended.code
      })
      return
    }
    const moved = await roadmap.setStatus(slug, 'ready')
    if (!moved.ok) {
      ui.pushToast({
        kind: 'danger',
        title: t('review.bounceNoteOnly'),
        description: moved.code
      })
      return
    }
    ui.pushToast({ kind: 'success', title: t('review.bounced', { id: card.value?.id ?? slug }) })
    bouncing.value = false
    bounceNote.value = ''
    ui.closeReview()
  } finally {
    busy.value = false
  }
}

/**
 * With no card there is nothing to Close or Bounce, so the action slot offers
 * the one thing that IS actionable on a card-less branch: a shell in the
 * worktree. Reuses the same door the Folder View's "Terminal here" opens.
 */
function openInTerminal(): void {
  if (!folderPath.value) return
  sessions.createFolderTerminal(folderPath.value)
  ui.closeReview()
}

/**
 * Whether "Ask a fresh session" is allowed to run right now (BUG-94 AC-2/AC-3).
 *
 * `store.load` nulls the snapshot on every non-silent load and on any thrown
 * IPC failure, so both windows — loading and errored — leave nothing for a
 * companion to sit beside. Spawning one there reships the original defect this
 * pane exists to not have: a session that starts running `git status` on its
 * own because nobody told it what review it is in.
 */
const companionDisabled = computed(() => store.snapshot === null || store.error !== null)

/**
 * What the companion is told about the review, so it knows it is BLIND (T247).
 *
 * The ONLY thing this pane hands the session, and it is five scalars: the base
 * and head commit SHAs, the head's readability state, whether the folder is a
 * git work tree, and the PR number when there is one. `correctiveFromSnapshot`
 * is the projection, and it is the whole door — the diff, the file list, the
 * counts, the CI/PR chips and everything else on `evidence` cannot reach a
 * session through it (spec §4.1, normative).
 *
 * SHAs rather than `head.ref`, deliberately: `refs/harnu/pr/<n>` is force-
 * overwritten by the refresh gesture, so a corrective naming the ref keeps
 * SUCCEEDING against different content — and a stale command that works is what
 * makes a session guess, which is the defect this unit exists to fix.
 *
 * The fallback names no ref and tells the session to ask. It is unreachable from
 * the button (disabled while the snapshot is null) and exists so that a future
 * caller cannot produce a companion that is blind without knowing it.
 */
const corrective = computed(() =>
  store.snapshot ? correctiveFromSnapshot(store.snapshot) : UNKNOWN_CORRECTIVE
)

/**
 * Open the review companion (T245) — a fresh `claude` in the helper stack
 * beside this pane.
 *
 * Deliberately lives in the takeover HEADER and nowhere else. The evidence
 * header, the discrepancy strip and the diff are receipts, and the companion is
 * a conversation; putting the affordance among the receipts would be the first
 * step toward a model's opinion sitting where a `git` fact sits (PRD §2, AC-3).
 *
 * There is no "ask the session that wrote this" twin. The interlocutor is
 * always a stranger — not a default with an override, the only behaviour (§1).
 * NOTE: the frozen visual contract's `review-pane--with-session` root still
 * shows a "switch to author" badge; that badge predates the 2026-08-27 decision
 * and is deliberately not built.
 *
 * The pane lands in the stack of the folder UNDER REVIEW, which is also the cwd
 * the session launches in — reading a diff while standing somewhere else is not
 * a thing anyone wants. When the shell is pointed at a different folder we point
 * it here first, or the pane would be added to a stack nobody is looking at.
 *
 * The guard here is the real gate (BUG-94 AC-3) — `:disabled` on the button is
 * a convenience on top of it, not a substitute: this function refuses on its
 * own even if the DOM attribute is bypassed.
 *
 * `addReviewCompanionHelper`'s return value is always consumed (BUG-94 AC-1):
 * with the companion's `dedupKey` a constant, a second activation returns the
 * SAME pane's id rather than creating a new one, and that id is what
 * `maximizePane` uses to bring the running companion into focus — so a second
 * click reveals it instead of being a silent no-op.
 */
function openCompanion(): void {
  const path = folderPath.value
  if (!path || companionDisabled.value) return
  if (sessions.activeFolderPath !== path) sessions.selectFolder(path)
  const id = helpers.addReviewCompanionHelper(path, path, corrective.value)
  helpers.maximizePane(path, id)
}

/**
 * The refresh gesture — and the ONLY thing on this path that goes to the
 * network. It fetches the PR head (T246 AC-3) and forces past the `gh` cache,
 * which is what makes "not fetched yet" a one-click state to leave rather than
 * a dead end.
 */
function refresh(): void {
  if (folderPath.value) {
    void store.load(folderPath.value, {
      prNumber: prNumber.value,
      fetch: true,
      session: sessionEndState.value,
      silent: true
    })
  }
}

// ── Submitting a review to GitHub (T244) ───────────────────────────────────

/**
 * The pane's ONE write, and the only surface in Harnu that speaks under the
 * operator's GitHub identity. Four rules shape everything below, and every one
 * of them is about what must NOT happen:
 *
 *  - **No agent may reach it.** There is no MCP verb, no session and no skill
 *    behind `store.submitReview`; the only trigger is a click in here.
 *  - **A confirm precedes every submission**, naming the PR, the repo, the
 *    verdict and the copy-paste boundary.
 *  - **The three verdicts are equal.** Same class string, same click cost, no
 *    default selection, and a body required from all three — GitHub itself
 *    lets an approval skip the prose, which is exactly the asymmetry that
 *    teaches people to approve.
 *  - **No verdict is ever inferred.** Nothing here reads CI, the review
 *    decision or the discrepancy strip. The evidence states facts, the human
 *    concludes, the tool carries it — three jobs, never blurred (R1).
 */
const pr = computed(() => {
  const e = evidence.value
  return e && e.pr.applicable ? e.pr.pr : null
})

/**
 * Absent, never present-and-inert (AC-7). With no `gh`, no auth or no PR the
 * evidence carries no `pr` at all, so this is `false` and the affordance simply
 * does not render — a disabled Approve button invites a hunt for the reason it
 * is disabled, and there is no reason to find.
 */
const canSubmitReview = computed(() => pr.value !== null)

/** `https://github.com/owner/repo/pull/12` → `owner/repo`, for the confirm. */
const repoSlug = computed(() => {
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(pr.value?.url ?? '')
  return m ? m[1] : ''
})

const composing = ref(false)
const reviewBody = ref('')
const reviewInput = ref<HTMLTextAreaElement | null>(null)
/** The verdict awaiting the confirm. `null` = no confirm is open. */
const pendingVerdict = ref<ReviewVerdict | null>(null)
const submitting = ref(false)

/**
 * ONE class string for all three buttons, referenced three times.
 *
 * Equal prominence is a structural property here rather than a visual
 * intention: the three render from the same constant in a `v-for` over
 * `REVIEW_VERDICTS`, so there is nowhere for an accent fill or a heavier weight
 * to attach itself to one of them. `review-pane-contract.test.ts` asserts the
 * rendered class attributes are byte-identical.
 */
const VERDICT_BTN =
  'flex h-[26px] flex-1 items-center justify-center rounded-sm border border-border-2 bg-surface-2 px-[11px] text-xs text-text-2 transition-colors hover:border-text-4 hover:text-text disabled:opacity-40'

/** `request-changes` → `requestChanges`: git's spelling in, i18n's key out. */
const VERDICT_KEY: Record<ReviewVerdict, string> = {
  approve: 'approve',
  'request-changes': 'requestChanges',
  comment: 'comment'
}

/** Main's named refusals → the sentence that says why (the core owns the fact). */
const REFUSAL_KEY: Record<string, string> = {
  'no-pr': 'noPr',
  'unknown-verdict': 'unknownVerdict',
  'empty-body': 'emptyBody',
  'pr-unresolved': 'prUnresolved',
  'base-mismatch': 'baseMismatch',
  'head-unreadable': 'headUnreadable',
  'head-moved': 'headMoved'
}

function startReview(): void {
  composing.value = true
  void nextTick(() => reviewInput.value?.focus())
}

function cancelReview(): void {
  composing.value = false
  reviewBody.value = ''
  pendingVerdict.value = null
}

/** Open the confirm. Nothing is submitted by this click (AC-3). */
function askConfirm(verdict: ReviewVerdict): void {
  if (reviewBody.value.trim().length === 0 || submitting.value) return
  pendingVerdict.value = verdict
}

function dismissConfirm(): void {
  if (!submitting.value) pendingVerdict.value = null
}

/**
 * Submit — the only caller of `store.submitReview`, and it runs only from the
 * confirm's own button.
 *
 * A submitted state is rendered ONLY off `res.ok`. Every other outcome — a
 * guard refusal, a `gh` failure, an IPC failure — is told out loud and leaves
 * the composer open with the operator's prose still in it: an approval someone
 * believes happened and did not is strictly worse than a visible error (AC-8).
 */
async function onSubmitReview(): Promise<void> {
  const verdict = pendingVerdict.value
  if (!verdict || submitting.value) return
  submitting.value = true
  try {
    const res = await store.submitReview(verdict, reviewBody.value)
    pendingVerdict.value = null
    if (!res.ok) {
      const key = res.refusal ? REFUSAL_KEY[res.refusal] : null
      ui.pushToast({
        kind: 'danger',
        title: t('review.submitFailed'),
        description: key
          ? t(`review.refusal.${key}`, { detail: res.detail ?? '' })
          : (res.error ?? t('review.refusal.unknownVerdict'))
      })
      return
    }
    ui.pushToast({
      kind: 'success',
      title: t('review.submitted', {
        verdict: t(`review.verdict.${VERDICT_KEY[verdict]}`),
        n: pr.value?.number ?? 0
      })
    })
    composing.value = false
    reviewBody.value = ''
  } finally {
    submitting.value = false
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

async function boot(path: string, slug: string): Promise<void> {
  if (!path) return
  if (slug && roadmap.folderPath !== path) await roadmap.open(path)
  // No `fetch` here, deliberately: opening a view must not cost a network call.
  await store.load(path, { prNumber: prNumber.value, session: sessionEndState.value })
}

onMounted(() => {
  clock = setInterval(() => (now.value = Date.now()), 30_000)
  measure()
  if (body.value) {
    ro = new ResizeObserver(measure)
    ro.observe(body.value)
  }
  void boot(folderPath.value, cardSlug.value)
})

watch([folderPath, cardSlug, prNumber], ([path, slug]) => {
  cancelBounce()
  cancelReview()
  void boot(path as string, slug as string)
})

onBeforeUnmount(() => {
  if (clock !== null) clearInterval(clock)
  ro?.disconnect()
  store.reset()
})
</script>

<template>
  <!-- The 16px of breathing room above the first box is a MARGIN on that
       first child, never `pt-4` on this scroller: a sticky child's pin point
       is the scrollport inset by the scroll container's padding, so top
       padding here would silently push `sticky top-0` (the file headers)
       and `sticky top-3` (the intent rail) down by 16px and leave an
       unpainted strip for the diff to show through. Same shape as the
       other takeovers: UsageDashboard/SystemMonitor pad an inner wrapper
       and keep the scroll container itself padding-free. -->
  <div
    ref="body"
    class="scrollable flex min-h-0 flex-1 flex-col gap-[14px] overflow-y-auto px-5 pb-7 [&>*:first-child]:mt-4"
  >
    <p v-if="store.loading" class="py-10 text-center text-[12.5px] text-text-3">
      {{ t('review.loading') }}
    </p>

    <div
      v-else-if="store.error"
      class="rounded border border-dashed border-border-2 bg-surface px-[18px] py-[26px] text-center"
    >
      <p class="mb-[5px] text-[13px] text-text-2">{{ t('review.errorTitle') }}</p>
      <p class="font-mono text-[11.5px] text-text-3">{{ store.error }}</p>
    </div>

    <template v-else-if="evidence">
      <!-- ══ EVIDENCE HEADER — a ledger of receipts, never a dashboard ══ -->
      <!-- `flex-none`: the body is a flex column, and `overflow-clip` gives
             this section a `min-height: 0`, so without it the receipts and the
             discrepancy strip are the first thing a short window squeezes away
             — which would silently hide the evidence the pane exists to show. -->
      <section class="flex-none overflow-clip rounded border border-border bg-surface">
        <div class="flex items-center gap-2.5 px-3 py-2.5">
          <span class="flex items-center gap-[7px] font-mono text-[12.5px] text-text">
            <GitBranch :size="13" class="text-text-3" />
            <span class="truncate">{{ evidence.branch }}</span>
            <span class="text-text-4">→</span>
            <span class="text-text-3">{{ evidence.base }}</span>
          </span>

          <span
            v-if="card"
            class="inline-flex flex-none items-center gap-[5px] whitespace-nowrap rounded-full border border-accent-line bg-accent-soft px-2 py-[2px] text-[11px] text-accent"
          >
            {{ card.id }}
          </span>

          <!-- The GitHub review is orthogonal to the card: it is offered
                 whenever a PR is known, bound card or not, and it is ABSENT
                 (never disabled) when there is no PR to review (AC-7). Its own
                 span so it cannot sit inside the card pair's v-if/v-else-if
                 chain, which has to stay adjacent to resolve. -->
          <span class="ml-auto flex flex-none gap-[7px]">
            <button
              v-if="canSubmitReview && !composing"
              class="flex h-[26px] items-center gap-1.5 rounded-sm border border-border-2 bg-surface-2 px-[11px] text-xs text-text-2 transition-colors hover:border-text-4 hover:text-text"
              @click="startReview"
            >
              {{ t('review.submitReview') }}
            </button>
          </span>

          <!-- With no card there is nothing to close or bounce, so the pair is
                 replaced rather than disabled (design.md §6). -->
          <span class="flex flex-none gap-[7px]">
            <template v-if="card && !bouncing">
              <button
                class="flex h-[26px] items-center gap-1.5 rounded-sm border border-border-2 bg-surface-2 px-[11px] text-xs text-text-2 transition-colors hover:border-text-4 hover:text-text disabled:opacity-50"
                :disabled="busy"
                @click="startBounce"
              >
                {{ t('review.bounce') }}
              </button>
              <button
                class="flex h-[26px] items-center gap-1.5 rounded-sm border border-accent bg-accent px-[11px] text-xs font-semibold text-accent-ink transition-[filter] hover:brightness-110 disabled:opacity-50"
                :disabled="busy"
                @click="onClose"
              >
                {{ t('review.closeCard') }}
              </button>
            </template>
            <button
              v-else-if="!card"
              class="flex h-[26px] items-center gap-1.5 rounded-sm border border-border-2 bg-surface-2 px-[11px] text-xs text-text-2 transition-colors hover:border-text-4 hover:text-text"
              @click="openInTerminal"
            >
              {{ t('review.openInTerminal') }}
            </button>
          </span>
        </div>

        <!-- Bounce composer. Not in the frozen spec (which shows the button
               only), but AC-7 requires the note to reach the card, and a bounce
               that silently discards it is the failure the AC names. Built from
               §6 primitives so it adds no new anatomy of its own. -->
        <div v-if="bouncing" class="border-t border-border bg-surface-2 px-3 py-2.5">
          <label class="mb-1.5 block text-[11px] text-text-4" for="review-bounce-note">
            {{ t('review.bounceLabel') }}
          </label>
          <textarea
            id="review-bounce-note"
            ref="bounceInput"
            v-model="bounceNote"
            rows="3"
            class="scrollable w-full resize-y rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-text outline-none placeholder:text-text-4 focus:border-accent-line"
            :placeholder="t('review.bouncePlaceholder')"
            @keydown.esc.stop="cancelBounce"
          ></textarea>
          <div class="mt-2 flex justify-end gap-[7px]">
            <button
              class="flex h-[26px] items-center rounded-sm border border-border-2 bg-surface-2 px-[11px] text-xs text-text-2 transition-colors hover:border-text-4 hover:text-text"
              @click="cancelBounce"
            >
              {{ t('review.bounceCancel') }}
            </button>
            <button
              class="flex h-[26px] items-center rounded-sm border border-accent bg-accent px-[11px] text-xs font-semibold text-accent-ink transition-[filter] hover:brightness-110 disabled:opacity-40"
              :disabled="busy || bounceNote.trim().length === 0"
              @click="onBounce"
            >
              {{ t('review.bounceSend') }}
            </button>
          </div>
        </div>

        <!-- ══ Submit a review to GitHub (T244) ══
               The pane's only write, and the only thing in Harnu that speaks
               under the operator's own GitHub identity.

               The three verdicts render from ONE class constant in a v-for over
               `REVIEW_VERDICTS`, which is what makes "equal prominence, equal
               click cost, no default" structural rather than a style intention
               — there is nowhere for an accent fill to attach itself to one of
               them. Nothing in this block reads CI, the review decision or the
               discrepancy strip: no verdict is recommended, pre-filled or
               gated on anything (AC-5). -->
        <div v-if="composing" class="border-t border-border bg-surface-2 px-3 py-2.5">
          <div class="mb-1.5 flex items-baseline gap-2">
            <label class="text-[11px] text-text-4" for="review-verdict-body">
              {{ t('review.submitLabel') }}
            </label>
            <span class="ml-auto truncate font-mono text-[11px] text-text-3">
              {{ repoSlug }} #{{ pr?.number }}
            </span>
          </div>
          <textarea
            id="review-verdict-body"
            ref="reviewInput"
            v-model="reviewBody"
            rows="4"
            class="scrollable w-full resize-y rounded-sm border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-text outline-none placeholder:text-text-4 focus:border-accent-line"
            :placeholder="t('review.submitPlaceholder')"
            @keydown.esc.stop="cancelReview"
          ></textarea>
          <p class="mt-1.5 text-[11px] leading-relaxed text-text-4">
            {{ t('review.submitBoundary') }}
          </p>
          <div class="mt-2 flex items-center gap-[7px]">
            <button
              class="flex h-[26px] items-center rounded-sm border border-border-2 bg-surface-2 px-[11px] text-xs text-text-2 transition-colors hover:border-text-4 hover:text-text"
              @click="cancelReview"
            >
              {{ t('review.submitCancel') }}
            </button>
            <span class="ml-auto flex min-w-0 flex-1 justify-end gap-[7px]">
              <button
                v-for="v in REVIEW_VERDICTS"
                :key="v"
                :class="VERDICT_BTN"
                :disabled="submitting || reviewBody.trim().length === 0"
                @click="askConfirm(v)"
              >
                {{ t(`review.verdict.${VERDICT_KEY[v]}`) }}
              </button>
            </span>
          </div>
        </div>

        <!-- Receipts: label/value pairs, value first, hairline-separated. -->
        <div class="flex flex-wrap items-center px-3 pb-2.5">
          <span
            v-for="(r, i) in receipts"
            :key="`${r.key}-${i}`"
            class="mr-3.5 flex items-baseline gap-1.5 border-r border-border pr-3.5 last:mr-0 last:border-r-0 last:pr-0"
          >
            <span
              class="font-mono text-[12px]"
              :class="r.alarm ? 'text-red' : r.dim ? 'text-text-3' : 'text-text'"
            >
              <template v-if="r.lines">
                <span class="text-green">+{{ r.lines.added }}</span>
                <span class="text-red"> −{{ r.lines.deleted }}</span>
              </template>
              <template v-else>
                <!-- A dot never appears without the word it encodes (§2). -->
                <span
                  v-if="r.dot"
                  class="mr-[5px] inline-block h-1.5 w-1.5 rounded-full align-middle"
                  :class="{
                    'bg-green': r.dot === 'ok',
                    'bg-warning': r.dot === 'warn',
                    'bg-red': r.dot === 'bad',
                    'bg-text-4': r.dot === 'idle'
                  }"
                />{{ r.valueKey ? t(`review.value.${r.valueKey}`) : r.value }}
              </template>
            </span>
            <span class="text-[11px] text-text-4">{{ t(`review.receipt.${r.key}`) }}</span>
          </span>
        </div>

        <!-- Discrepancy strip. Renders only when there is something to say —
               see `showFlags` and rule R2. -->
        <div
          v-if="showFlags"
          class="flex flex-col gap-[5px] border-t border-border bg-surface-2 px-3 py-[7px]"
        >
          <div
            v-for="(f, i) in flagLines"
            :key="`${f.key}-${i}`"
            class="flex items-center gap-2 text-[12px] text-text-2"
          >
            <span
              class="w-3 flex-none text-center font-mono text-[11px]"
              :class="{
                'text-red': f.severity === 'bad',
                'text-warning': f.severity === 'warn',
                'text-text-4': f.severity === 'info'
              }"
              >{{ SEVERITY_GLYPH[f.severity] }}</span
            >
            <span>
              <template v-if="f.params.branch || f.params.path || f.params.base">
                <i18n-t :keypath="`review.flag.${f.key}`" tag="span" scope="global">
                  <template #branch>
                    <code
                      class="rounded border border-border bg-surface px-1 font-mono text-[11.5px] text-text"
                      >{{ f.params.branch }}</code
                    >
                  </template>
                  <template #path>
                    <code
                      class="rounded border border-border bg-surface px-1 font-mono text-[11.5px] text-text"
                      >{{ f.params.path }}</code
                    >
                  </template>
                  <template #base>
                    <code
                      class="rounded border border-border bg-surface px-1 font-mono text-[11.5px] text-text"
                      >{{ f.params.base }}</code
                    >
                  </template>
                  <template #n>{{ f.params.n }}</template>
                </i18n-t>
              </template>
              <template v-else>{{ t(`review.flag.${f.key}`, f.params) }}</template>
            </span>
          </div>

          <!-- The repo-contract ledger: one line naming every contract's
                 state. `not applicable` is never a pass mark. -->
          <div
            v-if="contractParts.length > 0"
            class="flex items-center gap-2 text-[12px] text-text-2"
          >
            <span class="w-3 flex-none text-center font-mono text-[11px] text-text-4">{{
              SEVERITY_GLYPH[CONTRACT_LINE_SEVERITY]
            }}</span>
            <span class="flex flex-wrap items-center gap-x-1.5">
              <template v-for="(c, i) in contractParts" :key="c.id">
                <span v-if="i > 0" class="text-text-4">·</span>
                <span>
                  <code
                    class="rounded border border-border bg-surface px-1 font-mono text-[11.5px] text-text"
                    >{{ c.code }}</code
                  >
                  {{ t(`review.contract.${c.stateKey}`) }}
                </span>
              </template>
            </span>
          </div>
        </div>
      </section>

      <!-- ══ SPLIT — two columns, never three ══ -->
      <div class="relative flex flex-none items-start gap-[14px]">
        <div class="flex min-w-0 flex-1 flex-col gap-[10px]">
          <!-- Explicit empty states — never a blank pane (AC-4). -->
          <div
            v-if="!snapshot?.isRepo"
            class="rounded border border-dashed border-border-2 bg-surface px-[18px] py-[26px] text-center"
          >
            <p class="mb-[5px] text-[13px] text-text-2">{{ t('review.empty.noRepoTitle') }}</p>
            <p class="text-[12.5px] text-text-3">{{ t('review.empty.noRepoBody') }}</p>
          </div>
          <!-- T246 — "there is no diff, and here is why", BEFORE the
                 count-derived empty states. A ref that was never fetched
                 produces the same zeroes as a branch with nothing on it, and
                 letting it fall through to "no commits" is how an operator
                 concludes nothing happened and Closes. -->
          <div
            v-else-if="headBlocked"
            class="rounded border border-dashed border-border-2 bg-surface px-[18px] py-[26px] text-center"
            data-test="review-head-blocked"
            :data-head-state="headState"
          >
            <p class="mb-[5px] text-[13px] text-text-2">
              {{ t(`review.empty.${headKey}Title`) }}
            </p>
            <p class="text-[12.5px] text-text-3">
              <i18n-t :keypath="`review.empty.${headKey}Body`" tag="span" scope="global">
                <template #branch>
                  <code class="font-mono text-[11.5px] text-text">{{ evidence.branch }}</code>
                </template>
                <template #base>
                  <code class="font-mono text-[11.5px] text-text">{{ evidence.base }}</code>
                </template>
              </i18n-t>
            </p>
            <button
              v-if="headState !== 'base-unresolved'"
              class="mt-3 inline-flex h-[26px] items-center gap-1.5 rounded-sm border border-border-2 bg-surface-2 px-[11px] text-xs text-text-2 transition-colors hover:border-text-4 hover:text-text disabled:opacity-50"
              data-test="review-fetch-head"
              :disabled="store.refreshing"
              @click="refresh"
            >
              <RefreshCw :size="12" :class="store.refreshing ? 'animate-spin' : ''" />
              {{ t('review.fetchHead') }}
            </button>
          </div>
          <div
            v-else-if="files.length === 0"
            class="rounded border border-dashed border-border-2 bg-surface px-[18px] py-[26px] text-center"
          >
            <p class="mb-[5px] text-[13px] text-text-2">
              {{
                evidence.commitsAhead === 0
                  ? t('review.empty.noCommitsTitle')
                  : t('review.empty.nothingTitle')
              }}
            </p>
            <p class="text-[12.5px] text-text-3">
              <i18n-t
                :keypath="
                  evidence.commitsAhead === 0
                    ? 'review.empty.noCommitsBody'
                    : 'review.empty.nothingBody'
                "
                tag="span"
                scope="global"
              >
                <template #branch>
                  <code class="font-mono text-[11.5px] text-text">{{ evidence.branch }}</code>
                </template>
                <template #base>
                  <code class="font-mono text-[11.5px] text-text">{{ evidence.base }}</code>
                </template>
              </i18n-t>
            </p>
          </div>

          <!-- ══ FILE BOXES ══ -->
          <article
            v-for="file in files"
            :key="file.path"
            class="overflow-clip rounded border bg-surface"
            :class="isSensitive(file.path) ? 'border-warning/30' : 'border-border'"
          >
            <!-- The blast-radius marker is an INNER 2px bar child of the file
                   header, not a border on the rounded box: a border would be
                   clipped into a tapering sliver by the radius, shift every row
                   by its own width, and fight the sticky header's background
                   (design.md §6). -->
            <header
              class="group sticky top-0 z-[2] flex cursor-pointer select-none items-center gap-[9px] border-b border-border bg-surface-2 px-[11px] py-2"
              :class="isSensitive(file.path) ? 'relative' : ''"
              :aria-expanded="store.isExpanded(file.path)"
              @click="store.toggleFile(file.path)"
            >
              <span
                v-if="isSensitive(file.path)"
                class="absolute inset-y-0 left-0 w-0.5 bg-warning"
                aria-hidden="true"
              />
              <span
                v-if="isSensitive(file.path)"
                class="inline-flex flex-none items-center whitespace-nowrap rounded-full border border-warning/30 bg-warning/10 px-2 py-[2px] text-[11px] text-warning"
              >
                {{ t('review.sensitiveBadge') }}
              </span>
              <!-- `DISMISSED` is its own state, never a flavour of
                     never-read: "you read this, and then it moved" is a
                     different sentence, and it comes with the WORD rather than
                     a hue alone (design.md §6). -->
              <span
                v-if="store.viewedOf(file.path) === 'dismissed'"
                class="inline-flex flex-none items-center whitespace-nowrap rounded-full border border-border-2 bg-surface px-2 py-[2px] text-[11px] text-text-2"
              >
                {{ t('review.viewedDismissed') }}
              </span>
              <span
                class="truncate font-mono text-[12px]"
                :class="isRead(file.path) && !isSensitive(file.path) ? 'text-text-3' : 'text-text'"
              >
                <span class="text-text-4">{{ splitPath(file.path).dir }}</span
                >{{ splitPath(file.path).base }}
              </span>
              <span
                v-if="file.binary"
                class="inline-flex flex-none items-center rounded-sm border border-border bg-surface px-[5px] text-[10.5px] text-text-3"
              >
                {{ t('review.binary') }}
              </span>
              <span class="flex-1" />
              <span class="flex flex-none gap-2 font-mono text-[11.5px]">
                <span class="text-green">+{{ file.added }}</span>
                <span class="text-red">−{{ file.deleted }}</span>
              </span>
              <!-- The viewed mark (T243). A real nested button with
                     `@click.stop`, because the header itself toggles the file:
                     "I have read this" and "show me this" are different
                     gestures and must not share a hit box. It sits on the RIGHT
                     — the left edge of this header belongs to the blast-radius
                     bar, and nothing may crowd it. -->
              <button
                type="button"
                data-viewed-toggle
                :data-viewed="store.viewedOf(file.path)"
                class="inline-flex h-[18px] w-[18px] flex-none items-center justify-center rounded-sm border transition-colors"
                :class="viewedBoxClass(file.path)"
                :title="viewedLabel(file.path)"
                :aria-label="viewedLabel(file.path)"
                :aria-pressed="isRead(file.path)"
                @click.stop="onToggleViewed(file)"
              >
                <Check :size="11" :stroke-width="2.75" aria-hidden="true" />
              </button>
              <!-- The expand/collapse state, as the same lucide pair every other
                     collapsible in the repo uses (`SystemMonitorRow`), not a text
                     glyph: a ▾ in the stats column reads as punctuation next to
                     the +/− counts, which is exactly how it was missed on a
                     nine-file list. Two DIFFERENT icons rather than one rotated
                     one, and a colour a step above the metadata around it — the
                     state has to survive both a colour-blind read and a
                     grayscale one, and the icon has to read as a control. The
                     header itself is the click target, so this is a marker, not
                     a nested button. -->
              <component
                :is="store.isExpanded(file.path) ? ChevronDown : ChevronRight"
                data-collapse-caret
                :size="13"
                :stroke-width="2"
                class="flex-none text-text-3 transition-colors group-hover:text-text"
                aria-hidden="true"
              />
            </header>

            <!-- Binary files are listed by path and stop there (PRD §6). -->
            <div
              v-if="store.isExpanded(file.path) && file.binary"
              class="px-[11px] py-3 text-[12px] text-text-3"
            >
              {{ t('review.binaryBody') }}
            </div>

            <!-- ONE horizontal scroller for the whole file box, never one per
                   row: independent per-row scrollers mean a long line can never be
                   read beside its context, which is the entire reason a diff
                   renders context at all (BUG-92). The gutter stays readable at
                   every offset because each row's gutter cell is `sticky left-0`
                   with an opaque background — the shape GitHub's diff table
                   (`td.blob-num { position: sticky; left: 0 }`) and every other
                   diff viewer converged on. `overflow-y-hidden` is explicit: an
                   `overflow-x` alone makes the browser compute `overflow-y: auto`
                   and leak a native vertical bar (design.md §6, same quirk the
                   Usage dashboard hit). The rows sit in a `min-w-max` track so a
                   short row still paints its add/remove tint across the full
                   scroll width instead of stopping at its own text. -->
            <div
              v-else-if="store.isExpanded(file.path)"
              class="scrollable overflow-x-auto overflow-y-hidden font-mono text-[12px] leading-[1.65]"
            >
              <div class="min-w-max">
                <template v-for="(hunk, hi) in file.hunks" :key="hi">
                  <!-- Unchanged-line gap. Rendered as a marker, NOT a control:
                         expanding it in place needs file content the diff does not
                         carry, and a button that cannot do its job is worse than a
                         label that is honest. -->
                  <div
                    v-if="gapFor(file.hunks, hi) > 0"
                    class="flex items-center border-y border-border bg-bg text-[11.5px] text-text-4"
                  >
                    <span
                      data-diff-gutter
                      class="sticky left-0 z-[1] w-[92px] flex-none border-r border-border bg-bg text-center"
                      >⋯</span
                    >
                    <span class="whitespace-pre pl-3">{{
                      t('review.unchangedLines', { n: gapFor(file.hunks, hi) })
                    }}</span>
                  </div>

                  <div
                    class="flex items-center gap-2.5 border-y border-border bg-bg text-[11.5px] text-text-4"
                  >
                    <span
                      data-diff-gutter
                      class="sticky left-0 z-[1] w-[92px] flex-none border-r border-border bg-bg text-center"
                      >@@</span
                    >
                    <span class="whitespace-pre">{{ hunkLabel(hunk) }}</span>
                  </div>

                  <!-- The add/remove tint lives on the ROW, not on the code cell:
                         the row stretches to the `min-w-max` track's full width, so
                         the stripe survives being scrolled instead of ending where
                         that line's text happens to end. -->
                  <div
                    v-for="(row, ri) in hunk.rows"
                    :key="ri"
                    data-diff-row
                    class="flex items-start"
                    :class="{
                      'diff-line-add': row.kind === 'add',
                      'diff-line-del': row.kind === 'del',
                      'text-text': row.kind !== 'context',
                      'text-text-2': row.kind === 'context'
                    }"
                  >
                    <!-- `sticky left-0` + an opaque `bg-surface-2` is what keeps
                           the gutter pinned while the code column scrolls under it
                           (AC-3). It has to stay opaque, or the code shows through
                           the line numbers at any offset > 0. -->
                    <span
                      data-diff-gutter
                      class="sticky left-0 z-[1] flex w-[92px] flex-none select-none border-r border-border bg-surface-2 text-[11px] text-text-4"
                    >
                      <span class="w-[34px] pr-1.5 text-right">{{ row.oldLine ?? '' }}</span>
                      <span class="w-[34px] pr-1.5 text-right">{{ row.newLine ?? '' }}</span>
                      <!-- The sign glyph is the SECOND channel: colour never
                             carries add/remove on its own (§2). -->
                      <span
                        class="w-4 text-center"
                        :class="{
                          'text-green': row.kind === 'add',
                          'text-red': row.kind === 'del'
                        }"
                        >{{ row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ' }}</span
                      >
                    </span>
                    <span class="flex-none whitespace-pre px-3">
                      <template v-for="(seg, si) in segmentsFor(file, row)" :key="si">
                        <span
                          v-if="seg.mark"
                          :class="seg.mark === 'add' ? 'diff-word-add' : 'diff-word-del'"
                          ><span v-for="(p, pi) in seg.parts" :key="pi" :class="p.cls">{{
                            p.text
                          }}</span></span
                        >
                        <template v-else>
                          <span v-for="(p, pi) in seg.parts" :key="pi" :class="p.cls">{{
                            p.text
                          }}</span>
                        </template>
                      </template>
                      <span v-if="row.noNewline" class="text-text-4">{{
                        t('review.noNewline')
                      }}</span>
                    </span>
                  </div>
                </template>
              </div>
            </div>
          </article>

          <!-- Truncation is said out loud: silently showing a partial diff is
                 the worst possible failure in a surface whose job is "you can
                 defend this decision" (PRD §6). -->
          <p
            v-if="snapshot?.truncated"
            class="rounded border border-dashed border-border-2 bg-surface px-3 py-2.5 text-[12px] text-text-3"
          >
            {{
              t('review.truncated', {
                n: snapshot?.omittedFiles.length ?? 0,
                rows: snapshot?.totalRows ?? 0
              })
            }}
          </p>
        </div>

        <!-- Intent rail. With no card bound it is ABSENT, not empty: an empty
               box advertises a feature this branch cannot have (design.md §6). -->
        <aside
          v-if="showRail"
          class="overflow-hidden rounded border border-border bg-surface"
          :class="
            narrow
              ? 'absolute right-0 top-0 z-[3] w-[320px] shadow-pop'
              : 'sticky top-3 w-[320px] flex-none'
          "
        >
          <div
            class="flex cursor-pointer items-center gap-[7px] border-b border-border px-[11px] py-[9px]"
            @click="store.railOpen = !store.railOpen"
          >
            <span class="text-[11px] uppercase tracking-[0.04em] text-text-4">
              {{ t('review.intentLabel') }}
            </span>
            <span class="ml-auto font-mono text-[11px] text-text-4">{{ narrow ? '›' : '▾' }}</span>
          </div>
          <div class="scrollable max-h-[460px] overflow-y-auto p-[11px]">
            <h4 class="mb-1.5 text-[13px] font-semibold leading-[1.35] text-text">
              {{ card?.title }}
            </h4>
            <div class="mb-2.5 flex flex-wrap gap-1.5">
              <span
                v-if="card?.kind"
                class="inline-flex items-center rounded-full border border-border bg-surface px-2 py-[2px] text-[11px] text-text-3"
                >{{ card.kind }}</span
              >
              <span
                v-if="card?.complexity"
                class="inline-flex items-center rounded-full border border-border bg-surface px-2 py-[2px] text-[11px] text-text-3"
                >{{ card.complexity }}</span
              >
              <span
                v-if="card?.priority"
                class="inline-flex items-center rounded-full border border-warning/30 bg-warning/10 px-2 py-[2px] text-[11px] text-warning"
                >{{ card.priority }}</span
              >
            </div>
            <!-- The card's body through the shared seam, so headings, lists,
                   code chips and AC lines inherit their existing prose
                   treatment (design.md §6 — Markdown pane). -->
            <MarkdownRenderer :source="card?.body ?? ''" />
          </div>
        </aside>

        <!-- Collapsed rail: keeps its position so the affordance stays where
               the muscle memory is; expanding overlays the diff (AC-8). -->
        <button
          v-else-if="showRailStrip"
          class="sticky top-3 flex w-9 flex-none cursor-pointer flex-col items-center gap-2.5 self-stretch rounded border border-border bg-surface py-[9px] transition-colors hover:border-border-2"
          :title="t('review.intentLabel')"
          :aria-label="t('review.intentLabel')"
          @click="store.railOpen = true"
        >
          <span class="font-mono text-[11px] text-text-4">‹</span>
          <span class="h-[5px] w-[5px] flex-none rounded-full bg-accent" />
          <span
            class="whitespace-nowrap text-[11px] uppercase tracking-[0.06em] text-text-4 [transform:rotate(180deg)] [writing-mode:vertical-rl]"
          >
            {{ t('review.intentStrip', { id: card?.id ?? '' }) }}
          </span>
        </button>
      </div>
    </template>
  </div>

  <!-- ══ The confirm (T244 AC-3) ══
         Every submission passes through here, and nothing else calls
         `onSubmitReview`. It names the four things an operator needs in order
         to be sure this is the review they meant: the verdict, the repo, the PR
         number, and the copy-paste boundary — once prose from a companion
         session is in that body it goes out under their identity and carries no
         different status from words they typed. A review submitted to the wrong
         PR is not undone by an undo; it is undone by an explanation. -->
  <Teleport to="body">
    <div
      v-if="pendingVerdict"
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="dismissConfirm"
    >
      <div
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        style="width: min(460px, 90vw); border-radius: 10px; box-shadow: var(--shadow-pop)"
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-submit-confirm-title"
        @mousedown.stop
      >
        <header class="border-b border-border px-5 pb-3 pt-[18px]">
          <h2 id="review-submit-confirm-title" class="text-[15px] font-medium leading-[22px]">
            {{
              t('review.confirmTitle', {
                verdict: t(`review.verdict.${VERDICT_KEY[pendingVerdict]}`)
              })
            }}
          </h2>
          <p class="mt-[5px] font-mono text-[12px] text-text-3">{{ repoSlug }} #{{ pr?.number }}</p>
        </header>
        <div class="px-5 py-3">
          <p class="text-[11.5px] leading-relaxed text-text-3">
            {{ t('review.confirmBoundary') }}
          </p>
        </div>
        <footer
          class="flex items-center justify-end gap-[7px] border-t border-border px-5 pb-[18px] pt-3.5"
        >
          <Button variant="ghost" :disabled="submitting" @click="dismissConfirm">
            {{ t('review.confirmCancel') }}
          </Button>
          <Button variant="primary" :disabled="submitting" @click="onSubmitReview">
            {{
              submitting
                ? t('review.confirmSubmitting')
                : t('review.confirmSubmit', {
                    verdict: t(`review.verdict.${VERDICT_KEY[pendingVerdict]}`)
                  })
            }}
          </Button>
        </footer>
      </div>
    </div>
  </Teleport>

  <!-- T300/U3: header markup rendered into the shared TakeoverShell (design.md §6
       "TakeoverShell — shared chrome") via Teleport, since a dynamically swapped
       view can't fill a named slot of the ancestor wrapping it. Placed after the
       real body content (not first) so this stays a component whose first root
       node is a real element — Vue Test Utils resolves `wrapper.element` off the
       first root, and a Teleport placeholder there breaks every `find`/`get`. -->
  <Teleport to="#takeover-shell-icon" defer>
    <CheckSquare :size="15" class="text-accent" />
  </Teleport>
  <Teleport to="#takeover-shell-actions" defer>
    <span class="truncate font-mono text-[11px] text-text-4">{{ subject }}</span>
    <Button
      variant="soft"
      class="ml-auto"
      :disabled="companionDisabled"
      :title="companionDisabled ? t('review.companionDisabledHint') : t('review.companionHint')"
      :aria-label="t('review.companion')"
      @click="openCompanion"
    >
      <MessageSquare :size="12" />
      {{ t('review.companion') }}
    </Button>
    <Button
      variant="ghost"
      size="icon"
      :title="t('review.refresh')"
      :aria-label="t('review.refresh')"
      @click="refresh"
    >
      <RefreshCw :size="13" :class="store.refreshing ? 'animate-spin' : ''" />
    </Button>
  </Teleport>
</template>
