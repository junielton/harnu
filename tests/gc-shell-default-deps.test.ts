/**
 * The wiring in `defaultGcShellDeps`, with every real module mocked: what matters here is
 * which options reach the docker listing and how a listing failure travels up to the
 * reprobe. Nothing touches docker, git or electron.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  inspectAll: vi.fn(),
  computeFolderSets: vi.fn(),
  executor: {} as Record<string, unknown>,
  /** The fake disk's realpath; by default every path is real and exists. */
  realpath: vi.fn(async (p: string): Promise<string> => p)
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>()
  return { ...real, default: { ...real, realpath: h.realpath }, realpath: h.realpath }
})

vi.mock('../src/main/containers/containers-shell', () => ({
  inspectAll: h.inspectAll,
  dockerActions: {
    stop: vi.fn(),
    removeContainers: vi.fn(),
    removeVolumes: vi.fn()
  }
}))
vi.mock('../src/main/reaper/scanner-shell', () => ({
  computeFolderSets: h.computeFolderSets
}))
vi.mock('../src/main/reaper/reaper-ipc', () => ({
  buildDeps: () => h.executor,
  buildHydrationDeps: () => ({ dehydrate: {} })
}))

import { createGcOps, defaultGcShellDeps, DockerUnavailableError } from '../src/main/gc/gc-shell'
import type { WorktreeBundle } from '../src/main/gc/bundle-core'
import type { ReapItem } from '../src/main/reaper/reaper-core'

const REPO = '/ws/org/proj/www'
const WT = '/ws/org/proj/worktrees/PROJ-0000-slug'
const TIP = 'a'.repeat(40)
const EXEC_NOW = 1_700_000_000_000

function harvestable(): WorktreeBundle {
  const item: ReapItem = {
    id: `${REPO}::worktree::${WT}`,
    repoPath: REPO,
    kind: 'worktree',
    branch: 'feat/PROJ-0000-slug',
    path: WT,
    hidden: false,
    ageDays: 12,
    diskBytes: 1_000_000,
    checkpoints: [],
    verdict: 'harvestable',
    blockers: [],
    needsRemoteDelete: false,
    untracked: [],
    justifiedBy: 'ancestor',
    hydration: null
  }
  return {
    item,
    fate: { fate: 'merged', signal: 'ancestor', strong: true },
    session: 'none',
    lastSignOfLifeAt: EXEC_NOW - 10 * 86_400_000,
    graceDays: 2,
    stackIds: [],
    sharedStackIds: [],
    ownedVolumes: [],
    depsBytes: null,
    keep: false,
    neverClean: false,
    isMainCheckout: false,
    pathsResolved: true,
    localTip: TIP,
    bucket: 'corpse',
    reason: null
  }
}

/** What execFile rejects with when its timeout kills the docker call. */
/** What the CLI reports when it is installed but the daemon is stopped (Docker 29 wording). */
const daemonDownError = (): Error =>
  Object.assign(new Error('Command failed: docker ps'), {
    code: 1,
    stderr:
      'failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory'
  })

const timeoutError = (): Error =>
  Object.assign(new Error('Command failed: docker inspect'), {
    killed: true,
    signal: 'SIGTERM',
    code: null
  })

beforeEach(() => {
  h.realpath.mockReset()
  h.realpath.mockImplementation(async (p: string) => p)
  h.inspectAll.mockReset()
  h.computeFolderSets.mockReset()
  h.computeFolderSets.mockResolvedValue({ live: new Set(), inUse: new Set() })
  h.executor = {
    probeStatus: vi.fn(async () => ({ trackedDirty: false, untracked: [] })),
    git: vi.fn(async () => `${TIP}\n`),
    now: () => EXEC_NOW
  }
})

