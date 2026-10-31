/**
 * Campaign ch.5a (T597, spec §3.4, AC-5a.2) — the git half of `rebase_stack`, against REAL
 * repositories (a mocked git would only prove the mock). What is pinned:
 *
 *  - it runs `git rebase --onto` in the step's linked worktree;
 *  - on a conflict it aborts, leaves the tree exactly as it was and refuses `REBASE_CONFLICT`;
 *  - PUSH BEHAVIOUR (the card's clarification): `rebase_stack` NEVER pushes. It rewrites the
 *    local branch only; publishing the rewritten branch is the owner's move. So no remote ref
 *    moves, for this branch or any other.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebaseStack } from '../src/main/steward-rebase'

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null'
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim()
}

function commitFile(cwd: string, file: string, body: string, msg: string): string {
  writeFileSync(join(cwd, file), body)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', msg)
  return git(cwd, 'rev-parse', 'HEAD')
}

interface Fixture {
  origin: string
  main: string
  /** A linked worktree on branch `step-1`, two commits ahead of the initial main. */
  wt: string
}

function fixture(): Fixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'harnu-rebase-')))
  const origin = join(base, 'origin.git')
  const main = join(base, 'main')
  const wt = join(base, 'wt-step-1')
  git(base, 'init', '-q', '--bare', '-b', 'main', origin)
  git(base, 'init', '-q', '-b', 'main', main)
  git(main, 'remote', 'add', 'origin', origin)
  commitFile(main, 'base.txt', 'base\n', 'base')
  git(main, 'push', '-q', 'origin', 'main')
  git(main, 'worktree', 'add', '-q', '-b', 'step-1', wt)
  commitFile(wt, 'one.txt', 'one\n', 'step one')
  commitFile(wt, 'two.txt', 'two\n', 'step two')
  git(wt, 'push', '-q', 'origin', 'step-1')
  return { origin, main, wt }
}

const refs = (cwd: string): string => git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)')

let fx: Fixture
beforeEach(() => {
  fx = fixture()
})

describe('AC-5a.2 — rebase_stack runs git rebase --onto in the step worktree', () => {
  it('replays the branch on top of the new base and reports before/after', async () => {
    const newBase = commitFile(fx.main, 'other.txt', 'other\n', 'main moved')
    const before = git(fx.wt, 'rev-parse', 'HEAD')
    const res = await rebaseStack({ worktree: fx.wt, onto: 'main' })
    expect(res).toMatchObject({ ok: true, branch: 'step-1', before, rebased: true, pushed: false })
    if (!res.ok) throw new Error('unreachable')
    expect(res.after).not.toBe(before)
    expect(git(fx.wt, 'rev-parse', 'HEAD')).toBe(res.after)
    // main's new commit is now an ancestor of the branch, and both step commits survive.
    expect(git(fx.wt, 'merge-base', '--is-ancestor', newBase, 'HEAD') ?? '').toBe('')
    expect(git(fx.wt, 'log', '--format=%s', '-3')).toBe('step two\nstep one\nmain moved')
    expect(git(fx.wt, 'status', '--porcelain')).toBe('')
  })

  it('with `from`, drops a squash-merged parent: git rebase --onto <onto> <from>', async () => {
    // step-1 is the parent (already on the branch); step-2 stacks a commit on top of it.
    const parentTip = git(fx.wt, 'rev-parse', 'HEAD')
    commitFile(fx.wt, 'three.txt', 'three\n', 'step three (child)')
    // The parent lands on main as ONE squashed commit, so its two commits are "duplicates".
    writeFileSync(join(fx.main, 'one.txt'), 'one\n')
    writeFileSync(join(fx.main, 'two.txt'), 'two\n')
    git(fx.main, 'add', '.')
    git(fx.main, 'commit', '-q', '-m', 'squash: steps one and two')
    const res = await rebaseStack({ worktree: fx.wt, onto: 'main', from: parentTip })
    expect(res.ok).toBe(true)
    expect(git(fx.wt, 'log', '--format=%s', '-3')).toBe(
      'step three (child)\nsquash: steps one and two\nbase'
    )
  })

  it('is a no-op when the branch is already on the new base', async () => {
    const before = git(fx.wt, 'rev-parse', 'HEAD')
    const res = await rebaseStack({ worktree: fx.wt, onto: 'main' })
    expect(res).toMatchObject({ ok: true, rebased: false, before, after: before })
  })
})

