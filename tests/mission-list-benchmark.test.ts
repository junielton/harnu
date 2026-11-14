/**
 * Mission v3 S2 (§3.8, AC-8) — the read-latency benchmark: `mission:list` over
 * 9 open fixture missions with a `gh` that takes 5 s, through the REAL path —
 * `listMissionViews` → `mapLimit` → `deriveMissionSignals` → `findPrsForWorktrees`
 * → the single-flight PR cache. Only `gh` itself is stubbed (at the `execFile`
 * seam, like tests/pr-stack-mission-join.test.ts); `git` runs for real.
 *
 * Smoke S-4 measured 3.5–11 s per mission derive, run one after another
 * (≈ 46 s a pass), and up to ~90 s before the close dialog dismissed.
 * Targets: ≤ 12 s cold, ≤ 1 s warm, doors within 2 s.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createMissionFile, type Mission, type MissionStep } from '../src/main/mission-core'
import type { MissionV4, StepV4 } from '../src/main/missions/model'
import { deriveProgress } from '../src/main/missions/progress'
import type { StepInput } from '../src/main/missions/state'
import { buildMissionSummary, missionListRow } from '../src/main/missions/summary'
import { deriveStepResults, waitingListV4 } from '../src/main/missions/waiting'

const GH_MS = 5000

const h = vi.hoisted(() => ({
  userDataDir: '',
  ghCalls: 0,
  spawns: 0,
  /** Every call into `node:fs` and `node:fs/promises`, sync or async, by name (AC-20 asserts none). */
  fsCalls: [] as string[],
  wrapFs: (
    obj: Record<string, unknown>,
    prefix: string,
    calls: string[]
  ): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(obj).map(([k, v]) =>
        typeof v === 'function' && !/^[A-Z]/.test(k)
          ? [
              k,
              (...a: unknown[]): unknown => {
                calls.push(`${prefix}.${k}`)
                return (v as (...x: unknown[]) => unknown)(...a)
              }
            ]
          : [k, v]
      )
    )
}))

// Count every file-system call, synchronous ones included: the real-path tests below still run through
// the real `fs`, the wrapper only records and delegates.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...h.wrapFs(real, 'fs', h.fsCalls),
    promises: h.wrapFs(real.promises as Record<string, unknown>, 'fs.promises', h.fsCalls),
    // A default import (`import fs from 'node:fs'`) is counted too, and so is `fs.promises` through it.
    default: {
      ...h.wrapFs(real.default as Record<string, unknown>, 'fs.default', h.fsCalls),
      promises: h.wrapFs(
        (real.default as { promises: Record<string, unknown> }).promises,
        'fs.default.promises',
        h.fsCalls
      )
    }
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...h.wrapFs(real, 'fs/promises', h.fsCalls),
    default: h.wrapFs(real.default as Record<string, unknown>, 'fs/promises.default', h.fsCalls)
  }
})

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
vi.mock('../src/main/appimage-env', () => ({
  spawnEnvOnce: async (): Promise<Record<string, string>> => ({ ...process.env }) as never
}))
vi.mock('../src/main/claude-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/claude-reader')>()),
  scanFolders: async (): Promise<unknown[]> => []
}))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  type Cb = (err: Error | null, out?: { stdout: string; stderr: string }) => void
  const execFile = (file: string, args: string[], opts: object, cb: Cb): void => {
    h.spawns++
    if (file === 'gh') {
      // The claim is about the PR LIST (single-flight per repo); the merge-commit CI
      // lookups of the campaign `main` gate (spec §3.2) are separate, cached calls.
      if (args[0] === 'pr' && args[1] === 'list') h.ghCalls++
      const prs = [7, 8, 9].map((n) => ({
        number: n,
        headRefName: `feat/b${n}`,
        baseRefName: 'main',
        state: n === 9 ? 'CLOSED' : n === 8 ? 'MERGED' : 'OPEN',
        url: `https://example.test/pull/${n}`
      }))
      setTimeout(() => cb(null, { stdout: JSON.stringify(prs), stderr: '' }), GH_MS)
      return
    }
    real.execFile(file, args, opts, (err, stdout, stderr) =>
      err ? cb(err) : cb(null, { stdout: String(stdout), stderr: String(stderr) })
    )
  }
  // Every other way to start a process is counted too (v4 AC-20 asserts the v4 view starts none).
  const counted = <T extends (...a: never[]) => unknown>(fn: T): T =>
    ((...a: never[]): unknown => {
      h.spawns++
      return fn(...a)
    }) as T
  return {
    ...real,
    execFile,
    spawn: counted(real.spawn),
    spawnSync: counted(real.spawnSync),
    exec: counted(real.exec),
    execSync: counted(real.execSync),
    execFileSync: counted(real.execFileSync),
    fork: counted(real.fork),
    // A default import (`import cp from 'node:child_process'`) is counted too.
    default: {
      ...real.default,
      execFile,
      spawn: counted(real.spawn),
      spawnSync: counted(real.spawnSync),
      exec: counted(real.exec),
      execSync: counted(real.execSync),
      execFileSync: counted(real.execFileSync),
      fork: counted(real.fork)
    }
  }
})

