// The shelve cycle (U2.2 AC-1, AC-6, AC-7): off by default, report-only until acknowledged, capped,
// locked per repo, self-disabling after a streak of failures, one journal entry per shelve.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { createCycleState, runGcCycle, type CycleState } from '../src/main/gc/gc-cycle'
import { createJobQueue, type GcJobDone } from '../src/main/gc/gc-jobs-core'
import { defaultGcPrefs, type GcPrefs } from '../src/main/gc/gc-prefs'
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import type { ShelveProbe } from '../src/main/gc/shelve-eligibility-core'
import type { ShelveDecision, ShelveOutcome } from '../src/main/gc/shelve-exec-shell'
import {
  SHELVE_FAILURE_TTL_MS,
  runShelveCycle,
  type ShelveCycleDeps
} from '../src/main/gc/shelve-cycle'
import type { ShelveRecord } from '../src/main/gc/shelve-core'
import type { Tombstone } from '../src/main/reaper/journal'
import { DAY, NOW, REPO, bundle, reapItem } from './gc-fixtures'

const HEAD = 'a'.repeat(40)
const pathOf = (n: string): string => `/ws/trees/${n}`

/** An unproven worktree idle for `days` days. */
const idle = (n: string, days = 9, over: Parameters<typeof bundle>[2] = {}): WorktreeBundle =>
  bundle(pathOf(n), 'review', {
    item: reapItem(pathOf(n), { branch: `feat/${n}`, diskBytes: 1_000_000 }),
    fate: { fate: 'closed-unmerged', signal: null, strong: false },
    lastSignOfLifeAt: NOW - days * DAY,
    ...over
  })

const prefsWith = (shelve: Partial<GcPrefs['shelve']> = {}): GcPrefs => {
  const p = defaultGcPrefs()
  return { ...p, shelve: { ...p.shelve, enabled: true, firstReportAcknowledged: true, ...shelve } }
}

const goodProbe = (b: WorktreeBundle): ShelveProbe => ({
  headSha: HEAD,
  workStamp: null,
  newestMtime: null,
  lastCommitAt: (b.lastSignOfLifeAt ?? NOW) - DAY,
  manifestDelegates: false
})

const recordOf = (d: ShelveDecision): ShelveRecord =>
  ({
    namespace: `refs/archive/${d.branch ?? 'detached'}/20261105T100000Z`,
    tipRef: `refs/archive/${d.branch}/20261105T100000Z/tip`,
    wipRef: `refs/archive/${d.branch}/20261105T100000Z/wip`,
    headSha: HEAD
  }) as unknown as ShelveRecord

const okOutcome = (d: ShelveDecision): ShelveOutcome => ({
  ok: true,
  record: recordOf(d),
  entry: {
    id: d.id,
    repoPath: d.repoPath,
    worktreePath: d.worktreePath,
    branch: d.branch,
    headSha: HEAD,
    namespace: recordOf(d).namespace,
    shelvedAt: NOW,
    idleDays: d.idleDays,
    reason: `Shelved \`${d.branch}\` — idle ${d.idleDays} d, branch kept`,
    freedBytes: d.diskBytes
  }
})

interface Rig {
  deps: ShelveCycleDeps
  state: CycleState
  decisions: ShelveDecision[]
  probed: string[]
  journal: Tombstone[]
  notices: Array<{ title: string; body: string }>
  disabled: number
  done: GcJobDone[]
  locks: string[]
}

function rig(
  prefs: GcPrefs,
  opts: {
    shelve?: (d: ShelveDecision, n: number) => ShelveOutcome
    lockedRepos?: Set<string>
    journalThrows?: boolean
    drifted?: string[]
    now?: () => number
    state?: CycleState
  } = {}
): Rig {
  const decisions: ShelveDecision[] = []
  const probed: string[] = []
  const journal: Tombstone[] = []
  const notices: Array<{ title: string; body: string }> = []
  const done: GcJobDone[] = []
  const locks: string[] = []
  let n = 0
  const r: Rig = {
    state: opts.state ?? createCycleState(),
    decisions,
    probed,
    journal,
    notices,
    disabled: 0,
    done,
    locks,
    deps: undefined as unknown as ShelveCycleDeps
  }
  r.deps = {
    prefs: () => prefs,
    driftedCwds: () => opts.drifted ?? [],
    probe: async (b) => {
      probed.push(b.item.path ?? '')
      return goodProbe(b)
    },
    shelve: async (d) => {
      decisions.push(d)
      return (opts.shelve ?? ((x) => okOutcome(x)))(d, decisions.length)
    },
    lock: async (repo, work) => {
      locks.push(repo)
      if (opts.lockedRepos?.has(repo)) return { ok: false, reason: 'locked', holder: null }
      return { ok: true, value: await work() }
    },
    queue: createJobQueue({
      newId: () => `job-${++n}`,
      emitProgress: () => undefined,
      emitDone: (d) => done.push(d)
    }),
    journal: async (t) => {
      if (opts.journalThrows) throw new Error('journal disk full')
      journal.push(t)
    },
    disableShelving: async () => {
      r.disabled++
    },
    notify: (x) => notices.push(x),
    now: opts.now ?? (() => NOW)
  }
  return r
}

