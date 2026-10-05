/**
 * T332 — the new-zombie alert and the zombie threshold (PRD T320 §3.3, §6).
 * The diff is pure; the service tests drive the REAL `createContainersService`
 * over a scripted scan, with userData in a throwaway temp dir so "once per
 * stack" is also checked across a restart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: (): string => '' },
  ipcMain: { handle: (): void => undefined }
}))

vi.mock('../src/main/containers/containers-shell', () => ({
  scanContainers: vi.fn(),
  dockerActions: {}
}))

import {
  createContainersService,
  diffNewZombies,
  notifiedFile,
  type ContainersService
} from '../src/main/containers/containers-ipc'
import { buildSnapshot, unavailableSnapshot } from '../src/main/containers/containers-core'
import { defaultPrefs } from '../src/main/containers/containers-prefs'
import type { ScanRequest } from '../src/main/containers/containers-shell'
import type {
  ContainersSnapshot,
  NewZombiesAlert,
  StackRow,
  Verdict
} from '../src/main/containers/containers-wire'
import {
  DAY,
  NOW,
  WT,
  available,
  composeContainer,
  scanInput,
  stackRow
} from './containers-fixtures'

const zombie = (id: string): StackRow => stackRow({ id, verdict: 'zombie' })
const pending = (id: string): StackRow =>
  stackRow({ id, verdict: 'pending', unusedForMs: DAY, zombieInMs: DAY })
const ids = (rows: StackRow[]): string[] => rows.map((s) => s.id)

describe('diffNewZombies', () => {
  it('first scan: every zombie is new, nothing else is', () => {
    const { fresh, seen } = diffNewZombies(new Set(), [zombie('a'), pending('b'), zombie('c')])
    expect(ids(fresh)).toEqual(['a', 'c'])
    expect([...seen].sort()).toEqual(['a', 'c'])
  })

  it('repeat scan: a zombie already seen is not new', () => {
    const first = diffNewZombies(new Set(), [zombie('a')])
    expect(ids(diffNewZombies(first.seen, [zombie('a')]).fresh)).toEqual([])
    expect(ids(diffNewZombies(first.seen, [zombie('a'), zombie('b')]).fresh)).toEqual(['b'])
  })

  it('a stack that leaves zombie and comes back is not new', () => {
    const first = diffNewZombies(new Set(), [zombie('a')])
    const left = diffNewZombies(first.seen, [pending('a')])
    expect(left.fresh).toEqual([])
    expect([...left.seen]).toEqual(['a'])
    expect(diffNewZombies(left.seen, [zombie('a')]).fresh).toEqual([])
  })

  it('a stack that disappears from docker is forgotten, so a recreated one is new', () => {
    const gone = diffNewZombies(new Set(['a']), [])
    expect(gone.seen.size).toBe(0)
    expect(ids(diffNewZombies(gone.seen, [zombie('a')]).fresh)).toEqual(['a'])
  })
})

let dir = ''
const services: ContainersService[] = []

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-containers-zombies-'))
})

afterEach(async () => {
  for (const s of services.splice(0)) s.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

function noopDocker(): Parameters<typeof createContainersService>[0]['docker'] {
  const ok = vi.fn(async (list: string[]) => ({ done: list, error: null }))
  return { stop: ok, start: ok, removeContainers: ok, removeVolumes: ok }
}

/** A service whose scans return `scans` in order (the last one repeats). */
function service(scan: (req: ScanRequest) => Promise<ContainersSnapshot>): {
  svc: ContainersService
  alerts: NewZombiesAlert[]
  pushes: ContainersSnapshot[]
} {
  const alerts: NewZombiesAlert[] = []
  const pushes: ContainersSnapshot[] = []
  const svc = createContainersService({
    scan,
    docker: noopDocker(),
    userDataDir: dir,
    push: (s) => pushes.push(s),
    alert: (a) => alerts.push(a),
    now: () => NOW
  })
  services.push(svc)
  return { svc, alerts, pushes }
}

function scripted(...scans: ContainersSnapshot[]): () => Promise<ContainersSnapshot> {
  let i = 0
  return async () => scans[Math.min(i++, scans.length - 1)]!
}