describe('AC-5a.2 — a conflict aborts and leaves the tree as it was', () => {
  it('refuses REBASE_CONFLICT naming the files, with HEAD, index and worktree untouched and no rebase left running', async () => {
    commitFile(fx.wt, 'clash.txt', 'branch side\n', 'branch edits clash')
    commitFile(fx.main, 'clash.txt', 'main side\n', 'main edits clash')
    const head = git(fx.wt, 'rev-parse', 'HEAD')
    const branchRefs = refs(fx.wt)
    const res = await rebaseStack({ worktree: fx.wt, onto: 'main' })
    expect(res).toMatchObject({ ok: false, code: 'REBASE_CONFLICT', branch: 'step-1', head })
    if (res.ok || res.code !== 'REBASE_CONFLICT') throw new Error('unreachable')
    expect(res.conflicts).toEqual(['clash.txt'])
    expect(git(fx.wt, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(fx.wt, 'symbolic-ref', '--short', 'HEAD')).toBe('step-1')
    expect(git(fx.wt, 'status', '--porcelain')).toBe('')
    expect(refs(fx.wt)).toBe(branchRefs)
    const gitDir = git(fx.wt, 'rev-parse', '--absolute-git-dir')
    expect(existsSync(join(gitDir, 'rebase-merge'))).toBe(false)
    expect(existsSync(join(gitDir, 'rebase-apply'))).toBe(false)
  })
})

describe('AC-5a.2 — never pushes', () => {
  it('moves no remote ref: not this branch, not main, not any other', async () => {
    commitFile(fx.main, 'other.txt', 'other\n', 'main moved')
    git(fx.main, 'push', '-q', 'origin', 'main')
    git(fx.main, 'branch', 'someone-elses')
    git(fx.main, 'push', '-q', 'origin', 'someone-elses')
    const remoteBefore = git(fx.origin, 'for-each-ref', '--format=%(refname) %(objectname)')
    const res = await rebaseStack({ worktree: fx.wt, onto: 'origin/main' })
    expect(res).toMatchObject({ ok: true, rebased: true, pushed: false })
    expect(git(fx.origin, 'for-each-ref', '--format=%(refname) %(objectname)')).toBe(remoteBefore)
    // The local branch moved on, the remote one did not: the owner publishes the rewrite.
    expect(git(fx.wt, 'rev-parse', 'HEAD')).not.toBe(git(fx.origin, 'rev-parse', 'step-1'))
  })

  it('touches no other local branch either', async () => {
    commitFile(fx.main, 'other.txt', 'other\n', 'main moved')
    git(fx.main, 'branch', 'bystander', 'step-1')
    const bystander = git(fx.main, 'rev-parse', 'bystander')
    const mainTip = git(fx.main, 'rev-parse', 'main')
    await rebaseStack({ worktree: fx.wt, onto: 'main' })
    expect(git(fx.main, 'rev-parse', 'bystander')).toBe(bystander)
    expect(git(fx.main, 'rev-parse', 'main')).toBe(mainTip)
  })
})

describe('AC-5a.2 — refusals that change nothing', () => {
  it('REBASE_DIRTY: a worktree with uncommitted work is left alone', async () => {
    commitFile(fx.main, 'other.txt', 'other\n', 'main moved')
    writeFileSync(join(fx.wt, 'one.txt'), 'edited, uncommitted\n')
    const head = git(fx.wt, 'rev-parse', 'HEAD')
    const res = await rebaseStack({ worktree: fx.wt, onto: 'main' })
    expect(res).toMatchObject({ ok: false, code: 'REBASE_DIRTY' })
    expect(git(fx.wt, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(fx.wt, 'status', '--porcelain')).toBe('M one.txt')
  })

  it('BAD_ONTO: an option-shaped or unknown ref never reaches git rebase', async () => {
    const head = git(fx.wt, 'rev-parse', 'HEAD')
    for (const onto of ['--exec=touch /tmp/pwned', '-i', 'no-such-ref', '', 'main; rm -rf /']) {
      const res = await rebaseStack({ worktree: fx.wt, onto })
      expect(res, onto).toMatchObject({ ok: false, code: 'BAD_ONTO' })
    }
    const res = await rebaseStack({ worktree: fx.wt, onto: 'main', from: '--abort' })
    expect(res).toMatchObject({ ok: false, code: 'BAD_ONTO' })
    expect(git(fx.wt, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('NOT_A_LINKED_WORKTREE: the main checkout is never rebased', async () => {
    const mainHead = git(fx.main, 'rev-parse', 'HEAD')
    const res = await rebaseStack({ worktree: fx.main, onto: 'main' })
    expect(res).toMatchObject({ ok: false, code: 'NOT_A_LINKED_WORKTREE' })
    expect(git(fx.main, 'rev-parse', 'HEAD')).toBe(mainHead)
  })

  it('DETACHED_HEAD: no branch to rewrite', async () => {
    git(fx.wt, 'checkout', '-q', '--detach')
    const res = await rebaseStack({ worktree: fx.wt, onto: 'main' })
    expect(res).toMatchObject({ ok: false, code: 'DETACHED_HEAD' })
  })

  it('NOT_A_WORKTREE: a path that is not a git checkout', async () => {
    const res = await rebaseStack({ worktree: tmpdir(), onto: 'main' })
    expect(res).toMatchObject({ ok: false, code: 'NOT_A_WORKTREE' })
  })
})
