/**
 * T370 (T358 S9) — `src/main/mission-ipc.ts`: the renderer's read of open
 * missions and the operator doors, driven against a real temp repo.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createMissionFile,
  missionsDir,
  parseMissionFile,
  readMissionLog,
  type Mission
} from '../src/main/mission-core'

const h = vi.hoisted(() => ({
  userDataDir: '',
  /** Extra latency each derive takes (Mission v3 S2 parallel-list test). */
  deriveDelayMs: 0,
  deriveCalls: 0,
  inFlight: 0,
  peakInFlight: 0,
  scanCalls: 0,
  deriveFails: false
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

// The fleet scan reads the real ~/.claude/projects — keep the tests off it.
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => {
    h.scanCalls++
    return []
  }
}))

// The real derive, observed: how many run, how many at once, and an optional delay.
vi.mock('../src/main/mcp/tool-handlers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/mcp/tool-handlers')>()
  return {
    ...real,
    deriveMissionSignals: async (
      ...args: Parameters<typeof real.deriveMissionSignals>
    ): ReturnType<typeof real.deriveMissionSignals> => {
      h.deriveCalls++
      h.inFlight++
      h.peakInFlight = Math.max(h.peakInFlight, h.inFlight)
      try {
        if (h.deriveDelayMs > 0) await new Promise((r) => setTimeout(r, h.deriveDelayMs))
        if (h.deriveFails) throw new Error('derive exploded')
        return await real.deriveMissionSignals(...args)
      } finally {
        h.inFlight--
      }
    }
  }
})

const OWNER = '11111111-2222-4333-8444-555555555555'

function mission(id: string, over: Partial<Mission> = {}): Mission {
  return {
    id,
    slug: `m-${id.slice(4)}`,
    folder: '/repo',
    owner: { sessionId: OWNER, folder: '/repo' },
    status: 'draft',
    declaredEnd: { kind: 'code', target: 'PR merging the slice', evidence: 'green gates' },
    steps: [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'fixed-start',
        title: 'Scope confirmed',
        verification: 'existence',
        proof: 'unproven',
        links: [],
        blockers: []
      },
      {
        id: 'stp-3',
        ordinal: 2,
        kind: 'custom',
        title: 'Copy review',
        verification: 'human',
        proof: 'unproven',
        links: [],
        blockers: []
      },
      {
        id: 'stp-2',
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
    createdAt: '2026-09-28T10:00:00.000Z',
    updatedAt: '2026-09-28T10:00:00.000Z',
    provenance: { author: 'agent', at: '2026-09-28T10:00:00.000Z' },
    ...over
  }
}

async function onDisk(root: string, id: string): Promise<{ m: Mission; log: string }> {
  const name = (await fs.readdir(missionsDir(root))).find((n) => n.startsWith(`${id}-`))!
  const raw = await fs.readFile(path.join(missionsDir(root), name), 'utf8')
  return { m: parseMissionFile(raw) as Mission, log: readMissionLog(raw) }
}

let root: string
let ipc: typeof import('../src/main/mission-ipc')

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-ipc-ud-'))
  h.deriveDelayMs = 0
  h.deriveCalls = 0
  h.inFlight = 0
  h.peakInFlight = 0
  h.scanCalls = 0
  h.deriveFails = false
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-ipc-'))
  vi.resetModules()
  ipc = await import('../src/main/mission-ipc')
})