describe('the new-zombie alert (PRD §6)', () => {
  it('fires once, on the scan where a stack first becomes a zombie', async () => {
    const { svc, alerts } = service(
      scripted(available([pending('a'), pending('b')]), available([zombie('a'), pending('b')]))
    )
    await svc.scan()
    expect(alerts).toEqual([])
    await svc.scan()
    expect(alerts).toEqual([{ count: 1, names: ['a'] }])
    await svc.scan()
    await svc.scan()
    expect(alerts).toHaveLength(1)
  })

  it('announces the zombies a first scan finds in one alert', async () => {
    const { svc, alerts } = service(scripted(available([zombie('a'), pending('b'), zombie('c')])))
    await svc.scan()
    expect(alerts).toEqual([{ count: 2, names: ['a', 'c'] }])
  })

  it('never fires again for the same stack after a restart', async () => {
    const snap = available([zombie('a')])
    const before = service(scripted(snap))
    await before.svc.scan()
    expect(before.alerts).toHaveLength(1)
    const onDisk = JSON.parse(await fs.readFile(notifiedFile(dir), 'utf8'))
    expect(onDisk).toEqual({ version: 1, stacks: ['a'] })

    const after = service(scripted(snap))
    await after.svc.scan()
    expect(after.alerts).toEqual([])
  })

  it('stays quiet while the pref is off, and does not replay when it is switched on', async () => {
    const { svc, alerts } = service(
      scripted(
        available([zombie('a')]),
        available([zombie('a')]),
        available([zombie('a'), zombie('b')])
      )
    )
    await svc.setPrefs({ ...defaultPrefs(), notifyOnNewZombies: false })
    await svc.scan()
    expect(alerts).toEqual([])
    await svc.setPrefs({ ...defaultPrefs(), notifyOnNewZombies: true })
    await svc.scan()
    expect(alerts).toEqual([])
    await svc.scan()
    expect(alerts).toEqual([{ count: 1, names: ['b'] }])
  })

  it('does not fire again when a stack leaves zombie and re-enters it', async () => {
    const { svc, alerts } = service(
      scripted(available([zombie('a')]), available([pending('a')]), available([zombie('a')]))
    )
    await svc.scan()
    await svc.scan()
    await svc.scan()
    expect(alerts).toEqual([{ count: 1, names: ['a'] }])
  })

  it('treats docker going away as an outage, not as every stack leaving', async () => {
    const { svc, alerts } = service(
      scripted(
        available([zombie('a')]),
        unavailableSnapshot('Cannot connect to the Docker daemon', NOW, 2, []),
        available([zombie('a')])
      )
    )
    await svc.scan()
    await svc.scan()
    await svc.scan()
    expect(alerts).toHaveLength(1)
  })
})

describe('the zombie threshold (PRD §3.3, §6)', () => {
  const verdictOf = (s: ContainersSnapshot | undefined): Verdict | null =>
    s?.dockerAvailable ? (s.stacks[0]?.verdict ?? null) : null

  it('a stack unused for 3 days flips zombie → pending when the threshold goes to 4', async () => {
    // The real classifier: a compose stack in a linked worktree, last started 3 days ago.
    const ctr = composeContainer('proj-wave-1', WT, {
      startedAt: NOW - 3 * DAY,
      createdAt: NOW - 3 * DAY
    })
    const { svc, alerts, pushes } = service(async (req) =>
      buildSnapshot(
        scanInput({ containers: [ctr], zombieAfterDays: req.zombieAfterDays, now: req.now })
      )
    )

    expect(verdictOf(await svc.scan())).toBe('zombie')

    await svc.setPrefs({ ...defaultPrefs(), zombieAfterDays: 4 })
    await vi.waitFor(() => expect(pushes).toHaveLength(2))
    expect(verdictOf(pushes[1])).toBe('pending')
    expect(pushes[1]!.dockerAvailable && pushes[1]!.stacks[0]!.zombieInMs).toBe(DAY)

    // Lowering it back re-sorts again — and the stack is not announced twice.
    await svc.setPrefs({ ...defaultPrefs(), zombieAfterDays: 2 })
    await vi.waitFor(() => expect(pushes).toHaveLength(3))
    expect(verdictOf(pushes[2])).toBe('zombie')
    expect(alerts).toEqual([{ count: 1, names: ['proj-wave-1'] }])
  })
})
