import { beforeEach, describe, expect, it, vi } from 'vitest'

// Wrap the real cleanItem in a spy so AC-7 can assert the exact options it receives while
// the real pipeline still runs against the recording fakes below.
vi.mock('../src/main/reaper/executor-core', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/reaper/executor-core')>()
  return { ...real, cleanItem: vi.fn(real.cleanItem) }
})

import { createGcOps, presenceFromSets, type GcShellDeps } from '../src/main/gc/gc-shell'
import { GcStepError } from '../src/main/gc/pipeline-core'
import type { SessionPresence, WorktreeBundle } from '../src/main/gc/bundle-core'
import { cleanItem, type ExecutorDeps } from '../src/main/reaper/executor-core'
import type { DehydrateDeps } from '../src/main/reaper/dehydrate-core'
import type { ReapItem } from '../src/main/reaper/reaper-core'
import type { DockerBatchResult } from '../src/main/containers/containers-actions'
import {
  COMPOSE_WORKING_DIR_LABEL,
  type InspectedContainer,
  type StackGroup
} from '../src/main/containers/containers-core'

const REPO = '/ws/org/proj/www'
const WT = '/ws/org/proj/worktrees/PROJ-0000-slug'

function reapItem(over: Partial<ReapItem> = {}): ReapItem {
  return {
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
    hydration: null,
    ...over
  }
}

function bundle(over: Partial<WorktreeBundle> = {}): WorktreeBundle {
  return {
    item: reapItem(),
    fate: { fate: 'merged', signal: 'ancestor', strong: true },
    session: 'none',
    lastSignOfLifeAt: 1,
    stackIds: ['app'],
    sharedStackIds: [],
    ownedVolumes: ['pgdata'],
    depsBytes: 4096,
    keep: false,
    neverClean: false,
    isMainCheckout: false,
    bucket: 'corpse',
    reason: null,
    ...over
  }
}

function container(id: string, workingDir?: string): InspectedContainer {
  return {
    id,
    name: `ctr-${id}`,
    image: 'postgres:16',
    labels: workingDir ? { [COMPOSE_WORKING_DIR_LABEL]: workingDir } : {},
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    createdAt: 1,
    ports: [],
    mounts: []
  }
}

function stack(id: string, containers: InspectedContainer[]): StackGroup {
  return { id, name: id, kind: 'compose', project: id, containers }
}

const ok = (done: string[]): DockerBatchResult => ({ done, error: null })

interface Harness {
  deps: GcShellDeps
  stop: ReturnType<typeof vi.fn>
  removeContainers: ReturnType<typeof vi.fn>
  removeVolumes: ReturnType<typeof vi.fn>
  listStacks: ReturnType<typeof vi.fn>
  presenceOf: ReturnType<typeof vi.fn>
  probeStatus: ReturnType<typeof vi.fn>
  git: ReturnType<typeof vi.fn>
  gitCalls: string[][]
  executor: ExecutorDeps
  dehydrate: DehydrateDeps
}

/** Every dependency is a fake: nothing here touches docker, git or the filesystem. */
function harness(
  over: {
    stacks?: StackGroup[]
    presence?: SessionPresence
    trackedDirty?: boolean
    executor?: Partial<ExecutorDeps>
    dehydrate?: Partial<DehydrateDeps>
  } = {}
): Harness {
  const stop = vi.fn(async (ids: string[]) => ok(ids))
  const removeContainers = vi.fn(async (ids: string[]) => ok(ids))
  const removeVolumes = vi.fn(async (names: string[]) => ok(names))
  const stacks = over.stacks ?? [stack('app', [container('c1', `${WT}/api`)])]
  const listStacks = vi.fn(async () => ({ stacks }))
  const presenceOf = vi.fn(async () => over.presence ?? ('none' as SessionPresence))
  const probeStatus = vi.fn(async () => ({
    trackedDirty: over.trackedDirty ?? false,
    untracked: []
  }))
  const gitCalls: string[][] = []
  const git = vi.fn(async (_repo: string, args: string[]) => {
    gitCalls.push(args)
    return ''
  })
  const executor: ExecutorDeps = {
    probeStatus,
    hasUnpushed: async () => false,
    trash: async () => undefined,
    git,
    resolveSha: async () => 'a'.repeat(40),
    archiveTip: async (_repo, ref) => ref,
    archiveWip: async (_repo, ref) => ref,
    detachSidebar: async () => undefined,
    appendTombstone: async () => undefined,
    now: () => 1_700_000_000_000,
    ...over.executor
  }
  const dehydrate: DehydrateDeps = {
    isSessionLive: async () => false,
    readManifest: async () => ({ ephemeral: ['node_modules'], setup: [] }),
    probeEntries: async () => [
      { path: 'node_modules', presence: 'dir', contained: true, ignored: true, tracked: false }
    ],
    trackedFingerprint: async () => new Map(),
    removeDir: async () => undefined,
    recordDehydrated: async () => undefined,
    ...over.dehydrate
  }
  return {
    deps: {
      executor,
      dehydrate,
      docker: { stop, removeContainers, removeVolumes },
      listStacks,
      presenceOf
    },
    stop,
    removeContainers,
    removeVolumes,
    listStacks,
    presenceOf,
    probeStatus,
    git,
    gitCalls,
    executor,
    dehydrate
  }
}