const OWNER = '11111111-2222-4333-8444-555555555555'

function step(id: string, ordinal: number, links: MissionStep['links']): MissionStep {
  return {
    id,
    ordinal,
    kind: 'custom',
    title: `Step ${ordinal}`,
    verification: 'existence',
    proof: 'unproven',
    links,
    blockers: []
  }
}

function fixture(id: string, root: string, n: number): Mission {
  return {
    id,
    slug: `bench-${n}`,
    folder: root,
    owner: { sessionId: OWNER, folder: root },
    status: 'active',
    declaredEnd: { kind: 'code', target: 'a PR', evidence: 'merged' },
    steps: [
      step('stp-1', 1, [{ kind: 'pr', ref: '#8' }]),
      step('stp-2', 2, [
        { kind: 'pr', ref: `org/proj#${7 + (n % 3)}` },
        { kind: 'worktree', ref: 'spec.md' }
      ]),
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
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: `2026-10-01T10:0${n}:00.000Z`,
    provenance: { author: 'agent', at: '2026-10-01T10:00:00.000Z' }
  }
}

const roots: string[] = []
let ipc: typeof import('../src/main/mission-ipc')

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-bench-ud-'))
  // 9 open missions across 3 repos (plus a closed one that must not cost a derive).
  for (let r = 0; r < 3; r++) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `harnu-bench-${r}-`))
    await fs.writeFile(path.join(root, 'spec.md'), '# spec')
    roots.push(root)
  }
  for (let n = 1; n <= 9; n++) {
    const root = roots[n % 3]
    await createMissionFile(root, fixture(`mnt-0000b00${n}`, root, n), `# Bench ${n}\n`)
  }
  await createMissionFile(roots[0], { ...fixture('mnt-0000b0ff', roots[0], 0), status: 'closed' })
  ipc = await import('../src/main/mission-ipc')
})

