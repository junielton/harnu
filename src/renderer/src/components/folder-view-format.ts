import type { PrEntry } from '../../../main/pr-stack-core'
import type { RoadmapPeekCard } from '../../../preload'
import type { Session } from '../stores/sessions'
import type { Dot as SessionDot } from './session-dot'

/**
 * T212 — pure shaping for `FolderView`. Same seam as `pr-stack-format.ts` and
 * `usage-history-format.ts`: the view renders, this module decides. Keeping the
 * buckets here is what lets the three sections be tested without jsdom.
 *
 * T285 extends the seam with the two things the scope-aware redesign turns on:
 * which **profile** a folder gets, and what **scope** each block really has.
 *
 * T286 adds the main profile's own two blocks: the fan-out rows (store counts
 * joined with git, card ownership and PR state) and the activity strip geometry.
 */

/** How many live sessions the view shows before the rest fold into "Older". */
export const VISIBLE_LIMIT = 8

export interface FolderSessionBuckets {
  current: Session[]
  older: Session[]
  archived: Session[]
}

function byNewest(a: Session, b: Session): number {
  return a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0
}

/**
 * Split a folder's sessions into the three sections the view renders. Archived
 * sessions never appear in `current`/`older` — archiving is the operator saying
 * "not part of the working set", and the view must honor that before recency.
 */
export function bucketSessions(
  sessions: readonly Session[],
  isArchived: (id: string) => boolean,
  visibleLimit: number = VISIBLE_LIMIT
): FolderSessionBuckets {
  const archived: Session[] = []
  const live: Session[] = []
  for (const s of sessions) {
    if (isArchived(s.sessionId)) archived.push(s)
    else live.push(s)
  }
  live.sort(byNewest)
  archived.sort(byNewest)
  return {
    current: live.slice(0, visibleLimit),
    older: live.slice(visibleLimit),
    archived
  }
}

// --- T285: profiles ----------------------------------------------------------

/**
 * The two jobs the Folder View does. `main` is the repo's orchestration home
 * (plan, dispatch, watch the fan-out); `worktree` is one feature's cockpit (land
 * a card, then die). The blocks are the same components either way — the profile
 * decides which one leads and how the rail is ordered.
 */
export type FolderViewProfile = 'main' | 'worktree'

/**
 * The only fields the profile decision reads. Deliberately structural rather
 * than `Folder`, so the rule is testable without a store, and so a caller with a
 * partial folder (a preview, a fixture) can ask the same question.
 */
export interface FolderProfileInput {
  repoId?: string
  gitBranch?: string
  isMainWorktree?: boolean
}

/** Is this folder inside a git repo at all? Mirrors `FolderView`'s own gate. */
export function isGitFolder(folder: FolderProfileInput | null | undefined): boolean {
  if (!folder) return false
  return (typeof folder.repoId === 'string' && folder.repoId.length > 0) || !!folder.gitBranch
}

/**
 * Resolve the profile. A folder is a cockpit only when it is a git folder that
 * git itself calls a linked worktree — `isMainWorktree === false`, never a
 * missing field, which means "not probed" and not "linked".
 *
 * A plain pinned folder with no repo gets `main`: it has no siblings and no
 * branch, so the cockpit would be a frame around nothing.
 */
export function resolveProfile(folder: FolderProfileInput | null | undefined): FolderViewProfile {
  if (!folder) return 'main'
  return isGitFolder(folder) && folder.isMainWorktree === false ? 'worktree' : 'main'
}

// --- T285: scope -------------------------------------------------------------

/**
 * Whether a block describes the folder you clicked, or the whole repo.
 *
 * This distinction is not cosmetic. `resolveMemoryCheckout` and
 * `resolveMemoryLocation` collapse every worktree of a repo onto its main
 * checkout, so a worktree's "Where we left off" and roadmap counts are
 * byte-identical to main's; the worktrees list is the repo's siblings, not this
 * folder's children. Printed untagged, all of it reads as a description of the
 * folder — which is a lie the view used to tell.
 */
export type BlockScope = 'folder' | 'repo'

/** Every block the Folder View can render, in either profile. */
export type FolderViewBlock =
  'sessions' | 'git' | 'memory' | 'roadmap' | 'worktrees' | 'fanout' | 'ownedCard' | 'activity'

/**
 * The scope table, as data. Headers read their tag from here through
 * {@link scopeOf} rather than hard-coding a chip in a template, so a tag can
 * never drift away from the read that feeds it.
 *
 * `fanout`, `ownedCard` and `activity` are declared before they are built
 * (T286 / T287 / unscheduled): the table is the contract, and a block that
 * lands later must not get to invent its own scope.
 */
