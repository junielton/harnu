/**
 * Missions v4 S-3, S-40 — what is left of the v3 derive: the TYPES of the retired v3 mission view, and
 * `linkPath`.
 *
 * `deriveMission` (one mission's live v3 view: each step's linked sessions, the gates, the existence
 * proofs, the stall verdict and the progress) is gone with the v3 handlers and the v3 list that read it;
 * v4 reads facts through `missions/facts.ts` and the pure state in `missions/state.ts`. These types stay
 * because the renderer's store and `lib/mission-view.ts` still type the (now always empty) v3 list by
 * them; the slice that removes that renderer code removes them too. Nothing here has a runtime meaning
 * but {@link linkPath}.
 */
import * as path from 'node:path'
import { mapLegacyDataPath } from '../data-dir'
import type { MissionChildState } from '../mcp/fleet-snapshot'
import type { MissionStepPulse } from '../mission-pulse'
import type { PrEntry } from '../pr-stack-core'
import type { MemoryDraft, Outcome } from '../consolidator-core'
import type { LedgerRow } from '../mission-ledger'

// ---- The v3 mission, as the retired v3 view typed it ---------------------------------------------

/** design.md §1.1 — the declared end, required at creation (decision 5). */
export interface DeclaredEnd {
  kind: 'code' | 'ui' | 'research' | 'decision' | 'other'
  target: string
  evidence: string
}

/** design.md §1.4 — a blocker is a flag on a mission or step, never a status. */
export interface Blocker {
  reason: string
  unblocks: string
  owner: 'agent' | 'operator'
  raisedAt: string
}

/** design.md §1.2 — what Harnu derives live signals from (decisions 10/11). */
export interface StepLink {
  kind: 'session' | 'worktree' | 'card' | 'pr'
  ref: string
}

/**
 * Mission v3 §3.6 — a human check on a step: a confirmation of a deliverable the
 * step produced (DSQA, "validated visually", a designer sign-off). The agent, the
 * operator or a verifier creates one; ONLY the operator ticks or deletes it, through
 * the UI doors — no MCP verb writes `ticked`. Checks never change progress.
 */
export interface Check {
  /** `chk-<n>`, unique per step. */
  id: string
  /** ≤ 200 chars; unique per step, case-insensitively. */
  label: string
  source: 'agent' | 'operator' | 'verifier'
  createdAt: string
  /** Only the operator's `tickCheck` door writes this. */
  ticked?: { at: string }
}

/**
 * design.md §1.2 — one step. Mission v3 §3.3: new missions have no fixed start
 * (scope is an attachment); a legacy file keeps its `fixed-start` step on disk,
 * read as scope and excluded from progress. The end is found by `kind`, never id.
 */
export interface MissionStep {
  id: string
  ordinal: number
  kind: 'fixed-start' | 'fixed-end' | 'custom'
  title: string
  verification: 'existence' | 'verifier' | 'human'
  proof: 'unproven' | 'claimed' | 'verified' | 'self-verified'
  verifiedBy?: {
    sessionId: string
    at: string
    verdict?: 'met' | 'unmet' | 'blocked' | 'needs-human'
    /**
     * Campaign ch.6 (T610): stamped by `mission_verify_step` on every verification it records.
     * The verifier gate asks for an evidence bundle ONLY when this is present, so a
     * verification recorded before the bundle existed keeps reading as it did.
     */
    evidenceRequired?: true
  }
  links: StepLink[]
  blockers: Blocker[]
  addedReason?: string
  /** Mission v3 §3.1 — when the step was added; legacy steps without it count as original. */
  addedAt?: string
  /** Mission v3 §3.6 — the step's human checks. */
  checks?: Check[]
  /** Campaign spec §3.2 — `false` = a side step: outside the headline, listed in the Side bucket. Absent = required. */
  required?: boolean
  /** Campaign spec §3.2 — the step this side step was discovered from (a step id). */
  discoveredFrom?: string
  /** Campaign spec §3.2 — typed edges; progress reads only `blocks` (the target is `locked` until the source is done). */
  edges?: StepEdge[]
  /** Campaign spec §3.2 — a decision node: the steps in `blocks` stay `locked` until the operator chooses. */
  decision?: StepDecision
}

/** Campaign spec §3.2 — a typed edge from a step to another step. */
export interface StepEdge {
  kind: 'blocks' | 'validates' | 'related'
  to: string
}

/**
 * Campaign spec §3.2 — a decision node. `chosen` (an index into `options`) is written
 * only by the operator's Choose door ({@link applyChooseDecision}); no verb sets it.
 */
export interface StepDecision {
  title: string
  options: string[]
  chosen?: number
  /** Step ids that read `locked` until `chosen` is set. */
  blocks: string[]
}

/**
 * design.md §1.1/§9 — where an imported mission came from (`mission_import_legacy`).
 * `needsReview` names the fields the importer filled best-effort rather than read
 * from the legacy file — `declaredEnd` when no explicit target/evidence was found.
 */
export interface LegacyImport {
  /** Absolute path of the `.harnu/goals/*.md` file imported — never modified or deleted. */
  source: string
  /** `sha256:<hex>` of the source file's bytes at import time. */
  sha256: string
  needsReview: 'declaredEnd'[]
}