describe('mission:list read latency (Mission v3 §3.8, AC-8)', () => {
  it(`cold: 9 missions with a ${GH_MS / 1000} s gh complete in ≤ 12 s — one gh call per repo`, async () => {
    const t0 = Date.now()
    const { views } = await ipc.listMissionViews(roots)
    const cold = Date.now() - t0
    console.info(
      `[bench] mission:list cold: ${cold} ms (${views.length} missions, gh ${h.ghCalls}×)`
    )
    expect(views).toHaveLength(9)
    expect(cold).toBeLessThanOrEqual(12_000)
    expect(h.ghCalls).toBe(3)
    // Resolved for real, not degraded: #8 MERGED proves stp-1 everywhere.
    expect(views.every((v) => v.derived.gh === 'available')).toBe(true)
    expect(views.every((v) => v.derived.steps[0].existence?.proven === true)).toBe(true)
  }, 30_000)

  it('warm: the same pass within 60 s completes in ≤ 1 s with no gh call', async () => {
    const before = h.ghCalls
    const t0 = Date.now()
    const { views } = await ipc.listMissionViews(roots)
    const warm = Date.now() - t0
    console.info(`[bench] mission:list warm: ${warm} ms`)
    expect(views).toHaveLength(9)
    expect(warm).toBeLessThanOrEqual(1000)
    expect(h.ghCalls).toBe(before)
  })

  it('doors return within 2 s: a tick answers with its view, an end with null', async () => {
    const root = roots[1]
    let t0 = Date.now()
    const tick = await ipc.runOperatorDoor({
      door: 'addCheck',
      root,
      missionId: 'mnt-0000b001',
      stepId: 'stp-2',
      label: 'Validated visually'
    })
    const tickMs = Date.now() - t0
    t0 = Date.now()
    const end = await ipc.runOperatorDoor({
      door: 'end',
      root,
      missionId: 'mnt-0000b004',
      closedAs: 'discarded'
    })
    const endMs = Date.now() - t0
    console.info(`[bench] door tick: ${tickMs} ms, door end: ${endMs} ms`)
    expect(tick).toMatchObject({ ok: true, view: { mission: { id: 'mnt-0000b001' } } })
    expect(end).toEqual({ ok: true, view: null })
    expect(tickMs).toBeLessThanOrEqual(2000)
    expect(endMs).toBeLessThanOrEqual(2000)
  })

  it('doors return within 2 s on a COLD PR cache too: sticky last-known proof, marked stale', async () => {
    // A fresh process: empty PR cache, but the sidecar remembers what resolved — the observer
    // pass remembers it (a read does not, AC-4), as it does every minute in the app.
    const warm = await import('../src/main/mission-ipc')
    await warm.observeOpenMissions(roots)
    const { flushLinkCache } = await import('../src/main/mission-link-cache')
    await flushLinkCache()
    vi.resetModules()
    const fresh = await import('../src/main/mission-ipc')
    const t0 = Date.now()
    const tick = await fresh.runOperatorDoor({
      door: 'addCheck',
      root: roots[2],
      missionId: 'mnt-0000b002',
      stepId: 'stp-1',
      label: 'DSQA done'
    })
    const ms = Date.now() - t0
    console.info(`[bench] door tick, cold PR cache: ${ms} ms`)
    expect(ms).toBeLessThanOrEqual(2000)
    if (!tick.ok || !tick.view) throw new Error(JSON.stringify(tick))
    const first = tick.view.derived.steps[0]
    expect(first.existence?.proven).toBe(true)
    expect(first.links[0]).toMatchObject({ kind: 'pr', state: 'MERGED', stale: true })
  })
})

/**
 * Missions v4 · S-8 · AC-20 — the v4 view costs no process: progress, the waiting list and the summary are
 * pure over a record and plain input facts, so a 10-milestone, 21-step mission adds no `git` or `gh` spawn
 * to what a read already spends. The facts (pull-request state, CI, `main`) come from the sticky link
 * cache the caller already holds and arrive as `StepInput`s; nothing here goes and fetches them.
 */