describe('listMissionViews', () => {
  it('returns every open mission with its derived block and a structured you item', async () => {
    await createMissionFile(root, mission('mnt-00000001'), '# First mission\n')
    await createMissionFile(
      root,
      mission('mnt-00000002', {
        status: 'active',
        updatedAt: '2026-09-28T11:00:00.000Z',
        pendingRescope: { kind: 'research', target: 'a memo', evidence: 'merged' }
      })
    )
    await createMissionFile(root, mission('mnt-00000003', { status: 'closed' }))
    const { views, unreadable } = await ipc.listMissionViews([root])
    expect(unreadable).toEqual([])
    // Closed missions are left out; newest first.
    expect(views.map((v) => v.mission.id)).toEqual(['mnt-00000002', 'mnt-00000001'])
    expect(views[1].title).toBe('First mission')
    // Mission v3 §3.12: an ordered list of what the operator owes.
    // The fixture's human step stp-3 is the current step, unticked: owed too.
    expect(views[0].you).toEqual([
      { kind: 'rescope', end: { kind: 'research', target: 'a memo', evidence: 'merged' } },
      { kind: 'human-steps', stepIds: ['stp-3'] }
    ])
    expect(views[1].you).toEqual([{ kind: 'human-steps', stepIds: ['stp-3'] }])
    expect(views[0].derived.live).toBe(true)
    expect(views[0].derived.steps.map((s) => s.stepId)).toEqual(['stp-1', 'stp-3', 'stp-2'])
    // Mission v3 §3.5: warnings, never a refusal; the view carries the progress.
    expect(views[0]).not.toHaveProperty('closeRefusal')
    expect(views[0].closeWarnings.map((w) => w.kind)).toEqual(['end-unverified', 'rescope-staged'])
    expect(views[0].progress).toMatchObject({ total: 2, current: { from: 1, to: 1 } })
    expect(views[0].derived.progress).toEqual(views[0].progress)
    expect(views[0].root).toBe(root)
  })

  it('never carries legacyRaw to the renderer', async () => {
    await createMissionFile(
      root,
      mission('mnt-00000004', {
        legacy: { source: '/repo/.harnu/goals/x.md', sha256: 'sha256:00', needsReview: [] },
        legacyRaw: 'a whole legacy file'
      })
    )
    const { views } = await ipc.listMissionViews([root])
    expect(views[0].mission).not.toHaveProperty('legacyRaw')
    expect(views[0].mission.legacy?.source).toBe('/repo/.harnu/goals/x.md')
  })

  // The plan's bound read "< 1.5 s", but 9 derives at 4 at once are 3 waves of
  // 500 ms — 1.5 s is the floor itself. The bound is the floor plus slack, far
  // below the 4.5 s a sequential loop takes; the peak pins the limit exactly.
  it('Mission v3 §3.8: derives in parallel (at most 4 at once) — 9 missions of 500 ms in 3 waves, not 9', async () => {
    const roots = [root, await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-ipc-b-'))]
    for (let i = 1; i <= 9; i++) {
      const id = `mnt-${i.toString(16).padStart(8, '0')}`
      await createMissionFile(
        roots[i % 2],
        mission(id, { status: 'active', updatedAt: `2026-09-28T10:0${i}:00.000Z` })
      )
    }
    h.deriveDelayMs = 500
    const t0 = Date.now()
    const { views } = await ipc.listMissionViews(roots)
    const took = Date.now() - t0
    expect(took).toBeGreaterThanOrEqual(1500)
    expect(took).toBeLessThan(2000)
    expect(h.deriveCalls).toBe(9)
    expect(h.peakInFlight).toBe(4)
    // Same answer as the sequential loop: every mission once, newest first.
    expect(views.map((v) => v.mission.id)).toEqual(
      [9, 8, 7, 6, 5, 4, 3, 2, 1].map((i) => `mnt-${i.toString(16).padStart(8, '0')}`)
    )
    expect(views.map((v) => v.root)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1].map((i) => roots[i % 2]))
  })

  it('Mission v3 §3.8: the fleet scan is memoized for 10 s across list calls', async () => {
    await createMissionFile(root, mission('mnt-00000001', { status: 'active' }))
    await ipc.listMissionViews([root])
    await ipc.listMissionViews([root])
    expect(h.scanCalls).toBe(1)
    const real = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 10_001)
    try {
      await ipc.listMissionViews([root])
    } finally {
      spy.mockRestore()
    }
    expect(h.scanCalls).toBe(2)
  })

  it('returns nothing for no folders or a repo with no missions dir', async () => {
    expect(await ipc.listMissionViews([])).toEqual({ views: [], unreadable: [], shadowed: [] })
    expect(await ipc.listMissionViews([root])).toEqual({ views: [], unreadable: [], shadowed: [] })
  })
})