/** One v3 mission, as a v3 Harnu stored it in `.harnu/missions/<id>-<slug>.md` (type only: v3-read.ts parses it). */
export interface Mission {
  id: string
  slug: string
  folder: string
  owner: { sessionId: string; folder: string }
  linkedCard?: string
  /**
   * `draft` survives only in legacy files: {@link parseMissionFile} reads it as
   * `active` (Mission v3 §3.4), and no writer produces it any more.
   */
  status: 'draft' | 'active' | 'stale' | 'delivered' | 'closed'
  /** Mission v3 §3.5 — how the operator ended it; set only on a `closed` mission. */
  closedAs?: 'delivered' | 'discarded'
  /** Mission v3 §3.5 — the operator's optional reason for ending it. */
  closeReason?: string
  declaredEnd: DeclaredEnd
  /**
   * The agreement on the declared end. `via: 'chat'` — the end agreed in chat when
   * the mission was created (Mission v3 §3.4); `'operator'` — a re-scope the
   * operator approved. Absent `via` = written before v3.
   */
  declaredEndApproval?: { at: string; bodyHash: string; via?: 'chat' | 'operator' }
  /**
   * Mission v3 §3.3 — the scope documents (spec / PRD / ADR), an attachment that
   * never enters progress. A legacy file has none and keeps them as its fixed
   * start's links instead — read both through {@link missionScope}.
   */
  scope?: StepLink[]
  /**
   * A re-scope `mission_set_end` staged for the operator (decision 6). It lives
   * until the operator approves it ({@link applyApprovedRescope}) or a later
   * `mission_set_end` replaces it — an unrelated edit (a new step, a blocker, a
   * claim) never voids it (design §1.1, resolved in S9).
   */
  pendingRescope?: DeclaredEnd
  steps: MissionStep[]
  /** design.md §1.4 — mission-level blockers (step-level ones live on each step). */
  blockers: Blocker[]
  openQuestions: string[]
  pendingClose?: { at: string; requestedBy: string }
  /** A pause an older Harnu's operator set on the mission's retired steward. Kept in the file, never read as owed. */
  stewardPause?: { at: string; reason: string }
  createdAt: string
  updatedAt: string
  provenance: { author: 'agent' | 'human'; at: string; branch?: string }
  /** design.md §9 — set only on a mission imported from a legacy goal file. */
  legacy?: LegacyImport
  /** design.md §9 — that legacy file's full content, byte-for-byte (the no-loss guarantee). */
  legacyRaw?: string
  /** Campaign spec §3.2 — what Harnu did and saw, append-only. Absent until the first event. */
  ledger?: LedgerRow[]
  /** Campaign spec §3.6 — written by Harnu when a close is requested; never by a verb. */
  outcome?: Outcome
  /** Campaign spec §3.6 — memory drafts waiting for the operator's tick in the end dialog. */
  memoryDrafts?: MemoryDraft[]
  /** Campaign spec §3.2 — the campaign this mission is a chapter of (set with `chapterId`, at creation). */
  campaignId?: string
  /** Campaign spec §3.2 — the chapter of `campaignId` this mission IS (the chapter records this mission's id). */
  chapterId?: string
}

// ---- Gates and progress, as the retired v3 view typed them ------------------------------------

export type GateState = 'green' | 'red' | 'running' | 'off' | 'na'

export const GATE_NAMES = ['pr', 'ci', 'main', 'verifier', 'checks'] as const
export type GateName = (typeof GATE_NAMES)[number]

/** CI as `pr-stack-core` reports it (`unknown` also covers a PR with no checks at all). */
export type GateCi = 'passing' | 'failing' | 'pending' | 'unknown'

/** The five gates of one step. `stale` marks facts that are last-known, not live. */
export type StepGates = Record<GateName, GateState> & { stale?: true }

export type StepState =
  | 'verified'
  | 'done'
  | 'running'
  | 'waiting'
  | 'blocked'
  | 'todo'
  // Campaign spec §3.2 — an open `blocks` edge (or an undecided decision) holds it back.
  | 'locked'

export interface MissionProgress {
  /** Steps, excluding a legacy fixed start. */
  total: number
  /** 1-based; `from === to` unless several steps run in parallel; `null` = all done. */
  current: { from: number; to: number } | null
  allDone: boolean
  /** verified + done. */
  done: number
  verified: number
  states: Record<string, StepState>
  /** `todo` steps before the last done one (step ids). */
  leftBehind: string[]
  /** Reached or current existence steps with no link that can resolve (§3.9). */
  unprovable: string[]
  /**
   * Campaign spec §3.2 — the Side bucket: `required: false` steps, outside `total`,
   * `current` and `leftBehind`. Absent when the mission has none, so a mission that
   * uses no side step keeps the exact v3 shape.
   */
  side?: {
    count: number
    steps: { id: string; state: StepState; discoveredFrom: string | null }[]
  }
  computedAt: string
}

// ---- The derived view ---------------------------------------------------------------------

/** What {@link evaluateMissionStall} decided, and from what — reported verbatim in the ACK. */
export interface MissionStall {
  stale: boolean
  /** ISO time of the newest evidence; `null` only when no timestamp parsed at all. */
  lastEvidenceAt: string | null
  thresholdMs: number
  /** Linked sessions whose `taskState` is `working` — any one of them keeps the mission active. */
  workingSessions: string[]
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

/**
 * A `worktree` link's ref as an absolute path (a relative one is read from the repo root).
 * A stored `.harnu/…` ref resolves under the current data dir, so links written before
 * the rename keep resolving (the mission file itself is never rewritten).
 */
export function linkPath(root: string, ref: string): string {
  return path.isAbsolute(ref) ? ref : path.resolve(root, mapLegacyDataPath(ref))
}