describe('v4 view cost (Missions v4 S-8, AC-20)', () => {
  const AT = '2026-11-14T10:00:00Z'

  function largeMission(): { mission: MissionV4; inputs: Record<string, StepInput>; log: string } {
    const milestones = Array.from({ length: 10 }, (_, i) => ({
      id: `mls-${i + 1}`,
      title: `Milestone ${i + 1} is true`,
      optional: false,
      waitsFor: null
    })) as MissionV4['milestones']
    const steps: StepV4[] = []
    const inputs: Record<string, StepInput> = {}
    for (let n = 1; n <= 21; n++) {
      const id = `stp-${n}`
      steps.push({
        id,
        milestone: `mls-${Math.ceil(n / 2.1)}`,
        title: `Step ${n}`,
        acs: [
          {
            id: 'ac-1',
            text: `The pull request for ${id} is merged`,
            by: 'fact',
            fact: 'pr-merged'
          },
          { id: 'ac-2', text: `You read the page for ${id}`, by: 'operator' }
        ],
        links: [{ kind: 'pr', ref: String(300 + n) }],
        blockers: []
      } as StepV4)
      inputs[id] =
        n % 3 === 0 ? { pr: 'merged', facts: { 'main-green': n % 6 !== 0 } } : { pr: 'open' }
    }
    const mission = {
      schemaVersion: 4,
      id: 'mnt-1a2b3c4d',
      title: 'A large mission',
      doneWhen: 'Every milestone is true.',
      status: 'open',
      milestones,
      steps,
      sessions: [],
      links: [],
      blockers: []
    } as MissionV4
    const log = `\n### ${AT} · decision · stp-1\n\nWe chose the first option.\n`
    return { mission, inputs, log }
  }

  it('v4 view stays inside the spawn budget', () => {
    const { mission, inputs, log } = largeMission()
    expect(mission.milestones).toHaveLength(10)
    expect(mission.steps).toHaveLength(21)

    const readSpies = (['readFile', 'readdir', 'stat', 'open', 'writeFile', 'access'] as const).map(
      (k) => vi.spyOn(fs, k as 'readFile')
    )
    const RealDate = Date
    let clockReads = 0
    class CountingDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) clockReads++
        super(...(args as [number]))
      }
      static now(): number {
        clockReads++
        return RealDate.now()
      }
    }
    vi.stubGlobal('Date', CountingDate)

    const spawnsBefore = h.spawns
    const ghBefore = h.ghCalls
    h.fsCalls.length = 0
    const PASSES = 200
    const t0 = performance.now()
    let nextAsk = ''
    for (let i = 0; i < PASSES; i++) {
      // One view: every step is derived once for progress and once for its criteria, then shared.
      const progress = deriveProgress(mission, inputs)
      const results = deriveStepResults(mission, inputs)
      const list = waitingListV4(mission, { inputs, progress, results })
      const { text } = buildMissionSummary(mission, log, { inputs, progress, results })
      const row = missionListRow(mission, { inputs, progress, results })
      nextAsk = list.next?.ask ?? ''
      expect(text.length).toBeLessThanOrEqual(8000)
      expect(row.endsWith(nextAsk)).toBe(true)
    }
    const ms = performance.now() - t0
    vi.unstubAllGlobals()
    const syncAndAsyncFsCalls = [...h.fsCalls]
    const reads = readSpies.reduce((n, s) => n + s.mock.calls.length, 0)
    readSpies.forEach((s) => s.mockRestore())
    console.info(
      `[bench] v4 view: ${(ms / PASSES).toFixed(3)} ms a pass over 10 milestones / 21 steps; ` +
        `spawns +${h.spawns - spawnsBefore}, gh +${h.ghCalls - ghBefore}, file reads ${reads}, clock reads ${clockReads}`
    )

    expect(nextAsk).not.toBe('') // it really derived something
    expect(h.spawns - spawnsBefore).toBe(0) // no git, no gh, no other process
    expect(h.ghCalls - ghBefore).toBe(0)
    expect(reads).toBe(0)
    expect(syncAndAsyncFsCalls).toEqual([]) // no file read or write at all, sync or async
    expect(clockReads).toBe(0)
    expect(ms / PASSES).toBeLessThan(50) // a pure derive, not a fetch: milliseconds, not seconds
  })

  it('the file-system counter sees a synchronous read when one is made', async () => {
    const fsMod = await import('node:fs')
    h.fsCalls.length = 0
    fsMod.readFileSync('package.json', 'utf8')
    expect(h.fsCalls).toContain('fs.readFileSync')
    h.fsCalls.length = 0
  })

  it('the file-system counter sees a read through a default import too', async () => {
    const fsDefault = (await import('node:fs')).default
    h.fsCalls.length = 0
    fsDefault.readFileSync('package.json', 'utf8')
    expect(h.fsCalls).toContain('fs.default.readFileSync')
    h.fsCalls.length = 0
  })

  it('the spawn counter sees a process when one is started', async () => {
    // The proof above is only worth anything if the counter can fail.
    const cp = await import('node:child_process')
    const before = h.spawns
    cp.execFileSync('true')
    expect(h.spawns).toBe(before + 1)
    cp.default.execFileSync('true') // through the default export
    expect(h.spawns).toBe(before + 2)
  })
})