describe('off by default (AC-1)', () => {
  it('with the switch off it probes nothing and shelves nothing', async () => {
    const r = rig(defaultGcPrefs())
    const rec = await runShelveCycle(r.deps, [idle('a'), idle('b')], r.state)
    expect(rec.mode).toBe('off')
    expect(r.probed).toEqual([])
    expect(r.decisions).toEqual([])
    expect(r.notices).toEqual([])
  })

  it('the autopilot being on and acknowledged does not switch shelving on', async () => {
    const p = { ...defaultGcPrefs(), autopilot: true, firstReportAcknowledged: true }
    const r = rig(p)
    expect((await runShelveCycle(r.deps, [idle('a')], r.state)).mode).toBe('off')
  })
})

describe('the first cycle only reports (AC-1)', () => {
  const unacked = (): GcPrefs => prefsWith({ firstReportAcknowledged: false })

  it('lists what it would shelve and shelves nothing', async () => {
    const r = rig(unacked())
    const rec = await runShelveCycle(r.deps, [idle('a'), idle('b')], r.state)
    expect(rec).toMatchObject({ mode: 'report', found: 2, foundBytes: 2_000_000, shelved: [] })
    expect(r.decisions).toEqual([])
    expect(r.locks).toEqual([])
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0]!.body).toContain('2')
  })

  it('says it once: the same count next cycle is not announced again, a different one is', async () => {
    const r = rig(unacked())
    await runShelveCycle(r.deps, [idle('a')], r.state)
    await runShelveCycle(r.deps, [idle('a')], r.state)
    expect(r.notices).toHaveLength(1)
    await runShelveCycle(r.deps, [idle('a'), idle('b')], r.state)
    expect(r.notices).toHaveLength(2)
  })

  it('finding nothing is silent', async () => {
    const r = rig(unacked())
    await runShelveCycle(r.deps, [idle('a', 1)], r.state)
    expect(r.notices).toEqual([])
  })
})

describe('what reaches the executor (AC-2 at the cycle level)', () => {
  it('a strongly merged branch is never probed, let alone shelved', async () => {
    const merged = idle('m', 9, { fate: { fate: 'merged', signal: 'ancestor', strong: true } })
    const r = rig(prefsWith())
    const rec = await runShelveCycle(r.deps, [merged, idle('a')], r.state)
    expect(r.probed).toEqual([pathOf('a')])
    expect(rec.shelved.map((s) => s.id)).toEqual([`${REPO}::worktree::${pathOf('a')}`])
  })

  it('a session that drifted into a worktree keeps it out', async () => {
    const r = rig(prefsWith(), { drifted: [`${pathOf('a')}/api`] })
    const rec = await runShelveCycle(r.deps, [idle('a'), idle('b')], r.state)
    expect(rec.shelved.map((s) => s.folderAlias)).toEqual(['b'])
  })

  it('one that is too recent is judged and refused, not shelved', async () => {
    const r = rig(prefsWith())
    const rec = await runShelveCycle(r.deps, [idle('fresh', 1), idle('old', 9)], r.state)
    expect(rec.shelved.map((s) => s.folderAlias)).toEqual(['old'])
  })

  it('hands the executor the facts it decided on', async () => {
    const r = rig(prefsWith())
    await runShelveCycle(r.deps, [idle('a', 9)], r.state)
    expect(r.decisions[0]).toMatchObject({
      id: `${REPO}::worktree::${pathOf('a')}`,
      repoPath: REPO,
      worktreePath: pathOf('a'),
      branch: 'feat/a',
      binding: { headSha: HEAD, workStamp: null, newestMtime: null },
      idleDays: 9,
      diskBytes: 1_000_000
    })
  })
})