// BUG-173 S1 (mission cue noise spec §3.1): missions are unique by `mission.id`.
describe('listMissionViews — one entry per mission id', () => {
  /** A second repo root: a temp dir with a `.git` directory, like a separate clone. */
  async function cloneRoot(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-ipc-clone-'))
    await fs.mkdir(path.join(dir, '.git'))
    return fs.realpath(dir)
  }

  beforeEach(async () => {
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    root = await fs.realpath(root)
  })

  it('lists a mission once when two roots hold the same id', async () => {
    const other = await cloneRoot()
    await createMissionFile(root, mission('mnt-0000d001', { status: 'active' }), '# Twin\n')
    await createMissionFile(other, mission('mnt-0000d001', { status: 'active' }), '# Twin\n')
    const { views, shadowed } = await ipc.listMissionViews([root, other])
    expect(views.map((v) => v.mission.id)).toEqual(['mnt-0000d001'])
    // Same updatedAt: the root that sorts first by path wins; the other is reported.
    const [winner, loser] = [root, other].sort()
    expect(views[0].root).toBe(winner)
    expect(shadowed).toEqual([{ missionId: 'mnt-0000d001', root: loser }])
    expect(h.deriveCalls).toBe(1)
  })

  it('newest updatedAt wins and a tie breaks on root path', async () => {
    const other = await cloneRoot()
    const [first, second] = [root, other].sort()
    const older = '2026-09-28T10:00:00.000Z'
    const newer = '2026-09-29T10:00:00.000Z'
    // The root that sorts LAST holds the newer copy: recency beats path order.
    await createMissionFile(first, mission('mnt-0000d002', { status: 'active', updatedAt: older }))
    await createMissionFile(second, mission('mnt-0000d002', { status: 'active', updatedAt: newer }))
    // Folder order must not matter.
    for (const order of [
      [first, second],
      [second, first]
    ]) {
      const { views, shadowed } = await ipc.listMissionViews(order)
      expect(views).toHaveLength(1)
      expect(views[0].root).toBe(second)
      expect(views[0].mission.updatedAt).toBe(newer)
      expect(shadowed).toEqual([{ missionId: 'mnt-0000d002', root: first }])
    }
  })

  it('a closed winner drops the id even if an older copy is active', async () => {
    const other = await cloneRoot()
    await createMissionFile(
      root,
      mission('mnt-0000d003', { status: 'active', updatedAt: '2026-09-28T10:00:00.000Z' })
    )
    await createMissionFile(
      other,
      mission('mnt-0000d003', { status: 'closed', updatedAt: '2026-09-29T10:00:00.000Z' })
    )
    const { views, shadowed } = await ipc.listMissionViews([root, other])
    expect(views).toEqual([])
    expect(shadowed).toEqual([{ missionId: 'mnt-0000d003', root }])
  })

  it('two spellings of one directory are one root', async () => {
    await createMissionFile(root, mission('mnt-0000d004', { status: 'active' }))
    const alias = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-ipc-ln-')), 'l')
    await fs.symlink(root, alias)
    const { views, shadowed } = await ipc.listMissionViews([root, alias])
    expect(views.map((v) => v.mission.id)).toEqual(['mnt-0000d004'])
    expect(shadowed).toEqual([])
    expect(h.deriveCalls).toBe(1)
  })
})

