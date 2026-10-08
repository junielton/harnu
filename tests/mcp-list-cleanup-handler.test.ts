import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'node:os'
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
  WT_READY,
  WT_DIRTY,
  WT_OPEN,
  WT_OUT_OF_TREE,
  WT_OUT_OF_TREE,
  absolutePathsIn,
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

/** The fixed, path-free sentence list_cleanup gives a `dirty` review reason. */
const DIRTY_SENTENCE = 'The working tree has uncommitted changes, or could not be verified clean.'

type Listed = {
  id: string
  folderAlias: string
  branch: string | null
  bucket: string
  reason: string | null
  reasonCode: string | null
  bytes: number | null
  released: boolean
  agentControllable: boolean
}

const ready = bundle(WT_READY, { item: { diskBytes: 5_000 } })
const dirty = bundle(WT_DIRTY, {
  bucket: 'review',
  reason: { code: 'dirty', detail: '1 blocker: dirty.' },
  item: { diskBytes: 700, blockers: ['dirty'] }
})
const open = bundle(WT_OPEN, {
  bucket: 'in-use',
  fate: { fate: 'open', signal: null, strong: false },
  item: { diskBytes: 40 }
})
const other = bundle(OTHER_WT, { item: { repoPath: OTHER_MAIN, diskBytes: 9_000 } })

