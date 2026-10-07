import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * T445 — `list_cleanup` driven through the REAL wired handler.
 *
 * The GC service is replaced by a stub, so no docker or git command runs: this file pins
 * what the verb does with the snapshot the service hands back — redaction, scope, totals,
 * the blocked-folder refusal, and that it only ever reads.
 */

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => '/tmp',
    getAppPath: (): string => process.cwd()
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

const h = vi.hoisted(() => ({
  service: null as null | {
    snapshot: (opts?: { refresh?: boolean }) => Promise<unknown>
    release: (id: string, at: number) => Promise<void>
  },
  snapshotCalls: [] as Array<{ refresh?: boolean } | undefined>
}))

vi.mock('../src/main/gc/gc-service-registry', () => ({
  getGcService: () => h.service
}))

import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import type { FolderEntry } from '../src/main/folder-model'
import type { GcSnapshot } from '../src/main/gc/gc-wire'
import {
  MAIN,
  NOW,
  OTHER_MAIN,
  OTHER_WT,
  WT_CORPSE,
  WT_DIRTY,
  WT_OPEN,
  bundle,
  snapshot
} from './gc-snapshot-fixtures'

const handler = WIRED_TOOLS.find((t) => t.op === 'list_cleanup')!.handler!

function serve(snap: GcSnapshot): { release: ReturnType<typeof vi.fn> } {
  const release = vi.fn(async () => undefined)
  h.service = {
    snapshot: async (opts) => {
      h.snapshotCalls.push(opts)
      return snap
    },
    release
  }
  return { release }
}

function folderEntry(p: string, repoId: string): FolderEntry {
  return { path: p, alias: path.basename(p), repoId, sessions: [] } as unknown as FolderEntry
}

function ctx(denyFolders: string[] = [], folders: FolderEntry[] = [], folder = '') {
  return { folder, folders, denyFolders, bridge: undefined }
}

function textOf(res: CallToolResult): string {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  return first.text
}

type Listed = {
  id: string
  folderAlias: string
  branch: string | null
  bucket: string
  reason: string | null
  bytes: number | null
  released: boolean
  agentControllable: boolean
}

const corpse = bundle(WT_CORPSE, { item: { diskBytes: 5_000 } })
const dirty = bundle(WT_DIRTY, {
  bucket: 'decide',
  reason: { code: 'dirty', detail: '1 blocker: dirty.' },
  item: { diskBytes: 700, blockers: ['dirty'] }
})
const open = bundle(WT_OPEN, {
  bucket: 'alive',
  fate: { fate: 'open', signal: null, strong: false },
  item: { diskBytes: 40 }
})
const other = bundle(OTHER_WT, { item: { repoPath: OTHER_MAIN, diskBytes: 9_000 } })

const FOLDERS = [
  folderEntry(MAIN, 'www'),
  folderEntry(WT_CORPSE, 'www'),
  folderEntry(WT_DIRTY, 'www'),
  folderEntry(WT_OPEN, 'www'),
  folderEntry(OTHER_MAIN, 'gw'),
  folderEntry(OTHER_WT, 'gw')
]

beforeEach(() => {
  h.service = null
  h.snapshotCalls = []
})

