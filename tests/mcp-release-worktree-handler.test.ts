import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as path from 'node:path'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/**
 * T445 — `release_worktree` driven through the REAL wired handler.
 *
 * The GC service is a stub. This file pins the refusals (and that a refusal records
 * nothing), the ACK, and that release deletes nothing: the service the handler can reach
 * has no clean method at all.
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
  service: null as null | Record<string, unknown>
}))

vi.mock('../src/main/gc/gc-service-registry', () => ({
  getGcService: () => h.service
}))

import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'
import { listedId } from '../src/main/mcp/cleanup-listing'
import type { FolderEntry } from '../src/main/folder-model'
import type { GcSnapshot } from '../src/main/gc/gc-wire'
import {
  MAIN,
  NOW,
  WT_CORPSE,
  WT_DIRTY,
  WT_OPEN,
  WT_OUT_OF_TREE,
  WT_WEAK,
  absolutePathsIn,
  bundle,
  snapshot
} from './gc-snapshot-fixtures'

const handler = WIRED_TOOLS.find((t) => t.op === 'release_worktree')!.handler!

function serve(snap: GcSnapshot): { release: ReturnType<typeof vi.fn> } {
  const release = vi.fn(async () => undefined)
  h.service = { snapshot: async () => snap, release }
  return { release }
}

function folderEntry(p: string, over: Record<string, unknown> = {}): FolderEntry {
  return {
    path: p,
    alias: path.basename(p),
    repoId: 'www',
    sessions: [],
    ...over
  } as unknown as FolderEntry
}

function ctx(folder: string, denyFolders: string[] = [], folders: FolderEntry[] = []) {
  return { folder, folders, denyFolders, bridge: undefined }
}

function textOf(res: CallToolResult): string {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected text content')
  return first.text
}

// A merged, strong, clean worktree still inside its grace window: "alive" until released.
const fresh = bundle(WT_CORPSE, { bucket: 'alive', lastSignOfLifeAt: NOW - 3_600_000 })

beforeEach(() => {
  h.service = null
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

describe('release_worktree handler (T445)', () => {
  it('AC-3: records the release and says the bundle is a corpse from the next cycle', async () => {
    const { release } = serve(snapshot([fresh]))
    const res = await handler({ folder: WT_CORPSE }, ctx(WT_CORPSE))
    expect(res.isError).toBeFalsy()
    const ack = JSON.parse(textOf(res))
    expect(ack).toMatchObject({
      ok: true,
      op: 'release_worktree',
      folderAlias: 'PROJ-231-wave-1',
      released: true,
      alreadyReleased: false,
      bucketAfter: 'corpse',
      reason: null,
      deleted: false
    })
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith(fresh.item.id, NOW)
  })

  it('AC-3: the ACK carries no absolute path', async () => {
    serve(snapshot([fresh]))
    const text = textOf(await handler({ folder: WT_CORPSE }, ctx(WT_CORPSE)))
    expect(absolutePathsIn(text)).toEqual([])
    expect(text).not.toContain('/srv/ws')
  })

  it('AC-3: releasing twice is idempotent and says so', async () => {
    const snap = snapshot([fresh])
    snap.prefs.released = { [fresh.item.id]: NOW - 5_000 }
    serve(snap)
    const ack = JSON.parse(textOf(await handler({ folder: WT_CORPSE }, ctx(WT_CORPSE))))
    expect(ack).toMatchObject({ ok: true, alreadyReleased: true, released: true })
  })

  it('AC-3: a trailing slash on the folder still finds the bundle', async () => {
    const { release } = serve(snapshot([fresh]))
    const res = await handler({ folder: `${WT_CORPSE}/` }, ctx(`${WT_CORPSE}/`))
    expect(res.isError).toBeFalsy()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('AC-3: FATE_NOT_MERGED when the fate is not merged', async () => {
    const open = bundle(WT_OPEN, {
      bucket: 'alive',
      fate: { fate: 'open', signal: null, strong: false }
    })
    const { release } = serve(snapshot([open]))
    const res = await handler({ folder: WT_OPEN }, ctx(WT_OPEN))
    expect(res.isError).toBe(true)
    expect(JSON.parse(textOf(res))).toMatchObject({ ok: false, error: 'FATE_NOT_MERGED' })
    expect(release).not.toHaveBeenCalled()
  })

  it('AC-3: FATE_NOT_MERGED when the merge signal is weak', async () => {
    const weak = bundle(WT_WEAK, {
      bucket: 'decide',
      fate: { fate: 'merged', signal: 'remote-gone-after-close', strong: false }
    })
    const { release } = serve(snapshot([weak]))
    const res = await handler({ folder: WT_WEAK }, ctx(WT_WEAK))
    expect(JSON.parse(textOf(res)).error).toBe('FATE_NOT_MERGED')
    expect(release).not.toHaveBeenCalled()
  })

  it('AC-3: FOLDER_NOT_ALLOWED for a blocked folder, and nothing is recorded', async () => {
    const { release } = serve(snapshot([fresh]))
    const res = await handler({ folder: WT_CORPSE }, ctx(WT_CORPSE, [MAIN]))
    expect(res.isError).toBe(true)
    expect(textOf(res)).toContain('FOLDER_NOT_ALLOWED')
    expect(release).not.toHaveBeenCalled()
  })

  it('AC-3: IS_MAIN_CHECKOUT when the bundle is the main checkout', async () => {
    const main = bundle(MAIN, { isMainCheckout: true, bucket: 'alive' })
    const { release } = serve(snapshot([main]))
    const res = await handler({ folder: MAIN }, ctx(MAIN))
    expect(JSON.parse(textOf(res))).toMatchObject({ ok: false, error: 'IS_MAIN_CHECKOUT' })
    expect(release).not.toHaveBeenCalled()
  })

  it('AC-3: IS_MAIN_CHECKOUT for a main checkout that is not a bundle at all', async () => {
    const { release } = serve(snapshot([fresh]))
    const folders = [folderEntry(MAIN, { isMainWorktree: true })]
    const res = await handler({ folder: MAIN }, ctx(MAIN, [], folders))
    expect(JSON.parse(textOf(res)).error).toBe('IS_MAIN_CHECKOUT')
    expect(release).not.toHaveBeenCalled()
  })

  it('AC-3: NOT_A_WORKTREE for a folder the scan does not know', async () => {
    const { release } = serve(snapshot([fresh]))
    const res = await handler({ folder: '/srv/ws/org/elsewhere' }, ctx('/srv/ws/org/elsewhere'))
    expect(JSON.parse(textOf(res))).toMatchObject({ ok: false, error: 'NOT_A_WORKTREE' })
    expect(release).not.toHaveBeenCalled()
  })

  it('AC-3: every refusal carries a message and a next action', async () => {
    serve(snapshot([fresh]))
    const refusal = JSON.parse(
      textOf(await handler({ folder: '/srv/ws/org/elsewhere' }, ctx('/srv/ws/org/elsewhere')))
    )
    expect(refusal.message).toEqual(expect.any(String))
    expect(refusal.nextActions.length).toBeGreaterThan(0)
  })

  it('AC-4: a released bundle with dirty files is accepted but reported as decide, not corpse', async () => {
    const dirty = bundle(WT_DIRTY, {
      bucket: 'decide',
      reason: { code: 'dirty', detail: '1 blocker: dirty.' },
      item: { blockers: ['dirty'] }
    })
    serve(snapshot([dirty]))
    const ack = JSON.parse(textOf(await handler({ folder: WT_DIRTY }, ctx(WT_DIRTY))))
    expect(ack).toMatchObject({ ok: true, bucketAfter: 'decide', deleted: false })
    expect(ack.reason).toContain('dirty')
  })

  it('AC-4: a live session, a shared stack, keep and neverClean all keep it out of corpse', async () => {
    const cases = [
      bundle(WT_CORPSE, { session: 'open-idle' }),
      bundle(WT_CORPSE, { sharedStackIds: ['api'] }),
      bundle(WT_CORPSE, { keep: true }),
      bundle(WT_CORPSE, { neverClean: true })
    ]
    for (const b of cases) {
      serve(snapshot([b]))
      const ack = JSON.parse(textOf(await handler({ folder: WT_CORPSE }, ctx(WT_CORPSE))))
      expect(ack.bucketAfter).not.toBe('corpse')
      expect(ack.deleted).toBe(false)
    }
  })

  describe('D3: the repo block is checked before anything else (T445 delta 1)', () => {
    const outOfTree = bundle(WT_OUT_OF_TREE, { bucket: 'alive', lastSignOfLifeAt: NOW - 1000 })

    it('an out-of-tree worktree of a blocked repo is refused FOLDER_NOT_ALLOWED', async () => {
      const { release } = serve(snapshot([outOfTree]))
      const res = await handler({ folder: WT_OUT_OF_TREE }, ctx(WT_OUT_OF_TREE, [MAIN]))
      expect(res.isError).toBe(true)
      expect(textOf(res)).toContain('FOLDER_NOT_ALLOWED')
      expect(release).not.toHaveBeenCalled()
    })

    it('the block wins over every other refusal, whatever the fate', async () => {
      const open = bundle(WT_OUT_OF_TREE, {
        bucket: 'alive',
        fate: { fate: 'open', signal: null, strong: false }
      })
      serve(snapshot([open]))
      const res = await handler({ folder: WT_OUT_OF_TREE }, ctx(WT_OUT_OF_TREE, [MAIN]))
      expect(textOf(res)).toContain('FOLDER_NOT_ALLOWED')
      expect(textOf(res)).not.toContain('FATE_NOT_MERGED')
    })

    it('a block on the worktree folder alone is refused too (its repo is not blocked)', async () => {
      const { release } = serve(snapshot([outOfTree]))
      const res = await handler({ folder: WT_OUT_OF_TREE }, ctx(WT_OUT_OF_TREE, [WT_OUT_OF_TREE]))
      expect(textOf(res)).toContain('FOLDER_NOT_ALLOWED')
      expect(release).not.toHaveBeenCalled()
    })

    it('an out-of-tree worktree of an allowed repo can be released', async () => {
      const { release } = serve(snapshot([outOfTree]))
      const res = await handler(
        { folder: WT_OUT_OF_TREE },
        ctx(WT_OUT_OF_TREE, ['/srv/ws/elsewhere'])
      )
      expect(res.isError).toBeFalsy()
      expect(release).toHaveBeenCalledTimes(1)
    })
  })

  describe('D4: release by the listed id (T445 delta 1)', () => {
    it('accepts { id } from list_cleanup and records the raw bundle id', async () => {
      const { release } = serve(snapshot([fresh]))
      const res = await handler({ id: listedId(fresh) }, ctx(''))
      expect(res.isError).toBeFalsy()
      expect(JSON.parse(textOf(res))).toMatchObject({ ok: true, bucketAfter: 'corpse' })
      expect(release).toHaveBeenCalledWith(fresh.item.id, NOW)
    })

    it('an unknown id is NOT_A_WORKTREE, and the advice names the id from list_cleanup', async () => {
      const { release } = serve(snapshot([fresh]))
      const res = await handler({ id: 'www::worktree::nope::deadbeef' }, ctx(''))
      const refusal = JSON.parse(textOf(res))
      expect(refusal.error).toBe('NOT_A_WORKTREE')
      expect(JSON.stringify(refusal.nextActions)).toMatch(/\bid\b/)
      expect(release).not.toHaveBeenCalled()
    })

    it('the NOT_A_WORKTREE advice for a folder also points at the id', async () => {
      serve(snapshot([fresh]))
      const res = await handler({ folder: '/srv/ws/org/elsewhere' }, ctx('/srv/ws/org/elsewhere'))
      expect(JSON.stringify(JSON.parse(textOf(res)).nextActions)).toMatch(/\bid\b/)
    })

    it('an id of a bundle in a blocked repo is refused FOLDER_NOT_ALLOWED', async () => {
      const { release } = serve(snapshot([fresh]))
      const res = await handler({ id: listedId(fresh) }, ctx('', [MAIN]))
      expect(textOf(res)).toContain('FOLDER_NOT_ALLOWED')
      expect(release).not.toHaveBeenCalled()
    })

    it('an id of a main checkout is IS_MAIN_CHECKOUT', async () => {
      const main = bundle(MAIN, { isMainCheckout: true, bucket: 'alive' })
      serve(snapshot([main]))
      const res = await handler({ id: listedId(main) }, ctx(''))
      expect(JSON.parse(textOf(res)).error).toBe('IS_MAIN_CHECKOUT')
    })

    it('with neither folder nor id it is BAD_ARGS', async () => {
      serve(snapshot([fresh]))
      const res = await handler({}, ctx(''))
      expect(res.isError).toBe(true)
      expect(textOf(res)).toContain('BAD_ARGS')
    })
  })

  describe('D7: each guard is covered on its own (T445 delta 1)', () => {
    it('M8: a main checkout is recognised by a bundle’s repoPath alone', async () => {
      // No bundle at the main checkout, and no isMainWorktree flag on any folder.
      const { release } = serve(snapshot([fresh]))
      const res = await handler({ folder: MAIN }, ctx(MAIN, [], []))
      expect(JSON.parse(textOf(res)).error).toBe('IS_MAIN_CHECKOUT')
      expect(release).not.toHaveBeenCalled()
    })

    it('M5: a blocked worktree folder is refused when its repo is not blocked', async () => {
      const { release } = serve(snapshot([fresh]))
      const res = await handler({ folder: WT_CORPSE }, ctx(WT_CORPSE, [WT_CORPSE]))
      expect(textOf(res)).toContain('FOLDER_NOT_ALLOWED')
      expect(release).not.toHaveBeenCalled()
    })

    it('M10: a blocked repo is refused when the worktree folder itself is not blocked', async () => {
      const outOfTree = bundle(WT_OUT_OF_TREE, { bucket: 'alive' })
      const { release } = serve(snapshot([outOfTree]))
      const res = await handler({ folder: WT_OUT_OF_TREE }, ctx(WT_OUT_OF_TREE, [MAIN]))
      expect(textOf(res)).toContain('FOLDER_NOT_ALLOWED')
      expect(release).not.toHaveBeenCalled()
    })
  })

  it('AC-5: the service the handler reaches has no way to clean', async () => {
    serve(snapshot([fresh]))
    await handler({ folder: WT_CORPSE }, ctx(WT_CORPSE))
    expect(Object.keys(h.service!).sort()).toEqual(['release', 'snapshot'])
  })

  it('refuses GC_NOT_READY before the service is registered', async () => {
    const res = await handler({ folder: WT_CORPSE }, ctx(WT_CORPSE))
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatch(/^GC_NOT_READY/)
  })
})