export const BLOCK_SCOPE: Record<FolderViewBlock, BlockScope> = {
  // `folder.sessions`, keyed by cwd.
  sessions: 'folder',
  // `folders:gitStatus` on this path.
  git: 'folder',
  // `card.executedIn` === this branch.
  ownedCard: 'folder',
  // `resolveMemoryCheckout` collapses worktrees onto the main checkout.
  memory: 'repo',
  // Same collapse, via `roadmap:peek`.
  roadmap: 'repo',
  // Siblings by `repoId` — all of them, not just children.
  worktrees: 'repo',
  // Every sibling branch, with its card, sessions, git and PR.
  fanout: 'repo',
  // Sessions bucketed across the repo.
  activity: 'repo'
}

/** The real scope of `block`. */
export function scopeOf(block: FolderViewBlock): BlockScope {
  return BLOCK_SCOPE[block]
}

// --- T285 AC-4: activity shaping --------------------------------------------

/**
 * A local calendar day key (`YYYY-MM-DD`). Local, not UTC: "how many sessions
 * did I start on Tuesday" is a question about the operator's own day, and a UTC
 * key silently moves late-evening work into tomorrow. Same convention (and same
 * deliberate small duplication) as `usage-dashboard-format.ts`'s private key
 * helper — the format seams stay independent of each other.
 */