describe('the per-cycle cap (AC-6)', () => {
  it('shelves at most maxPerCycle, oldest first, and counts the rest as deferred', async () => {
    const bundles = [idle('d', 5), idle('a', 20), idle('c', 7), idle('b', 12), idle('e', 4)]
    const r = rig(prefsWith({ maxPerCycle: 2 }))
    const rec = await runShelveCycle(r.deps, bundles, r.state)
    expect(rec.shelved.map((s) => s.folderAlias)).toEqual(['a', 'b'])
    expect(rec).toMatchObject({ found: 5, deferred: 3, mode: 'shelve' })
  })
})

describe('one job through the queue, a repo lock around each shelve (AC-6)', () => {
  it('runs as an autopilot job whose ok results are the shelved items', async () => {
    const r = rig(prefsWith())
    await runShelveCycle(r.deps, [idle('a'), idle('b')], r.state)
    expect(r.done).toHaveLength(1)
    expect(r.done[0]!.kind).toBe('autopilot')
    expect(r.done[0]!.results.filter((x) => x.ok).map((x) => x.id)).toEqual([
      `${REPO}::worktree::${pathOf('a')}`,
      `${REPO}::worktree::${pathOf('b')}`
    ])
  })

  it('takes the lock of each worktree’s repo', async () => {
    const r = rig(prefsWith())
    await runShelveCycle(r.deps, [idle('a'), idle('b')], r.state)
    expect(r.locks).toEqual([REPO, REPO])
  })

  it('a repo another Harnu holds is skipped: counted as locked, not as a failure, not retried blindly', async () => {
    const r = rig(prefsWith(), { lockedRepos: new Set([REPO]) })
    const rec = await runShelveCycle(r.deps, [idle('a'), idle('b')], r.state)
    expect(rec).toMatchObject({ locked: 2, failed: 0, shelved: [] })
    expect(r.decisions).toEqual([])
    expect(r.state.shelveStreak).toBe(0)
    expect(r.state.shelveFailures.size).toBe(0)
  })
})

describe('the failure-streak kill switch (AC-6)', () => {
  const fails = (): ShelveOutcome => ({
    ok: false,
    step: 'verify',
    reason: 'worktree-changed',
    message: 'differs',
    folderRemoved: false
  })

  it('switches shelving off after failureLimit failures in a row and leaves the rest untouched', async () => {
    const bundles = ['a', 'b', 'c', 'd', 'e'].map((n, i) => idle(n, 20 - i))
    const r = rig(prefsWith({ failureLimit: 3, maxPerCycle: 5 }), { shelve: () => fails() })
    const rec = await runShelveCycle(r.deps, bundles, r.state)
    expect(r.decisions).toHaveLength(3)
    expect(rec).toMatchObject({ failed: 3, paused: true, shelved: [] })
    expect(r.disabled).toBe(1)
    expect(r.notices.map((n) => n.body).join(' ')).toMatch(/3/)
  })

  it('a success in between resets the streak', async () => {
    const bundles = ['a', 'b', 'c', 'd', 'e'].map((n, i) => idle(n, 20 - i))
    const r = rig(prefsWith({ failureLimit: 3, maxPerCycle: 5 }), {
      shelve: (d, n) => (n === 3 ? okOutcome(d) : fails())
    })
    const rec = await runShelveCycle(r.deps, bundles, r.state)
    expect(rec.paused).toBe(false)
    expect(r.disabled).toBe(0)
    expect(rec).toMatchObject({ failed: 4, shelved: [expect.anything()] })
  })

  it('the streak carries over cycles', async () => {
    const r = rig(prefsWith({ failureLimit: 3, maxPerCycle: 1 }), { shelve: () => fails() })
    let t = NOW
    r.deps.now = () => t
    for (const n of ['a', 'b', 'c']) {
      await runShelveCycle(r.deps, [idle(n)], r.state)
      t += SHELVE_FAILURE_TTL_MS
    }
    expect(r.disabled).toBe(1)
  })

  it('a refusal because the world moved is not a failure and does not count toward the streak', async () => {
    const moved = (): ShelveOutcome => ({
      ok: false,
      step: 'reprobe',
      reason: 'changed-since-decided',
      message: 'moved',
      folderRemoved: false
    })
    const r = rig(prefsWith({ failureLimit: 2, maxPerCycle: 5 }), { shelve: () => moved() })
    const rec = await runShelveCycle(r.deps, [idle('a'), idle('b'), idle('c')], r.state)
    expect(rec).toMatchObject({ refused: 3, failed: 0, paused: false })
    expect(r.disabled).toBe(0)
  })

  it('a refused or failed worktree is not tried again within a day, and is after it', async () => {
    let t = NOW
    const r = rig(prefsWith({ failureLimit: 10 }), { shelve: () => fails() })
    r.deps.now = () => t
    await runShelveCycle(r.deps, [idle('a')], r.state)
    t += SHELVE_FAILURE_TTL_MS - 1000
    await runShelveCycle(r.deps, [idle('a')], r.state)
    expect(r.decisions).toHaveLength(1)
    t += 2000
    await runShelveCycle(r.deps, [idle('a')], r.state)
    expect(r.decisions).toHaveLength(2)
  })

  it('a worktree whose folder is already partly gone is a failure that keeps its entry (reported as such)', async () => {
    const partial = (): ShelveOutcome => ({
      ok: false,
      step: 'remove',
      reason: 'remove-partial',
      message: 'EACCES',
      folderRemoved: true
    })
    const r = rig(prefsWith(), { shelve: () => partial() })
    const rec = await runShelveCycle(r.deps, [idle('a')], r.state)
    expect(rec.failed).toBe(1)
    expect(r.done[0]!.results[0]).toMatchObject({ ok: false })
  })
})