describe('list_cleanup handler (T445)', () => {
  it('AC-1: lists every bundle with id, alias, branch, bucket, reason and bytes', async () => {
    serve(snapshot([corpse, dirty, open]))
    const res = await handler({}, ctx())
    expect(res.isError).toBeFalsy()
    const payload = JSON.parse(textOf(res))
    expect(payload).toMatchObject({ ok: true, scannedAt: NOW })
    const rows = payload.bundles as Listed[]
    expect(rows.map((r) => [r.folderAlias, r.bucket, r.reason, r.bytes])).toEqual([
      ['PROJ-231-wave-1', 'corpse', null, 5_000],
      ['PROJ-231-wave-2', 'decide', '1 blocker: dirty.', 700],
      ['PROJ-347-wave-3', 'alive', null, 40]
    ])
    expect(rows[0]).toMatchObject({ branch: 'feat/PROJ-231-wave-1', released: false })
    expect(typeof rows[0]!.id).toBe('string')
  })

  it('AC-1: redaction — no absolute path appears anywhere in the payload', async () => {
    const withVolume = snapshot([corpse, dirty, open], {
      orphanVolumes: [
        {
          id: 'volume:pgdata',
          name: 'pgdata',
          sizeBytes: 123,
          project: 'proj',
          reason: {
            code: 'no-known-worktree',
            detail: 'No known worktree uses the project "proj".'
          }
        }
      ]
    })
    serve(withVolume)
    const text = textOf(await handler({}, ctx()))
    expect(text).not.toContain(MAIN)
    expect(text).not.toContain('/home/dev')
    expect(text).not.toMatch(/\/\.claude\/worktrees\//)
  })

  it('AC-1: a detached worktree’s id and alias never carry the path either', async () => {
    const detached = bundle(`${MAIN}/.claude/worktrees/PROJ-9-detached`, {
      item: { kind: 'detached-worktree', branch: undefined }
    })
    serve(snapshot([detached]))
    const text = textOf(await handler({}, ctx()))
    expect(text).not.toContain('/home/dev')
    const row = JSON.parse(text).bundles[0] as Listed
    expect(row.branch).toBeNull()
    expect(row.folderAlias).toBe('PROJ-9-detached')
  })

  it('AC-1: lists orphan volumes and totals', async () => {
    serve(
      snapshot([corpse, dirty, open], {
        orphanVolumes: [
          {
            id: 'volume:pgdata',
            name: 'pgdata',
            sizeBytes: 123,
            project: 'proj',
            reason: { code: 'no-known-worktree', detail: 'No known worktree uses "proj".' }
          },
          {
            id: 'volume:redis',
            name: 'redis',
            sizeBytes: null,
            project: null,
            reason: { code: 'no-known-worktree', detail: 'No known worktree uses this volume.' }
          }
        ]
      })
    )
    const payload = JSON.parse(textOf(await handler({}, ctx())))
    expect(payload.orphanVolumes.map((v: { name: string }) => v.name)).toEqual(['pgdata', 'redis'])
    expect(payload.totals).toEqual({
      corpse: 1,
      corpseBytes: 5_000,
      decide: 1,
      decideBytes: 700,
      alive: 1,
      orphanVolumes: 2,
      orphanVolumeBytes: 123
    })
  })

  it('AC-1: reports the autopilot state and the next cycle', async () => {
    serve(
      snapshot([corpse], {
        prefs: { autopilot: true, firstReportAcknowledged: false, graceDays: 3 },
        nextCycleAt: NOW + 5_000
      })
    )
    const payload = JSON.parse(textOf(await handler({}, ctx())))
    expect(payload.autopilot).toEqual({ enabled: true, reportOnly: true, graceDays: 3 })
    expect(payload.nextCycleAt).toBe(NOW + 5_000)
  })

  it('AC-1: nextCycleAt is null when the background scan is off', async () => {
    serve(snapshot([corpse], { nextCycleAt: null }))
    expect(JSON.parse(textOf(await handler({}, ctx()))).nextCycleAt).toBeNull()
  })

  it('AC-1: folder scopes the listing, and the totals, to one repo and its worktrees', async () => {
    serve(snapshot([corpse, dirty, open, other]))
    const res = await handler({ folder: WT_DIRTY }, ctx([], FOLDERS, WT_DIRTY))
    const payload = JSON.parse(textOf(res))
    expect(payload.bundles.map((b: Listed) => b.folderAlias)).toEqual([
      'PROJ-231-wave-1',
      'PROJ-231-wave-2',
      'PROJ-347-wave-3'
    ])
    expect(payload.totals).toMatchObject({ corpse: 1, decide: 1, alive: 1, corpseBytes: 5_000 })
  })

  it('AC-1: a scoped listing leaves out the orphan volumes (they belong to no folder)', async () => {
    serve(
      snapshot([corpse], {
        orphanVolumes: [
          {
            id: 'volume:pgdata',
            name: 'pgdata',
            sizeBytes: 1,
            project: null,
            reason: { code: 'no-known-worktree', detail: 'No known worktree uses this volume.' }
          }
        ]
      })
    )
    const payload = JSON.parse(
      textOf(await handler({ folder: WT_CORPSE }, ctx([], FOLDERS, WT_CORPSE)))
    )
    expect(payload.orphanVolumes).toEqual([])
    expect(payload.totals.orphanVolumes).toBe(0)
  })

  it('AC-1: a blocked folder as the scope is refused FOLDER_NOT_ALLOWED', async () => {
    serve(snapshot([corpse]))
    const res = await handler({ folder: WT_CORPSE }, ctx([MAIN], FOLDERS, WT_CORPSE))
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('FOLDER_NOT_ALLOWED')
    expect(h.snapshotCalls).toHaveLength(0)
  })

  it('AC-1: unscoped, a blocked folder’s bundle still lists, marked agentControllable:false', async () => {
    serve(snapshot([corpse, other]))
    const rows = JSON.parse(textOf(await handler({}, ctx([MAIN])))).bundles as Listed[]
    expect(rows.map((r) => [r.folderAlias, r.agentControllable])).toEqual([
      ['PROJ-231-wave-1', false],
      ['PROJ-500-hotfix', true]
    ])
  })

  it('marks a bundle the agent already released', async () => {
    const snap = snapshot([corpse])
    snap.prefs.released = { [corpse.item.id]: NOW - 1000 }
    serve(snap)
    const rows = JSON.parse(textOf(await handler({}, ctx()))).bundles as Listed[]
    expect(rows[0]!.released).toBe(true)
  })

  it('AC-2: reads a fresh snapshot and never calls release', async () => {
    const { release } = serve(snapshot([corpse]))
    await handler({}, ctx())
    expect(h.snapshotCalls).toEqual([{ refresh: true }])
    expect(release).not.toHaveBeenCalled()
  })

  it('refuses GC_NOT_READY before the service is registered', async () => {
    const res = await handler({}, ctx())
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/^GC_NOT_READY/)
  })
})