function localDayKey(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** How many days the activity strip covers. */
export const ACTIVITY_DAYS = 14

/** One column of the activity strip. */
export interface ActivityDay {
  /** Local `YYYY-MM-DD`. */
  day: string
  /** Sessions **created** on that day. */
  count: number
  /** True for the last bucket — the strip emphasises today. */
  isToday: boolean
}

/**
 * Sessions started per local day over the last {@link ACTIVITY_DAYS} days,
 * oldest first, **including days with nothing on them** — a sparkline with holes
 * punched out of it misreads as a shorter, busier history than it was.
 *
 * Keyed on `created`, not `modified`: the strip answers "when did work start
 * here", and `modified` would move every old session onto today the moment it is
 * touched. A session whose `created` is unparseable or outside the window is
 * dropped rather than bucketed to an edge day.
 */
export function sessionsPerDay(
  sessions: readonly Session[],
  now: number = Date.now(),
  days: number = ACTIVITY_DAYS
): ActivityDay[] {
  const span = Math.max(1, Math.floor(days))
  const todayKey = localDayKey(now)

  // Walk back day-by-day from local midnight, so a DST shift can never drop or
  // duplicate a column the way `now - n * 86_400_000` does.
  const anchor = new Date(now)
  anchor.setHours(0, 0, 0, 0)
  const out: ActivityDay[] = []
  const index = new Map<string, ActivityDay>()
  for (let i = span - 1; i >= 0; i--) {
    const d = new Date(anchor)
    d.setDate(d.getDate() - i)
    const key = localDayKey(d.getTime())
    const bucket: ActivityDay = { day: key, count: 0, isToday: key === todayKey }
    out.push(bucket)
    index.set(key, bucket)
  }

  for (const s of sessions) {
    const ms = Date.parse(s.created)
    if (Number.isNaN(ms)) continue
    const bucket = index.get(localDayKey(ms))
    if (bucket) bucket.count++
  }
  return out
}

/** The three-way split the activity strip and the sessions header both print. */
export interface ActivityCounts {
  working: number
  needsInput: number
  idle: number
}

/**
 * The three-way liveness axis the Folder View speaks in. `dotFor` resolves seven
 * dots; a Folder View session row and the counts beside it only ever distinguish
 * these three, and they must fold identically — a row painted green while the
 * tally says idle is exactly the sidebar-vs-board split (BUG-13) reappearing on a
 * third surface.
 */
export type ActivityBucket = 'working' | 'needs-input' | 'idle'

/**
 * Fold one sidebar dot onto the Folder View's three buckets.
 *
 * `stuck` folds to **working**: a stuck session is a working one gone quiet, and
 * calling it idle would under-report the fan-out. Every terminal or lifecycle
 * state (`idle`, `completed`, `failed`, `archived`) folds to **idle** — this axis
 * is a liveness read, not an outcome ledger.
 */
export function activityBucket(dot: SessionDot): ActivityBucket {
  if (dot === 'needs-input') return 'needs-input'
  if (dot === 'working' || dot === 'stuck') return 'working'
  return 'idle'
}

/**
 * Fold a working set onto working / needs-input / idle counts.
 *
 * Takes the dot **resolver** rather than the dots, so the count is fed by the
 * exact same `dotFor(...)` projection the sidebar paints with and cannot drift
 * into a second opinion — while this module stays pure and jsdom-free, since the
 * caller owns the store lookup.
 */
export function countActivity<T>(
  sessions: readonly T[],
  dotOf: (session: T) => SessionDot
): ActivityCounts {
  const counts: ActivityCounts = { working: 0, needsInput: 0, idle: 0 }
  for (const s of sessions) {
    const bucket = activityBucket(dotOf(s))
    if (bucket === 'needs-input') counts.needsInput++
    else if (bucket === 'working') counts.working++
    else counts.idle++
  }
  return counts
}

// --- T287: the worktree's feature rail ---------------------------------------

/** The four steps a card travels through, in the order the rail prints them. */
export type RailStepKey = 'dispatched' | 'commits' | 'pr' | 'merge'

/**
 * How far the rail has got. `current` is the frontier — the step the work is
 * standing on right now — and it is the ONLY accent-coloured bar, so there is
 * exactly one at a time.
 */
export type RailStepState = 'done' | 'current' | 'pending'

/** The branch's pull request, as the rail reads it. */
export interface RailPr {
  number: number
  /** The PR has landed. */
  merged: boolean
}

/**
 * Everything the rail needs, already read. `null` and `undefined` are NOT
 * interchangeable here and that distinction is the whole of AC-5: `null` means
 * "read it, there is none", `undefined` means "could not read it at all" (no
 * `gh`, no upstream, the probe timed out).
 */
export interface FeatureRailInput {
  /** A card names this branch — the dispatch is its own evidence. */
  dispatched: boolean
  /** Commits this branch carries beyond the repo base; `null` = unreadable. */
  commits: number | null
  /** The branch's PR: an entry, `null` for none, `undefined` for unreadable. */
  pr: RailPr | null | undefined
}

/** One rendered step. */
export interface RailStep {
  key: RailStepKey
  state: RailStepState
  /**
   * Could the evidence behind this step actually be read? A step that is not
   * `known` can never be `done` or `current` — it prints its bare name and an
   * empty bar, which is the honest rendering of "we do not know".
   */
  known: boolean
}

/** The rail's steps, in print order. Exported so the view cannot re-order them. */
export const RAIL_STEPS: readonly RailStepKey[] = ['dispatched', 'commits', 'pr', 'merge']

/**
 * Shape the four-step rail.
 *
 * The rule is a **frontier**, not four independent booleans: the furthest step
 * whose evidence is actually present becomes `current`, everything before it is
 * `done`, everything after is `pending`. A merged PR is the one terminal state —
 * there is nothing after it, so it reads `done` rather than `current`.
 *
 * **Unreadable evidence never advances the frontier** (AC-5). If the commit
 * count could not be read, the frontier stops at `dispatched` and the three
 * later steps print as "not yet" — a step whose evidence we cannot see must
 * never be painted as complete, because a rail that over-reports is worse than
 * no rail at all.
 */
export function featureRail(input: FeatureRailInput): RailStep[] {
  const commitsKnown = input.commits !== null
  const prKnown = input.pr !== undefined

  // Reachability, in order. A step is only reachable when every step before it
  // is — an unreadable step therefore truncates the whole rail.
  const reached: Record<RailStepKey, boolean> = {
    dispatched: input.dispatched,
    commits: false,
    pr: false,
    merge: false
  }
  reached.commits = reached.dispatched && commitsKnown && (input.commits ?? 0) > 0
  reached.pr = reached.commits && prKnown && input.pr != null
  reached.merge = reached.pr && input.pr != null && input.pr.merged

  const known: Record<RailStepKey, boolean> = {
    dispatched: true,
    commits: commitsKnown,
    pr: prKnown,
    merge: prKnown
  }

  // The frontier: the last reached step. -1 when nothing is reached at all.
  let frontier = -1
  for (let i = 0; i < RAIL_STEPS.length; i++) {
    if (reached[RAIL_STEPS[i]]) frontier = i
  }

  return RAIL_STEPS.map((key, i) => {
    if (i < frontier) return { key, state: 'done' as const, known: known[key] }
    if (i > frontier) return { key, state: 'pending' as const, known: known[key] }
    // The frontier itself: terminal once merged, in flight otherwise.
    const state: RailStepState = key === 'merge' ? 'done' : 'current'
    return { key, state, known: known[key] }
  })
}

// --- T286: the main-checkout fan-out ------------------------------------------

/**
 * One sibling worktree, as the fan-out reads it out of the store.
 *
 * Structural rather than `Folder`, and with the session counts already resolved
 * by the caller: the dot projection lives in the view (it needs the store), the
 * row shaping lives here, and that split is what lets the whole table be proved
 * without jsdom — exactly the seam {@link countActivity} already draws.
 */
export interface FanoutFolder {
  path: string
  /** `''` for a detached HEAD, in which case the row falls back to `label`. */
  branch: string
  /** What to print when there is no branch — the folder's alias. */
  label: string
  /** The folder the view is currently showing. Exactly one row carries it. */
  isSelf: boolean
  sessionCount: number
  /** Sessions that are working or waiting on you — everything but idle. */
  liveCount: number
  /** Sessions in `needs-input`. Feeds the "needs you" tile (AC-8). */
  needsInputCount: number
}

/** The four pill tones of the approved spec (`.pill.ok/.warn/.bad/.mute`). */
export type PillTone = 'ok' | 'warn' | 'bad' | 'mute'

export interface FanoutPr {
  number: number
  url: string
  /**
   * The PR's own title. The collapsed row has no room for it — its pill prints
   * a state and a number — but the expanded detail row (BUG-118) is exactly the
   * place the operator asks "which PR is that?". `PrEntry` has always carried
   * it, so passing it through costs no read.
   */
  title: string
  tone: PillTone
  /** Key under `folderView.fanout.prState.*`. */
  key: string
  /**
   * The operator is the blocker on this PR. Only `changes requested` qualifies:
   * a red build is the executor's problem, a draft is nobody's yet.
   */
  needsYou: boolean
}

/**
 * One PR entry → the pill the fan-out prints. A **total** function over
 * `PrEntry`, ordered worst-news-first so a PR can never advertise a green build
 * while a human is waiting on it:
 *
 * lifecycle (merged / closed) → changes requested → draft → CI.
 *
 * `changes requested` deliberately outranks `draft`, because it is the one state
 * that feeds the "needs you" tile and a draft carrying it still needs you.
 *
 * > **`merged` and `closed` are not reachable from `prStackLoad` today.**
 * > `buildGraph` (pr-stack-core) filters the snapshot to `state === 'OPEN'`
 * > before it leaves the main process, and `WorktreeNode.mergedPr` is a
 * > caller-supplied echo, not a lookup. The branches stay here because this is a
 * > total mapping of a type that genuinely carries those states, and because
 * > widening the snapshot is `pr-stack*.ts`'s call to make (T280), not this
 * > view's. Until it does, a merged branch shows an empty PR cell.
 */
export function prPill(pr: PrEntry): FanoutPr {
  const at = { number: pr.number, url: pr.url, title: pr.title }
  if (pr.state === 'MERGED') return { ...at, tone: 'mute', key: 'merged', needsYou: false }
  if (pr.state === 'CLOSED') return { ...at, tone: 'mute', key: 'closed', needsYou: false }
  if (pr.reviewDecision === 'CHANGES_REQUESTED')
    return { ...at, tone: 'warn', key: 'changesRequested', needsYou: true }
  if (pr.isDraft) return { ...at, tone: 'mute', key: 'draft', needsYou: false }
  if (pr.ci === 'failing') return { ...at, tone: 'bad', key: 'checksFailing', needsYou: false }
  if (pr.ci === 'pending') return { ...at, tone: 'mute', key: 'checksRunning', needsYou: false }
  if (pr.ci === 'passing') return { ...at, tone: 'ok', key: 'checksPassing', needsYou: false }
  return { ...at, tone: 'mute', key: 'open', needsYou: false }
}

/** One fan-out row: the store's counts, plus everything the async reads added. */
export interface FanoutRow extends FanoutFolder {
  /** `null` when `folders:gitStatus` did not answer — the cell degrades to nothing. */
  ahead: number | null
  behind: number | null
  /** The card whose `executedIn` names this branch (T284), or `null`. */
  card: RoadmapPeekCard | null
  /** `null` when there is no PR for this branch, or PR state is unreadable. */
  pr: FanoutPr | null
}

/**
 * Join the store's siblings with the three async reads into the rows the table
 * prints, in display order.
 *
 * Every async input is a lookup that may simply be missing, and a missing one
 * yields `null` on the row rather than dropping it: a worktree whose git probe
 * failed is still a worktree in flight, and hiding it would under-report the
 * fan-out (AC-4, AC-6).
 *
 * `prs` is `null` — not empty — when PR state could not be read at all (no `gh`,
 * no network, the call threw). The distinction is the whole of AC-6/AC-8: an
 * empty map means "asked, no PRs", `null` means "could not ask", and only the
 * second one is allowed to change what the KPI tile claims.
 */
export function fanoutRows(
  siblings: readonly FanoutFolder[],
  git: ReadonlyMap<string, { ahead?: number | null; behind?: number | null } | null>,
  cards: ReadonlyMap<string, RoadmapPeekCard | null>,
  prs: ReadonlyMap<string, PrEntry> | null
): FanoutRow[] {
  const rows = siblings.map((s): FanoutRow => {
    const g = git.get(s.path) ?? null
    const pr = s.branch && prs ? (prs.get(s.branch) ?? null) : null
    return {
      ...s,
      ahead: typeof g?.ahead === 'number' ? g.ahead : null,
      behind: typeof g?.behind === 'number' ? g.behind : null,
      card: cards.get(s.path) ?? null,
      pr: pr ? prPill(pr) : null
    }
  })
  return rows.sort(compareFanoutRows)
}

/**
 * Display order: the folder you are standing in goes **last** (it is the anchor,
 * not the news), everything else alphabetically by branch.
 *
 * Deliberately NOT sorted by liveness: a session going quiet would reorder the
 * table under the operator's cursor, and a table you cannot point at is worse
 * than one whose busiest row is not on top.
 */
function compareFanoutRows(a: FanoutRow, b: FanoutRow): number {
  if (a.isSelf !== b.isSelf) return a.isSelf ? 1 : -1
  return (a.branch || a.label).localeCompare(b.branch || b.label)
}

/** The counts the KPI strip prints, folded out of the fan-out rows. */
export interface FanoutTally {
  worktrees: number
  /** Worktrees with at least one live session. */
  inFlight: number
  idle: number
  needsYou: number
  needsYouSessions: number
  /**
   * PRs with changes requested, or `null` when PR state could not be read.
   *
   * `null` is not zero. A tile that silently counted an unreadable signal as
   * "nothing waiting" would be under-reporting exactly when the operator most
   * needs to know it is blind, so the view prints the gap instead (AC-8).
   */
  needsYouPrs: number | null
}

/**
 * Fold the rows onto the KPI counts. `prsAvailable` is the caller's answer to
 * "could we read PR state at all", and it is the only thing that decides whether
 * the PR signal is counted or declared missing.
 */
export function fanoutTally(rows: readonly FanoutRow[], prsAvailable: boolean): FanoutTally {
  let inFlight = 0
  let needsYouSessions = 0
  let needsYouPrs = 0
  for (const row of rows) {
    if (row.liveCount > 0) inFlight++
    needsYouSessions += row.needsInputCount
    if (row.pr?.needsYou) needsYouPrs++
  }
  return {
    worktrees: rows.length,
    inFlight,
    idle: rows.length - inFlight,
    needsYouSessions,
    needsYouPrs: prsAvailable ? needsYouPrs : null,
    needsYou: needsYouSessions + (prsAvailable ? needsYouPrs : 0)
  }
}

// --- T286 AC-9: activity strip geometry --------------------------------------

/** The activity sparkline's coordinate space. Matches the approved spec 1:1. */
export const ACTIVITY_VIEWBOX = { width: 280, height: 44 } as const

/** Baseline y. The axis rule sits half a pixel below it, at `43.5`. */
const ACTIVITY_BASELINE = 43

/** One bar of the activity strip, in `ACTIVITY_VIEWBOX` coordinates. */
export interface ActivityBar extends ActivityDay {
  x: number
  y: number
  width: number
  height: number
  /** A day with nothing on it — painted as a flat `--border-2` tick, not a gap. */
  isZero: boolean
}

/**
 * Lay the day buckets out as bars.
 *
 * A zero day gets a 2px tick rather than no mark at all: the strip's job is to
 * show the **shape** of a fortnight, and a fortnight with four quiet days is a
 * different picture from a ten-day history. Non-zero bars carry a 4px floor for
 * the same reason — a single session must not round down to invisible.
 */
export function activityBars(days: readonly ActivityDay[]): ActivityBar[] {
  if (days.length === 0) return []
  const slot = ACTIVITY_VIEWBOX.width / days.length
  const width = Math.max(1, slot - 4)
  const peak = days.reduce((max, d) => Math.max(max, d.count), 0)
  return days.map((day, i) => {
    const isZero = day.count === 0
    const height = isZero
      ? 2
      : Math.max(4, Math.round((day.count / Math.max(1, peak)) * (ACTIVITY_BASELINE - 1)))
    return {
      ...day,
      isZero,
      x: i * slot + 2,
      y: ACTIVITY_BASELINE - height,
      width,
      height
    }
  })
}
