/**
 * Campaign ch.5a (T597, spec §3.4, AC-5a.2) — the git half of `rebase_stack`.
 *
 * Runs `git rebase --onto <onto> <from>` in one LINKED worktree, and nothing else:
 *
 *  - On a conflict it aborts the rebase and verifies HEAD is back where it started, so the tree is
 *    left exactly as it was; the caller turns that into a `REBASE_CONFLICT` refusal and a blocker.
 *  - PUSH BEHAVIOUR (decided with the card's clarification): it NEVER pushes. It rewrites the
 *    local branch of the step's own worktree and reports `pushed: false`; publishing a rewritten
 *    branch (a `--force-with-lease` of that one branch) is the owner's move, so no code path here
 *    can move a remote ref, this branch's or anyone else's.
 *  - It never rebases the main checkout, a detached HEAD, or a dirty tree.
 *
 * Refs reach git as separate argv entries (no shell), are shape-checked first (never option-shaped)
 * and resolved to a commit before the rebase starts. Hooks and fsmonitor are switched off for the
 * run, the same posture as the observe tick's "no config-driven code execution" rule (BUG-164).
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'

const execFileP = promisify(execFile)

export type RebaseResult =
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
export async function rebaseStack(input: {
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
export async function worktreeToplevel(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--show-toplevel'])
  return r.ok && r.out ? r.out : null
}

/** The repository a checkout belongs to (its absolute common git dir), or `null`. */
export async function repoCommonDir(dir: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  return r.ok && r.out ? r.out : null
}
