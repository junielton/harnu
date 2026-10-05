/**
 * T198 — small pure formatters for the PR Stack Canvas. Kept out of the SFCs
 * so they are unit-testable (the repo's `*-format.ts` convention).
 */
import type { GhFailure, PrAutoMerge, PrReviewRequest } from '../../../main/pr-stack-core'

import type { Lod } from '../../../main/pr-stack-core'

import type { MergeStateStatus, PrEntry } from '../../../main/pr-stack-core'

/**
 * Compact age for a card's top-right corner: `now`, `12m`, `6h`, `2d`.
 *
 * Deliberately unit-suffixed rather than a translated sentence — it shares a
 * 14px row with the PR number and has to stay readable at 0.45 zoom, where a
 * localized "2 days ago" would not fit.
 */
export function shortAgo(iso: string | null, nowMs: number): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const mins = Math.floor((nowMs - then) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/** What the canvas says when it has no cards to draw. */
export type PrEmptyStateKind = 'unavailable' | 'failed' | 'empty'

/**
 * Names the empty canvas after what actually happened (BUG-148). A failed read
 * is not "no pull requests", and a slow `gh` is not "GitHub CLI is unavailable":
 * only `ghAvailable: false` is allowed to send the operator off to install or
 * authenticate something. `refreshFailure` covers the case with no snapshot at
 * all (the very first load rejected).
 */
export function prEmptyStateKind(
  snapshot: { ghAvailable: boolean; ghFailure: GhFailure | null } | null,
  refreshFailure: GhFailure | null = null
): PrEmptyStateKind {
  if (snapshot && !snapshot.ghAvailable) return 'unavailable'
  if (snapshot?.ghFailure || (!snapshot && refreshFailure)) return 'failed'
  return 'empty'
}

/** i18n keys (title + body) for a failed refresh, by failure kind. */
export function refreshFailureKeys(failure: GhFailure): { title: string; body: string } {
  return {
    title: `prStack.refreshFailed.${failure}.title`,
    body: `prStack.refreshFailed.${failure}.body`
  }
}

/** Reclaimable size for the harvest tray, in the units a human reads. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/**
 * The card's leading role bar colour — the one signal that survives every zoom
 * level, since the marker strip itself is shed below 0.70.
 */
export function roleBarClass(role: {
  isStagingTip: boolean
  isMergeNext: boolean
  baseMerged: boolean
  blocked: boolean
}): string {
  if (role.blocked) return 'bg-red'
  if (role.baseMerged) return 'bg-warning'
  if (role.isStagingTip) return 'bg-accent'
  if (role.isMergeNext) return 'bg-green'
  return 'bg-border-2'
}

// ── Status slot (T273 / spec T272 §4.1) ───────────────────────────────────

/**
 * The single status the card's one status slot can render.
 *
 * Deliberately camelCase so a slot doubles as its own i18n leaf:
 * `t(prStatusLabelKey(slot))` → `prStack.<slot>`.
 */
export type PrStatusSlot =
  'conflicts' | 'retarget' | 'changesRequested' | 'blocked' | 'approved' | 'review'

/** Everything {@link prStatusSlot} is allowed to look at. Nothing else. */
export interface PrStatusInput {
  /** `mergeable === false` — GitHub says this cannot merge. `null` = not computed yet. */
  mergeable: boolean | null
  /** The PR's base branch was merged and deleted, so GitHub silently retargeted it. */
  baseMerged: boolean
  /** Raw `gh` value: `APPROVED` | `CHANGES_REQUESTED` | `REVIEW_REQUIRED` | null. */
  reviewDecision: string | null
  /**
   * T274 (S2) — GitHub reports `mergeStateStatus === 'BLOCKED'` for a PR that is
   * not a draft: a branch-protection rule refuses the merge although no human
   * said no. Derived by {@link prStatusInput}, never set by hand in the SFC.
   */
  policyBlocked?: boolean
}

/**
 * Builds the ladder's input from a parsed PR — the one place `mergeStateStatus`
 * is translated into what {@link prStatusSlot} reads, so the SFC never branches
 * on GitHub's raw vocabulary.
 *
 * - `DIRTY` is GitHub's own word for "conflicts", so it lands on the same rank
 *   as `mergeable === false` (spec §4.1 rank 1) instead of opening a second
 *   conflicts chip. The two normally agree; `DIRTY` wins when `mergeable` is
 *   still uncomputed.
 * - `BLOCKED` on a **draft** is not a policy block: GitHub folds its deprecated
 *   `DRAFT` state into `BLOCKED`, so the draft badge already explains it and a
 *   `blocked` chip beside it would say the same thing twice.
 * - `BLOCKED` while checks are **running** is not a policy block either: GitHub
 *   reports `BLOCKED` until required checks finish, so an approved PR would
 *   flash `blocked` → `approved` on every CI run. The `running N` CI chip already
 *   names that wait, and the drawer's merge row still says `blocked`
 *   ({@link prMergeStateNoteKey}). A *failing* required check keeps the chip:
 *   that block stays until someone acts.
 */
export function prStatusInput(
  pr: Pick<PrEntry, 'mergeable' | 'reviewDecision' | 'mergeStateStatus' | 'isDraft' | 'ci'>,
  baseMerged: boolean
): PrStatusInput {
  return {
    mergeable: pr.mergeStateStatus === 'DIRTY' ? false : pr.mergeable,
    baseMerged,
    reviewDecision: pr.reviewDecision,
    policyBlocked: pr.mergeStateStatus === 'BLOCKED' && !pr.isDraft && pr.ci !== 'pending'
  }
}

/**
 * The card's status slot holds **exactly one** chip, and this function picks it.
 *
 * It is a function rather than a `v-if` ladder in the SFC because seven units
 * (T273..T279) all target the same flex line: as a template chain each would
 * re-litigate its own priority in template order, and none of it would be
 * testable. Every later unit changes THIS function.
 *
 * Precedence, highest first — spec `docs/specs/T272-pr-stack-card-signals.md`
 * §4.1 is the authority:
 *
 * | # | slot               | why it outranks the next                       |
 * |---|--------------------|------------------------------------------------|
 * | 1 | `conflicts`        | nothing can proceed until the tree merges       |
 * | 2 | `retarget`         | the PR points at a branch that is gone          |
 * | 3 | `changesRequested` | a human read it and blocked it                  |
 * | 4 | `blocked`          | policy blocks it, no human did (T274)           |
 * | 5 | `approved`         | ready, pending mechanics                        |
 * | 6 | `review`           | fallback: nothing above applies                 |
 *
 * **`blocked` yields to `review` while a required review is outstanding.** On a
 * branch that requires reviews, GitHub reports `BLOCKED` for every PR still
 * waiting on one — the missing review IS the block, and `review` names it more
 * precisely than `blocked` would. Without this, `blocked` would swallow the
 * whole neutral bucket on any protected repo. The block is still surfaced: the
 * drawer's merge row says it (see {@link prMergeStateNoteKey}).
 *
 * **Draft is deliberately absent.** A draft's review state is not meaningful, so
 * draft is a card-level state (the identity row's badge), not a verdict about
 * the review — putting it in this ladder would hide a real `changesRequested`
 * behind "not finished yet".
 */
export function prStatusSlot(pr: PrStatusInput): PrStatusSlot {
  if (pr.mergeable === false) return 'conflicts'
  if (pr.baseMerged) return 'retarget'
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'changesRequested'
  if (pr.policyBlocked === true && pr.reviewDecision !== 'REVIEW_REQUIRED') return 'blocked'
  if (pr.reviewDecision === 'APPROVED') return 'approved'
  return 'review'
}

/**
 * Token pairing per `design.md` §6 "Readiness chips". Red and green are
 * **reserved for verdicts** (spec §4.3): `blocked` is a policy state rather than
 * a human's answer, so it takes the warn pairing that `retarget` already uses.
 */
export function prStatusChipClass(slot: PrStatusSlot): string {
  switch (slot) {
    case 'conflicts':
    case 'changesRequested':
      return 'bg-red-soft text-red'
    case 'retarget':
    case 'blocked':
      return 'bg-warning/10 text-warning'
    case 'approved':
      return 'bg-green-soft text-green'
    case 'review':
      return 'bg-surface-2 text-text-3'
  }
}

/** The `prStack.*` message key for a slot. */
export function prStatusLabelKey(slot: PrStatusSlot): string {
  return `prStack.${slot}`
}

// ── Waiting on reviewer (T277 / spec T272 §5.5) ───────────────────────────

/**
 * Splits the neutral `review` slot into its two very different halves:
 * *nobody was asked* (next action: request a reviewer) and *asked, no answer*
 * (next action: ping, or wait). Before this, both drew the same grey chip.
 */
export interface PrWaitingOn {
  /** The reviewer the chip names: `@dberri`. */
  lead: string
  /** The overflow suffix — `+2` — or `null` when `lead` is the only one. */
  more: string | null
  /** Every pending reviewer, in chip order, for the drawer and the tooltip. */
  all: string[]
}

/**
 * Neutral pairing, the same `wait` variant as the `review` slot it qualifies.
 * A PR correctly awaiting review is not in a bad state, so it never takes the
 * warning tone (spec §4.3 keeps red and green for verdicts).
 */
export const PR_WAITING_CHIP_CLASS = 'bg-surface-2 text-text-3'

/** A GitHub login or team slug — the only shapes an `@` addresses. */
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * How one pending request reads on the card. A user is `@login`; a team is
 * `@slug`. A team that arrived with only a display name (pr-stack-core keeps
 * the row rather than drop an unanswered request) stays plain text: `@Platform
 * Core` would name a handle that does not exist.
 */
export function reviewerHandle(r: PrReviewRequest): string {
  const login = r.login.trim()
  return HANDLE.test(login) ? `@${login}` : login
}

/**
 * The waiting-on chip for a card, or `null` when there is none to draw.
 *
 * Gated on {@link prStatusSlot} rather than on the raw review fields: the
 * request list only means something while the slot is the neutral `review`.
 * Once a verdict exists it is noise — GitHub keeps a second reviewer's request
 * pending after the first approves, and the approval is the news. The SFC
 * passes the slot it already computed, so the precedence lives in one place.
 *
 * Users lead over teams (a person is who you can ping), in GitHub's order
 * within each kind; a duplicate is counted once. `null`, `undefined`, an empty
 * list and a list of blank entries all return `null`, so the card can never
 * draw an empty `waiting` chip.
 */
export function prWaitingOn(
  slot: PrStatusSlot,
  requests: readonly PrReviewRequest[] | null | undefined
): PrWaitingOn | null {
  if (slot !== 'review' || !Array.isArray(requests)) return null
  const valid = requests.filter(
    (r): r is PrReviewRequest => !!r && typeof r.login === 'string' && r.login.trim() !== ''
  )
  const seen = new Set<string>()
  const all = [...valid.filter((r) => r.kind !== 'team'), ...valid.filter((r) => r.kind === 'team')]
    .filter((r) => {
      const key = `${r.kind}:${r.login.trim()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(reviewerHandle)
  if (all.length === 0) return null
  return { lead: all[0], more: all.length > 1 ? `+${all.length - 1}` : null, all }
}

// ── Diff size (T276 / spec T272 §5.4) ──────────────────────────────────────

/** The three `PrEntry` counts the diff-size chip reads. `null` = GitHub did not say. */
export interface PrDiffSize {
  additions: number | null
  deletions: number | null
  changedFiles: number | null
}

/**
 * The only words in the diff-size string. Passed in so the formatter stays pure
 * and the SFC keeps the plural rules where vue-i18n owns them.
 */
export interface DiffSizeLabels {
  /** `n` is the raw count (picks singular/plural); `count` is `n` as rendered. */
  files: (n: number, count: string) => string
  /** A PR GitHub measured as touching nothing at all. */
  empty: string
}

/**
 * The diff-size chip's token pairing — the `wait` readiness variant (design.md
 * §6). Muted on purpose: spec §4.3 reserves red and green for verdicts, and a
 * size is not one, so GitHub's `+green −red` convention is not followed.
 */
export const DIFF_SIZE_CHIP_CLASS = 'bg-surface-2 text-text-3'

/** A real count: a finite, non-negative integer. `undefined` and `null` are not. */
function isCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0
}

/**
 * `412` → `412`, `1_234` → `1.2k`, `48_900` → `48k`, `2_310_000` → `2.3M`.
 *
 * TRUNCATES rather than rounds: a size is a lower bound, so `1_999` is `1.9k`
 * and never `2k` — and no rounding can ever carry `999_999` over into `1000k`.
 * The decimal separator is always `.`, locale-neutral on purpose like
 * {@link shortAgo}: the card needs a fixed-width token, not a sentence.
 */
export function compactCount(n: number): string {
  if (n < 1_000) return String(n)
  if (n < 10_000) return `${Math.floor(n / 100) / 10}k`
  if (n < 1_000_000) return `${Math.floor(n / 1_000)}k`
  if (n < 10_000_000) return `${Math.floor(n / 100_000) / 10}M`
  return `${Math.floor(n / 1_000_000)}M`
}

/**
 * The card's diff-size string: `+412 −38 · 9 files`.
 *
 * - **Missing data renders nothing.** Any of the three counts absent or not a
 *   count → `''`, which the card reads as "draw no chip". Never `+0 −0 · 0
 *   files`: that is a claim the PR is empty, and absence is no evidence of it.
 * - **A measured empty PR says so** — all three counts a real `0` → the `empty`
 *   label, so a PR that touches nothing is distinguishable from one whose size
 *   never arrived.
 * - Thousands abbreviate through {@link compactCount} unless `exact` is set; the
 *   collapsed chip abbreviates so it stays short, the drawer row does not.
 * - `−` is U+2212, the minus sign — the width of `+`, not a hyphen.
 */
export function formatDiffSize(
  size: PrDiffSize,
  labels: DiffSizeLabels,
  opts: { exact?: boolean } = {}
): string {
  const { additions, deletions, changedFiles } = size
  if (!isCount(additions) || !isCount(deletions) || !isCount(changedFiles)) return ''
  if (additions === 0 && deletions === 0 && changedFiles === 0) return labels.empty
  const fmt = opts.exact ? String : compactCount
  return `+${fmt(additions)} −${fmt(deletions)} · ${labels.files(changedFiles, fmt(changedFiles))}`
}

// ── Auto-merge (T279 / spec T272 §5.7) ────────────────────────────────────

/** The drawer's auto-merge row, as a `prStack.*` message key plus its params. */
export interface AutoMergeDetail {
  key: string
  params: { method?: string; actor?: string }
}

/**
 * What the drawer says about an armed auto-merge: the merge method and who
 * armed it — `squash, armed by @x`.
 *
 * Each half is dropped on its own when GitHub did not report it, and with
 * neither the row still reads `armed`: the presence of `autoMergeRequest` is
 * the signal (`autoMergeOf` in `pr-stack-core.ts`), so an unreadable payload
 * must not render an empty row that reads as un-armed.
 *
 * The method is lowercased and left untranslated — `squash` / `merge` /
 * `rebase` are GitHub's own nouns, kept verbatim like every other git term in
 * the copy (design.md §8). The actor is a login, so it takes the `@`.
 */
export function autoMergeDetail(am: PrAutoMerge): AutoMergeDetail {
  const method = am.mergeMethod ? am.mergeMethod.toLowerCase() : null
  const actor = am.enabledBy ? `@${am.enabledBy}` : null
  if (method && actor) return { key: 'prStack.autoMergeMethodBy', params: { method, actor } }
  if (method) return { key: 'prStack.autoMergeMethod', params: { method } }
  if (actor) return { key: 'prStack.autoMergeBy', params: { actor } }
  return { key: 'prStack.autoMergeArmed', params: {} }
}

// ── Unresolved review threads (T275 / spec T272 §5.3) ─────────────────────

/**
 * The thread fields of a `PrEntry`. `undefined` is accepted and read as
 * absent, so a payload from before the field existed can never render a count.
 */
export interface PrThreadsInput {
  unresolvedThreads?: number | null
  outdatedThreads?: number | null
  threadsTruncated?: boolean
}

/** `3`, or `3+` when GitHub holds more threads than were read. */
export function threadCountText(n: number, truncated: boolean): string {
  return truncated ? `${n}+` : String(n)
}

/**
 * The additive thread chip — its count text, or `null` for no chip.
 *
 * It is not the status slot (spec §4.2 lists it as additive): it sits right
 * after whatever `prStatusSlot()` picked and never displaces it, because
 * "approved, with three open threads" is two facts and the card must say both.
 *
 * No chip in two cases, for two different reasons:
 *   - **unmeasured** (`null`) — absence is not zero, and a failed call supports
 *     no claim at all;
 *   - **measured zero** — nothing to act on; the drawer row still says `0`.
 *
 * Outdated threads never count here: the code they point at is gone.
 */
export function prThreadChip(pr: PrThreadsInput): { count: string } | null {
  const n = pr.unresolvedThreads
  if (typeof n !== 'number' || n <= 0) return null
  return { count: threadCountText(n, pr.threadsTruncated === true) }
}

/**
 * The drawer's `threads` row — where outdated threads are broken out, so
 * nothing the chip leaves out is hidden, only deprioritised.
 *
 * `null` means the threads could not be read (the row says so, which is what
 * keeps a measured `0` distinguishable from no data). `outdated` is `null`
 * when there are none, so the row does not spend a clause on a zero.
 */
export function prThreadsDrawer(
  pr: PrThreadsInput
): { unresolved: string; outdated: string | null } | null {
  const n = pr.unresolvedThreads
  if (typeof n !== 'number') return null
  const truncated = pr.threadsTruncated === true
  const outdated = typeof pr.outdatedThreads === 'number' ? pr.outdatedThreads : 0
  return {
    unresolved: threadCountText(n, truncated),
    outdated: outdated > 0 ? threadCountText(outdated, truncated) : null
  }
}

// ── Label chips (T278 / spec T272 §4.2, §5.6) ─────────────────────────────

/** How many label chips a card draws at `full`. The rest go to the drawer. */
export const LABEL_CHIP_CAP = 2

export interface LabelChips {
  /** Names drawn as chips on the collapsed card — at most {@link LABEL_CHIP_CAP}. */
  chips: string[]
  /** Labels past the cap, shown as a bare `+N` count. `0` renders nothing. */
  hidden: number
  /**
   * Every label, for the drawer's `labels` row. The FULL list, not just the
   * remainder: the chips sit last in a track that clips from the trailing edge,
   * so a chip that is "shown" may still be clipped off a 272px card, and spec
   * §4.2 requires every additive chip to be findable at `full` + expanded.
   */
  drawer: string[]
}

/**
 * Which labels the card draws, and where.
 *
 * - `enabled` is the Settings → PR Stack toggle, **off by default**: labels are
 *   the one signal whose worth is entirely repo-dependent, so off means off —
 *   no chip, no count and no drawer row.
 * - Chips render only at `full`, capped at {@link LABEL_CHIP_CAP}. Below `full`
 *   there are no chips at all (spec §4.2 budget); the drawer itself only opens
 *   at `full`, so it is where the remainder is found.
 * - An empty or absent list renders nothing anywhere.
 *
 * Names only, never colours: `PrEntry.labels` carries no hex, so nothing this
 * returns can paint a raw colour into the card (`design.md` §9).
 */
export function labelChips(
  labels: readonly string[] | null | undefined,
  lod: Lod,
  enabled: boolean
): LabelChips {
  const none: LabelChips = { chips: [], hidden: 0, drawer: [] }
  if (!enabled || !labels) return none
  const names = labels.filter((name) => typeof name === 'string' && name.trim() !== '')
  if (names.length === 0) return none
  if (lod !== 'full') return { ...none, drawer: names }
  return {
    chips: names.slice(0, LABEL_CHIP_CAP),
    hidden: Math.max(0, names.length - LABEL_CHIP_CAP),
    drawer: names
  }
}

// ── Behind its base (T274 / spec T272 §2.4, §5.2) ─────────────────────────

/**
 * What the card can honestly say about how far a PR's branch trails its base.
 *
 * Three states, not two — that is the whole fix. Before T274 a missing behind
 * chip meant "up to date" OR "never fetched here", and nothing told them apart.
 */
export type PrBehindState =
  /** Behind. `count` is the local magnitude, or `null` when git could not count it. */
  | { kind: 'behind'; count: number | null }
  /** Measured locally: zero commits behind, and GitHub does not say otherwise. */
  | { kind: 'upToDate' }
  /** The branch (or its base) is not in this checkout, and GitHub did not say `BEHIND`. */
  | { kind: 'unmeasured' }

/**
 * Combines GitHub's merge verdict with the local `git rev-list` count.
 *
 * **Option A, accepted by the operator (card T274, 2026-09-03): keep both.**
 * GitHub's `BEHIND` is computed server-side against the real refs, so it shows
 * the chip whether or not this machine ever fetched the branch — and it beats a
 * local `0`, which only means this checkout's refs are stale. The local count
 * stays as enrichment: it turns `behind` into `5 behind` when the branch is here.
 * Option B (drop `rev-list`, boolean chip) would lose the number; option C
 * (leave behind alone) would not fix the bug.
 *
 * **Any other GitHub value is silence, not "up to date".** GitHub reports
 * `BEHIND` only when the base branch requires branches to be up to date before
 * merging, and a `BLOCKED` or `DIRTY` verdict masks it. A PR stacked on another
 * PR's branch — the canvas's core case — never has such a rule, and neither does
 * a repo without branch protection. So a positive local count still shows the
 * chip under `CLEAN`: hiding it there would erase the behind chip from every
 * stacked PR, which is the loss option A exists to avoid.
 *
 * @param localBehind the snapshot's `behind[n]`: a number when git counted
 *   (`0` included), `undefined` when it could not.
 */
export function prBehindState(
  mergeStateStatus: MergeStateStatus | null,
  localBehind: number | undefined
): PrBehindState {
  const counted =
    typeof localBehind === 'number' && Number.isInteger(localBehind) && localBehind >= 0
      ? localBehind
      : null
  if (mergeStateStatus === 'BEHIND') {
    return { kind: 'behind', count: counted !== null && counted > 0 ? counted : null }
  }
  if (counted === null) return { kind: 'unmeasured' }
  if (counted > 0) return { kind: 'behind', count: counted }
  return { kind: 'upToDate' }
}

/** An i18n key plus its `n` param, ready for `t(key, { n })`. */
export interface PrLabel {
  key: string
  n?: number
}

/** The behind chip's label, or `null` when the card must show no chip at all. */
export function prBehindChipLabel(state: PrBehindState): PrLabel | null {
  if (state.kind !== 'behind') return null
  return state.count === null
    ? { key: 'prStack.behindBare' }
    : { key: 'prStack.behind', n: state.count }
}

/**
 * The drawer's `vs base` row. Always a sentence — never an empty row — so an
 * expanded card distinguishes "up to date" from "could not measure locally".
 */
export function prBehindDrawerLabel(state: PrBehindState): PrLabel {
  switch (state.kind) {
    case 'behind':
      return state.count === null
        ? { key: 'prStack.behindBaseGithub' }
        : { key: 'prStack.behindBase', n: state.count }
    case 'upToDate':
      return { key: 'prStack.upToDate' }
    case 'unmeasured':
      return { key: 'prStack.notMeasured' }
  }
}

/**
 * The drawer's `merge` row: GitHub's verdict when it is one the card's chips do
 * not already carry, else `null` (no row).
 *
 * - `BLOCKED` — always said here, including when the status slot yields to
 *   `review` or `changes requested`: the chip names the most blocking thing,
 *   the drawer names every one. Not on a draft, whose badge already says why.
 * - `UNSTABLE` — a non-required check is failing. Drawer only: the CI chip
 *   already reads `failing N`, and a second chip for it would double up.
 */
export function prMergeStateNoteKey(
  pr: Pick<PrEntry, 'mergeStateStatus' | 'isDraft'>
): string | null {
  if (pr.mergeStateStatus === 'BLOCKED' && !pr.isDraft) return 'prStack.mergeBlocked'
  if (pr.mergeStateStatus === 'UNSTABLE') return 'prStack.mergeUnstable'
  return null
}
