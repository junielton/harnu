// The one answer to "may Harnu remove this?" for the Cleanup screen. Main refuses a Remove for a
// handful of reasons it can read straight off a bundle (`refusalFor` in autopilot-core, `refusalOf`
// in pipeline-core, the reprobe in gc-shell). Offering one of them lets the operator confirm a red
// dialog that ends in "0 cleaned", so every surface that offers Remove — the panel, a list row, the
// selection bar, "Select all", "Remove the ones marked safe", Retry — asks this and nothing else.
// The renderer never imports main code, so the rules are re-stated here from the same facts, and
// tests/gc-removability.test.ts pins each one against main's real functions.
//
// No DOM, no Vue, no i18n.

import type { WorktreeBundle } from '../../../main/gc/bundle-core'
import type { GcBlock } from './gc-model'

/** Why a Remove cannot go ahead, in the operator's terms (main's codes are finer; see the parity test). */
export type RemovalRefusal =
  | 'main-checkout'
  | 'never-clean'
  | 'kept'
  | 'in-use'
  | 'unsupported-kind'
  | 'shared-stack'
  | 'nested-worktree'
  | 'check-failed'
  | 'folder-gone'
  | 'tip-unknown'
  | 'grace-not-elapsed'
  | 'path-unresolved'
  | 'session-open'
  | 'locked'
  | 'cannot-unregister'
  | 'protected-now'
  | 'stack-present'
  | 'scan-blind'
  | 'operation-in-progress'

export type Removability =
  | { ok: true }
  | {
      ok: false
      reason: RemovalRefusal
      /** A command the operator can run to clear the cause, when there is one. */
      hint?: string
    }

/**
 * The worktree kinds a Remove can take. Mirror `CLEANABLE_KINDS` and `REVIEW_CLEANABLE_KINDS` in
 * `src/main/gc/autopilot-core.ts` (pinned by the parity test). A detached worktree is the second
 * list only: it is archived by its HEAD sha and removed from Needs review on the operator's
 * confirm, and is never a ready item.
 */
const CLEANABLE_WORKTREE_KINDS: readonly string[] = ['worktree', 'hidden-folder']
const REVIEW_ONLY_WORKTREE_KINDS: readonly string[] = ['detached-worktree']

const DAY_MS = 86_400_000

/** A path as one comparable string: slashes unified, no trailing slash. */
const looseKey = (p: string): string =>
  p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '')

/** `p` as a single shell word: plain paths stay bare, anything else is single-quoted. */
export function shellQuote(p: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}

/**
 * What a remembered reprobe refusal means for Remove, for an item that was demoted to Needs review
 * because main refused it again and again. The facts above catch most of them; these are the ones
 * only main's own check could see (git has no single unlocked registration, a stack is running).
 */
const REMEMBERED: Readonly<Record<string, RemovalRefusal>> = {
  'cannot-unregister': 'cannot-unregister',
  'protected-now': 'protected-now',
  'operation-in-progress': 'operation-in-progress',
  'stack-present': 'stack-present',
  'tip-unknown': 'tip-unknown',
  'path-unresolved': 'path-unresolved',
  'nested-worktree': 'nested-worktree',
  'check-failed': 'check-failed',
  'foreign-checkout': 'nested-worktree',
  'shared-stack': 'shared-stack'
}

/** The command that ends each operation that keeps its state in the worktree. */
const OPERATION_ABORT = {
  rebase: 'rebase --abort',
  bisect: 'bisect reset',
  am: 'am --abort'
} as const

const refused = (reason: RemovalRefusal, hint?: string): Removability =>
  hint === undefined ? { ok: false, reason } : { ok: false, reason, hint }

type Refusal = Extract<Removability, { ok: false }>

/**
 * EVERY reason `gc:clean` would refuse this worktree bundle for, from its facts, in the order main judges
 * them (the first is what {@link bundleRemovability} answers). A guided action needs the whole list: two
 * stacked causes (a shared stack and a lock) must be fixed together, or each one's dry run meets the other.
 * `now` is the clock the grace window is held against (main re-checks it at the click).
 */