describe('defaultGcShellDeps.listStacks', () => {
  it('asks docker for a strict listing, so a failed inspect chunk cannot pass as a full one', async () => {
    h.inspectAll.mockResolvedValue([])
    const deps = await defaultGcShellDeps(() => null)
    await deps.listStacks()
    expect(h.inspectAll).toHaveBeenCalledWith({ strict: true })
  })

  it('rejects when the listing times out (a killed call proves nothing about what runs)', async () => {
    h.inspectAll.mockRejectedValue(timeoutError())
    const deps = await defaultGcShellDeps(() => null)
    await expect(deps.listStacks()).rejects.toThrow(/docker inspect/)
  })

  it('yields no stacks when the docker CLI is not installed', async () => {
    h.inspectAll.mockRejectedValue(
      Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
    )
    const deps = await defaultGcShellDeps(() => null)
    expect(await deps.listStacks()).toEqual({ stacks: [] })
  })

  // A stopped daemon may come back with the same containers, so it proves nothing about
  // what runs from the worktree: it must refuse, not read as "no stacks".
  it('rejects with DockerUnavailableError when the daemon is down', async () => {
    h.inspectAll.mockRejectedValue(daemonDownError())
    const deps = await defaultGcShellDeps(() => null)
    await expect(deps.listStacks()).rejects.toBeInstanceOf(DockerUnavailableError)
  })
})

describe('reprobe over the default deps', () => {
  it('reports probe-failed when the docker listing fails, instead of reading it as no stacks', async () => {
    h.inspectAll.mockRejectedValue(timeoutError())
    const ops = createGcOps(await defaultGcShellDeps(() => null))
    const r = await ops.reprobe(harvestable())
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/^probe-failed/)
  })

  it.each(['keep', 'neverClean'] as const)(
    'refuses a bundle with %s set as protected-now, before any docker call',
    async (flag) => {
      h.inspectAll.mockResolvedValue([])
      const ops = createGcOps(await defaultGcShellDeps(() => null))
      expect(await ops.reprobe({ ...harvestable(), [flag]: true })).toEqual({
        ok: false,
        reason: 'protected-now'
      })
      expect(h.inspectAll).not.toHaveBeenCalled()
    }
  )

  it('isProtectedNow reads a bundle whose path is its repo path as the main checkout (delta 3, item 6)', async () => {
    const deps = await defaultGcShellDeps(() => null)
    const base = harvestable()
    expect(await deps.isProtectedNow(base)).toBe(false)
    for (const path of [REPO, `${REPO}/`]) {
      const main = { ...base, item: { ...base.item, path }, isMainCheckout: false }
      expect(await deps.isProtectedNow(main)).toBe(true)
    }
  })

  it('refuses as docker-unavailable when the daemon is down', async () => {
    h.inspectAll.mockRejectedValue(daemonDownError())
    const ops = createGcOps(await defaultGcShellDeps(() => null))
    expect(await ops.reprobe(harvestable())).toEqual({ ok: false, reason: 'docker-unavailable' })
  })

  it('still cleans a stackless bundle when the docker CLI is not installed', async () => {
    h.inspectAll.mockRejectedValue(
      Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
    )
    const ops = createGcOps(await defaultGcShellDeps(() => null))
    expect(await ops.reprobe(harvestable())).toEqual({ ok: true })
  })
})

describe('real paths over the default deps (delta 4, item C)', () => {
  const LINK = '/link/wt'

  it('realpath answers the real path, and null when it cannot be read', async () => {
    h.realpath.mockImplementation(async (p: string) => {
      if (p === LINK) return WT
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    })
    const deps = await defaultGcShellDeps(() => null)
    expect(await deps.realpath(LINK)).toBe(WT)
    expect(await deps.realpath('/gone')).toBeNull()
  })

  it('presenceOf counts a session reached through a symlink to the worktree', async () => {
    h.realpath.mockImplementation(async (p: string) =>
      p.startsWith(LINK) ? WT + p.slice(LINK.length) : p
    )
    h.computeFolderSets.mockResolvedValue({ live: new Set([`${LINK}/api`]), inUse: new Set() })
    const deps = await defaultGcShellDeps(() => null)
    expect(await deps.presenceOf(WT)).toBe('working')
  })

  it('presenceOf resolves the queried path too', async () => {
    h.realpath.mockImplementation(async (p: string) => (p === LINK ? WT : p))
    h.computeFolderSets.mockResolvedValue({ live: new Set(), inUse: new Set([`${WT}/web`]) })
    const deps = await defaultGcShellDeps(() => null)
    expect(await deps.presenceOf(LINK)).toBe('open-idle')
  })
})
