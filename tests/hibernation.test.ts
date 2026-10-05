import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { dataDirReady, setLazyDataDirMigration } from '../src/main/data-dir'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  markHibernated,
  clearHibernated,
  isHibernated,
  hibernatedKeys,
  resetHibernation,
  markParking,
  isParking,
  clearParking,
  recordPark,
  recordWake,
  parkHistory
} from '../src/main/hibernation'
import { missionOwnersWithLiveChildren, ownsMissionWithLiveChild } from '../src/main/hibernation'
import {
  evaluateFleet,
  explainFleet,
  type LiveSession,
  type Policy
} from '../src/main/fleet-policy'
import {
  buildMissionFileContent,
  missionFilePath,
  missionsDir,
  type Mission,
  type StepLink
} from '../src/main/mission-core'

describe('hibernation registry', () => {
  beforeEach(() => resetHibernation())

  it('an unknown key is not hibernated', () => {
    expect(isHibernated('nope')).toBe(false)
    expect(hibernatedKeys()).toEqual(new Set())
  })

  it('mark then read', () => {
    markHibernated('a')
    expect(isHibernated('a')).toBe(true)
    expect(hibernatedKeys()).toEqual(new Set(['a']))
  })

  it('marking twice is idempotent', () => {
    markHibernated('a')
    markHibernated('a')
    expect(hibernatedKeys()).toEqual(new Set(['a']))
  })

  // The wake invariant (spec §5.1): `pty:create` clears the flag, so a session with a live
  // PTY can never remain flagged as parked. Self-healing — no reconciliation pass needed.
  it('clear removes the flag (the wake path)', () => {
    markHibernated('a')
    clearHibernated('a')
    expect(isHibernated('a')).toBe(false)
    expect(hibernatedKeys()).toEqual(new Set())
  })

  it('clearing an unknown key is a no-op, not a throw', () => {
    expect(() => clearHibernated('ghost')).not.toThrow()
    expect(hibernatedKeys()).toEqual(new Set())
  })

  it('tracks several keys independently', () => {
    markHibernated('a')
    markHibernated('b')
    clearHibernated('a')
    expect(hibernatedKeys()).toEqual(new Set(['b']))
  })

  it('hibernatedKeys returns a COPY — mutating it cannot corrupt the registry', () => {
    markHibernated('a')
    const snapshot = hibernatedKeys() as Set<string>
    snapshot.add('smuggled')
    expect(isHibernated('smuggled')).toBe(false)
    expect(hibernatedKeys()).toEqual(new Set(['a']))
  })
})

// BUG-70 §3.1 — park provenance tag, keyed by ptyId (survives the index
// removal `hibernateSession` does before `onExit` fires).
describe('park-provenance tagging (markParking/isParking/clearParking)', () => {
  beforeEach(() => resetHibernation())

  it('an untagged ptyId is not parking', () => {
    expect(isParking('pty-1')).toBe(false)
  })

  it('markParking then isParking round-trips', () => {
    markParking('pty-1')
    expect(isParking('pty-1')).toBe(true)
  })

  it('clearParking drops the tag', () => {
    markParking('pty-1')
    clearParking('pty-1')
    expect(isParking('pty-1')).toBe(false)
  })

  it('clearing an unknown ptyId is a no-op, not a throw', () => {
    expect(() => clearParking('ghost')).not.toThrow()
  })

  it('marking twice is idempotent', () => {
    markParking('pty-1')
    markParking('pty-1')
    expect(isParking('pty-1')).toBe(true)
    clearParking('pty-1')
    expect(isParking('pty-1')).toBe(false)
  })

  it('tracks several ptyIds independently', () => {
    markParking('pty-1')
    markParking('pty-2')
    clearParking('pty-1')
    expect(isParking('pty-1')).toBe(false)
    expect(isParking('pty-2')).toBe(true)
  })
})