beforeEach(() => {
  vi.mocked(cleanItem).mockClear()
})

describe('presenceFromSets', () => {
  const sets = {
    live: new Set(['/live']),
    inUse: new Set(['/live', '/idle'])
  }

  it('maps a live folder to working', () => {
    expect(presenceFromSets('/live', sets)).toBe('working')
  })

  it('maps a folder with only an idle PTY to open-idle', () => {
    expect(presenceFromSets('/idle', sets)).toBe('open-idle')
  })

  it('maps a folder with no PTY to none', () => {
    expect(presenceFromSets('/nobody', sets)).toBe('none')
  })
})

describe('reprobe (AC-5)', () => {
  it('returns ok when every fact still matches the scan', async () => {
    const h = harness()
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({ ok: true })
  })

  it('refuses a non-harvestable item before any other probe', async () => {
    const h = harness()
    const b = bundle({ item: reapItem({ verdict: 'blocked' }) })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({ ok: false, reason: 'not-harvestable' })
    expect(h.probeStatus).not.toHaveBeenCalled()
  })

  it('refuses when the worktree became tracked-dirty since the scan', async () => {
    const h = harness({ trackedDirty: true })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  it('refuses when the scan saw a dirty blocker that is gone now', async () => {
    const h = harness({ trackedDirty: false })
    const b = bundle({ item: reapItem({ blockers: ['dirty'] }) })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  it('accepts a worktree that was dirty at the scan and still is (the executor guard decides)', async () => {
    const h = harness({ trackedDirty: true })
    const b = bundle({ item: reapItem({ blockers: ['dirty'] }) })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({ ok: true })
  })

  it('refuses when a session opened since the scan (none to open-idle)', async () => {
    const h = harness({ presence: 'open-idle' })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  it('refuses when a session started working since the scan (none to working)', async () => {
    const h = harness({ presence: 'working' })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  it('treats a scanned needs-input session as the working the fresh probe reports', async () => {
    const h = harness({ presence: 'working' })
    const b = bundle({ session: 'needs-input' })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({ ok: true })
  })

  it('refuses when a new stack appeared for this worktree', async () => {
    const h = harness({
      stacks: [
        stack('app', [container('c1', `${WT}/api`)]),
        stack('extra', [container('c2', `${WT}/worker`)])
      ]
    })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  it('refuses when a scanned stack is gone', async () => {
    const h = harness({ stacks: [] })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  it('ignores stacks that run from somewhere else', async () => {
    const h = harness({
      stacks: [
        stack('app', [container('c1', `${WT}/api`)]),
        stack('other', [container('c9', '/ws/org/proj/worktrees/PROJ-9999-other')]),
        stack('loose', [container('c8')])
      ]
    })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({ ok: true })
  })

  it('counts a stack with any working dir inside the worktree, shared stacks included', async () => {
    const h = harness({
      stacks: [
        stack('app', [container('c1', `${WT}/api`)]),
        stack('shared', [container('c3', WT), container('c4', REPO)])
      ]
    })
    const b = bundle({ sharedStackIds: ['shared'] })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({ ok: true })
  })

  it('compares stack ids as a sorted set, whatever order the scan listed them in', async () => {
    const h = harness({
      stacks: [
        stack('web', [container('c2', `${WT}/web`)]),
        stack('app', [container('c1', `${WT}/api`)])
      ]
    })
    const b = bundle({ stackIds: ['web', 'app'] })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({ ok: true })
  })

  it('reports a throwing status probe as probe-failed', async () => {
    const h = harness({
      executor: {
        probeStatus: async () => {
          throw new Error('git exploded')
        }
      }
    })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'probe-failed: git exploded'
    })
  })

  it('reports a throwing presence probe as probe-failed', async () => {
    const h = harness()
    h.presenceOf.mockRejectedValueOnce(new Error('fleet unavailable'))
    const r = await createGcOps(h.deps).reprobe(bundle())
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/^probe-failed/)
  })

  it('reports a throwing stack listing as probe-failed', async () => {
    const h = harness()
    h.listStacks.mockRejectedValueOnce(new Error('docker gone'))
    const r = await createGcOps(h.deps).reprobe(bundle())
    expect(r.ok === false && r.reason).toMatch(/^probe-failed/)
  })
})

describe('stopStacks / removeContainers', () => {
  const stacks = [
    stack('app', [container('c1'), container('c2')]),
    stack('web', [container('c3')]),
    stack('other', [container('c4')])
  ]

  it('stops only the containers of the given stacks, resolved from a fresh listing', async () => {
    const h = harness({ stacks })
    await createGcOps(h.deps).stopStacks(['app', 'web'])
    expect(h.listStacks).toHaveBeenCalledTimes(1)
    expect(h.stop).toHaveBeenCalledTimes(1)
    expect(h.stop).toHaveBeenCalledWith(['c1', 'c2', 'c3'])
  })

  it('removes only the containers of the given stacks', async () => {
    const h = harness({ stacks })
    await createGcOps(h.deps).removeContainers(['web'])
    expect(h.removeContainers).toHaveBeenCalledWith(['c3'])
  })

  it('throws when docker reports an error', async () => {
    const h = harness({ stacks })
    h.stop.mockResolvedValueOnce({ done: ['c1', 'c2', 'c3'], error: 'daemon said no' })
    await expect(createGcOps(h.deps).stopStacks(['app', 'web'])).rejects.toThrow('daemon said no')
  })

  it('throws when fewer containers finished than were targeted', async () => {
    const h = harness({ stacks })
    h.removeContainers.mockResolvedValueOnce({ done: ['c1'], error: null })
    await expect(createGcOps(h.deps).removeContainers(['app'])).rejects.toThrow(/1 of 2/)
  })

  it('makes no docker call for an empty target list', async () => {
    const h = harness({ stacks })
    const ops = createGcOps(h.deps)
    await ops.stopStacks([])
    await ops.removeContainers([])
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.removeContainers).not.toHaveBeenCalled()
  })

  it('makes no docker call when the named stacks no longer exist', async () => {
    const h = harness({ stacks })
    await createGcOps(h.deps).stopStacks(['vanished'])
    expect(h.stop).not.toHaveBeenCalled()
  })
})

describe('removeVolumes', () => {
  it('passes the volume names to docker', async () => {
    const h = harness()
    await createGcOps(h.deps).removeVolumes(['pgdata', 'cache'])
    expect(h.removeVolumes).toHaveBeenCalledWith(['pgdata', 'cache'])
  })

  it('throws when docker reports an error (an in-use volume is docker`s own refusal)', async () => {
    const h = harness()
    h.removeVolumes.mockResolvedValueOnce({ done: [], error: 'volume is in use' })
    await expect(createGcOps(h.deps).removeVolumes(['pgdata'])).rejects.toThrow('volume is in use')
  })

  it('throws when fewer volumes were removed than requested', async () => {
    const h = harness()
    h.removeVolumes.mockResolvedValueOnce({ done: ['pgdata'], error: null })
    await expect(createGcOps(h.deps).removeVolumes(['pgdata', 'cache'])).rejects.toThrow()
  })

  it('makes no docker call for an empty list', async () => {
    const h = harness()
    await createGcOps(h.deps).removeVolumes([])
    expect(h.removeVolumes).not.toHaveBeenCalled()
  })
})

describe('dropDeps', () => {
  it('returns the scanned reclaimable bytes when the dehydrate succeeds', async () => {
    const h = harness()
    expect(await createGcOps(h.deps).dropDeps(bundle({ depsBytes: 8192 }))).toBe(8192)
  })

  it('returns 0 when the scan measured nothing', async () => {
    const h = harness()
    expect(await createGcOps(h.deps).dropDeps(bundle({ depsBytes: null }))).toBe(0)
  })

  it('treats "nothing removable" as a benign no-op worth 0 bytes', async () => {
    const h = harness({ dehydrate: { readManifest: async () => ({ ephemeral: [], setup: [] }) } })
    expect(await createGcOps(h.deps).dropDeps(bundle({ depsBytes: 8192 }))).toBe(0)
  })

  it('throws when a directory failed to be removed', async () => {
    const h = harness({
      dehydrate: {
        removeDir: async () => {
          throw new Error('EPERM')
        }
      }
    })
    await expect(createGcOps(h.deps).dropDeps(bundle())).rejects.toThrow(/EPERM/)
  })

  it('throws when the tracked set changed under the removal', async () => {
    let calls = 0
    const h = harness({
      dehydrate: {
        trackedFingerprint: async () =>
          new Map<string, string>(calls++ === 0 ? [] : [['src/a.ts', 'M:1']])
      }
    })
    await expect(createGcOps(h.deps).dropDeps(bundle())).rejects.toThrow()
  })

  it('throws on any other refusal, such as a live session', async () => {
    const h = harness({ dehydrate: { isSessionLive: async () => true } })
    await expect(createGcOps(h.deps).dropDeps(bundle())).rejects.toThrow(/session is live/)
  })
})

describe('cleanGit', () => {
  it('AC-7: never reaches the remote even for an item that wants its remote branch deleted', async () => {
    const h = harness()
    const item = reapItem({ needsRemoteDelete: true, remoteSha: 'b'.repeat(40) })
    await createGcOps(h.deps).cleanGit(bundle({ item }))

    expect(cleanItem).toHaveBeenCalledTimes(1)
    expect(cleanItem).toHaveBeenCalledWith(item, { deleteRemote: false }, h.executor)
    expect(h.gitCalls.some((args) => args.includes('push'))).toBe(false)
    // The local side did run: the branch was deleted, so the spy is not vacuous.
    expect(h.gitCalls).toContainEqual(['branch', '-d', 'feat/PROJ-0000-slug'])
  })

  it('resolves when every executor step succeeds', async () => {
    const h = harness()
    await expect(createGcOps(h.deps).cleanGit(bundle())).resolves.toBeUndefined()
  })

  const failing: Array<[string, Partial<ExecutorDeps>, string]> = [
    ['guard', { probeStatus: async () => ({ trackedDirty: true, untracked: [] }) }, 'reprobe'],
    [
      'archive',
      {
        archiveTip: async () => {
          throw new Error('ref write failed')
        }
      },
      'archive'
    ],
    [
      'trash-folder',
      {
        trash: async () => {
          throw new Error('trash failed')
        }
      },
      'trash'
    ],
    [
      'worktree-prune',
      {
        git: async (_repo, args) => {
          if (args[0] === 'worktree') throw new Error('prune failed')
          return ''
        }
      },
      'prune'
    ],
    [
      'branch-delete',
      {
        git: async (_repo, args) => {
          if (args[0] === 'branch') throw new Error('branch failed')
          return ''
        }
      },
      'branch-delete'
    ],
    [
      'sidebar-detach',
      {
        detachSidebar: async () => {
          throw new Error('detach failed')
        }
      },
      'detach'
    ],
    [
      'journal',
      {
        appendTombstone: async () => {
          throw new Error('journal failed')
        }
      },
      'detach'
    ]
  ]

  it.each(failing)(
    'maps a failed %s step to the pipeline step it belongs to',
    async (_cleanStep, executorOver, expected) => {
      const h = harness({ executor: executorOver })
      const err = await createGcOps(h.deps)
        .cleanGit(bundle())
        .then(
          () => null,
          (e: unknown) => e
        )
      expect(err).toBeInstanceOf(GcStepError)
      expect((err as GcStepError).step).toBe(expected)
      expect((err as GcStepError).message.length).toBeGreaterThan(0)
    }
  )

  it('carries the failing step message through', async () => {
    const h = harness({
      executor: {
        trash: async () => {
          throw new Error('trash failed')
        }
      }
    })
    await expect(createGcOps(h.deps).cleanGit(bundle())).rejects.toThrow(/trash failed/)
  })
})
