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

const GH_MS = 5000

const h = vi.hoisted(() => ({ userDataDir: '', ghCalls: 0 }))

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
    if (file === 'gh') {
      h.ghCalls++
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
  return { ...real, execFile }
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
    // A fresh process: empty PR cache, but the sidecar remembers what resolved.
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
