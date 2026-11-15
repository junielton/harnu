/**
 * Missions v4 S-27 (AC-70) — `rebase_stack` for a mission's LEADER, with no steward in the picture,
 * on real git repositories under the OS temp directory. The git mechanics are pinned in
 * `steward-rebase.test.ts`; this file pins who may ask, which worktree is rebased, and that nothing
 * is ever pushed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { rebaseStackV4, type RebaseV4Deps } from '../src/main/missions/rebase'
import type { MissionV4, StepV4 } from '../src/main/missions/model'

const LEADER = '11111111-2222-4333-8444-555555555555'
const BUILDER = '66666666-7777-4888-8999-000000000000'

let tmp = ''
let root = ''
let origin = ''
let wt1 = ''
let wt2 = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}
function commit(cwd: string, file: string, body: string, msg: string): void {
  writeFileSync(path.join(cwd, file), body)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', msg)
}

const step = (id: string, extra: Partial<StepV4> = {}): StepV4 => ({
  id,
  title: `Step ${id}`,
  acs: [],
  links: [],
  blockers: [],
  ...extra
})

function record(steps: StepV4[]): MissionV4 {
  return {
    schemaVersion: 4,
    id: 'mnt-0badc0de',
    title: 'A stack',
    doneWhen: 'the stack landed',
    status: 'open',
    milestones: [],
    steps,
    sessions: [
      { id: LEADER, role: 'leads', from: '2026-11-15T08:00:00.000Z', to: null },
      { id: BUILDER, role: 'worked', from: '2026-11-15T08:05:00.000Z', to: null }
    ],
    links: [],
    blockers: []
  } as MissionV4
}

const deps = (others: MissionV4[] = [], executedIn: Record<string, string> = {}): RebaseV4Deps => ({
  executedIn: async (slug) => executedIn[slug],
  otherOpenMissions: async () => others
})

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'harnu-rebase-leader-')))
  origin = path.join(tmp, 'origin.git')
  root = path.join(tmp, 'repo')
  git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
  git(tmp, 'init', '-q', '-b', 'main', root)
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'remote', 'add', 'origin', origin)
  commit(root, 'base.txt', 'base\n', 'base')
  git(root, 'push', '-q', 'origin', 'main')
  wt1 = path.join(tmp, 'wt-step-1')
  wt2 = path.join(tmp, 'wt-step-2')
  git(root, 'worktree', 'add', '-q', '-b', 'feat/step-1', wt1)
  git(root, 'worktree', 'add', '-q', '-b', 'feat/step-2', wt2)
  commit(wt1, 'one.txt', 'one\n', 'step one work')
  commit(wt2, 'two.txt', 'two\n', 'step two work')
  git(wt1, 'push', '-q', 'origin', 'feat/step-1')
  // main moves on, so the step's branch has something to be rebased onto.
  commit(root, 'later.txt', 'later\n', 'main moved')
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('AC-70 — rebase_stack for the leader', () => {
  it('the leader can rebase a step', async () => {
    const rec = record([step('stp-1', { links: [{ kind: 'worktree', ref: wt1 }] }), step('stp-2')])
    const before = git(wt1, 'rev-parse', 'HEAD')
    const remoteBefore = git(origin, 'rev-parse', 'refs/heads/feat/step-1')

    const out = await rebaseStackV4(
      { root, record: rec, actor: { kind: 'session', sessionId: LEADER }, onto: 'main' },
      deps()
    )

    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.ack).toMatchObject({
      ok: true,
      op: 'rebase_stack',
      stepId: 'stp-1',
      branch: 'feat/step-1',
      before,
      rebased: true,
      pushed: false
    })
    // The local branch moved onto main's tip...
    expect(git(wt1, 'rev-parse', 'HEAD')).toBe(out.ack.after)
    expect(git(wt1, 'merge-base', 'HEAD', 'main')).toBe(git(root, 'rev-parse', 'main'))
    // ...and no remote ref moved: the rewrite is local, publishing it is the leader's own move.
    expect(git(origin, 'rev-parse', 'refs/heads/feat/step-1')).toBe(remoteBefore)
  })

  it('needs the leader: a session that worked a step is refused', async () => {
    const rec = record([step('stp-2', { links: [{ kind: 'worktree', ref: wt2 }] })])
    const out = await rebaseStackV4(
      { root, record: rec, actor: { kind: 'session', sessionId: BUILDER }, onto: 'main' },
      deps()
    )
    expect(out.ok).toBe(false)
    expect(!out.ok && out.error).toContain('NOT_LEADER')
    expect(git(wt2, 'merge-base', 'HEAD', 'main')).not.toBe(git(root, 'rev-parse', 'main'))
  })

  it('a Harnu system worker (what a steward was) reads and never rebases', async () => {
    const rec = record([step('stp-2', { links: [{ kind: 'worktree', ref: wt2 }] })])
    const out = await rebaseStackV4(
      { root, record: rec, actor: { kind: 'worker', missionId: rec.id }, onto: 'main' },
      deps()
    )
    expect(!out.ok && out.error).toContain('READ_ONLY')
  })

  it('a session that is not attached is refused, and a closed mission too', async () => {
    const rec = record([step('stp-2', { links: [{ kind: 'worktree', ref: wt2 }] })])
    const stranger = await rebaseStackV4(
      {
        root,
        record: rec,
        actor: { kind: 'session', sessionId: '99999999-9999-4999-8999-999999999999' },
        onto: 'main'
      },
      deps()
    )
    expect(!stranger.ok && stranger.error).toContain('NOT_ATTACHED')
    const closed = await rebaseStackV4(
      {
        root,
        record: { ...rec, status: 'closed', closedAs: 'discarded' },
        actor: { kind: 'session', sessionId: LEADER },
        onto: 'main'
      },
      deps()
    )
    expect(!closed.ok && closed.error).toContain('MISSION_CLOSED')
  })

  it('rebases only the step’s own worktree: a card that names another branch makes the link foreign', async () => {
    const rec = record([
      step('stp-2', { card: 'T9-step-2', links: [{ kind: 'worktree', ref: wt2 }] })
    ])
    const out = await rebaseStackV4(
      { root, record: rec, actor: { kind: 'session', sessionId: LEADER }, onto: 'main' },
      deps([], { 'T9-step-2': 'card/some-other-branch' })
    )
    expect(!out.ok && out.error).toContain('NOT_STEP_WORKTREE')
    expect(git(wt2, 'merge-base', 'HEAD', 'main')).not.toBe(git(root, 'rev-parse', 'main'))
  })

  it('never rewrites a worktree another step also links, nor the main checkout', async () => {
    const shared = record([
      step('stp-1', { links: [{ kind: 'worktree', ref: wt2 }] }),
      step('stp-2', { links: [{ kind: 'worktree', ref: wt2 }] })
    ])
    const sibling = await rebaseStackV4(
      {
        root,
        record: shared,
        actor: { kind: 'session', sessionId: LEADER },
        onto: 'main',
        stepId: 'stp-1'
      },
      deps()
    )
    expect(!sibling.ok && sibling.error).toContain('NOT_STEP_WORKTREE')

    const trunk = record([step('stp-1', { links: [{ kind: 'worktree', ref: root }] })])
    const main = await rebaseStackV4(
      { root, record: trunk, actor: { kind: 'session', sessionId: LEADER }, onto: 'main' },
      deps()
    )
    expect(main.ok).toBe(false)
  })

  it('several candidate steps with no stepId is ambiguous, not a guess', async () => {
    const rec = record([
      step('stp-1', { links: [{ kind: 'worktree', ref: wt1 }] }),
      step('stp-2', { links: [{ kind: 'worktree', ref: wt2 }] })
    ])
    const out = await rebaseStackV4(
      { root, record: rec, actor: { kind: 'session', sessionId: LEADER }, onto: 'main' },
      deps()
    )
    expect(!out.ok && out.error).toContain('STEP_AMBIGUOUS')
  })

  it('a conflict aborts and leaves the worktree exactly as it was', async () => {
    commit(root, 'two.txt', 'main wrote two\n', 'main touches two')
    const rec = record([step('stp-2', { links: [{ kind: 'worktree', ref: wt2 }] })])
    const head = git(wt2, 'rev-parse', 'HEAD')
    const out = await rebaseStackV4(
      {
        root,
        record: rec,
        actor: { kind: 'session', sessionId: LEADER },
        onto: 'main',
        stepId: 'stp-2'
      },
      deps()
    )
    expect(!out.ok && out.error).toContain('REBASE_CONFLICT')
    expect(git(wt2, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(wt2, 'status', '--porcelain')).toBe('')
  })
})
