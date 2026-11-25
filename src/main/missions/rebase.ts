/**
 * Missions v4 S-27 (AC-70) — `rebase_stack` for the mission's LEADER.
 *
 * The verb used to be the steward's routine move. It is the leader's now: `git rebase --onto <onto>
 * <from|onto>` in the linked worktree of one of the mission's steps, and nothing else.
 *
 *  - Only the session that leads the mission may ask (`guardMission` with the `lead` need). A Harnu
 *    system worker reads and never writes, so it is refused `READ_ONLY` like any other write.
 *  - Only a step's OWN worktree is rebased. A worktree being linked on a step proves little (a step may
 *    link a sibling it only reads), so ownership needs evidence: the branch of the step's dispatched
 *    card, or else a worktree no other step of any open mission links, off the trunk branches.
 *  - It never pushes. It rewrites the step's own LOCAL branch and says `pushed: false`; publishing the
 *    rewrite is the leader's move, so no code path here can move a remote ref.
 *  - It writes no mission file. A conflict aborts the rebase (the git core verifies the tree is exactly
 *    as it was) and is refused `REBASE_CONFLICT`; raising a blocker on the step is the leader's call
 *    (`mission_set_blocker`), not something this module writes behind its back.
 *
 * The git mechanics (the bottom of this file) are a copy of the steward's own, so a v4 module imports
 * no steward file and S-38 can delete those with nothing to repoint. Electron-free: the card lookup
 * and the other missions come in as `deps`.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { linkPath } from './derive'
import { guardMission, type Actor } from './guard'
import type { MissionV4, StepV4 } from './model'
import { runFile as execFileP } from '../spawn-runner'

export interface RebaseV4Deps {
  /** The branch Harnu stamped on a card when it dispatched it (`executedIn`), or undefined. */
  executedIn: (cardSlug: string) => Promise<string | undefined>
  /** Every OTHER open mission of the repo, to tell whether a worktree is claimed by one step alone. */
  otherOpenMissions: () => Promise<MissionV4[]>
}

export interface RebaseV4Input {
  /** The repo root (never a worktree): relative `worktree` links resolve from it. */
  root: string
  record: MissionV4
  actor: Actor
  onto: string
  from?: string
  stepId?: string
}

export type RebaseV4Result =
  | {
      ok: true
      ack: {
        ok: true
        op: 'rebase_stack'
        stepId: string
        branch: string
        before: string
        after: string
        rebased: boolean
        pushed: false
      }
    }
  | { ok: false; error: string }

const fail = (error: string): RebaseV4Result => ({ ok: false, error })

/** The checkouts (never the main one) a step's `worktree` links resolve to. */
async function stepWorktrees(root: string, step: StepV4): Promise<string[]> {
  const found = new Set<string>()
  for (const l of step.links) {
    if (l.kind !== 'worktree') continue
    const p = linkPath(root, l.ref)
    const st = await fs.stat(p).catch(() => null)
    if (!st) continue
    const top = await worktreeToplevel(st.isDirectory() ? p : path.dirname(p))
    if (top) found.add(top)
  }
  return [...found]
}

/** Why `worktree` is NOT `step`'s own (a reason), or `null` when it is. */
async function foreignReason(
  input: RebaseV4Input,
  deps: RebaseV4Deps,
  step: StepV4,
  worktree: string
): Promise<string | null> {
  const branch = await currentBranch(worktree)
  if (branch === 'main' || branch === 'master') return `it is on ${branch}`
  if (step.card) {
    const owned = await deps.executedIn(step.card)
    if (owned) {
      return branch === owned
        ? null
        : `its branch ${branch ?? '(detached)'} is not the branch ${owned} the step's card was dispatched to`
    }
  }
  const missions = [input.record, ...(await deps.otherOpenMissions())].filter(
    (m) => m.status !== 'closed'
  )
  for (const m of missions) {
    for (const s of m.steps) {
      if (m.id === input.record.id && s.id === step.id) continue
      if ((await stepWorktrees(input.root, s)).includes(worktree)) {
        return `${m.id === input.record.id ? s.id : `${m.id}/${s.id}`} links it too, and nothing names which branch is this step's`
      }
    }
  }
  return null
}