describe('the journal and the Activity line (AC-7)', () => {
  it('writes exactly one journal entry per shelve, with the reason and the way back', async () => {
    const r = rig(prefsWith())
    await runShelveCycle(r.deps, [idle('a', 9), idle('b', 12)], r.state)
    expect(r.journal).toHaveLength(2)
    const t = r.journal.find((x) => x.branch === 'feat/a')!
    expect(t).toMatchObject({
      at: NOW,
      repoPath: REPO,
      kind: 'shelved-worktree',
      branch: 'feat/a',
      sha: HEAD,
      deleted: [pathOf('a')],
      justifiedBy: null,
      archiveTipRef: 'refs/archive/feat/a/20261105T100000Z/tip',
      archiveWipRef: 'refs/archive/feat/a/20261105T100000Z/wip',
      actor: 'autopilot'
    })
    expect(t.restoreHint).toBe(`git -C ${REPO} worktree add ${pathOf('a')} feat/a`)
  })

  it('a detached worktree’s hint restores from its archived tip', async () => {
    const det = bundle(pathOf('det'), 'review', {
      item: reapItem(pathOf('det'), {
        kind: 'detached-worktree',
        branch: undefined,
        headSha: HEAD
      }),
      fate: { fate: 'detached', signal: null, strong: false },
      lastSignOfLifeAt: NOW - 9 * DAY
    })
    const r = rig(prefsWith(), {
      shelve: (d) => {
        const o = okOutcome(d)
        return o.ok
          ? {
              ...o,
              record: {
                ...o.record,
                tipRef: 'refs/archive/detached/20261105T100000Z/abc/tip',
                wipRef: 'refs/archive/detached/20261105T100000Z/abc/wip'
              } as ShelveRecord
            }
          : o
      }
    })
    await runShelveCycle(r.deps, [det], r.state)
    expect(r.journal[0]).toMatchObject({ branch: null })
    expect(r.journal[0]!.restoreHint).toBe(
      `git -C ${REPO} worktree add ${pathOf('det')} refs/archive/detached/20261105T100000Z/abc/tip`
    )
  })

  it('the record carries one summary per shelve for the Activity line: branch, days idle, folder', async () => {
    const r = rig(prefsWith())
    const rec = await runShelveCycle(r.deps, [idle('a', 9)], r.state)
    expect(rec.shelved).toEqual([
      {
        id: `${REPO}::worktree::${pathOf('a')}`,
        branch: 'feat/a',
        folderAlias: 'a',
        folderPath: pathOf('a'),
        idleDays: 9,
        freedBytes: 1_000_000
      }
    ])
  })

  it('a journal that cannot be written does not undo the shelve: it is still counted, and flagged', async () => {
    const r = rig(prefsWith(), { journalThrows: true })
    const rec = await runShelveCycle(r.deps, [idle('a')], r.state)
    expect(rec.shelved).toHaveLength(1)
    expect(rec.journalFailed).toBe(1)
    expect(rec.failed).toBe(0)
    expect(r.state.shelveStreak).toBe(0)
  })

  it('announces what it shelved once, with the freed size', async () => {
    const r = rig(prefsWith())
    await runShelveCycle(r.deps, [idle('a'), idle('b')], r.state)
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0]!.body).toMatch(/Shelved 2 worktrees/)
    expect(r.notices[0]!.body).toMatch(/branches/i)
  })
})

