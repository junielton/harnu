/**
 * Missions v4 S-3 (R-25, AC-4) — a read with no side effects.
 *
 * `deriveMission` computes one mission's live view: each step's linked sessions, its
 * worktree / card / PR links joined to commits and pull requests, the gates, the existence
 * proofs, the stall verdict and the progress. It READS (the mission, git, `gh`, the sticky
 * last-known cache) and writes nothing: no file, no sidecar row, no remembered sighting, no
 * steward wake. What the read learned travels back in `MissionReading.observation`, and only
 * the observer (`./observer.ts`) acts on it.
 *
 * The live sources that belong to the MCP layer (the scoped fleet projection of a mission's
 * sessions) are injected as {@link DeriveDeps}, so this module never imports the handlers.
 */
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { DATA_DIR, LEGACY_DATA_DIRS, mapLegacyDataPath } from '../data-dir'
import type { MissionChildState } from '../mcp/fleet-snapshot'
import { buildStepPulse, type MissionStepPulse } from '../mission-pulse'
import {
  findMainCi,
  findPrsForWorktrees,
  type MissionPrJoin,
  type WorktreePrJoin
} from '../pr-stack'
import type { PrEntry } from '../pr-stack-core'
import { checkDeliveredMissions } from '../github-budget-tracker'
import {
  ensureLinkCacheLoaded,
  getLastKnown,
  type LinkCacheKind,
  type LinkResolution
} from '../mission-link-cache'
import {
  computeStepGates,
  hasEvidenceBundle,
  type GateCi,
  type GatePrFacts,
  type StepGates
} from '../mission-gates'
import { missionScope, type Mission, type MissionStep, type StepLink } from '../mission-core'
import { computeProgress, type MissionProgress } from '../mission-progress'
import { readCard } from '../roadmap-ipc'

/**
 * Why a physically-resolved path cannot prove "Scope confirmed" (Mission v2
 * §3.1, BUG-145): it lies outside the repo, it is the repo root, it has a
 * `.git` / `.harnu` (or legacy `.capy`) component at any depth, or it is — or is inside — a git
 * checkout (a directory holding a `.git` entry, file or dir: a linked worktree,
 * a submodule, a nested clone) or Harnu's worktree home `.claude/worktrees`.
 * All of those exist in, or next to, every repo, so like the root they would
 * prove the step trivially. Components compare case-insensitively (a
 * case-insensitive file system resolves `.HARNU` to `.harnu`). `null` = a scope
 * path.
 */
export type ScopeTargetProblem = 'outside' | 'root' | 'internal' | 'checkout'

export async function scopeTargetProblem(
  real: string,
  realRoot: string
): Promise<ScopeTargetProblem | null> {
  if (real === realRoot) return 'root'
  if (!isInside(real, realRoot)) return 'outside'
  const parts = path.relative(realRoot, real).split(path.sep)
  const lower = parts.map((c) => c.toLowerCase())
  if (lower.some((c) => c === '.git' || c === DATA_DIR || LEGACY_DATA_DIRS.includes(c)))
    return 'internal'
  if (lower[0] === '.claude' && lower[1] === 'worktrees') return 'checkout'
  // The path itself, or any directory between the root and it, being a checkout.
  // Fails CLOSED: only "no such entry" (ENOENT / ENOTDIR) means no `.git` there;
  // any other error (EACCES on an unsearchable dir, …) could hide one, so it
  // counts as a checkout rather than as proof there is none.
  for (let i = 1; i <= parts.length; i++) {
    try {
      await fs.lstat(path.join(realRoot, ...parts.slice(0, i), '.git'))
      return 'checkout'
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return 'checkout'
    }
  }
  return null
}

export const SCOPE_PROBLEM_TEXT: Record<ScopeTargetProblem, string> = {
  outside: 'resolves outside the repo',
  root: 'is the repo root',
  internal: 'is inside .git, .harnu or .capy',
  checkout: 'is a worktree checkout (or inside one)'
}

/** `p` lies strictly inside the directory `dir`. */
export function isInside(p: string, dir: string): boolean {
  return p.startsWith(dir + path.sep)
}

// ---- T358 S6: derived live signals + the stall rule (design §7, §8) ---------

