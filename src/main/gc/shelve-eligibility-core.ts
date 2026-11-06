// Which worktrees may be shelved (autonomous cleanup U2.2, design §4 U2, C4, C10). Pure: the facts a
// shell probed come in as arguments, so every rule is table-testable (ADR-0001).
//
// Shelving needs no merge proof (it is fully restorable), but it removes a folder, so it never
// touches anything that could be in use or that deleting would take along. Every rule fails closed:
// a fact that is missing is a refusal, never a pass.

import { isInside } from '../containers/containers-core'
import { AS_GIVEN, canonicalPathKey, type CanonicalPath, type WorktreeBundle } from './bundle-core'
import { isProtectedNow } from './autopilot-core'
import type { GcPrefs } from './gc-prefs'

const DAY_MS = 86_400_000

/** What the shell read from the worktree itself right now. A null is "could not tell". */
export interface ShelveProbe {
  /** `git rev-parse HEAD`. */
  headSha: string | null
  /** Fingerprint of the uncommitted work (`gc-work-stamp`); null when the tree is clean. */
  workStamp: string | null
  /** Newest mtime among the files `git status` lists; null when it lists none. */
  newestMtime: number | null
  /** Committer time of HEAD, epoch ms. */
  lastCommitAt: number | null
  /** The repo's WORKTREE.md sets `create:` / `remove:` (or could not be read): C10. */
  manifestDelegates: boolean
}

export type ShelveRefusal =
  | 'not-a-worktree'
  | 'merged'
  | 'protected'
  | 'session'
  | 'stack'
  | 'blind'
  | 'operation'
  | 'locked'
  | 'nested'
  | 'unresolved'
  | 'drifted'
  | 'delegated-manifest'
  | 'unreadable'
  | 'unknown-age'
  | 'too-recent'

export interface ShelveContext {
  prefs: GcPrefs
  /** Folders a session drifted into (`scanTranscripts().drifted`). */
  driftedCwds: readonly string[]
  canonical?: CanonicalPath
}

/**
 * The rules that need no probe. Cheap, so the cycle runs them on every bundle before it spends a
 * git call on any. Null means "worth probing".
 */
export function shelveCandidate(b: WorktreeBundle, ctx: ShelveContext): ShelveRefusal | null {
  if (b.item.kind !== 'worktree' && b.item.kind !== 'detached-worktree') return 'not-a-worktree'
  if (!b.item.path) return 'not-a-worktree'
  // D-A: a strongly merged branch keeps today's removal path; nothing is shelved for it.
  if (b.fate.fate === 'merged' && b.fate.strong) return 'merged'
  // The main checkout, a Keep mark (ANY mark, stale ones included: a stale mark downgrades to
  // review, never to eligible) and a neverClean path.
  if (isProtectedNow(b, ctx.prefs, ctx.canonical ?? AS_GIVEN)) return 'protected'
  // Working, waiting for input, or merely open: a live process would lose its cwd.
  if (b.session !== 'none') return 'session'
  // A stack running from the folder would lose its bind mounts (parking it is U3's job).
  if (b.stackIds.length > 0 || b.sharedStackIds.length > 0) return 'stack'
  if (b.dockerBlind === true) return 'blind'
  if (b.operation !== undefined) return 'operation'
  if (b.locked === true) return 'locked'
  // Something living inside the folder goes with it. A list that is missing was never checked.
  if (!Array.isArray(b.nestedWorktrees) || b.nestedWorktrees.length > 0) return 'nested'
  if (!Array.isArray(b.foreignCheckouts) || b.foreignCheckouts.length > 0) return 'nested'
  if (b.pathsResolved !== true) return 'unresolved'
  if (drifted(b.item.path, ctx.driftedCwds)) return 'drifted'
  return null
}

/** True when a session drifted into the worktree or any folder under it. */
function drifted(worktreePath: string, cwds: readonly string[]): boolean {
  const platform = process.platform
  const root = canonicalPathKey(worktreePath, platform)
  return cwds.some((c) => isInside(canonicalPathKey(c, platform), root))
}

const known = (n: number | null | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0

export type ShelveVerdict =
  { eligible: true; idleMs: number; since: number } | { eligible: false; reason: ShelveRefusal }

/**
 * The full decision: the bundle rules, then the probe's. `since` is the newest sign of life among
 * the transcript/session/container clock, the last commit and the newest edited file; the
 * worktree must have been quiet for `shelve.thresholdDays` since then.
 */
export function shelveVerdict(
  b: WorktreeBundle,
  probe: ShelveProbe,
  ctx: ShelveContext & { now: number }
): ShelveVerdict {
  const no = (reason: ShelveRefusal): ShelveVerdict => ({ eligible: false, reason })
  const candidate = shelveCandidate(b, ctx)
  if (candidate) return no(candidate)
  if (probe.manifestDelegates) return no('delegated-manifest')
  if (!probe.headSha || !known(probe.lastCommitAt)) return no('unreadable')
  if (!known(b.lastSignOfLifeAt) || !known(ctx.now)) return no('unknown-age')
  const since = Math.max(
    b.lastSignOfLifeAt,
    probe.lastCommitAt,
    known(probe.newestMtime) ? probe.newestMtime : 0
  )
  const idleMs = ctx.now - since
  if (idleMs < ctx.prefs.shelve.thresholdDays * DAY_MS) return no('too-recent')
  return { eligible: true, idleMs, since }
}