export async function rebaseStackV4(
  input: RebaseV4Input,
  deps: RebaseV4Deps
): Promise<RebaseV4Result> {
  const { root, record, onto, from, stepId } = input
  const access = guardMission(record, input.actor, 'lead')
  if (!access.ok) return fail(access.error)

  const pool = stepId ? record.steps.filter((s) => s.id === stepId) : record.steps
  if (stepId && pool.length === 0) {
    return fail(`STEP_NOT_FOUND: ${record.id} has no step ${stepId}.`)
  }
  const repoDir = await repoCommonDir(root)
  // Fail CLOSED: if the mission's own repository cannot be identified, no worktree can be shown to
  // belong to it, so nothing is rebased.
  if (!repoDir) {
    return fail(
      `WORKTREE_NOT_IN_REPO: could not identify the repository of ${root}, so no worktree can be shown to belong to it — rebase_stack rebases nothing.`
    )
  }

  const candidates: Array<{ step: StepV4; worktree: string }> = []
  for (const step of pool) {
    for (const wt of await stepWorktrees(root, step)) {
      if (wt === root) continue // never the main checkout: the rebase core would refuse it anyway
      if ((await repoCommonDir(wt)) !== repoDir) {
        return fail(
          `WORKTREE_NOT_IN_REPO: ${wt}, linked on ${step.id}, belongs to a different repository than this mission — rebase_stack only rebases this repo's own worktrees.`
        )
      }
      candidates.push({ step, worktree: wt })
    }
  }
  if (candidates.length === 0) {
    return fail(
      `NO_STEP_WORKTREE: ${stepId ?? 'no step of this mission'} links a worktree — mission_link { kind: 'worktree', ref: <path> } the step's worktree first.`
    )
  }

  const own: typeof candidates = []
  const foreign: string[] = []
  for (const c of candidates) {
    const why = await foreignReason(input, deps, c.step, c.worktree)
    if (why) foreign.push(`${c.worktree} (${why})`)
    else own.push(c)
  }
  if (own.length === 0) {
    return fail(
      `NOT_STEP_WORKTREE: none of the worktrees linked on ${stepId ?? 'the steps'} is this step's own — ${foreign.join('; ')}. rebase_stack rewrites only a step's own branch.`
    )
  }
  if (own.length > 1) {
    return fail(
      `STEP_AMBIGUOUS: several steps link a worktree (${own.map((c) => `${c.step.id} → ${c.worktree}`).join('; ')}) — pass stepId.`
    )
  }
  const { step, worktree } = own[0]

  const res = await rebaseStack({ worktree, onto, ...(from ? { from } : {}) })
  if (res.ok) {
    return {
      ok: true,
      ack: {
        ok: true,
        op: 'rebase_stack',
        stepId: step.id,
        branch: res.branch,
        before: res.before,
        after: res.after,
        rebased: res.rebased,
        // The local branch moved; no remote ref did. Publishing is the leader's move.
        pushed: false
      }
    }
  }
  if (res.code === 'REBASE_CONFLICT') {
    return fail(
      `REBASE_CONFLICT: rebase of ${res.branch} onto ${onto} conflicted in ${res.conflicts.join(', ')}. The rebase was aborted and ${worktree} is exactly as it was (HEAD ${res.head}). Do not retry: resolve it by hand or raise a blocker with mission_set_blocker and tell the operator.`
    )
  }
  return fail(`${res.code}: ${res.detail}`)
}

// ---- The git half ---------------------------------------------------------------
//
// `git rebase --onto <onto> <from>` in one LINKED worktree and nothing else: on a conflict it aborts
// and verifies HEAD is back where it started; it NEVER pushes (no code path here can move a remote
// ref); it never rebases the main checkout, a detached HEAD or a dirty tree. Refs reach git as separate
// argv entries (no shell), are shape-checked first and resolved to a commit before the rebase starts.
// Hooks and fsmonitor are switched off for the run (BUG-164).

type RebaseResult =
  | { ok: true; branch: string; before: string; after: string; rebased: boolean; pushed: false }
  | {
      ok: false
      code: 'REBASE_CONFLICT'
      branch: string
      head: string
      conflicts: string[]
    }
  | {
      ok: false
      code:
        | 'BAD_ONTO'
        | 'REBASE_DIRTY'
        | 'DETACHED_HEAD'
        | 'NOT_A_LINKED_WORKTREE'
        | 'NOT_A_WORKTREE'
        | 'REBASE_ABORT_FAILED'
        | 'GIT_FAILED'
      detail: string
    }

/** A branch, tag, remote ref or commit id: no option shape, no shell metacharacters, no whitespace. */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/@^~{}+-]*$/

const GIT_ARGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