describe('inside the autopilot cycle', () => {
  it('runGcCycle calls the shelve hook with the gathered bundles and records the result', async () => {
    const seen: WorktreeBundle[][] = []
    const record = {
      mode: 'shelve',
      found: 1,
      foundBytes: 1,
      shelved: [],
      refused: 0,
      failed: 0,
      deferred: 0,
      paused: false,
      locked: 0,
      journalFailed: 0
    } as const
    const emitted: unknown[] = []
    const rec = await runGcCycle(
      {
        prefs: () => defaultGcPrefs(),
        gather: async () => ({
          bundles: [idle('a')],
          housekeeping: {
            volumes: [],
            containers: [],
            dirExists: () => true,
            knownFolders: [],
            protectedProjects: new Set()
          }
        }),
        opsFor: () => {
          throw new Error('nothing to clean')
        },
        queue: createJobQueue({
          newId: () => 'j',
          emitProgress: () => undefined,
          emitDone: () => undefined
        }),
        housekeeping: async () => ({
          buildCacheBytes: 0,
          imageBytes: 0,
          volumeBytes: 0,
          errors: []
        }),
        notify: () => undefined,
        emitCycle: (r) => emitted.push(r),
        shelve: async (bundles) => {
          seen.push(bundles)
          return record
        },
        state: createCycleState(),
        now: () => NOW
      },
      'timer'
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]!.map((b) => b.item.path)).toEqual([pathOf('a')])
    expect(rec.shelve).toEqual(record)
    expect(emitted[0]).toMatchObject({ shelve: { mode: 'shelve' } })
  })

  it('a shelve hook that throws never fails the cycle', async () => {
    const rec = await runGcCycle(
      {
        prefs: () => defaultGcPrefs(),
        gather: async () => ({
          bundles: [],
          housekeeping: {
            volumes: [],
            containers: [],
            dirExists: () => true,
            knownFolders: [],
            protectedProjects: new Set()
          }
        }),
        opsFor: () => {
          throw new Error('unused')
        },
        queue: createJobQueue({
          newId: () => 'j',
          emitProgress: () => undefined,
          emitDone: () => undefined
        }),
        housekeeping: async () => ({
          buildCacheBytes: 0,
          imageBytes: 0,
          volumeBytes: 0,
          errors: []
        }),
        notify: () => undefined,
        emitCycle: () => undefined,
        shelve: async () => {
          throw new Error('boom')
        },
        state: createCycleState(),
        now: () => NOW
      },
      'timer'
    )
    expect(rec.shelve).toBeUndefined()
  })

  it('without a hook the cycle record has no shelve field', async () => {
    const rec = await runGcCycle(
      {
        prefs: () => defaultGcPrefs(),
        gather: async () => ({
          bundles: [],
          housekeeping: {
            volumes: [],
            containers: [],
            dirExists: () => true,
            knownFolders: [],
            protectedProjects: new Set()
          }
        }),
        opsFor: () => {
          throw new Error('unused')
        },
        queue: createJobQueue({
          newId: () => 'j',
          emitProgress: () => undefined,
          emitDone: () => undefined
        }),
        housekeeping: async () => ({
          buildCacheBytes: 0,
          imageBytes: 0,
          volumeBytes: 0,
          errors: []
        }),
        notify: () => undefined,
        emitCycle: () => undefined,
        state: createCycleState(),
        now: () => NOW
      },
      'timer'
    )
    expect('shelve' in rec).toBe(false)
  })
})

describe('what the cycle must never call (AC-5)', () => {
  it('imports none of the doors that treat a folder as removed', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'src', 'main', 'gc', 'shelve-cycle.ts'),
      'utf8'
    )
    for (const forbidden of [
      'user-projects',
      'gc-removed-folders',
      'detachFromSidebar',
      'recordRemovedFolder',
      'removeGhostFoldersUnder'
    ]) {
      expect(src).not.toContain(forbidden)
    }
  })
})