describe('runOperatorDoor', () => {
  const AT = '2026-09-28T15:00:00.000Z'
  const now = (): string => AT

  it('approveRescope and verifyStep apply their core functions', async () => {
    await createMissionFile(
      root,
      mission('mnt-0000000b', {
        status: 'active',
        pendingRescope: { kind: 'research', target: 'a memo', evidence: 'merged' }
      })
    )
    expect(
      await ipc.runOperatorDoor({ door: 'approveRescope', root, missionId: 'mnt-0000000b' }, now)
    ).toEqual({ ok: true, view: expect.objectContaining({ root }) })
    expect(
      await ipc.runOperatorDoor(
        { door: 'verifyStep', root, missionId: 'mnt-0000000b', stepId: 'stp-3', verified: true },
        now
      )
    ).toEqual({ ok: true, view: expect.objectContaining({ root }) })
    const { m } = await onDisk(root, 'mnt-0000000b')
    expect(m.declaredEnd.target).toBe('a memo')
    expect(m.pendingRescope).toBeUndefined()
    expect(m.steps[1].proof).toBe('verified')
  })

  it('end: closes any non-closed mission, logs the outcome, and agent verbs then refuse MISSION_CLOSED (Mission v3 §3.5)', async () => {
    await createMissionFile(
      root,
      mission('mnt-0000000c', { status: 'active' }),
      '# Title\n\n## Log\n'
    )
    expect(
      await ipc.runOperatorDoor(
        { door: 'end', root, missionId: 'mnt-0000000c', closedAs: 'discarded', reason: 'dead' },
        now
      )
    ).toEqual({ ok: true, view: null })
    const { m, log } = await onDisk(root, 'mnt-0000000c')
    expect(m).toMatchObject({ status: 'closed', closedAs: 'discarded', closeReason: 'dead' })
    expect(log).toContain(`### ${AT} · operator ended (discarded)`)
    expect(log).toContain('dead')
    // Review Focus: a double Close is a refusal, never a crash or a resurrected mission.
    expect(
      await ipc.runOperatorDoor(
        { door: 'end', root, missionId: 'mnt-0000000c', closedAs: 'delivered' },
        now
      )
    ).toEqual({ ok: false, error: expect.stringMatching(/^MISSION_CLOSED/) })
    expect((await onDisk(root, 'mnt-0000000c')).m.closedAs).toBe('discarded')
    // The owner learns of it: every agent verb now refuses.
    const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
    const log_ = WIRED_TOOLS.find((t) => t.op === 'mission_log')!.handler as unknown as (
      a: Record<string, unknown>,
      c: Record<string, unknown>
    ) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>
    const res = await log_(
      { folder: root, missionId: 'mnt-0000000c', note: 'still here?' },
      { folder: root, folders: [], denyFolders: [], bridge: undefined }
    )
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/^MISSION_CLOSED/)
    // …and the list no longer shows it.
    expect((await ipc.listMissionViews([root])).views).toEqual([])
  })

  it('every door appends a line to the Log, so the owner can read what the operator did', async () => {
    await createMissionFile(root, mission('mnt-0000000f', { status: 'active' }), '# T\n\n## Log\n')
    await ipc.runOperatorDoor(
      { door: 'verifyStep', root, missionId: 'mnt-0000000f', stepId: 'stp-3', verified: true },
      now
    )
    await ipc.runOperatorDoor(
      { door: 'addCheck', root, missionId: 'mnt-0000000f', stepId: 'stp-3', label: 'DSQA' },
      now
    )
    const { log } = await onDisk(root, 'mnt-0000000f')
    expect(log.match(/^### .* · operator /gm)).toHaveLength(2)
  })

  it('checks: the operator adds (source operator), ticks, un-ticks and deletes (Mission v3 §3.6)', async () => {
    await createMissionFile(root, mission('mnt-0000000e', { status: 'active' }))
    const door = (d: Record<string, unknown>): Promise<unknown> =>
      ipc.runOperatorDoor({ root, missionId: 'mnt-0000000e', ...d }, now)
    expect(await door({ door: 'addCheck', stepId: 'stp-3', label: 'Validated visually' })).toEqual({
      ok: true,
      view: expect.objectContaining({ root })
    })
    let { m } = await onDisk(root, 'mnt-0000000e')
    expect(m.steps[1].checks).toEqual([
      { id: 'chk-1', label: 'Validated visually', source: 'operator', createdAt: AT }
    ])
    expect(
      await door({ door: 'tickCheck', stepId: 'stp-3', checkId: 'chk-1', ticked: true })
    ).toEqual({ ok: true, view: expect.objectContaining({ root }) })
    ;({ m } = await onDisk(root, 'mnt-0000000e'))
    expect(m.steps[1].checks![0].ticked).toEqual({ at: AT })
    expect(
      await door({ door: 'tickCheck', stepId: 'stp-3', checkId: 'chk-1', ticked: false })
    ).toEqual({ ok: true, view: expect.objectContaining({ root }) })
    ;({ m } = await onDisk(root, 'mnt-0000000e'))
    expect(m.steps[1].checks![0].ticked).toBeUndefined()
    expect(await door({ door: 'deleteCheck', stepId: 'stp-3', checkId: 'chk-1' })).toEqual({
      ok: true,
      view: expect.objectContaining({ root })
    })
    ;({ m } = await onDisk(root, 'mnt-0000000e'))
    expect(m.steps[1].checks).toEqual([])
    expect(await door({ door: 'deleteCheck', stepId: 'stp-3', checkId: 'chk-1' })).toEqual({
      ok: false,
      error: expect.stringMatching(/^CHECK_NOT_FOUND/)
    })
    for (const bad of [
      { door: 'addCheck', stepId: 'stp-3' },
      { door: 'tickCheck', stepId: 'stp-3', checkId: 'chk-1' },
      { door: 'deleteCheck', stepId: 'stp-3' }
    ]) {
      expect(await door(bad), JSON.stringify(bad)).toEqual({
        ok: false,
        error: expect.stringMatching(/^BAD_ARGS/)
      })
    }
  })

  it('Delta 1: an operator addCheck that dedupes writes nothing, logs nothing, and says deduped', async () => {
    await createMissionFile(root, mission('mnt-0000000f', { status: 'active' }), '# T\n\n## Log\n')
    const add = (label: string): Promise<unknown> =>
      ipc.runOperatorDoor(
        { door: 'addCheck', root, missionId: 'mnt-0000000f', stepId: 'stp-3', label },
        now
      )
    expect(await add('Validated visually')).toEqual({
      ok: true,
      view: expect.objectContaining({ root })
    })
    const file = path.join(missionsDir(root), (await fs.readdir(missionsDir(root)))[0])
    const before = await fs.readFile(file, 'utf8')
    expect(
      await ipc.runOperatorDoor(
        {
          door: 'addCheck',
          root,
          missionId: 'mnt-0000000f',
          stepId: 'stp-3',
          label: 'VALIDATED   visually'
        },
        () => '2026-09-29T09:00:00.000Z'
      )
    ).toEqual({ ok: true, view: expect.objectContaining({ root }), deduped: true })
    // Byte-identical: no log line, no updatedAt bump.
    expect(await fs.readFile(file, 'utf8')).toBe(before)
    const { m, log } = await onDisk(root, 'mnt-0000000f')
    expect(m.steps[1].checks).toHaveLength(1)
    expect(log.match(/operator added a check/g)).toHaveLength(1)
  })

  it('Mission v3 §3.2: a tick answers with that mission re-derived — and derives nothing else', async () => {
    await createMissionFile(root, mission('mnt-00000011', { status: 'active' }), '# Ticked\n')
    await createMissionFile(root, mission('mnt-00000012', { status: 'active' }))
    await createMissionFile(root, mission('mnt-00000013', { status: 'active' }))
    const res = await ipc.runOperatorDoor(
      { door: 'verifyStep', root, missionId: 'mnt-00000011', stepId: 'stp-3', verified: true },
      now
    )
    expect(h.deriveCalls).toBe(1)
    expect(h.scanCalls).toBeLessThanOrEqual(1)
    if (!res.ok) throw new Error(res.error)
    const view = res.view!
    expect(view.root).toBe(root)
    expect(view.title).toBe('Ticked')
    expect(view.mission.id).toBe('mnt-00000011')
    expect(view.mission.steps[1].proof).toBe('verified')
    expect(view.mission.updatedAt).toBe(AT)
    expect(view.progress.states['stp-3']).toBe('verified')
    expect(view.derived.progress).toEqual(view.progress)
    expect(view.mission).not.toHaveProperty('legacyRaw')
    // The same projection the list builds for that mission.
    const listed = (await ipc.listMissionViews([root])).views.find(
      (v) => v.mission.id === 'mnt-00000011'
    )!
    expect({ ...view, derived: null, progress: null }).toEqual({
      ...listed,
      derived: null,
      progress: null
    })
    expect(view.progress.states).toEqual(listed.progress.states)
  })

  it('Mission v3 §3.2: end answers view null without deriving, for delivered and discarded alike', async () => {
    await createMissionFile(root, mission('mnt-00000014', { status: 'active' }))
    await createMissionFile(root, mission('mnt-00000015', { status: 'delivered' }))
    expect(
      await ipc.runOperatorDoor(
        { door: 'end', root, missionId: 'mnt-00000014', closedAs: 'discarded' },
        now
      )
    ).toEqual({ ok: true, view: null })
    expect(
      await ipc.runOperatorDoor(
        { door: 'end', root, missionId: 'mnt-00000015', closedAs: 'delivered' },
        now
      )
    ).toEqual({ ok: true, view: null })
    expect(h.deriveCalls).toBe(0)
  })

  it('Review Focus: a double Close clicked at once — one closes, the other is MISSION_CLOSED', async () => {
    await createMissionFile(root, mission('mnt-00000016', { status: 'active' }), '# T\n\n## Log\n')
    const end = (): Promise<unknown> =>
      ipc.runOperatorDoor(
        { door: 'end', root, missionId: 'mnt-00000016', closedAs: 'delivered' },
        now
      )
    const results = await Promise.all([end(), end()])
    expect(results).toContainEqual({ ok: true, view: null })
    expect(results).toContainEqual({ ok: false, error: expect.stringMatching(/^MISSION_CLOSED/) })
    const { m, log } = await onDisk(root, 'mnt-00000016')
    expect(m.status).toBe('closed')
    expect(log.match(/operator ended/g)).toHaveLength(1)
    // Never resurrected: the list does not show it, and no view was built for it.
    expect((await ipc.listMissionViews([root])).views).toEqual([])
  })

  it('a door whose re-derive fails still reports the write: ok with view null, never a throw', async () => {
    await createMissionFile(root, mission('mnt-00000017', { status: 'active' }))
    h.deriveFails = true
    expect(
      await ipc.runOperatorDoor(
        { door: 'verifyStep', root, missionId: 'mnt-00000017', stepId: 'stp-3', verified: true },
        now
      )
    ).toEqual({ ok: true, view: null })
    expect((await onDisk(root, 'mnt-00000017')).m.steps[1].proof).toBe('verified')
  })

  it('refuses a malformed door without touching disk', async () => {
    for (const bad of [
      null,
      { door: 'delete', root, missionId: 'mnt-0000000d' },
      { door: 'approve', root, missionId: 'mnt-0000000d' },
      { door: 'close', root, missionId: 'mnt-0000000d' },
      { door: 'end', missionId: 'mnt-0000000d', closedAs: 'delivered' },
      { door: 'end', root, missionId: 'mnt-0000000d', closedAs: 'abandoned' },
      { door: 'verifyStep', root, missionId: 'mnt-0000000d', stepId: 'stp-3' }
    ]) {
      expect(await ipc.runOperatorDoor(bad)).toEqual({
        ok: false,
        error: expect.stringMatching(/^BAD_ARGS/)
      })
    }
    expect(
      await ipc.runOperatorDoor({
        door: 'end',
        root,
        missionId: 'mnt-0000dead',
        closedAs: 'delivered'
      })
    ).toEqual({ ok: false, error: expect.stringMatching(/^MISSION_NOT_FOUND/) })
  })
})