/** design §8 — a mission with no new evidence for longer than this, and no linked session working, is stale. */
export const MISSION_STALL_AFTER_MS = 60 * 60 * 1000

/** What {@link evaluateMissionStall} decided, and from what — reported verbatim in the ACK. */
export interface MissionStall {
  stale: boolean
  /** ISO time of the newest evidence; `null` only when no timestamp parsed at all. */
  lastEvidenceAt: string | null
  thresholdMs: number
  /** Linked sessions whose `taskState` is `working` — any one of them keeps the mission active. */
  workingSessions: string[]
}

/** Every `### <ISO>` heading `mission_log` writes into the Log body. */
function missionLogTimestamps(log: string): string[] {
  return [...log.matchAll(/^### (\d{4}-\d{2}-\d{2}T[0-9:.]+Z)/gm)].map((m) => m[1])
}

/**
 * design §8, exactly, with no model call:
 *
 *     stale := (mission.status == 'active')
 *           && (now - lastEvidenceAt > 1h)
 *           && every linked session's taskState != 'working'
 *
 * `lastEvidenceAt` = max of the mission's `updatedAt`, its steps' and blockers'
 * own timestamps, every `mission_log` entry, every linked session's last
 * `taskState` transition and its subagents' last hook, and (T547) the newest
 * commit on each linked worktree. The verdict lives only in `mission_get`'s `derived`
 * block — `stale` is never written to the stored status (§3), so the rule
 * always reads the operator-approved `active`, and `draft`/`delivered`/`closed`
 * never go stale. Pure; `now` is injected.
 */
export function evaluateMissionStall(
  mission: Mission,
  log: string,
  children: readonly Pick<
    MissionChildState,
    'sessionId' | 'taskState' | 'lastTransitionAt' | 'helperActivityAt'
  >[],
  now: number,
  /** T547: extra evidence timestamps (ISO) — the commits landed on linked worktrees. */
  extraEvidence: readonly string[] = []
): MissionStall {
  const stamps = [
    mission.updatedAt,
    ...mission.blockers.map((b) => b.raisedAt),
    ...mission.steps.flatMap((s) => [
      ...(s.verifiedBy ? [s.verifiedBy.at] : []),
      ...s.blockers.map((b) => b.raisedAt)
    ]),
    ...missionLogTimestamps(log),
    ...children.flatMap(
      (c) => [c.lastTransitionAt, c.helperActivityAt].filter((t) => !!t) as string[]
    ),
    ...extraEvidence
  ]
  const last = stamps.map((t) => Date.parse(t)).filter(Number.isFinite)
  const lastMs = last.length > 0 ? Math.max(...last) : null
  const workingSessions = children.filter((c) => c.taskState === 'working').map((c) => c.sessionId)
  const stale =
    mission.status === 'active' &&
    (lastMs === null || now - lastMs > MISSION_STALL_AFTER_MS) &&
    workingSessions.length === 0
  return {
    stale,
    lastEvidenceAt: lastMs === null ? null : new Date(lastMs).toISOString(),
    thresholdMs: MISSION_STALL_AFTER_MS,
    workingSessions
  }
}

/** A PR as a mission reports it — the canvas's `PrEntry`, trimmed to what an owner reads. */
export interface MissionPrSummary {
  number: number
  title: string
  state: PrEntry['state']
  isDraft: boolean
  ci: PrEntry['ci']
  url: string
  /** The branch the PR merges INTO (Mission v2 §3.6) — informative, no derived flag. */
  baseRefName: string
  /** When GitHub says the PR was opened / merged (ISO); present only when it said. */
  createdAt?: string
  mergedAt?: string
}

function prSummary(p: PrEntry): MissionPrSummary {
  return {
    number: p.number,
    title: p.title,
    state: p.state,
    isDraft: p.isDraft,
    ci: p.ci,
    url: p.url,
    baseRefName: p.base,
    ...(p.createdAt ? { createdAt: p.createdAt } : {}),
    ...(p.mergedAt ? { mergedAt: p.mergedAt } : {})
  }
}

/** One resolved non-session link (design §7): what it points at, and whether that exists. */
export type MissionLinkSignal =
  | {
      kind: 'worktree'
      ref: string
      exists: boolean
      branch: string | null
      head: { sha: string; subject: string; at: string } | null
      /** T547: commits beyond the open PR's base, else the repo's default branch; absent when git could not count. */
      commits?: number
      prs: MissionPrSummary[]
      /**
       * Mission v3 §3.7 — the path is gone, but its branch was seen with this
       * merged PR: the link stays resolved (Reaper/dehydrate cleanup does not
       * undo proof). Present only with `stale: true`.
       */
      mergedPr?: number
      /** Mission v3 §3.7 — resolved from the last-known state, not a live read. */
      stale?: true
    }
  | {
      kind: 'card'
      ref: string
      exists: boolean
      status?: string
      executedIn?: string
      prs: MissionPrSummary[]
    }
  | {
      kind: 'pr'
      ref: string
      number: number | null
      exists: boolean
      state?: PrEntry['state']
      url?: string
      /** The branch the PR merges INTO (Mission v2 §3.6); absent when the PR is unknown. */
      baseRefName?: string
      /** Campaign spec §3.2 — CI of the PR head (live, or the last known when `stale`). */
      ci?: GateCi
      /** When GitHub says the PR was opened / merged (ISO); present only when it said. */
      createdAt?: string
      mergedAt?: string
      /**
       * Mission v3 §3.7 — GitHub could not say (unreachable, or the PR is not
       * among the recent ones): the last-known state is shown, or, if the link
       * never resolved, it reads unknown (`exists: false`). Never a downgrade.
       */
      stale?: true
    }

/**
 * Commits a worktree link reports. Once the branch's PR merged (and no PR on it is
 * still open) nothing is left to land, whatever the merge style: a squash leaves the
 * branch's commits "ahead" of the default branch forever, so git's count would read
 * the finished unit as 10 commits of unmerged work. An open PR, or no PR, keeps the
 * git count (`undefined` = git could not count).
 */
function commitsOf(w: WorktreePrJoin | undefined): number | undefined {
  if (!w) return undefined
  const prs = w.prs ?? []
  if (prs.some((p) => p.state === 'MERGED') && !prs.some((p) => p.state === 'OPEN')) return 0
  return w.commits
}

/** A CI word from `pr-stack-core` (or the cache) as the gates' four states. */
function gateCiOf(ci: string | undefined): GateCi {
  return ci === 'passing' || ci === 'failing' || ci === 'pending' ? ci : 'unknown'
}

/**
 * The PR a step's gates read, from its resolved links: a `pr` link first, else a PR
 * joined through a linked worktree or card. An open or merged PR beats a closed one;
 * among equals the newest number wins. `stale` = the values are last-known.
 */
function stepPrFacts(
  links: readonly MissionLinkSignal[]
): { facts: GatePrFacts; stale: boolean } | null {
  const found: Array<{ facts: GatePrFacts; stale: boolean; direct: boolean }> = []
  for (const l of links) {
    if (l.kind === 'pr') {
      if (l.number !== null && l.state !== undefined) {
        found.push({
          facts: {
            number: l.number,
            state: l.state,
            ci: l.ci ?? 'unknown',
            ...(l.createdAt ? { createdAt: l.createdAt } : {}),
            ...(l.mergedAt ? { mergedAt: l.mergedAt } : {})
          },
          stale: l.stale === true,
          direct: true
        })
      }
    } else if (l.kind === 'worktree' || l.kind === 'card') {
      for (const p of l.prs) {
        if (p.state === 'OPEN' || p.state === 'MERGED' || p.state === 'CLOSED') {
          found.push({
            facts: {
              number: p.number,
              state: p.state,
              ci: gateCiOf(p.ci),
              ...(p.createdAt ? { createdAt: p.createdAt } : {}),
              ...(p.mergedAt ? { mergedAt: p.mergedAt } : {})
            },
            stale: false,
            direct: false
          })
        }
      }
    }
  }
  const rank = (f: { facts: GatePrFacts; direct: boolean }): number =>
    (f.facts.state === 'CLOSED' ? 0 : 2) + (f.direct ? 1 : 0)
  found.sort((a, b) => rank(b) - rank(a) || b.facts.number - a.facts.number)
  return found.length > 0 ? { facts: found[0].facts, stale: found[0].stale } : null
}

/**
 * Campaign ch.6 (T610) — whether the evidence bundle a step links is on disk. `undefined`
 * when the step links no bundle at all (the gate then says why it is waiting).
 */
function bundleOnDisk(
  root: string,
  missionId: string,
  step: Pick<MissionStep, 'id' | 'links'>,
  exists: ReadonlyMap<string, boolean>
): boolean | undefined {
  const link = step.links.find((l) => hasEvidenceBundle([l], missionId, step.id))
  return link ? (exists.get(linkPath(root, link.ref)) ?? false) : undefined
}

export interface MissionStepSignals {
  stepId: string
  /** Live state of this step's `session` links, from the scoped fleet projection. */
  children: MissionChildState[]
  /** This step's `worktree`/`card`/`pr` links, resolved. */
  links: MissionLinkSignal[]
  /** Computed proof for an `existence`-level step; `null` for any other level. */
  existence: { proven: boolean; reason?: string } | null
  /** T547 — signs of movement inside the step: commits landed and the newest activity. */
  pulse: MissionStepPulse
  /**
   * Campaign spec §3.2 — the facts that prove the step: PR, CI, main CI, verifier,
   * checks. Computed on every read, never stored; `stale: true` = last-known values.
   */
  gates: StepGates
  /** The PR the gates read, or `null` when the step has none. */
  prNumber: number | null
}

/** The PR number a `pr` link names: `owner/repo#123`, `#123`, `123` or a `/pull/123` URL. */
function prNumberOf(ref: string): number | null {
  const m = /(?:#|\/pull\/|^)(\d+)\/?\s*$/.exec(ref.trim())
  return m ? Number(m[1]) : null
}

/**
 * A `worktree` link's ref as an absolute path (a relative one is read from the repo root).
 * A stored `.harnu/…` ref resolves under the current data dir, so links written before
 * the rename keep resolving (the mission file itself is never rewritten).
 */
export function linkPath(root: string, ref: string): string {
  return path.isAbsolute(ref) ? ref : path.resolve(root, mapLegacyDataPath(ref))
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * The fixed start's `worktree` links (repo-relative or absolute) that cannot
 * prove it right now, with why ({@link scopeTargetProblem}): a path accepted at
 * create/link time can later be swapped for a symlink out of the repo, and a
 * mission written before BUG-145 may hold an absolute path, the root or `.git`
 * — so the existence proof re-checks every one, by `realpath`, on every read
 * (Mission v2 §3.1). Only paths that exist are checked; a missing one is
 * already unproven. `worktree` links on every other step resolve as before.
 */
async function scopeLinkProblems(
  root: string,
  scopeLinks: readonly StepLink[]
): Promise<Map<string, ScopeTargetProblem>> {
  const problems = new Map<string, ScopeTargetProblem>()
  const refs = scopeLinks.filter((l) => l.kind === 'worktree')
  if (refs.length === 0) return problems
  let realRoot: string | null
  try {
    realRoot = await fs.realpath(root)
  } catch {
    // Fails closed: with no resolvable root, no link can be shown to be inside it.
    realRoot = null
  }
  for (const l of refs) {
    const p = linkPath(root, l.ref)
    if (!(await pathExists(p))) continue
    let problem: ScopeTargetProblem | null
    try {
      problem = realRoot ? await scopeTargetProblem(await fs.realpath(p), realRoot) : 'outside'
    } catch {
      // It existed a moment ago; unresolvable now is not proof of containment.
      problem = 'outside'
    }
    if (problem) problems.set(l.ref, problem)
  }
  return problems
}

/** Is this resolved link the artifact it claims (design §7 — PR open/merged, card in review/done)? */
function linkResolves(l: MissionLinkSignal): boolean {
  if (l.kind === 'worktree') return l.exists || l.mergedPr !== undefined
  if (l.kind === 'card') return l.exists && (l.status === 'review' || l.status === 'done')
  return l.exists
}

function existenceOf(
  links: readonly MissionLinkSignal[],
  gh: MissionPrJoin['ghAvailable']
): { proven: boolean; reason?: string } {
  if (links.length === 0) {
    return {
      proven: false,
      reason: 'no artifact link (a path in the repo, a card or a PR) to check'
    }
  }
  const failing = links.find((l) => !linkResolves(l))
  if (!failing) return { proven: true }
  if (failing.kind === 'pr' && gh === false) {
    return { proven: false, reason: `gh is unavailable — PR ${failing.ref} cannot be checked` }
  }
  const why =
    failing.kind === 'card'
      ? failing.exists
        ? `is in ${failing.status}, not review/done`
        : 'is not on the board'
      : failing.kind === 'pr'
        ? failing.state
          ? `is ${failing.state}`
          : 'was not found'
        : 'does not exist'
  return { proven: false, reason: `${failing.kind} ${failing.ref} ${why}` }
}

/**
 * Mission v3 §3.3 — the scope attachment, resolved: each path link and whether
 * every one exists inside the repo right now. Never part of progress; the popover
 * reads an unresolved path as "on a branch". The same read-time containment
 * re-check (BUG-145) a legacy fixed start had applies.
 */
export interface MissionScopeSignals {
  links: MissionLinkSignal[]
  resolved: { proven: boolean; reason?: string }
}

/** Everything `mission_get` derives (design §7, §8). */
export interface MissionDerived {
  live: true
  computedAt: string
  stale: boolean
  stall: MissionStall
  /** Whether PR data was read: `not-needed` when no link asked for it. */
  gh: 'available' | 'unavailable' | 'not-needed'
  /** Approval Inbox requests parked by linked sessions right now. */
  pendingApprovals: number
  scope: MissionScopeSignals
  steps: MissionStepSignals[]
  /**
   * Mission v3 §3.1 — where the work is, computed ONCE here from the stored steps
   * and the live signals above. Every surface renders it; none recounts.
   */
  progress: MissionProgress
}

/** How long `mission_get` waits for a merged PR's merge-commit CI before reading last-known. */
export const MAIN_CI_GET_WAIT_MS = 3000
/** A merge commit that has been green this long is not asked about again. */
const MAIN_CI_FINAL_AFTER_MS = 30 * 60 * 1000

/**
 * CI of each merged PR's merge commit on the default branch (campaign spec §3.2
 * `main` gate), sticky: a result that has stayed green for {@link MAIN_CI_FINAL_AFTER_MS}
 * is final and not asked again, everything else is re-checked (`findMainCi` caches for
 * 60 s), and an unreachable GitHub — or a lookup still running past `waitMs` — reads
 * the last-known value (`stale: true`) or nothing. The lookup itself keeps running and
 * lands in the cache, so the next read has it. `pending` is live-only — never remembered.
 */
async function resolveMainCi(
  root: string,
  numbers: readonly number[],
  ghAvailable: boolean | null,
  waitMs: number,
  learned: StickyOp[]
): Promise<Map<number, { ci: GateCi | null; stale: boolean }>> {
  const out = new Map<number, { ci: GateCi | null; stale: boolean }>()
  const ask: number[] = []
  for (const n of numbers) {
    const known = getLastKnown(root, 'pr-main', String(n))
    if (known?.state === 'passing' && Date.now() - Date.parse(known.at) > MAIN_CI_FINAL_AFTER_MS) {
      out.set(n, { ci: 'passing', stale: false })
    } else {
      ask.push(n)
    }
  }
  const live =
    ask.length > 0 && ghAvailable !== false
      ? await findMainCi(root, ask, { waitMs })
      : { ghAvailable: false as boolean | null, byNumber: {} as Record<number, GateCi | null> }
  for (const n of ask) {
    const seen = live.ghAvailable ? live.byNumber[n] : undefined
    if (seen !== undefined && seen !== null) {
      if (seen === 'passing' || seen === 'failing') {
        learned.push(remember(root, 'pr-main', String(n), { state: seen, prNumber: n }))
      }
      out.set(n, { ci: seen, stale: false })
      continue
    }
    const known = getLastKnown(root, 'pr-main', String(n))
    if (live.ghAvailable === false && known) {
      out.set(n, { ci: gateCiOf(known.state), stale: true })
    } else {
      out.set(n, { ci: null, stale: false })
    }
  }
  return out
}

/**
 * A fact a read learned about a link, for the sticky last-known cache (Mission v3 §3.7). The
 * read only says what it saw; the observer remembers it.
 */
export type StickyOp =
  | {
      op: 'remember'
      root: string
      kind: LinkCacheKind
      ref: string
      seen: Omit<LinkResolution, 'at'>
    }
  | { op: 'forget'; root: string; kind: LinkCacheKind; ref: string }

function remember(
  root: string,
  kind: LinkCacheKind,
  ref: string,
  seen: Omit<LinkResolution, 'at'>
): StickyOp {
  return { op: 'remember', root, kind, ref, seen }
}

/** What a read saw and could not record itself: handed to the observer, never acted on here. */
export interface MissionObservation {
  /** Sticky sightings (a link that resolved, a CI result) and the one contrary observation. */
  sticky: StickyOp[]
  /** The PR each step's gates read (`null` = none), in step order: the PR and CI ledger rows. */
  prByStep: ReadonlyArray<{ facts: GatePrFacts } | null>
}

/** A mission's derived view plus what the read observed on the way. */
export interface MissionReading {
  derived: MissionDerived
  children: MissionChildState[]
  observation: MissionObservation
}

/** The live sources a read needs that belong to the MCP layer, injected so this module stays free of it. */
export interface DeriveDeps {
  /** The scoped live state of `ids` — never the unscoped fleet (design §7, T360 Q4). */
  children: (missionId: string, ids: readonly string[]) => Promise<MissionChildState[]>
}

/**
 * Derive design §7's live signals for one mission: each step's linked children
 * (scoped projection), its worktree/card/pr links joined to commits and PRs
 * (one `pr-stack` join for the whole mission), the computed existence proofs,
 * and §8's stall verdict. Read-only (AC-4): the file, the sidecar, the sticky cache and the
 * steward are never touched here; what the read learned comes back as `observation`.
 * Computed fresh on every call.
 */
export async function deriveMission(
  root: string,
  mission: Mission,
  log: string,
  deps: DeriveDeps,
  now: number,
  /** `prWaitMs`: how long to wait for GitHub before reading the sticky last-known states. */
  opts: { prWaitMs?: number; mainCiWaitMs?: number } = {}
): Promise<MissionReading> {
  const learned: StickyOp[] = []
  const scopeLinks = missionScope(mission)
  const links = [...mission.steps.flatMap((s) => s.links), ...(mission.scope ?? [])]
  const sessionIds = [...new Set(links.filter((l) => l.kind === 'session').map((l) => l.ref))]
  const children = await deps.children(mission.id, sessionIds)
  const childById = new Map(children.map((c) => [c.sessionId, c]))

  const cards = new Map<string, { status: string; executedIn?: string } | null>()
  for (const l of links) {
    if (l.kind !== 'card' || cards.has(l.ref)) continue
    try {
      const read = await readCard(root, l.ref)
      cards.set(
        l.ref,
        read.ok
          ? {
              status: read.card.status,
              ...(read.card.executedIn ? { executedIn: read.card.executedIn } : {})
            }
          : null
      )
    } catch {
      cards.set(l.ref, null)
    }
  }
  const worktreePaths = [
    ...new Set(links.filter((l) => l.kind === 'worktree').map((l) => linkPath(root, l.ref)))
  ]
  const branches = [
    ...new Set([...cards.values()].flatMap((c) => (c?.executedIn ? [c.executedIn] : [])))
  ]
  const numbers = [
    ...new Set(
      links.flatMap((l) => (l.kind === 'pr' ? [prNumberOf(l.ref)] : [])).filter((n) => n !== null)
    )
  ] as number[]
  const exists = new Map<string, boolean>()
  for (const p of worktreePaths) exists.set(p, await pathExists(p))
  // git/gh only for the paths that exist (a plain file link needs neither).
  const gitPaths = worktreePaths.filter((p) => exists.get(p))
  // T611 D-5: a delivered mission is never asked of GitHub (unless the operator opts back in). Its
  // local git facts are still read; its PR facts and gates are the sticky last-known ones below.
  const skipGithub = mission.status === 'delivered' && !checkDeliveredMissions()
  const join: MissionPrJoin =
    gitPaths.length + branches.length + numbers.length > 0
      ? await findPrsForWorktrees(
          root,
          { worktrees: gitPaths, branches, numbers },
          { waitMs: opts.prWaitMs, skipGh: skipGithub }
        )
      : { ghAvailable: null, worktrees: {}, branches: {}, numbers: {} }

  // Mission v3 §3.7 — sticky proof: a link that resolved once keeps that state
  // through an unreachable GitHub or a PR that aged out of the recent list
  // (`stale: true`); only a contrary observation downgrades it. The last-known
  // states live in a userData sidecar — never in the mission file.
  await ensureLinkCacheLoaded()
  const resolve = (l: StepLink): MissionLinkSignal | null => {
    if (l.kind === 'worktree') {
      const p = linkPath(root, l.ref)
      const w = join.worktrees[p]
      const onDisk = exists.get(p) ?? false
      const merged = w?.prs.find((pr) => pr.state === 'MERGED')
      if (onDisk && merged && w?.branch) {
        learned.push(
          remember(root, 'worktree', p, {
            state: 'MERGED',
            prNumber: merged.number,
            branch: w.branch
          })
        )
      }
      const known = onDisk ? null : getLastKnown(root, 'worktree', p)
      if (known?.state === 'MERGED' && known.prNumber !== undefined) {
        return {
          kind: 'worktree',
          ref: l.ref,
          exists: false,
          branch: known.branch ?? null,
          head: null,
          prs: [],
          mergedPr: known.prNumber,
          stale: true
        }
      }
      return {
        kind: 'worktree',
        ref: l.ref,
        exists: onDisk,
        branch: w?.branch ?? null,
        head: w?.head ?? null,
        ...(commitsOf(w) !== undefined ? { commits: commitsOf(w) } : {}),
        prs: (w?.prs ?? []).map(prSummary)
      }
    }
    if (l.kind === 'card') {
      const c = cards.get(l.ref)
      if (!c) return { kind: 'card', ref: l.ref, exists: false, prs: [] }
      return {
        kind: 'card',
        ref: l.ref,
        exists: true,
        status: c.status,
        ...(c.executedIn ? { executedIn: c.executedIn } : {}),
        prs: (c.executedIn ? (join.branches[c.executedIn] ?? []) : []).map(prSummary)
      }
    }
    if (l.kind === 'pr') {
      const number = prNumberOf(l.ref)
      if (number === null) return { kind: 'pr', ref: l.ref, number, exists: false }
      const pr = join.numbers[number] ?? null
      if (pr) {
        if (pr.state === 'OPEN' || pr.state === 'MERGED') {
          learned.push(
            remember(root, 'pr', String(number), {
              state: pr.state,
              prNumber: number,
              url: pr.url,
              baseRefName: pr.base,
              ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {})
            })
          )
          if (pr.ci === 'passing' || pr.ci === 'failing') {
            learned.push(
              remember(root, 'pr-ci', String(number), { state: pr.ci, prNumber: number })
            )
          }
        } else {
          // Closed unmerged: the one contrary observation that downgrades.
          learned.push({ op: 'forget', root, kind: 'pr', ref: String(number) })
        }
        return {
          kind: 'pr',
          ref: l.ref,
          number,
          exists: pr.state === 'OPEN' || pr.state === 'MERGED',
          state: pr.state,
          url: pr.url,
          baseRefName: pr.base,
          ci: gateCiOf(pr.ci),
          ...(pr.createdAt ? { createdAt: pr.createdAt } : {}),
          ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {})
        }
      }
      // gh unreachable, or the PR is not among the recent ones: unknown.
      const known = getLastKnown(root, 'pr', String(number))
      if (!known) return { kind: 'pr', ref: l.ref, number, exists: false, stale: true }
      return {
        kind: 'pr',
        ref: l.ref,
        number,
        exists: true,
        state: known.state as PrEntry['state'],
        ...(known.url ? { url: known.url } : {}),
        ...(known.baseRefName ? { baseRefName: known.baseRefName } : {}),
        ...(known.mergedAt ? { mergedAt: known.mergedAt } : {}),
        ci: gateCiOf(getLastKnown(root, 'pr-ci', String(number))?.state),
        stale: true
      }
    }
    return null
  }

  const fixedStart = mission.steps.find((s) => s.kind === 'fixed-start')
  // Scope paths (v3's attachment, or a legacy fixed start's links) are re-checked
  // for containment on every read (BUG-145).
  const scopeProblems = await scopeLinkProblems(root, scopeLinks)
  const unfitOf = (resolved: readonly MissionLinkSignal[]): MissionLinkSignal | undefined =>
    resolved.find((l) => l.kind === 'worktree' && scopeProblems.has(l.ref))
  const unfitReason = (l: MissionLinkSignal): string =>
    `worktree ${l.ref} ${SCOPE_PROBLEM_TEXT[scopeProblems.get(l.ref)!]}`
  const scopeResolved = scopeLinks.map(resolve).filter((l): l is MissionLinkSignal => l !== null)
  const scopeUnfit = unfitOf(scopeResolved)
  const scope: MissionScopeSignals = {
    links: scopeResolved,
    resolved: scopeUnfit
      ? { proven: false, reason: unfitReason(scopeUnfit) }
      : existenceOf(scopeResolved, join.ghAvailable)
  }
  const stepRows = mission.steps.map((s): Omit<MissionStepSignals, 'gates' | 'prNumber'> => {
    const resolved = s.links.map(resolve).filter((l): l is MissionLinkSignal => l !== null)
    const unfit = s === fixedStart ? unfitOf(resolved) : undefined
    const stepChildren = s.links
      .filter((l) => l.kind === 'session')
      .flatMap((l) => {
        const c = childById.get(l.ref)
        return c ? [c] : []
      })
    return {
      stepId: s.id,
      children: stepChildren,
      links: resolved,
      pulse: buildStepPulse(resolved, stepChildren),
      existence:
        s.verification !== 'existence'
          ? null
          : unfit
            ? { proven: false, reason: unfitReason(unfit) }
            : existenceOf(resolved, join.ghAvailable)
    }
  })
  // Campaign spec §3.2 — the gates: the PR, its CI and the CI of its merge commit on
  // the default branch, read once per merged PR and kept sticky like every other fact.
  const prByStep = stepRows.map((st) => stepPrFacts(st.links))
  const mergedNumbers = [
    ...new Set(prByStep.flatMap((f) => (f?.facts.state === 'MERGED' ? [f.facts.number] : [])))
  ]
  const mainCi = await resolveMainCi(
    root,
    mergedNumbers,
    skipGithub ? false : join.ghAvailable,
    opts.mainCiWaitMs ?? 0,
    learned
  )
  const steps = stepRows.map((st, i): MissionStepSignals => {
    const found = prByStep[i]
    const merged = found?.facts.state === 'MERGED'
    const main = merged ? mainCi.get(found.facts.number) : undefined
    const step = mission.steps[i]
    return {
      ...st,
      prNumber: found?.facts.number ?? null,
      gates: computeStepGates({
        missionId: mission.id,
        step,
        pr: found?.facts ?? null,
        mainCi: main?.ci ?? null,
        // Campaign ch.6 (T610): the verifier gate reads the evidence bundle the step links.
        bundleOnDisk: bundleOnDisk(root, mission.id, step, exists),
        stale: found?.stale === true || main?.stale === true
      })
    }
  })
  // T547: a commit landing on a linked worktree is evidence the work moves, even
  // while the child session itself reads idle.
  const commitEvidence = steps.flatMap((st) =>
    st.pulse.lastCommitAt ? [st.pulse.lastCommitAt] : []
  )
  const stall = evaluateMissionStall(mission, log, children, now, commitEvidence)
  const progress: MissionProgress = computeProgress(
    mission,
    steps.map((s) => ({
      stepId: s.stepId,
      children: s.children.map((c) => ({ sessionId: c.sessionId, taskState: c.taskState })),
      existenceProven: s.existence?.proven === true,
      // Amendment (a): the gates govern `verified`, so progress reads the SAME gates the rows carry.
      gates: s.gates
    })),
    now
  )
  return {
    children,
    observation: { sticky: learned, prByStep },
    derived: {
      live: true,
      computedAt: new Date(now).toISOString(),
      stale: stall.stale,
      stall,
      gh: join.ghAvailable === null ? 'not-needed' : join.ghAvailable ? 'available' : 'unavailable',
      pendingApprovals: children.reduce((n, c) => n + c.pendingApprovals, 0),
      scope,
      steps,
      progress
    }
  }
}
