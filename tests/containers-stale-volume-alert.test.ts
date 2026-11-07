/**
 * U3.7 AC-4 — the stale-volume alert through the REAL `createContainersService`: after a scan where
 * a live compose project mounts a volume Harnu kept for a removed worktree, the service alerts
 * once, remembers it in userData (so a restart repeats nothing), and stays quiet when Docker is
 * unavailable. Mirrors the new-zombie alert's test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  type ContainersService
} from '../src/main/containers/containers-ipc'
import { appendTombstone, journalFile } from '../src/main/containers/containers-journal'
import { unavailableSnapshot } from '../src/main/containers/containers-core'
import { staleLedgerFile } from '../src/main/gc/stale-volume-shell'
import type { ScanRequest } from '../src/main/containers/containers-shell'
import type {
  ContainersSnapshot,
  StaleVolumesAlert,
  Tombstone
} from '../src/main/containers/containers-wire'
import { NOW, available, stackRow } from './containers-fixtures'

const REMOVED = '/home/dev/org/proj/www/.claude/worktrees/feat-old'

const removal: Tombstone = {
  at: NOW - 1000,
  actor: 'autopilot',
  verb: 'remove',
  stacks: [
    {
      stack: 'ext-12',
      name: 'ext-12',
      path: REMOVED,
      containerIds: ['c1'],
      freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 },
      keptVolumes: ['ext-12_mysql'],
      keptVolumeOwner: { reason: 'worktree-removed', project: 'ext-12', worktreePath: REMOVED }
    }
  ],
  restoreHint: null,
  reason: 'Removed orphan stack `ext-12` — worktree gone, volumes kept: ext-12_mysql'
}

const mounting = (): ContainersSnapshot =>
  available([
    stackRow({
      id: 'ext-12',
      verdict: 'active',
      volumes: [{ name: 'ext-12_mysql', sizeBytes: 1, shared: false }]
    })
  ])

let dir = ''
const services: ContainersService[] = []

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-containers-stale-'))
  await appendTombstone(journalFile(dir), removal)
})
afterEach(async () => {
  for (const s of services.splice(0)) s.stop()
  await fs.rm(dir, { recursive: true, force: true })
})

function service(scan: (req: ScanRequest) => Promise<ContainersSnapshot>): {
  svc: ContainersService
  alerts: StaleVolumesAlert[]
} {
  const alerts: StaleVolumesAlert[] = []
  const ok = vi.fn(async (list: string[]) => ({ done: list, error: null }))
  const svc = createContainersService({
    scan,
    docker: { stop: ok, start: ok, removeContainers: ok, removeVolumes: ok },
    userDataDir: dir,
    push: () => undefined,
    alertStaleVolumes: (a) => alerts.push(a),
    now: () => NOW
  })
  services.push(svc)
  return { svc, alerts }
}

describe('the stale-volume alert', () => {
  it('fires once, on the scan where a live project mounts a kept volume', async () => {
    const { svc, alerts } = service(async () => mounting())
    await svc.scan()
    expect(alerts).toEqual([
      { warnings: [{ volume: 'ext-12_mysql', project: 'ext-12', worktree: 'feat-old' }] }
    ])
    await svc.scan()
    await svc.scan()
    expect(alerts).toHaveLength(1)
  })

  it('never fires again after a restart (the ledger is in userData)', async () => {
    await service(async () => mounting()).svc.scan()
    const ledger = JSON.parse(await fs.readFile(staleLedgerFile(dir), 'utf8')) as { keys: string[] }
    expect(ledger.keys).toHaveLength(1)

    const after = service(async () => mounting())
    await after.svc.scan()
    expect(after.alerts).toEqual([])
  })

  it('says nothing while no live project mounts the volume', async () => {
    const { svc, alerts } = service(async () =>
      available([stackRow({ id: 'ext-12', verdict: 'active' })])
    )
    await svc.scan()
    expect(alerts).toEqual([])
  })

  it('treats docker being unavailable as an outage, not a finding', async () => {
    const { svc, alerts } = service(async () => unavailableSnapshot('no daemon', NOW, 2, []))
    await svc.scan()
    expect(alerts).toEqual([])
  })
})
