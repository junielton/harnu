/**
 * Mission v3 S2 (§3.8, AC-8) — the read-latency benchmark, over 9 open fixture missions with a `gh` that
 * takes 5 s, through the REAL path: only `gh` itself is stubbed (at the `execFile` seam, like
 * tests/pr-stack-mission-join.test.ts); `git` runs for real.
 *
 * Smoke S-4 measured 3.5–11 s per mission derive, run one after another (≈ 46 s a pass), and up to ~90 s
 * before the close dialog dismissed.
 *
 * Missions v4 S-40: the v3 poll that derived every mission (`listMissionViews` → `deriveMissionSignals` →
 * `findPrsForWorktrees`) and the v3 operator doors are gone. What the targets bound now: the poll answers
 * no view and starts no `gh` (≤ 1 s, cold or warm, so the 5 s `gh` cannot reach it); the Mission pane's
 * view waits for GitHub no longer than its bound (≈ 1.5 s) and then reads each step's last-known state;
 * and one observer pass costs one `gh` call per repo, however many missions the repo holds.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildMissionRecordContent, type MissionV4, type StepV4 } from '../src/main/missions/model'
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
      else {
        // Anything else (a merge commit's workflow runs) answers at once: the claim is about the list.
        setTimeout(() => cb(null, { stdout: '[]', stderr: '' }), 5)
        return
      }
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

function fixture(id: string, n: number, status: 'open' | 'closed' = 'open'): MissionV4 {
  const ac = { id: 'ac-1', text: 'The pull request is merged', by: 'fact', fact: 'pr-merged' }
  return {
    schemaVersion: 4,
    id,
    title: `Bench ${n}`,
    doneWhen: 'A pull request is merged',
    status,
    ...(status === 'closed' ? { closedAs: 'delivered' } : {}),
    milestones: [],
    steps: [
      { id: 'stp-1', title: 'Step 1', acs: [ac], links: [{ kind: 'pr', ref: '8' }], blockers: [] },
      {
        id: 'stp-2',
        title: 'Step 2',
        acs: [ac],
        links: [
          { kind: 'pr', ref: String(7 + (n % 3)) },
          { kind: 'doc', ref: 'spec.md' }
        ],
        blockers: []
      }
    ],
    sessions: [{ id: OWNER, role: 'leads', from: '2026-10-01T10:00:00Z', to: null }],
    links: [],
    blockers: []
  } as unknown as MissionV4
}

async function writeRecord(root: string, rec: MissionV4): Promise<void> {
  const dir = path.join(root, '.harnu', 'missions-v4')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, `${rec.id}-bench.md`),
    buildMissionRecordContent(rec, `# ${rec.title}\n`)
  )
}

const roots: string[] = []
let ipc: typeof import('../src/main/mission-ipc')

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-bench-ud-'))
  // 9 open missions across 3 repos (plus a closed one that must not cost a read).
  for (let r = 0; r < 3; r++) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `harnu-bench-${r}-`))
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    await fs.writeFile(path.join(root, 'spec.md'), '# spec')
    roots.push(root)
  }
  for (let n = 1; n <= 9; n++) {
    const root = roots[n % 3]
    await writeRecord(root, fixture(`mnt-0000b00${n}`, n))
  }
  await writeRecord(roots[0], fixture('mnt-0000b0ff', 0, 'closed'))
  ipc = await import('../src/main/mission-ipc')
})

describe('mission read latency (Mission v3 §3.8, AC-8; Missions v4 S-40)', () => {
  it(`the poll: 9 missions with a ${GH_MS / 1000} s gh answer in ≤ 1 s and start no gh`, async () => {
    const t0 = Date.now()
    const { views, unreadable } = await ipc.listMissionViews(roots)
    const cold = Date.now() - t0
    console.info(`[bench] mission:list: ${cold} ms (gh ${h.ghCalls}×)`)
    expect(views).toEqual([])
    expect(unreadable).toEqual([])
    expect(cold).toBeLessThanOrEqual(1000)
    expect(h.ghCalls).toBe(0)
  }, 30_000)

  it('the one-line rows (mission_list) cost no gh either: 3 repos, 9 open missions', async () => {
    const { missionList } = await import('../src/main/missions/verbs-read')
    const t0 = Date.now()
    const rows = (
      await Promise.all(roots.map((r) => missionList(r, { kind: 'operator' })))
    ).flatMap((l) => (l.ok ? l.missions : []))
    const ms = Date.now() - t0
    console.info(`[bench] mission_list rows: ${ms} ms`)
    expect(rows).toHaveLength(9)
    expect(ms).toBeLessThanOrEqual(1000)
    expect(h.ghCalls).toBe(0)
  })

  it('the pane view returns within its bound on a COLD cache: no step waits out the 5 s gh', async () => {
    const t0 = Date.now()
    const reply = await ipc.buildMissionV4View({
      folder: roots[1],
      sessionId: OWNER,
      missionId: 'mnt-0000b001'
    })
    const ms = Date.now() - t0
    console.info(`[bench] pane view, cold PR cache: ${ms} ms`)
    expect(reply.state).toBe('mission')
    // The view waits 1.5 s for GitHub at most; the 5 s gh is still running when it answers.
    expect(ms).toBeLessThanOrEqual(3000)
    expect(ms).toBeLessThan(GH_MS)
  })

  it('one observer pass costs one gh call per repo, and the next view reads the last-known state within its bound', async () => {
    const before = h.ghCalls
    const t0 = Date.now()
    // Three open missions of one repo: one `pr list`, shared (single-flight).
    expect(await ipc.observeOpenMissions([roots[2]])).toBe(3)
    const passMs = Date.now() - t0
    console.info(`[bench] observer pass, one repo: ${passMs} ms (gh ${h.ghCalls - before}×)`)
    expect(h.ghCalls - before).toBe(1)
    expect(passMs).toBeLessThanOrEqual(GH_MS + 4000) // one 5 s list, not one per mission

    // A fresh process: empty PR cache, but the sidecar remembers what the pass resolved.
    const { flushLinkCache } = await import('../src/main/mission-link-cache')
    await flushLinkCache()
    vi.resetModules()
    const fresh = await import('../src/main/mission-ipc')
    const t1 = Date.now()
    const reply = await fresh.buildMissionV4View({
      folder: roots[2],
      sessionId: OWNER,
      missionId: 'mnt-0000b002'
    })
    const ms = Date.now() - t1
    console.info(`[bench] pane view, last-known cache: ${ms} ms`)
    expect(ms).toBeLessThanOrEqual(3000)
    if (reply.state !== 'mission') throw new Error(JSON.stringify(reply))
    // #8 was seen merged: the step reads that, not "unknown", though the gh is still slow.
    expect(reply.stepFacts?.['stp-1']).toMatchObject({ pr: 'merged' })
  }, 30_000)
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