async function git(
  cwd: string,
  args: string[]
): Promise<{ ok: true; out: string } | { ok: false; out: string; err: string }> {
  try {
    const { stdout } = await execFileP('git', [...GIT_ARGS, ...args], {
      cwd,
      env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 8 * 1024 * 1024
    })
    return { ok: true, out: stdout.trim() }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string }
    return { ok: false, out: (err.stdout ?? '').trim(), err: (err.stderr ?? err.message).trim() }
  }
}

async function commitOf(cwd: string, ref: string): Promise<string | null> {
  if (!REF_RE.test(ref)) return null
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return r.ok && r.out ? r.out : null
}

/** Rebase the branch checked out in `worktree` onto `onto`, replaying only the commits after `from` (default: `onto`). */
async function rebaseStack(input: {
  worktree: string
  onto: string
  from?: string
}): Promise<RebaseResult> {
  const { worktree, onto } = input

  const top = await git(worktree, ['rev-parse', '--show-toplevel'])
  if (!top.ok)
    return { ok: false, code: 'NOT_A_WORKTREE', detail: `${worktree} is not a git checkout.` }

  const gitDir = await git(worktree, ['rev-parse', '--absolute-git-dir'])
  const common = await git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (!gitDir.ok || !common.ok) {
    return {
      ok: false,
      code: 'NOT_A_WORKTREE',
      detail: `Could not read ${worktree}'s git directory.`
    }
  }
  if (path.resolve(gitDir.out) === path.resolve(common.out)) {
    return {
      ok: false,
      code: 'NOT_A_LINKED_WORKTREE',
      detail: "This is the main checkout. rebase_stack only rebases a step's own linked worktree."
    }
  }

  const branch = await git(worktree, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (!branch.ok || !branch.out) {
    return { ok: false, code: 'DETACHED_HEAD', detail: 'The worktree has no branch checked out.' }
  }

  const ontoCommit = await commitOf(worktree, onto)
  if (!ontoCommit) {
    return {
      ok: false,
      code: 'BAD_ONTO',
      detail: `"${onto}" is not a ref or commit in this repository.`
    }
  }
  if (input.from !== undefined && !(await commitOf(worktree, input.from))) {
    return {
      ok: false,
      code: 'BAD_ONTO',
      detail: `"${input.from}" is not a ref or commit in this repository.`
    }
  }

  const dirty = await git(worktree, ['status', '--porcelain', '--untracked-files=no'])
  if (!dirty.ok || dirty.out !== '') {
    return {
      ok: false,
      code: 'REBASE_DIRTY',
      detail: 'The worktree has uncommitted changes to tracked files; commit or stash them first.'
    }
  }

  const before = (await git(worktree, ['rev-parse', 'HEAD'])).out
  const upstream = input.from ?? onto
  const run = await git(worktree, ['rebase', '--onto', onto, upstream])
  if (run.ok) {
    const after = (await git(worktree, ['rev-parse', 'HEAD'])).out
    return { ok: true, branch: branch.out, before, after, rebased: after !== before, pushed: false }
  }

  // Failed: name the conflicting files, abort, and verify the tree is exactly where it was.
  const unmerged = await git(worktree, ['diff', '--name-only', '--diff-filter=U'])
  const conflicts =
    unmerged.ok && unmerged.out ? unmerged.out.split('\n').filter(Boolean).sort() : []
  const abort = await git(worktree, ['rebase', '--abort'])
  const head = (await git(worktree, ['rev-parse', 'HEAD'])).out
  const restored =
    head === before &&
    (await git(worktree, ['symbolic-ref', '--short', '-q', 'HEAD'])).out === branch.out
  if (!abort.ok && !restored) {
    return {
      ok: false,
      code: 'REBASE_ABORT_FAILED',
      detail: `git rebase --abort failed (${abort.err}); the worktree may be mid-rebase — look at it before anything else touches it.`
    }
  }
  if (conflicts.length > 0)
    return { ok: false, code: 'REBASE_CONFLICT', branch: branch.out, head, conflicts }
  return { ok: false, code: 'GIT_FAILED', detail: run.err || 'git rebase failed.' }
}

/** The top-level directory of the checkout containing `dir`, or `null` when it is not in one. */
async function worktreeToplevel(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--show-toplevel'])
  return r.ok && r.out ? r.out : null
}

/** The repository a checkout belongs to (its absolute common git dir), or `null`. */
async function repoCommonDir(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return r.ok && r.out ? r.out : null
}

/** The branch checked out in `dir`, or `null` when detached (or not a checkout). */
async function currentBranch(dir: string): Promise<string | null> {
  const r = await git(dir, ['symbolic-ref', '--short', '-q', 'HEAD'])
  return r.ok && r.out ? r.out : null
}