// BUG-70 §4 — the park ledger. Replaces `clearHibernated`'s silent erase with a
// bounded record of when a session was parked and when/how it woke.
describe('park ledger (recordPark/recordWake/parkHistory)', () => {
  beforeEach(() => resetHibernation())

  it('starts empty', () => {
    expect(parkHistory()).toEqual([])
  })

  it('recordPark appends an open entry (wokenAt null)', () => {
    recordPark('s1', 1000)
    expect(parkHistory()).toEqual([
      { sessionKey: 's1', parkedAt: 1000, wokenAt: null, wakeGesture: null }
    ])
  })

  it('recordWake closes the most recent open entry for that session', () => {
    recordPark('s1', 1000)
    recordWake('s1', 2000, 'select')
    expect(parkHistory()).toEqual([
      { sessionKey: 's1', parkedAt: 1000, wokenAt: 2000, wakeGesture: 'select' }
    ])
  })

  it('recordWake for a session with no open park entry is a no-op, not a throw', () => {
    expect(() => recordWake('never-parked', 2000, 'unknown')).not.toThrow()
    expect(parkHistory()).toEqual([])
  })

  it('records a second park/wake cycle for the same session as a distinct entry', () => {
    recordPark('s1', 1000)
    recordWake('s1', 1500, 'restart')
    recordPark('s1', 2000)
    recordWake('s1', 2500, 'notification-click')
    expect(parkHistory()).toEqual([
      { sessionKey: 's1', parkedAt: 1000, wokenAt: 1500, wakeGesture: 'restart' },
      { sessionKey: 's1', parkedAt: 2000, wokenAt: 2500, wakeGesture: 'notification-click' }
    ])
  })

  it('is bounded to 200 entries — the oldest falls off first (a ring)', () => {
    for (let i = 0; i < 205; i++) recordPark(`s${i}`, i)
    const history = parkHistory()
    expect(history).toHaveLength(200)
    expect(history[0].sessionKey).toBe('s5')
    expect(history[history.length - 1].sessionKey).toBe('s204')
  })

  it("T215: records 'peer-message' — an AGENT, not a human, un-parked it", () => {
    // BUG-70 built the ledger precisely so a wake stops being an untraceable
    // flag flip. It is the ONLY place the agent/human distinction can be read
    // back, so an agent-driven wake must be legible here rather than folded
    // into 'unknown'.
    recordPark('s1', 1000)
    recordWake('s1', 2000, 'peer-message')
    expect(parkHistory()).toEqual([
      { sessionKey: 's1', parkedAt: 1000, wokenAt: 2000, wakeGesture: 'peer-message' }
    ])
  })

  it("T215: a 'peer-message' wake of a session that was NEVER parked records nothing", () => {
    // Every `pty:create` calls `recordWake` unconditionally (the self-healing
    // clear), so a brand-new agent session must not fabricate ledger history.
    recordWake('never-parked', 2000, 'peer-message')
    expect(parkHistory()).toEqual([])
  })

  it('resetHibernation clears the ledger and the parking tags (test-only)', () => {
    recordPark('s1', 1000)
    markParking('pty-1')
    resetHibernation()
    expect(parkHistory()).toEqual([])
    expect(isParking('pty-1')).toBe(false)
  })
})

// ---- T363: mission-owner exemption (plan Slice S2, design.md §8 / §13 Resolved B) ----------