const FOLDERS = [
  folderEntry(MAIN, 'www'),
  folderEntry(WT_READY, 'www'),
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
    serve(snapshot([ready, dirty, open]))
    const res = await handler({}, ctx())
    expect(res.isError).toBeFalsy()
    const payload = JSON.parse(textOf(res))
    expect(payload).toMatchObject({ ok: true, scannedAt: NOW })
    const rows = payload.bundles as Listed[]
    expect(rows.map((r) => [r.folderAlias, r.bucket, r.reason, r.bytes])).toEqual([
      ['PROJ-231-wave-1', 'ready', null, 5_000],
      ['PROJ-231-wave-2', 'review', DIRTY_SENTENCE, 700],
      ['PROJ-347-wave-3', 'in-use', null, 40]
    ])
    expect(rows[0]).toMatchObject({ branch: 'feat/PROJ-231-wave-1', released: false })
    expect(typeof rows[0]!.id).toBe('string')
  })

  it('AC-1: redaction — no absolute path appears anywhere in the payload', async () => {
    const withVolume = snapshot([ready, dirty, open], {
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
    expect(absolutePathsIn(text)).toEqual([])
    expect(text).not.toContain('/srv/ws')
    expect(text).not.toMatch(/\/\.claude\/worktrees\//)
  })

  it('AC-1: a detached worktree’s id and alias never carry the path either', async () => {
    const detached = bundle(`${MAIN}/.claude/worktrees/PROJ-9-detached`, {
      item: { kind: 'detached-worktree', branch: undefined }
    })
    serve(snapshot([detached]))
    const text = textOf(await handler({}, ctx()))
    expect(absolutePathsIn(text)).toEqual([])
    expect(text).not.toContain('/srv/ws')
    const row = JSON.parse(text).bundles[0] as Listed
    expect(row.branch).toBeNull()
    expect(row.folderAlias).toBe('PROJ-9-detached')
  })

  it('AC-1: lists orphan volumes and totals', async () => {
    serve(
      snapshot([ready, dirty, open], {
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
      ready: 1,
      readyBytes: 5_000,
      review: 1,
      reviewBytes: 700,
      inUse: 1,
      orphanVolumes: 2,
      orphanVolumeBytes: 123
    })
  })

  it('M11: the totals count each bucket on its own (in-use never counts review)', async () => {
    const inUse2 = bundle(`${MAIN}/.claude/worktrees/PROJ-8-b`, {
      bucket: 'in-use',
      item: { diskBytes: 3 }
    })
    const inUse3 = bundle(`${MAIN}/.claude/worktrees/PROJ-9-c`, {
      bucket: 'in-use',
      item: { diskBytes: 4 }
    })
    const review2 = bundle(`${MAIN}/.claude/worktrees/PROJ-10-d`, {
      bucket: 'review',
      reason: { code: 'unpushed', detail: 'x' },
      item: { diskBytes: 20 }
    })
    serve(snapshot([ready, dirty, open, inUse2, inUse3, review2]))
    const t = JSON.parse(textOf(await handler({}, ctx()))).totals
    expect(t).toMatchObject({
      ready: 1,
      readyBytes: 5_000,
      review: 2,
      reviewBytes: 720,
      inUse: 3
    })
  })

  it('AC-1: reports the autopilot state and the next cycle', async () => {
    serve(
      snapshot([ready], {
        prefs: { autopilot: true, firstReportAcknowledged: false, graceDays: 3 },
        nextCycleAt: NOW + 5_000
      })
    )
    const payload = JSON.parse(textOf(await handler({}, ctx())))
    expect(payload.autopilot).toEqual({ enabled: true, reportOnly: true, graceDays: 3 })
    expect(payload.nextCycleAt).toBe(NOW + 5_000)
  })

  it('AC-1: nextCycleAt is null when the background scan is off', async () => {
    serve(snapshot([ready], { nextCycleAt: null }))
    expect(JSON.parse(textOf(await handler({}, ctx()))).nextCycleAt).toBeNull()
  })

  it('AC-1: folder scopes the listing, and the totals, to one repo and its worktrees', async () => {
    serve(snapshot([ready, dirty, open, other]))
    const res = await handler({ folder: WT_DIRTY }, ctx([], FOLDERS, WT_DIRTY))
    const payload = JSON.parse(textOf(res))
    expect(payload.bundles.map((b: Listed) => b.folderAlias)).toEqual([
      'PROJ-231-wave-1',
      'PROJ-231-wave-2',
      'PROJ-347-wave-3'
    ])
    expect(payload.totals).toMatchObject({ ready: 1, review: 1, inUse: 1, readyBytes: 5_000 })
  })

  it('AC-1: scope follows the bundle’s repo, so an out-of-tree worktree absent from the folder list is included', async () => {
    const outOfTree = bundle(WT_OUT_OF_TREE, { item: { diskBytes: 11 } })
    serve(snapshot([ready, outOfTree, other]))
    for (const scope of [MAIN, WT_READY]) {
      const payload = JSON.parse(textOf(await handler({ folder: scope }, ctx([], FOLDERS, scope))))
      expect(payload.bundles.map((b: Listed) => b.folderAlias)).toEqual([
        'PROJ-231-wave-1',
        'PROJ-231-oot'
      ])
      expect(payload.totals).toMatchObject({ ready: 2, readyBytes: 5_011 })
    }
  })

  it('AC-1: scoping to an out-of-tree worktree finds its repo too', async () => {
    serve(snapshot([ready, bundle(WT_OUT_OF_TREE), other]))
    const payload = JSON.parse(
      textOf(await handler({ folder: WT_OUT_OF_TREE }, ctx([], FOLDERS, WT_OUT_OF_TREE)))
    )
    expect(payload.bundles.map((b: Listed) => b.folderAlias)).toEqual([
      'PROJ-231-wave-1',
      'PROJ-231-oot'
    ])
  })

  it('AC-1: a scope that matches no repo lists nothing', async () => {
    serve(snapshot([ready, other]))
    const payload = JSON.parse(
      textOf(await handler({ folder: '/srv/ws/nowhere' }, ctx([], FOLDERS, '/srv/ws/nowhere')))
    )
    expect(payload.bundles).toEqual([])
  })

  it('D6: two repos sharing a basename and a branch get different ids, with no path in them', async () => {
    const a = bundle('/srv/ws/a/www/.claude/worktrees/PROJ-1-x', {
      item: { repoPath: '/srv/ws/a/www', branch: 'feat/x' }
    })
    const b = bundle('/srv/ws/b/www/.claude/worktrees/PROJ-1-x', {
      item: { repoPath: '/srv/ws/b/www', branch: 'feat/x' }
    })
    serve(snapshot([a, b]))
    const text = textOf(await handler({}, ctx()))
    const ids = (JSON.parse(text).bundles as Listed[]).map((r) => r.id)
    expect(new Set(ids).size).toBe(2)
    expect(absolutePathsIn(text)).toEqual([])
  })

  it('D6: the id of a bundle is stable between calls', async () => {
    serve(snapshot([ready]))
    const first = (JSON.parse(textOf(await handler({}, ctx()))).bundles as Listed[])[0]!.id
    const second = (JSON.parse(textOf(await handler({}, ctx()))).bundles as Listed[])[0]!.id
    expect(second).toBe(first)
  })

  it('AC-1: a scoped listing leaves out the orphan volumes (they belong to no folder)', async () => {
    serve(
      snapshot([ready], {
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
      textOf(await handler({ folder: WT_READY }, ctx([], FOLDERS, WT_READY)))
    )
    expect(payload.orphanVolumes).toEqual([])
    expect(payload.totals.orphanVolumes).toBe(0)
  })

  it('AC-1: a blocked folder as the scope is refused FOLDER_NOT_ALLOWED', async () => {
    serve(snapshot([ready]))
    const res = await handler({ folder: WT_READY }, ctx([MAIN], FOLDERS, WT_READY))
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('FOLDER_NOT_ALLOWED')
    expect(h.snapshotCalls).toHaveLength(0)
  })

  it('AC-1: unscoped, a blocked folder’s bundle still lists, marked agentControllable:false', async () => {
    serve(snapshot([ready, other]))
    const rows = JSON.parse(textOf(await handler({}, ctx([MAIN])))).bundles as Listed[]
    expect(rows.map((r) => [r.folderAlias, r.agentControllable])).toEqual([
      ['PROJ-231-wave-1', false],
      ['PROJ-500-hotfix', true]
    ])
  })

  it('M5/M10: agentControllable looks at the worktree folder and at its repo, each on its own', async () => {
    const oot = bundle(WT_OUT_OF_TREE)
    serve(snapshot([oot]))
    const rows = async (deny: string[]): Promise<boolean[]> =>
      (JSON.parse(textOf(await handler({}, ctx(deny)))).bundles as Listed[]).map(
        (r) => r.agentControllable
      )
    expect(await rows([])).toEqual([true])
    // Only the repo is blocked: the worktree sits outside its tree.
    expect(await rows([MAIN])).toEqual([false])
    // Only the worktree folder is blocked.
    expect(await rows([WT_OUT_OF_TREE])).toEqual([false])
  })

  it('M5: a blocked scope is refused even when no bundle sits under it', async () => {
    serve(snapshot([ready]))
    const res = await handler({ folder: '/srv/ws/blocked' }, ctx(['/srv/ws/blocked'], FOLDERS))
    expect(textOf(res)).toContain('FOLDER_NOT_ALLOWED')
  })

  it('marks a bundle the agent already released', async () => {
    const snap = snapshot([ready])
    snap.prefs.released = { [ready.item.id]: NOW - 1000 }
    snap.prefs.releasedFrom = {
      [ready.item.id]: { repoPath: MAIN, path: WT_READY, localTip: 'a'.repeat(40) }
    }
    serve(snap)
    const rows = JSON.parse(textOf(await handler({}, ctx()))).bundles as Listed[]
    expect(rows[0]!.released).toBe(true)
  })

  it('a mark made at another tip, or with no tip, does not read as released', async () => {
    const old = snapshot([ready])
    old.prefs.released = { [ready.item.id]: NOW - 1000 }
    old.prefs.releasedFrom = {
      [ready.item.id]: { repoPath: MAIN, path: WT_READY, localTip: 'b'.repeat(40) }
    }
    serve(old)
    expect((JSON.parse(textOf(await handler({}, ctx()))).bundles as Listed[])[0]!.released).toBe(
      false
    )
    const legacy = snapshot([ready])
    legacy.prefs.released = { [ready.item.id]: NOW - 1000 }
    serve(legacy)
    expect((JSON.parse(textOf(await handler({}, ctx()))).bundles as Listed[])[0]!.released).toBe(
      false
    )
  })

  it('AC-2: reads the current snapshot, asks for no refresh, and never calls release', async () => {
    const { release } = serve(snapshot([ready]))
    await handler({}, ctx())
    expect(h.snapshotCalls).toHaveLength(1)
    expect(h.snapshotCalls[0]?.refresh).toBeFalsy()
    expect(release).not.toHaveBeenCalled()
  })

  it('refuses GC_NOT_READY before the service is registered', async () => {
    const res = await handler({}, ctx())
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/^GC_NOT_READY/)
  })

  describe('D2-1: no absolute path ever reaches the payload (T445 delta 2)', () => {
    const HOME_REPO = path.join(os.homedir(), 'work', 'org', 'proj', 'www')
    const HOME_WT = `${HOME_REPO}/.claude/worktrees/PROJ-9-home`
    const GIT_ERROR = (p: string): string =>
      `Cleanup stopped at stack: fatal: '${p}' contains modified or untracked files, use --force to delete it`

    function halted(wt: string, repo: string, detail: string) {
      return bundle(wt, {
        bucket: 'review',
        reason: { code: 'cleanup-failed', detail },
        item: { repoPath: repo }
      })
    }

    const outside = halted(WT_READY, MAIN, GIT_ERROR(WT_READY))
    const inside = halted(HOME_WT, HOME_REPO, GIT_ERROR(HOME_WT))
    const windows = halted(
      '/srv/ws/win/PROJ-7-win',
      '/srv/ws/win',
      "Cleanup stopped at deps: error: unable to unlink 'C:\\Users\\dev\\proj\\node_modules\\x' and \\\\fileserver\\share\\proj\\y"
    )

    function leaksIn(text: string): string[] {
      return [
        ...absolutePathsIn(text),
        ...(text.match(/[A-Za-z]:\\\\/g) ?? []),
        ...(text.match(/\\\\\\\\[\w.-]+\\\\/g) ?? []),
        ...(text.includes('/srv/ws') ? ['/srv/ws'] : []),
        ...(text.includes(os.homedir()) ? [os.homedir()] : [])
      ]
    }

    it('a halted bundle’s raw git error is replaced by "Cleanup stopped at <step>", with the code', async () => {
      serve(snapshot([outside]))
      const text = textOf(await handler({}, ctx()))
      const row = JSON.parse(text).bundles[0] as Listed
      expect(row.reasonCode).toBe('cleanup-failed')
      expect(row.reason).toBe('Cleanup stopped at stack.')
      expect(leaksIn(text)).toEqual([])
    })

    it('fixtures outside and inside $HOME, posix and windows, all come out path-free', async () => {
      serve(snapshot([outside, inside, windows]))
      const text = textOf(await handler({}, ctx()))
      expect(leaksIn(text)).toEqual([])
      const rows = JSON.parse(text).bundles as Listed[]
      expect(rows.map((r) => r.reasonCode)).toEqual([
        'cleanup-failed',
        'cleanup-failed',
        'cleanup-failed'
      ])
      expect(rows.map((r) => r.reason)).toEqual([
        'Cleanup stopped at stack.',
        'Cleanup stopped at stack.',
        'Cleanup stopped at deps.'
      ])
    })

    it('every review code reads as its own fixed sentence, never the raw detail', async () => {
      const codes = [
        'dirty',
        'unpushed',
        'open-idle-session',
        'closed-unmerged',
        'remote-gone',
        'detached',
        'unknown-fate',
        'weak-merge-signal',
        'shared-stack',
        'path-unresolved',
        'nested-worktree'
      ] as const
      const bundles = codes.map((code, i) =>
        bundle(`${MAIN}/.claude/worktrees/PROJ-${i}-c`, {
          bucket: 'review',
          reason: { code, detail: `raw detail naming ${MAIN}/secret/${code}` }
        })
      )
      serve(snapshot(bundles))
      const text = textOf(await handler({}, ctx()))
      expect(leaksIn(text)).toEqual([])
      const rows = JSON.parse(text).bundles as Listed[]
      expect(rows.map((r) => r.reasonCode)).toEqual([...codes])
      for (const r of rows) {
        expect(r.reason).toEqual(expect.any(String))
        expect(r.reason).not.toContain('raw detail')
      }
      expect(new Set(rows.map((r) => r.reason)).size).toBe(codes.length)
    })

    it('nested-worktree has its own sentence, not the generic one, and names no path', async () => {
      const nested = bundle(WT_READY, {
        bucket: 'review',
        reason: {
          code: 'nested-worktree',
          detail: `1 other worktree lives inside this one: ${MAIN}/.claude/worktrees/inner.`
        }
      })
      serve(snapshot([nested]))
      const text = textOf(await handler({}, ctx()))
      expect(leaksIn(text)).toEqual([])
      const row = (JSON.parse(text).bundles as Listed[])[0]!
      expect(row.reasonCode).toBe('nested-worktree')
      expect(row.reason).toMatch(/worktree/i)
      expect(row.reason).not.toBe('This worktree needs your review.')
    })

    it('an unknown review code still gets a generic, path-free sentence', async () => {
      const odd = bundle(WT_READY, {
        bucket: 'review',
        reason: { code: 'brand-new-code' as never, detail: `see ${MAIN}/x` }
      })
      serve(snapshot([odd]))
      const text = textOf(await handler({}, ctx()))
      expect(leaksIn(text)).toEqual([])
      expect((JSON.parse(text).bundles as Listed[])[0]!.reason).toEqual(expect.any(String))
    })

    it('M9: a path in a bundle’s branch or alias is stripped to its basename', async () => {
      const odd = bundle(`${MAIN}/.claude/worktrees/PROJ-1-b`, {
        item: { branch: '/srv/ws/leak/branch-name' }
      })
      serve(snapshot([odd]))
      const text = textOf(await handler({}, ctx()))
      expect(leaksIn(text)).toEqual([])
      expect((JSON.parse(text).bundles as Listed[])[0]!.branch).toBe('branch-name')
    })

    it('M10: orphan volume name, project, id and reason are scrubbed too', async () => {
      serve(
        snapshot([ready], {
          orphanVolumes: [
            {
              id: 'volume:/srv/ws/leak/vol',
              name: '/srv/ws/leak/vol',
              sizeBytes: 5,
              project: `${os.homedir()}/work/proj`,
              reason: {
                code: 'no-known-worktree',
                detail: `No known worktree uses "/srv/ws/leak/proj" nor C:\\Users\\dev\\proj.`
              }
            }
          ]
        })
      )
      const text = textOf(await handler({}, ctx()))
      expect(leaksIn(text)).toEqual([])
      const v = JSON.parse(text).orphanVolumes[0]
      expect(v.name).toBe('vol')
      expect(v.project).toBe('proj')
    })

    it('the id and folderAlias of a bundle never carry a path', async () => {
      serve(snapshot([outside, inside]))
      const text = textOf(await handler({}, ctx()))
      expect(leaksIn(text)).toEqual([])
    })
  })
})