export function bundleRemovabilityAll(
  b: WorktreeBundle,
  now: number = Date.now(),
  /** What the CURRENT prefs say about this bundle; a mark made since the scan is not in its flags. */
  protection: 'never-clean' | 'kept' | null = null
): Refusal[] {
  const out: Refusal[] = []
  const add = (reason: RemovalRefusal, hint?: string): void => {
    if (!out.some((r) => r.reason === reason)) out.push(refused(reason, hint) as Refusal)
  }
  const path = b.item.path
  // refusalFor (autopilot-core)
  if (b.isMainCheckout || (!!path && looseKey(path) === looseKey(b.item.repoPath))) {
    add('main-checkout')
  }
  if (b.neverClean || protection === 'never-clean') add('never-clean')
  if (b.keep || protection === 'kept') add('kept')
  if (b.bucket === 'in-use') add('in-use')
  // A clean that stopped after the trash: the engine refuses a folder that is not there, and what
  // is left (prune, branch-delete) is finished by hand with the commands the panel shows.
  if (b.folderGone === true) add('folder-gone')
  // Scanned while Docker was down: its stacks were never seen, and main refuses it until a scan does.
  if (b.dockerBlind === true) add('scan-blind')
  // No hint for what is left here: `git worktree remove` would delete a detached worktree with
  // nothing archived, which is exactly what Remove now does safely from review.
  const kind = b.item.kind
  if (
    !CLEANABLE_WORKTREE_KINDS.includes(kind) &&
    !(REVIEW_ONLY_WORKTREE_KINDS.includes(kind) && b.bucket === 'review')
  ) {
    add('unsupported-kind')
  }
  // refusalOf (pipeline-core): refused even when confirmed
  const code = b.reason?.code
  if (b.sharedStackIds.length > 0 || code === 'shared-stack') add('shared-stack')
  // In refusalOf's order. A list that is missing or not a list cannot show there is none: the
  // probe did not answer (`check-failed`), which refuses just the same but is not "something
  // lives inside"; a list with entries is (`nested-worktree`).
  const nested = b.nestedWorktrees
  const foreign = b.foreignCheckouts
  if (!Array.isArray(nested)) add('check-failed')
  else if (nested.length > 0) add('nested-worktree')
  if (!Array.isArray(foreign)) add('check-failed')
  else if (foreign.length > 0 || code === 'nested-worktree') add('nested-worktree')
  if (code === 'check-failed') add('check-failed')
  // The reprobe (gc-shell): what it can refuse from the scan's own facts
  if (typeof b.localTip !== 'string') add('tip-unknown')
  const known = (n: number | null | undefined): n is number =>
    Number.isFinite(n) && (n as number) >= 0
  if (
    !known(b.lastSignOfLifeAt) ||
    !known(b.graceDays) ||
    now - b.lastSignOfLifeAt < b.graceDays * DAY_MS
  ) {
    add('grace-not-elapsed')
  }
  if (!path || b.pathsResolved !== true || code === 'path-unresolved') add('path-unresolved')
  // Any running session refuses, even one the scan already saw idle.
  if (b.session !== 'none' || code === 'open-idle-session') add('session-open')
  if (b.locked === true || code === 'locked') {
    add('locked', path ? `git worktree unlock ${shellQuote(path)}` : undefined)
  }
  // A rebase, bisect or git am keeps its state in the folder, which Remove would trash — on a detached
  // worktree or a branch one.
  if (b.operation !== undefined || code === 'operation-in-progress') {
    add(
      'operation-in-progress',
      b.operation === undefined || !path
        ? undefined
        : `git -C ${shellQuote(path)} ${OPERATION_ABORT[b.operation]}`
    )
  }
  // Demoted after repeated refusals: main said no again and again, and nothing here shows what changed.
  // It is only the answer when nothing above explains the refusal.
  if (out.length === 0 && b.bucket === 'review') {
    const remembered = REMEMBERED[b.reprobeRefusal?.code ?? '']
    if (remembered) {
      add(
        remembered,
        remembered === 'cannot-unregister' ? 'git worktree list --porcelain' : undefined
      )
    }
  }
  return out
}

/**
 * Whether `gc:clean` would take this worktree bundle, judged from its facts, in the order main
 * judges them: the first of {@link bundleRemovabilityAll}.
 */
export function bundleRemovability(
  b: WorktreeBundle,
  now: number = Date.now(),
  protection: 'never-clean' | 'kept' | null = null
): Removability {
  return bundleRemovabilityAll(b, now, protection)[0] ?? { ok: true }
}

/**
 * Whether a block can be removed. An orphan volume is always offered: what refuses one (a container
 * took it, its folder is back) is only known to main, at the click, and is reported then.
 */
export function removability(b: GcBlock, now: number = Date.now()): Removability {
  if (b.kind === 'volume' || !b.bundle) return { ok: true }
  return bundleRemovability(b.bundle, now, b.protection)
}

/** Every reason a block cannot be removed, first one first; an orphan volume has none (main decides at the click). */
export function removabilityAll(b: GcBlock, now: number = Date.now()): Refusal[] {
  if (b.kind === 'volume' || !b.bundle) return []
  return bundleRemovabilityAll(b.bundle, now, b.protection)
}