describe('hibernation — mission owners with live children (T363)', () => {
  const NOW = 1_700_000_000_000
  const MIN = 60_000
  const POLICY: Policy = { maxLive: 2, lruIdleMs: 15 * MIN, hardIdleMs: 60 * MIN }

  const OWNER = '8f2c1e4a-1111-4222-8333-944455556666'
  const CHILD = '2c9d0f1e-aaaa-4bbb-8ccc-ddddeeeeffff'
  const BYSTANDER = '5b6a7c8d-2222-4333-8444-a55566667777'

  let repo: string

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'harnu-t363-'))
    await mkdir(join(repo, '.git'), { recursive: true })
  })

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  function mission(over: Partial<Mission> = {}, childLinks: StepLink[] = []): Mission {
    return {
      id: 'mnt-0a1b2c3d',
      slug: 'mission-progress-rollout',
      folder: repo,
      owner: { sessionId: OWNER, folder: repo },
      status: 'active',
      declaredEnd: { kind: 'code', target: 'PR merging the slice', evidence: 'green gates' },
      steps: [
        {
          id: 'stp-1',
          ordinal: 1,
          kind: 'fixed-start',
          title: 'Scope confirmed',
          verification: 'existence',
          proof: 'verified',
          links: [{ kind: 'card', ref: 'T363-mission-progress-s2' }],
          blockers: []
        },
        {
          id: 'stp-2',
          ordinal: 2,
          kind: 'custom',
          title: 'Build the slice',
          verification: 'verifier',
          proof: 'unproven',
          links: childLinks,
          blockers: []
        },
        {
          id: 'stp-3',
          ordinal: 3,
          kind: 'fixed-end',
          title: 'Delivered and verified',
          verification: 'verifier',
          proof: 'unproven',
          links: [],
          blockers: []
        }
      ],
      blockers: [],
      openQuestions: [],
      createdAt: '2026-09-28T09:00:00.000Z',
      updatedAt: '2026-09-28T09:00:00.000Z',
      provenance: { author: 'agent', at: '2026-09-28T09:00:00.000Z' },
      ...over
    }
  }

  async function writeMission(m: Mission, root = repo): Promise<void> {
    await mkdir(missionsDir(root), { recursive: true })
    await writeFile(missionFilePath(root, m.id, m.slug), buildMissionFileContent(m))
  }

  /** A cold, parkable session in `cwd` — a valid victim unless something exempts it. */
  function cold(sessionKey: string, idleMin: number, cwd: string): LiveSession & { cwd: string } {
    return {
      sessionKey,
      cwd,
      kind: 'claude-resume',
      taskState: 'idle',
      lastFocusedAt: NOW - idleMin * MIN,
      lastActivityAt: NOW - idleMin * MIN,
      isSelected: false,
      hasPendingApproval: false
    }
  }

  /** What `pty.ts#fleetSnapshot` does: read the missions, stamp the owners. */
  function stamp(fleet: (LiveSession & { cwd: string })[]): LiveSession[] {
    const owners = missionOwnersWithLiveChildren(fleet)
    return fleet.map((s) => ({ ...s, ownsLiveMission: owners.has(s.sessionKey) }))
  }

  it('a session owning an active mission with a live linked child is never selected for hibernation, even when idle past the cap', async () => {
    await writeMission(mission({}, [{ kind: 'session', ref: CHILD }]))
    // The owner is the coldest session by far — past `hardIdleMs` — and the fleet is at
    // the cap, so without the exemption it is the first victim of BOTH triggers.
    const fleet = stamp([cold(OWNER, 600, repo), cold(CHILD, 1, repo)])

    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual([])
    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual([])
    const why = explainFleet(fleet, NOW, POLICY).find((e) => e.sessionKey === OWNER)
    expect(why).toMatchObject({ reason: 'mission-owner', sweepRank: null })
  })

  it('the exemption composes with the working rule — it does not replace it', async () => {
    await writeMission(mission({}, [{ kind: 'session', ref: CHILD }]))
    // A bystander that claims `working` but has been silent past `hardIdleMs` is still
    // swept exactly as before; only the owner is pinned.
    const bystander = { ...cold(BYSTANDER, 90, repo), taskState: 'working' as const }
    const fleet = stamp([cold(OWNER, 600, repo), cold(CHILD, 1, repo), bystander])

    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual([BYSTANDER])
  })

  it('an owner whose linked children all finished (no live PTY) is still eligible', async () => {
    await writeMission(mission({}, [{ kind: 'session', ref: CHILD }]))
    const fleet = stamp([cold(OWNER, 600, repo), cold(BYSTANDER, 1, repo)])

    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual([OWNER])
    expect(evaluateFleet(fleet, NOW, POLICY, 'cap')).toEqual([OWNER])
  })

  it('an owner of an active mission with no session ever linked is still eligible', async () => {
    await writeMission(
      mission({}, [
        { kind: 'worktree', ref: '/tmp/wt' },
        { kind: 'card', ref: 'T363' },
        { kind: 'pr', ref: 'owner/repo#1' }
      ])
    )
    const fleet = stamp([cold(OWNER, 600, repo), cold(CHILD, 1, repo)])

    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual([OWNER])
  })

  it('an owner that links only ITSELF is still eligible — a self-link is not a child', async () => {
    await writeMission(mission({}, [{ kind: 'session', ref: OWNER }]))
    const fleet = stamp([cold(OWNER, 600, repo)])

    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual([OWNER])
  })

  it('Mission v3 §3.4: a legacy draft mission reads active, so it pins its owner like one', async () => {
    await writeMission(mission({ status: 'draft' }, [{ kind: 'session', ref: CHILD }]))
    const fleet = stamp([cold(OWNER, 600, repo), cold(CHILD, 1, repo)])

    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual([])
  })

  it.each(['stale', 'delivered', 'closed'] as const)(
    'a %s mission does not pin its owner, even with a live child',
    async (status) => {
      await writeMission(mission({ status }, [{ kind: 'session', ref: CHILD }]))
      const fleet = stamp([cold(OWNER, 600, repo), cold(CHILD, 1, repo)])

      expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual([OWNER])
    }
  )

  it('only the OWNER is pinned — the live child itself stays eligible', async () => {
    await writeMission(mission({}, [{ kind: 'session', ref: CHILD }]))
    const fleet = stamp([cold(OWNER, 600, repo), cold(CHILD, 120, repo)])

    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual([CHILD])
  })

  it("reads the MAIN checkout's missions when the owner runs in a linked worktree", async () => {
    await writeMission(mission({}, [{ kind: 'session', ref: CHILD }]))
    // `git worktree add` layout: `<wt>/.git` is a FILE naming `<repo>/.git/worktrees/<name>`,
    // whose `commondir` points back at `<repo>/.git`.
    const wtGitDir = join(repo, '.git', 'worktrees', 'owner-wt')
    await mkdir(wtGitDir, { recursive: true })
    await writeFile(join(wtGitDir, 'commondir'), '../..\n')
    const wt = await mkdtemp(join(tmpdir(), 'harnu-t363-wt-'))
    try {
      await writeFile(join(wt, '.git'), `gitdir: ${wtGitDir}\n`)
      const fleet = stamp([cold(OWNER, 600, wt), cold(CHILD, 1, join(wt, 'src'))])

      expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual([])
    } finally {
      await rm(wt, { recursive: true, force: true })
    }
  })

  it('fails open: a malformed mission file, or no missions dir at all, exempts nobody', async () => {
    const fleetWithoutMissions = stamp([cold(OWNER, 600, repo), cold(CHILD, 1, repo)])
    expect(evaluateFleet(fleetWithoutMissions, NOW, POLICY, 'sweep')).toEqual([OWNER])

    await mkdir(missionsDir(repo), { recursive: true })
    await writeFile(join(missionsDir(repo), 'mnt-deadbeef-broken.md'), '---\nstatus: [\n---\n')
    const fleet = stamp([cold(OWNER, 600, repo), cold(CHILD, 1, repo)])
    expect(evaluateFleet(fleet, NOW, POLICY, 'sweep')).toEqual([OWNER])
  })

  it('ownsMissionWithLiveChild is a pure read of the missions and the live set', () => {
    const m = mission({}, [{ kind: 'session', ref: CHILD }])
    expect(ownsMissionWithLiveChild(OWNER, [m], new Set([OWNER, CHILD]))).toBe(true)
    expect(ownsMissionWithLiveChild(OWNER, [m], new Set([OWNER]))).toBe(false)
    expect(ownsMissionWithLiveChild(CHILD, [m], new Set([OWNER, CHILD]))).toBe(false)
    expect(ownsMissionWithLiveChild(OWNER, [], new Set([OWNER, CHILD]))).toBe(false)
  })

  it('AC-3e: the first sweep over an unpinned repo with a legacy data dir misses its missions, and the next sweep self-heals', async () => {
    // The sweep reads missions synchronously, but a repo the boot pass never saw has its
    // legacy `.capy/` copied lazily and asynchronously. So the very first read can see no
    // missions — which at worst parks an owner (parking is not death: the transcript is intact
    // and selecting the row resumes it). It must heal as soon as the copy lands, with no
    // restart and no extra wiring.
    setLazyDataDirMigration(true)
    try {
      const m = mission({}, [{ kind: 'session', ref: CHILD }])
      const legacyFile = missionFilePath(repo, m.id, m.slug).replace('.harnu', '.capy')
      await mkdir(dirname(legacyFile), { recursive: true })
      await writeFile(legacyFile, buildMissionFileContent(m))

      const fleet = [cold(OWNER, 600, repo), cold(CHILD, 1, repo)]
      expect(missionOwnersWithLiveChildren(fleet).has(OWNER)).toBe(false) // first sweep: not copied yet

      await dataDirReady(repo)
      expect(missionOwnersWithLiveChildren(fleet).has(OWNER)).toBe(true) // next sweep: healed
    } finally {
      setLazyDataDirMigration(false)
    }
  })
})
