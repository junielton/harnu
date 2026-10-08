import { beforeEach, describe, expect, it, vi } from 'vitest'

// Wrap the real cleanItem in a spy so AC-7 can assert the exact options it receives while
// the real pipeline still runs against the recording fakes below.
vi.mock('../src/main/reaper/executor-core', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/reaper/executor-core')>()
  return { ...real, cleanItem: vi.fn(real.cleanItem) }
})

import {
  createGcOps,
  dockerCliAbsent,
  dockerDaemonDown,
  dockerIsUnavailable,
  DockerUnavailableError,
  presenceFromSets,
  resolveRealPaths,
  type GcShellDeps
} from '../src/main/gc/gc-shell'
import { GcStepError, runBundle } from '../src/main/gc/pipeline-core'
import {
  buildBundles,
  type CanonicalPath,
  type SessionPresence,
  type WorktreeBundle
} from '../src/main/gc/bundle-core'
import { cleanItem, type ExecutorDeps } from '../src/main/reaper/executor-core'
import type { DehydrateDeps } from '../src/main/reaper/dehydrate-core'
import type { BranchFacts, ReapItem } from '../src/main/reaper/reaper-core'
import type { DockerBatchResult } from '../src/main/containers/containers-actions'
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  groupStacks,
  type InspectedContainer,
  type StackGroup
} from '../src/main/containers/containers-core'

const REPO = '/ws/org/proj/www'
const WT = '/ws/org/proj/worktrees/PROJ-0000-slug'
const WT_B = '/ws/org/proj/worktrees/PROJ-0000-slug-b'
const ELSEWHERE = '/ws/org/other/api-gateway'
const TIP = 'a'.repeat(40)
const DAY = 86_400_000
/** The executor clock at execution time; scan-time facts in the fixtures are set relative to it. */
const EXEC_NOW = 1_700_000_000_000
const GRACE_DAYS = 2

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
    lastSignOfLifeAt: EXEC_NOW - 10 * DAY,
    graceDays: GRACE_DAYS,
    localTip: TIP,
    stackIds: ['app'],
    sharedStackIds: [],
    ownedVolumes: ['pgdata'],
    depsBytes: 4096,
    keep: false,
    neverClean: false,
    isMainCheckout: false,
    pathsResolved: true,
    bucket: 'ready',
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
  /** Replaces what the next listing returns, to model docker changing between calls. */
  setStacks(stacks: StackGroup[]): void
  presenceOf: ReturnType<typeof vi.fn>
  headOf: ReturnType<typeof vi.fn>
  isProtectedNow: ReturnType<typeof vi.fn>
  realpath: ReturnType<typeof vi.fn>
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
    trackedDirty?: boolean | null
    head?: string | null
    protectedNow?: boolean
    executor?: Partial<ExecutorDeps>
    dehydrate?: Partial<DehydrateDeps>
    /** Symlinks on the fake disk: a path under a link resolves under its target. */
    links?: Record<string, string>
    /** Paths whose realpath fails (a broken link, an unreadable folder). */
    unresolved?: string[]
    /** Paths whose realpath fails, without taking the paths under them down too. */
    unresolvedExactly?: string[]
  } = {}
): Harness {
  let stacks = over.stacks ?? [stack('app', [container('c1', `${WT}/api`)])]
  const stop = vi.fn(async (ids: string[]) => ok(ids))
  // Like docker, a removed container is gone from every later listing, so the recheck after
  // the docker steps no longer sees the stack the run just removed.
  const removeContainers = vi.fn(async (ids: string[]) => {
    stacks = stacks
      .map((s) => ({ ...s, containers: s.containers.filter((c) => !ids.includes(c.id)) }))
      .filter((s) => s.containers.length > 0)
    return ok(ids)
  })
  const removeVolumes = vi.fn(async (names: string[]) => ok(names))
  const listStacks = vi.fn(async () => ({ stacks }))
  const presenceOf = vi.fn(async () => over.presence ?? ('none' as SessionPresence))
  const headOf = vi.fn(async (): Promise<string | null> =>
    over.head === undefined ? TIP : over.head
  )
  const isProtectedNow = vi.fn((): boolean | Promise<boolean> => over.protectedNow ?? false)
  const under = (p: string, root: string): boolean => p === root || p.startsWith(`${root}/`)
  const realpath = vi.fn(async (p: string): Promise<string | null> => {
    if ((over.unresolved ?? []).some((u) => under(p, u))) return null
    if ((over.unresolvedExactly ?? []).includes(p)) return null
    for (const [link, target] of Object.entries(over.links ?? {})) {
      if (under(p, link)) return target + p.slice(link.length)
    }
    return p
  })
  const probeStatus = vi.fn(async () => ({
    // WorktreeStatus types this as a boolean; null models a probe that gave no real answer,
    // which the reprobe must refuse rather than read as clean.
    trackedDirty: (over.trackedDirty === undefined ? false : over.trackedDirty) as boolean,
    untracked: [] as string[]
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
    now: () => EXEC_NOW,
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
      presenceOf,
      headOf,
      isProtectedNow,
      realpath
    },
    stop,
    removeContainers,
    removeVolumes,
    listStacks,
    setStacks: (next) => {
      stacks = next
    },
    presenceOf,
    headOf,
    isProtectedNow,
    realpath,
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

  describe('sessions in a subfolder (delta 3, item 1)', () => {
    const sub = {
      live: new Set([`${WT}/api`]),
      inUse: new Set([`${WT}/api`, `${WT_B}/web/`])
    }

    it('a working session in a subfolder of the worktree reads working', () => {
      expect(presenceFromSets(WT, sub)).toBe('working')
    })

    it('an idle PTY in a subfolder of the worktree reads open-idle', () => {
      expect(presenceFromSets(WT_B, sub)).toBe('open-idle')
    })

    it('a sibling folder that only shares a name prefix does not count', () => {
      const sibling = { live: new Set([`${WT}-other`]), inUse: new Set([`${WT}-other/api`]) }
      expect(presenceFromSets(WT, sibling)).toBe('none')
    })

    it('a session in the worktree itself still counts, trailing slashes aside', () => {
      expect(presenceFromSets(`${WT}/`, { live: new Set([WT]), inUse: new Set() })).toBe('working')
    })

    it('a session in a parent folder of the worktree does not count', () => {
      const parent = { live: new Set(['/ws/org/proj']), inUse: new Set(['/ws/org/proj']) }
      expect(presenceFromSets(WT, parent)).toBe('none')
    })
  })

  describe('. and .. segments (delta 4, item F)', () => {
    it('a session folder that resolves into the worktree counts', () => {
      const sets = { live: new Set([`${WT}/api/../web`]), inUse: new Set<string>() }
      expect(presenceFromSets(WT, sets)).toBe('working')
    })

    it('a session folder that leaves the worktree through .. does not count', () => {
      const sets = { live: new Set([`${WT}/../PROJ-0000-slug-b`]), inUse: new Set<string>() }
      expect(presenceFromSets(WT, sets)).toBe('none')
    })

    it('the queried path is resolved too', () => {
      const sets = { live: new Set([`${WT}/api`]), inUse: new Set<string>() }
      expect(presenceFromSets(`${WT_B}/../PROJ-0000-slug/.`, sets)).toBe('working')
    })
  })
})

describe('dockerIsUnavailable', () => {
  const withProps = (message: string, props: Record<string, unknown>): Error =>
    Object.assign(new Error(message), props)

  it('is true when the docker CLI is not installed', () => {
    expect(dockerIsUnavailable(withProps('spawn docker ENOENT', { code: 'ENOENT' }))).toBe(true)
  })

  it.each([
    'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/containers/json": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'
  ])('is true when the daemon is down, read from stderr: %s', (stderr) => {
    expect(dockerIsUnavailable(withProps('Command failed: docker ps', { code: 1, stderr }))).toBe(
      true
    )
  })

  const DOCKER_29_DOWN =
    'failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory'

  it('is true for the Docker 29 stopped-daemon wording, read from stderr', () => {
    expect(
      dockerIsUnavailable(
        withProps('Command failed: docker ps', { code: 1, stderr: DOCKER_29_DOWN })
      )
    ).toBe(true)
  })

  it('is true for the Docker 29 stopped-daemon wording, read from the message', () => {
    expect(dockerIsUnavailable(new Error(`Command failed: docker ps\n${DOCKER_29_DOWN}`))).toBe(
      true
    )
  })

  it('matches the Docker 29 wording case-insensitively', () => {
    expect(
      dockerIsUnavailable(withProps('x', { code: 1, stderr: DOCKER_29_DOWN.toUpperCase() }))
    ).toBe(true)
  })

  it('is false for a killed call even when it carries the Docker 29 wording', () => {
    expect(
      dockerIsUnavailable(
        withProps('Command failed: docker ps', {
          killed: true,
          signal: 'SIGTERM',
          code: null,
          stderr: DOCKER_29_DOWN
        })
      )
    ).toBe(false)
  })

  it('is true when the daemon-down text is only in the message', () => {
    expect(
      dockerIsUnavailable(new Error('Command failed: docker ps\nIs the docker daemon running?'))
    ).toBe(true)
  })

  it('is false for a killed (timed out) call, even when its stderr reads like a daemon-down error', () => {
    expect(
      dockerIsUnavailable(
        withProps('Command failed: docker inspect', {
          killed: true,
          signal: 'SIGTERM',
          code: null,
          stderr: 'error during connect: context deadline exceeded'
        })
      )
    ).toBe(false)
  })

  it('is false for any other docker failure', () => {
    expect(
      dockerIsUnavailable(
        withProps('Command failed', {
          code: 1,
          stderr: 'permission denied while trying to connect'
        })
      )
    ).toBe(false)
  })

  it('is false for a plain Error and for a non-error value', () => {
    expect(dockerIsUnavailable(new Error('boom'))).toBe(false)
    expect(dockerIsUnavailable('boom')).toBe(false)
    expect(dockerIsUnavailable(null)).toBe(false)
  })
})

describe('dockerCliAbsent / dockerDaemonDown', () => {
  const enoent = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
  const down = Object.assign(new Error('Command failed: docker ps'), {
    code: 1,
    stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.'
  })

  it('tells a missing CLI apart from a stopped daemon', () => {
    expect(dockerCliAbsent(enoent)).toBe(true)
    expect(dockerDaemonDown(enoent)).toBe(false)
    expect(dockerCliAbsent(down)).toBe(false)
    expect(dockerDaemonDown(down)).toBe(true)
  })

  it('reads neither into a killed call or a plain error', () => {
    const killed = Object.assign(new Error('x'), {
      killed: true,
      signal: 'SIGTERM',
      stderr: 'Cannot connect to the Docker daemon'
    })
    for (const e of [killed, new Error('boom'), null]) {
      expect(dockerCliAbsent(e)).toBe(false)
      expect(dockerDaemonDown(e)).toBe(false)
    }
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

  // cleanItem's guard would refuse it anyway, but only after the docker steps had run.
  it('refuses a worktree that was dirty at the scan and still is, as dirty', async () => {
    const h = harness({ trackedDirty: true })
    const b = bundle({ item: reapItem({ blockers: ['dirty'] }) })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({ ok: false, reason: 'dirty' })
    expect(h.listStacks).not.toHaveBeenCalled()
  })

  it('refuses when the status probe cannot tell whether tracked files changed', async () => {
    const h = harness({ trackedDirty: null })
    const r = await createGcOps(h.deps).reprobe(bundle())
    expect(r.ok).toBe(false)
    expect(h.listStacks).not.toHaveBeenCalled()
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

  // I5: a running session, however idle, makes dehydrateItem refuse after the docker steps
  // already ran, so the reprobe refuses it up front. The reason names whether it is new.
  it('treats a scanned needs-input session as the working the fresh probe reports, and refuses it', async () => {
    const h = harness({ presence: 'working' })
    const b = bundle({ session: 'needs-input' })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({ ok: false, reason: 'session-open' })
  })

  it('refuses a session that was open-idle at the scan and still is', async () => {
    const h = harness({ presence: 'open-idle' })
    const b = bundle({ session: 'open-idle' })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({ ok: false, reason: 'session-open' })
    expect(h.listStacks).not.toHaveBeenCalled()
  })

  it('refuses a scanned open-idle session that is working now as changed-since-scan', async () => {
    const h = harness({ presence: 'working' })
    const b = bundle({ session: 'open-idle' })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  it('refuses a working session in a subfolder, read through the real folder sets (delta 3, item 1)', async () => {
    const h = harness()
    const sets = { live: new Set([`${WT}/api`]), inUse: new Set([`${WT}/api`]) }
    h.presenceOf.mockImplementation(async (path: string) => presenceFromSets(path, sets))
    const r = await runBundle(bundle(), createGcOps(h.deps), { removeVolumes: true })
    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'changed-since-scan' })
    expect(h.stop).not.toHaveBeenCalled()
    expect(cleanItem).not.toHaveBeenCalled()
  })

  it('accepts a session that was open-idle at the scan and has closed since', async () => {
    const h = harness({ presence: 'none' })
    const b = bundle({ session: 'open-idle' })
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

  it('refuses when a container of an exclusive stack now runs from outside the worktree', async () => {
    const h = harness({
      stacks: [stack('app', [container('c1', `${WT}/api`), container('c2', WT_B)])]
    })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  it('refuses when a container of an exclusive stack leaves the worktree through .. (delta 4, item F)', async () => {
    const h = harness({
      stacks: [stack('app', [container('c1', `${WT}/api`), container('c2', `${WT}/../www`)])]
    })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  it('refuses when a container of an exclusive stack has no folder at all', async () => {
    const h = harness({ stacks: [stack('app', [container('c1', `${WT}/api`), container('c2')])] })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  it('accepts a local tip that has not moved since the scan', async () => {
    const h = harness({ head: TIP })
    expect(await createGcOps(h.deps).reprobe(bundle({ localTip: TIP }))).toEqual({ ok: true })
    expect(h.headOf).toHaveBeenCalledWith(WT)
  })

  it('refuses when HEAD moved since the scan (new work on a merged branch)', async () => {
    const h = harness({ head: 'c'.repeat(40) })
    expect(await createGcOps(h.deps).reprobe(bundle({ localTip: TIP }))).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  it('refuses when HEAD can no longer be read', async () => {
    const h = harness()
    h.headOf.mockRejectedValueOnce(new Error('not a git repository'))
    expect(await createGcOps(h.deps).reprobe(bundle({ localTip: TIP }))).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  it('refuses when HEAD now reads as nothing', async () => {
    const h = harness({ head: null })
    expect(await createGcOps(h.deps).reprobe(bundle({ localTip: TIP }))).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  // A strong merge proof covers the scanned tip only; without one there is nothing to hold
  // HEAD against, so the clean must not go ahead.
  it.each([null, undefined])('refuses as tip-unknown when the scanned tip is %s', async (tip) => {
    const h = harness()
    expect(await createGcOps(h.deps).reprobe(bundle({ localTip: tip }))).toEqual({
      ok: false,
      reason: 'tip-unknown'
    })
    expect(h.headOf).not.toHaveBeenCalled()
    expect(h.probeStatus).not.toHaveBeenCalled()
    expect(h.listStacks).not.toHaveBeenCalled()
  })

  describe('grace re-check', () => {
    const graceMs = GRACE_DAYS * DAY

    it('passes when the grace window elapsed exactly at the boundary', async () => {
      const h = harness()
      const b = bundle({ lastSignOfLifeAt: EXEC_NOW - graceMs })
      expect(await createGcOps(h.deps).reprobe(b)).toEqual({ ok: true })
    })

    it('refuses one millisecond short of the grace window', async () => {
      const h = harness()
      const b = bundle({ lastSignOfLifeAt: EXEC_NOW - graceMs + 1 })
      expect(await createGcOps(h.deps).reprobe(b)).toEqual({
        ok: false,
        reason: 'grace-not-elapsed'
      })
    })

    it('refuses when the clock at execution is still inside the grace window', async () => {
      // Same bundle, but at execution only one day has passed since its last sign of life.
      const h = harness({ executor: { now: () => EXEC_NOW - 9 * DAY } })
      expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
        ok: false,
        reason: 'grace-not-elapsed'
      })
    })

    it('refuses when there is no sign of life to date the grace from', async () => {
      const h = harness()
      expect(await createGcOps(h.deps).reprobe(bundle({ lastSignOfLifeAt: null }))).toEqual({
        ok: false,
        reason: 'grace-not-elapsed'
      })
    })

    it('refuses a bundle that does not carry the grace it was bucketed with', async () => {
      const h = harness()
      expect(await createGcOps(h.deps).reprobe(bundle({ graceDays: undefined }))).toEqual({
        ok: false,
        reason: 'grace-not-elapsed'
      })
    })

    it.each<[string, Partial<WorktreeBundle>]>([
      ['a NaN sign of life', { lastSignOfLifeAt: NaN }],
      ['a negative sign of life', { lastSignOfLifeAt: -1 }],
      ['a NaN grace', { graceDays: NaN }],
      ['a negative grace', { graceDays: -1 }],
      ['an infinite grace', { graceDays: Infinity }]
    ])('refuses %s as grace-not-elapsed', async (_label, over) => {
      const h = harness()
      expect(await createGcOps(h.deps).reprobe(bundle(over))).toEqual({
        ok: false,
        reason: 'grace-not-elapsed'
      })
      expect(h.probeStatus).not.toHaveBeenCalled()
    })

    it('refuses before any probe runs', async () => {
      const h = harness()
      await createGcOps(h.deps).reprobe(bundle({ lastSignOfLifeAt: null }))
      expect(h.probeStatus).not.toHaveBeenCalled()
      expect(h.presenceOf).not.toHaveBeenCalled()
      expect(h.headOf).not.toHaveBeenCalled()
      expect(h.listStacks).not.toHaveBeenCalled()
    })
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

  it('refuses as docker-unavailable when the listing says the daemon is down', async () => {
    const h = harness()
    h.listStacks.mockRejectedValueOnce(new DockerUnavailableError('daemon down'))
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'docker-unavailable'
    })
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('reports a throwing stack listing as probe-failed', async () => {
    const h = harness()
    h.listStacks.mockRejectedValueOnce(new Error('docker gone'))
    const r = await createGcOps(h.deps).reprobe(bundle())
    expect(r.ok === false && r.reason).toMatch(/^probe-failed/)
  })
})

describe('reprobe pre-flights the cleanItem guard (delta 2, item 1)', () => {
  const opts = { removeVolumes: true }

  /** A recording dehydrate, so a test can prove drop-deps never started. */
  const watchedDeps = (): { readManifest: ReturnType<typeof vi.fn> } => ({
    readManifest: vi.fn(async () => ({ ephemeral: ['node_modules'], setup: [] }))
  })

  it('a still-dirty bundle halts at the reprobe and never reaches docker or drop-deps', async () => {
    const dehydrate = watchedDeps()
    const h = harness({ trackedDirty: true, dehydrate })
    const b = bundle({ item: reapItem({ blockers: ['dirty'] }) })
    const r = await runBundle(b, createGcOps(h.deps), opts)
    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'dirty', freedBytes: 0 })
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.removeContainers).not.toHaveBeenCalled()
    expect(h.removeVolumes).not.toHaveBeenCalled()
    expect(dehydrate.readManifest).not.toHaveBeenCalled()
  })

  it('an unknown tracked-dirty state halts at the reprobe before any docker step', async () => {
    const dehydrate = watchedDeps()
    const h = harness({ trackedDirty: null, dehydrate })
    const r = await runBundle(bundle(), createGcOps(h.deps), opts)
    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe' })
    expect(h.stop).not.toHaveBeenCalled()
    expect(dehydrate.readManifest).not.toHaveBeenCalled()
  })

  it('a still-unpushed bundle with no merge signal halts at the reprobe, before stopStacks', async () => {
    const hasUnpushed = vi.fn(async () => true)
    const h = harness({ executor: { hasUnpushed } })
    const b = bundle({ item: reapItem({ justifiedBy: null }) })
    const r = await runBundle(b, createGcOps(h.deps), opts)
    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'unpushed', freedBytes: 0 })
    expect(hasUnpushed).toHaveBeenCalledWith(WT)
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.removeContainers).not.toHaveBeenCalled()
  })

  it('reports a throwing unpushed probe as probe-failed', async () => {
    const h = harness({
      executor: {
        hasUnpushed: async () => {
          throw new Error('no upstream')
        }
      }
    })
    const b = bundle({ item: reapItem({ justifiedBy: null }) })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({
      ok: false,
      reason: 'probe-failed: no upstream'
    })
  })

  it('skips the unpushed probe when a merge signal justifies the item, as cleanItem does', async () => {
    const hasUnpushed = vi.fn(async () => true)
    const h = harness({ executor: { hasUnpushed } })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({ ok: true })
    expect(hasUnpushed).not.toHaveBeenCalled()
  })
})

describe('recheck before cleanGit (delta 2, item 4)', () => {
  const opts = { removeVolumes: true }

  it('passes while the worktree is still idle on the scanned tip', async () => {
    // By the recheck the exclusive stack was removed, so the listing no longer has it.
    const h = harness({ stacks: [] })
    expect(await createGcOps(h.deps).recheck(bundle())).toEqual({ ok: true })
  })

  it('a session that appears after drop-deps halts at archive before cleanGit', async () => {
    const h = harness()
    // The reprobe and the recheck before drop-deps still see nobody; the session opens while
    // the deps are being dropped.
    h.presenceOf
      .mockResolvedValueOnce('none')
      .mockResolvedValueOnce('none')
      .mockResolvedValue('working')
    const r = await runBundle(bundle(), createGcOps(h.deps), opts)
    expect(r).toMatchObject({ ok: false, haltedAt: 'archive', error: 'changed-mid-run' })
    expect(r.freedBytes).toBe(4096)
    expect(h.stop).toHaveBeenCalled()
    expect(cleanItem).not.toHaveBeenCalled()
  })

  it('HEAD moving after drop-deps halts at archive before cleanGit', async () => {
    const h = harness()
    // The reprobe and the recheck before drop-deps read the scanned tip; then it moves.
    h.headOf.mockResolvedValueOnce(TIP).mockResolvedValueOnce(TIP).mockResolvedValue('c'.repeat(40))
    const r = await runBundle(bundle(), createGcOps(h.deps), opts)
    expect(r).toMatchObject({ ok: false, haltedAt: 'archive', error: 'changed-mid-run' })
    expect(cleanItem).not.toHaveBeenCalled()
  })

  describe('re-lists the stacks touching the worktree (delta 3, item 3)', () => {
    it('a new stack started from the worktree during drop-deps halts at archive before cleanGit', async () => {
      let h: Harness | null = null
      h = harness({
        dehydrate: {
          // Someone runs `docker compose up` in the worktree while its deps are dropped.
          removeDir: async () => {
            h!.setStacks([
              stack('app', [container('c1', `${WT}/api`)]),
              stack('fresh', [container('c7', `${WT}/worker`)])
            ])
          }
        }
      })
      const r = await runBundle(bundle(), createGcOps(h.deps), opts)
      expect(r).toMatchObject({ ok: false, haltedAt: 'archive', error: 'changed-mid-run' })
      expect(r.freedBytes).toBe(4096)
      expect(cleanItem).not.toHaveBeenCalled()
    })

    it('a new stack touching the worktree refuses as stack-present', async () => {
      const h = harness({ stacks: [stack('fresh', [runWithBind('c7', `${WT}/data`)])] })
      expect(await createGcOps(h.deps).recheck(bundle())).toEqual({
        ok: false,
        reason: 'stack-present'
      })
    })

    // Delta 4, item B: by the recheck the exclusive stacks were removed and a shared one was
    // refused at the reprobe, so any stack still touching the worktree is new, whatever its id.
    it.each<[string, StackGroup[], Partial<WorktreeBundle>]>([
      ['an exclusive stack the scan saw', [stack('app', [container('c1', `${WT}/api`)])], {}],
      [
        'a shared stack the scan saw',
        [stack('shared', [container('c3', WT), container('c4', REPO)])],
        { stackIds: [], sharedStackIds: ['shared'] }
      ]
    ])('%s still touching the worktree refuses as stack-present', async (_label, stacks, over) => {
      const h = harness({ stacks })
      expect(await createGcOps(h.deps).recheck(bundle(over))).toEqual({
        ok: false,
        reason: 'stack-present'
      })
    })

    it('P1: compose up brings the scanned project back during drop-deps, so the run halts before cleanGit', async () => {
      let h: Harness | null = null
      h = harness({
        dehydrate: {
          // The same project id the run just removed comes back from the worktree.
          removeDir: async () => {
            h!.setStacks([stack('app', [container('c8', `${WT}/api`)])])
          }
        }
      })
      const r = await runBundle(bundle(), createGcOps(h.deps), opts)
      expect(h.removeContainers).toHaveBeenCalledWith(['c1'])
      expect(r).toMatchObject({ ok: false, haltedAt: 'archive', error: 'changed-mid-run' })
      expect(cleanItem).not.toHaveBeenCalled()
    })

    it('a stack whose working dir reaches the worktree through .. refuses (delta 4, item F)', async () => {
      const h = harness({
        stacks: [stack('fresh', [container('c7', '/ws/org/proj/worktrees/x/../PROJ-0000-slug')])]
      })
      expect(await createGcOps(h.deps).recheck(bundle())).toEqual({
        ok: false,
        reason: 'stack-present'
      })
    })

    it('a scanned stack that already vanished is fine', async () => {
      const h = harness({ stacks: [] })
      expect(await createGcOps(h.deps).recheck(bundle())).toEqual({ ok: true })
    })

    it('a new stack that runs from somewhere else is fine', async () => {
      const h = harness({ stacks: [stack('other', [container('c9', `${WT}-other`)])] })
      expect(await createGcOps(h.deps).recheck(bundle())).toEqual({ ok: true })
    })

    it.each([new Error('docker gone'), new DockerUnavailableError('daemon down')])(
      'refuses when the stack listing fails (%s)',
      async (err) => {
        const h = harness()
        h.listStacks.mockRejectedValueOnce(err)
        expect((await createGcOps(h.deps).recheck(bundle())).ok).toBe(false)
      }
    )
  })

  it('refuses when presence or HEAD cannot be read', async () => {
    const h = harness()
    h.presenceOf.mockRejectedValueOnce(new Error('fleet unavailable'))
    expect((await createGcOps(h.deps).recheck(bundle())).ok).toBe(false)
    h.headOf.mockRejectedValueOnce(new Error('not a git repository'))
    expect((await createGcOps(h.deps).recheck(bundle())).ok).toBe(false)
  })
})

describe('recheck before drop-deps (delta 4, item D)', () => {
  it('P2: a session that opens in WT/api during docker stop keeps node_modules in place', async () => {
    const sets = { live: new Set<string>(), inUse: new Set<string>() }
    const removeDir = vi.fn(async () => undefined)
    const h = harness({ dehydrate: { removeDir } })
    h.presenceOf.mockImplementation(async (path: string) => presenceFromSets(path, sets))
    h.stop.mockImplementation(async (ids: string[]) => {
      // Someone opens a session in a subfolder of the worktree while its stack stops.
      sets.live.add(`${WT}/api`)
      sets.inUse.add(`${WT}/api`)
      return ok(ids)
    })
    const r = await runBundle(bundle(), createGcOps(h.deps), { removeVolumes: false })
    expect(h.stop).toHaveBeenCalled()
    expect(r).toMatchObject({
      ok: false,
      haltedAt: 'drop-deps',
      error: 'changed-mid-run',
      freedBytes: 0
    })
    expect(removeDir).not.toHaveBeenCalled()
    expect(cleanItem).not.toHaveBeenCalled()
  })
})

describe('reprobe re-reads protection at execution time (delta 2, item 8)', () => {
  const opts = { removeVolumes: true }

  it('a bundle marked Keep after the scan is refused as protected-now before any op', async () => {
    const hasUnpushed = vi.fn(async () => false)
    const h = harness({ protectedNow: true, executor: { hasUnpushed } })
    const b = bundle({ keep: false })
    const r = await runBundle(b, createGcOps(h.deps), opts)
    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'protected-now' })
    expect(h.isProtectedNow).toHaveBeenCalledWith(b)
    for (const fn of [h.probeStatus, h.presenceOf, h.headOf, h.listStacks, hasUnpushed]) {
      expect(fn).not.toHaveBeenCalled()
    }
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.removeContainers).not.toHaveBeenCalled()
    expect(h.removeVolumes).not.toHaveBeenCalled()
    expect(cleanItem).not.toHaveBeenCalled()
  })

  it('accepts an asynchronous answer', async () => {
    const h = harness()
    h.isProtectedNow.mockResolvedValueOnce(true)
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'protected-now'
    })
  })

  it('refuses as probe-failed when the protection read throws', async () => {
    const h = harness()
    h.isProtectedNow.mockImplementationOnce(() => {
      throw new Error('prefs unreadable')
    })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'probe-failed: prefs unreadable'
    })
    expect(h.probeStatus).not.toHaveBeenCalled()
    expect(h.listStacks).not.toHaveBeenCalled()
  })

  it('still refuses on the scan-time main-checkout flag, whatever the live read says', async () => {
    const h = harness({ protectedNow: false })
    expect(await createGcOps(h.deps).reprobe(bundle({ isMainCheckout: true }))).toEqual({
      ok: false,
      reason: 'protected-now'
    })
    expect(h.probeStatus).not.toHaveBeenCalled()
  })

  describe('a main checkout told by its path (delta 3, item 6)', () => {
    /** Hand-built: every flag says "clean me", only the path says it is the main checkout. */
    const mainByPath = (path = REPO): WorktreeBundle =>
      bundle({
        item: reapItem({ path }),
        isMainCheckout: false,
        neverClean: false,
        keep: false
      })

    it.each([REPO, `${REPO}/`, `${REPO}/.`, '/ws/org/proj/worktrees/../www'])(
      'the reprobe refuses %s as protected-now before any probe',
      async (path) => {
        const h = harness({ protectedNow: false })
        expect(await createGcOps(h.deps).reprobe(mainByPath(path))).toEqual({
          ok: false,
          reason: 'protected-now'
        })
        for (const fn of [h.probeStatus, h.presenceOf, h.headOf, h.listStacks]) {
          expect(fn).not.toHaveBeenCalled()
        }
      }
    )

    it('runBundle refuses it with zero ops', async () => {
      const h = harness({ protectedNow: false })
      const r = await runBundle(mainByPath(), createGcOps(h.deps), opts)
      expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', freedBytes: 0 })
      expect(h.isProtectedNow).not.toHaveBeenCalled()
      expect(h.listStacks).not.toHaveBeenCalled()
      expect(h.stop).not.toHaveBeenCalled()
      expect(cleanItem).not.toHaveBeenCalled()
    })
  })

  it('lets an unprotected bundle proceed', async () => {
    const h = harness({ protectedNow: false })
    const r = await runBundle(bundle(), createGcOps(h.deps), opts)
    expect(r.ok).toBe(true)
    expect(h.isProtectedNow).toHaveBeenCalled()
  })
})

// ---- the scan and the run through the real builder ------------------------------

const MERGED_FACTS: BranchFacts = {
  kind: 'worktree',
  repoPath: REPO,
  branch: 'feat/PROJ-0000-slug',
  path: WT,
  hidden: false,
  sessionLive: false,
  trackedDirty: false,
  untracked: [],
  unpushed: false,
  remoteExists: false,
  ancestorOfDefault: true,
  patchIdContained: null,
  lastCommitAt: null,
  pr: null,
  ghAvailable: true,
  prSetComplete: true,
  prProvenance: 'own-name'
}

/** The bundle the real builder makes for the worktree at WT from this container listing. */
function scanned(
  containers: InspectedContainer[],
  links: CanonicalPath = (p) => ({ path: p, resolved: true }),
  path: string = WT,
  sessions: Map<string, { presence: SessionPresence; lastActivityAt: number | null }> = new Map()
): WorktreeBundle {
  // Merged ten days before the scan, so the grace window has long elapsed at execution time.
  const item = reapItem({
    path,
    id: `${REPO}::worktree::${path}`,
    checkpoints: [
      {
        id: 'pr-merged',
        state: 'green',
        detail: new Date(EXEC_NOW - 10 * DAY).toISOString()
      },
      { id: 'local-clean', state: 'green' }
    ]
  })
  const out = buildBundles({
    items: [item],
    fateInputs: new Map([[item.id, { facts: MERGED_FACTS, localTip: TIP }]]),
    stacks: groupStacks(containers),
    stackPaths: new Map(),
    containers,
    sessions,
    keep: new Set(),
    neverClean: new Set(),
    now: EXEC_NOW,
    graceDays: GRACE_DAYS,
    volumes: new Map([['deploy_pg', { sizeBytes: 1, project: 'deploy' }]]),
    knownFolders: [],
    protectedProjects: new Set(),
    canonical: links
  })
  expect(out).toHaveLength(1)
  return out[0]!
}

function composeIn(
  id: string,
  project: string,
  workingDir: string,
  mounts: InspectedContainer['mounts'] = []
): InspectedContainer {
  return {
    ...container(id),
    labels: { [COMPOSE_PROJECT_LABEL]: project, [COMPOSE_WORKING_DIR_LABEL]: workingDir },
    mounts
  }
}

/** A labelless `docker run -v <folder>:/app` container. */
function runWithBind(id: string, folder: string): InspectedContainer {
  return {
    ...container(id),
    name: id,
    mounts: [{ type: 'bind', source: folder, name: null }]
  }
}

const PG = { type: 'volume', source: '/var/lib/docker/volumes/deploy_pg/_data', name: 'deploy_pg' }

describe('reprobe through the real builder', () => {
  it('C1: a compose project that another worktree joined after the scan is never torn down', async () => {
    // At the scan, `deploy` runs only from this worktree and owns deploy_pg.
    const webA = composeIn('webA', 'deploy', `${WT}/deploy`, [PG])
    const b = scanned([webA])
    expect(b.stackIds).toEqual(['deploy'])
    expect(b.ownedVolumes).toEqual(['deploy_pg'])

    // Then `docker compose up db` in another worktree, same project name, same volume.
    const dbB = composeIn('dbB', 'deploy', `${WT_B}/deploy`, [PG])
    const h = harness({ stacks: groupStacks([webA, dbB]) })
    const r = await runBundle(b, createGcOps(h.deps), { removeVolumes: true })

    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'changed-since-scan' })
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.removeContainers).not.toHaveBeenCalled()
    expect(h.removeVolumes).not.toHaveBeenCalled()
  })

  it('I2: a labelless stack the scan attributed through a bind mount passes the reprobe', async () => {
    const web = runWithBind('web', `${WT}/src`)
    const b = scanned([web])
    expect(b.stackIds).toEqual(['web'])
    const h = harness({ stacks: groupStacks([web]) })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({ ok: true })
  })

  it('a stack run from elsewhere that bind-mounts the worktree is shared at the scan (delta 3, item 2)', () => {
    const web = composeIn('web', 'other', ELSEWHERE, [
      { type: 'bind', source: `${WT}/data`, name: null }
    ])
    const b = scanned([web])
    expect(b.stackIds).toEqual([])
    expect(b.sharedStackIds).toEqual(['other'])
    expect(b.bucket).toBe('review')
  })

  it('the same stack appearing after the scan refuses the clean (delta 3, item 2)', async () => {
    const b = scanned([])
    expect(b.bucket).toBe('ready')
    const web = composeIn('web', 'other', ELSEWHERE, [
      { type: 'bind', source: `${WT}/data`, name: null }
    ])
    const h = harness({ stacks: groupStacks([web]) })
    const r = await runBundle(b, createGcOps(h.deps), { removeVolumes: true })
    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'changed-since-scan' })
    expect(cleanItem).not.toHaveBeenCalled()
  })

  it('I2: a labelless container bind-mounting the worktree after the scan refuses the clean', async () => {
    const b = scanned([])
    expect(b.stackIds).toEqual([])
    const h = harness({ stacks: groupStacks([runWithBind('web', WT)]) })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })
})

describe('stopStacks / removeContainers', () => {
  const stacks = [
    stack('app', [container('c1', `${WT}/api`), container('c2', `${WT}/api`)]),
    stack('web', [container('c3', `${WT}/web`)]),
    stack('other', [container('c4', ELSEWHERE)])
  ]

  /** Ops whose reprobe already passed for a bundle owning `app` and `web`. */
  async function reprobed(h: Harness): Promise<ReturnType<typeof createGcOps>> {
    const ops = createGcOps(h.deps)
    expect(await ops.reprobe(bundle({ stackIds: ['app', 'web'] }))).toEqual({ ok: true })
    h.listStacks.mockClear()
    return ops
  }

  it('stops only the containers of the given stacks, resolved from a fresh listing', async () => {
    const h = harness({ stacks })
    await (await reprobed(h)).stopStacks(['app', 'web'])
    expect(h.listStacks).toHaveBeenCalledTimes(1)
    expect(h.stop).toHaveBeenCalledTimes(1)
    expect(h.stop).toHaveBeenCalledWith(['c1', 'c2', 'c3'])
  })

  it('removes only the containers of the given stacks', async () => {
    const h = harness({ stacks })
    await (await reprobed(h)).removeContainers(['web'])
    expect(h.removeContainers).toHaveBeenCalledWith(['c3'])
  })

  it('throws when docker reports an error', async () => {
    const h = harness({ stacks })
    h.stop.mockResolvedValueOnce({ done: ['c1', 'c2', 'c3'], error: 'daemon said no' })
    await expect((await reprobed(h)).stopStacks(['app', 'web'])).rejects.toThrow('daemon said no')
  })

  it('throws when fewer containers finished than were targeted', async () => {
    const h = harness({ stacks })
    h.removeContainers.mockResolvedValueOnce({ done: ['c1'], error: null })
    await expect((await reprobed(h)).removeContainers(['app'])).rejects.toThrow(/1 of 2/)
  })

  it('makes no docker call for an empty target list', async () => {
    const h = harness({ stacks })
    const ops = createGcOps(h.deps)
    await ops.stopStacks([])
    await ops.removeContainers([])
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.removeContainers).not.toHaveBeenCalled()
  })

  it('throws, with no docker call, for a stack no reprobe has passed', async () => {
    const h = harness({ stacks })
    await expect(createGcOps(h.deps).stopStacks(['app'])).rejects.toThrow('stack was not reprobed')
    await expect(createGcOps(h.deps).removeContainers(['app'])).rejects.toThrow(
      'stack was not reprobed'
    )
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.removeContainers).not.toHaveBeenCalled()
  })

  it('a failed reprobe withdraws an earlier pass for the same stacks', async () => {
    const h = harness({ stacks })
    const ops = await reprobed(h)
    h.probeStatus.mockResolvedValueOnce({ trackedDirty: true, untracked: [] })
    expect((await ops.reprobe(bundle({ stackIds: ['app', 'web'] }))).ok).toBe(false)
    await expect(ops.stopStacks(['app'])).rejects.toThrow('stack was not reprobed')
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('C1: throws, with no docker call, when a container started between the reprobe and the stop', async () => {
    const h = harness({ stacks })
    const ops = await reprobed(h)
    h.setStacks([
      stack('app', [
        container('c1', `${WT}/api`),
        container('c2', `${WT}/api`),
        container('c9', WT_B)
      ]),
      ...stacks.slice(1)
    ])
    await expect(ops.stopStacks(['app', 'web'])).rejects.toThrow(/changed since the reprobe/)
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('throws, with no docker call, when a reprobed stack vanished before the stop', async () => {
    const h = harness({ stacks })
    const ops = await reprobed(h)
    h.setStacks(stacks.slice(1))
    await expect(ops.stopStacks(['app'])).rejects.toThrow(/changed since the reprobe/)
    expect(h.stop).not.toHaveBeenCalled()
  })
})

describe('removeVolumes', () => {
  describe('re-lists who mounts each volume right before removing it (delta 3, item 5b)', () => {
    const mount = (name: string): InspectedContainer['mounts'][number] => ({
      type: 'volume',
      source: `/var/lib/docker/volumes/${name}/_data`,
      name
    })
    const foreign = (state: string): StackGroup =>
      stack('other', [{ ...container('c9', ELSEWHERE), state, mounts: [mount('pgdata')] }])

    it.each(['running', 'exited'])(
      'skips a volume a %s container still mounts, and removes the rest',
      async (state) => {
        const h = harness({ stacks: [foreign(state)] })
        expect(await createGcOps(h.deps).removeVolumes(['pgdata', 'cache'])).toEqual({
          skipped: [{ name: 'pgdata', reason: 'volume-in-use' }]
        })
        expect(h.listStacks).toHaveBeenCalledTimes(1)
        expect(h.removeVolumes).toHaveBeenCalledTimes(1)
        expect(h.removeVolumes).toHaveBeenCalledWith(['cache'])
      }
    )

    it('makes no docker call when every volume is still in use', async () => {
      const h = harness({ stacks: [foreign('running')] })
      expect(await createGcOps(h.deps).removeVolumes(['pgdata'])).toEqual({
        skipped: [{ name: 'pgdata', reason: 'volume-in-use' }]
      })
      expect(h.removeVolumes).not.toHaveBeenCalled()
    })

    it.each([new Error('docker gone'), new DockerUnavailableError('daemon down')])(
      'throws, with no docker call, when the listing fails (%s)',
      async (err) => {
        const h = harness()
        h.listStacks.mockRejectedValueOnce(err)
        await expect(createGcOps(h.deps).removeVolumes(['pgdata'])).rejects.toThrow()
        expect(h.removeVolumes).not.toHaveBeenCalled()
      }
    )

    it('through runBundle: a volume a foreign container took up is skipped and the item continues', async () => {
      const h = harness({
        stacks: [stack('app', [container('c1', `${WT}/api`)]), foreign('running')]
      })
      const r = await runBundle(
        bundle({ ownedVolumes: ['cache', 'pgdata'] }),
        createGcOps(h.deps),
        { removeVolumes: true }
      )
      expect(r).toMatchObject({
        ok: true,
        haltedAt: null,
        skippedVolumes: [{ name: 'pgdata', reason: 'volume-in-use' }]
      })
      expect(h.removeVolumes).toHaveBeenCalledWith(['cache'])
      expect(h.removeVolumes.mock.calls.flat(2)).not.toContain('pgdata')
      expect(cleanItem).toHaveBeenCalled()
    })

    it('through runBundle: a listing that fails halts at rm-volumes', async () => {
      const h = harness()
      const ops = createGcOps(h.deps)
      // reprobe, stop and rm list fine; the volume step's own listing fails.
      h.listStacks
        .mockImplementationOnce(async () => ({
          stacks: [stack('app', [container('c1', `${WT}/api`)])]
        }))
        .mockImplementationOnce(async () => ({
          stacks: [stack('app', [container('c1', `${WT}/api`)])]
        }))
        .mockImplementationOnce(async () => ({
          stacks: [stack('app', [container('c1', `${WT}/api`)])]
        }))
        .mockRejectedValueOnce(new Error('docker gone'))
      const r = await runBundle(bundle(), ops, { removeVolumes: true })
      expect(r).toMatchObject({ ok: false, haltedAt: 'rm-volumes' })
      expect(h.removeVolumes).not.toHaveBeenCalled()
      expect(cleanItem).not.toHaveBeenCalled()
    })
  })

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
    // The guard runs at the start of the archive phase, after docker and drop-deps already
    // ran, so naming the reprobe would claim nothing destructive had happened.
    ['guard', { probeStatus: async () => ({ trackedDirty: true, untracked: [] }) }, 'archive'],
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

  it.each<[string, Partial<ReapItem>, Partial<ExecutorDeps>]>([
    ['a non-harvestable verdict', { verdict: 'blocked' }, {}],
    ['dirty on re-probe', {}, { probeStatus: async () => ({ trackedDirty: true, untracked: [] }) }],
    ['unpushed on re-probe', { justifiedBy: null }, { hasUnpushed: async () => true }]
  ])(
    'a cleanItem guard refusal for %s halts at archive, never at reprobe',
    async (_label, itemOver, executorOver) => {
      const h = harness({ executor: executorOver })
      const err = await createGcOps(h.deps)
        .cleanGit(bundle({ item: reapItem(itemOver) }))
        .then(
          () => null,
          (e: unknown) => e
        )
      expect(err).toBeInstanceOf(GcStepError)
      expect((err as GcStepError).step).toBe('archive')
      expect((err as GcStepError).message).toMatch(/^guard:/)
    }
  )

  it('through runBundle, a guard refusal after the docker steps reports archive, not reprobe', async () => {
    const h = harness()
    // Clean at the reprobe, dirty by the time cleanItem's own guard re-probes.
    h.probeStatus
      .mockResolvedValueOnce({ trackedDirty: false, untracked: [] })
      .mockResolvedValue({ trackedDirty: true, untracked: [] })
    const r = await runBundle(bundle(), createGcOps(h.deps), { removeVolumes: true })
    expect(h.stop).toHaveBeenCalled()
    expect(r).toMatchObject({ ok: false, haltedAt: 'archive', freedBytes: 4096 })
    expect(r.error).toMatch(/dirty on re-probe/)
  })

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

// ---- path aliasing (delta 4, item C) ------------------------------------------------

const LINK = '/link/wt'

describe('resolveRealPaths (delta 4, item C)', () => {
  const disk: Record<string, string> = { [LINK]: WT, '/link/wt/api': `${WT}/api` }
  const realpath = vi.fn(async (p: string): Promise<string> => {
    const real = disk[p]
    if (!real) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' })
    return real
  })
  // A block body: a function returned from beforeEach would run as its teardown.
  beforeEach(() => {
    realpath.mockClear()
  })

  it('maps each path to its real path, resolved', async () => {
    const canonical = await resolveRealPaths([LINK, '/link/wt/api'], realpath)
    expect(canonical(LINK)).toEqual({ path: WT, resolved: true })
    expect(canonical('/link/wt/api')).toEqual({ path: `${WT}/api`, resolved: true })
  })

  it('a path realpath cannot read is unresolved, with its lexical key', async () => {
    const canonical = await resolveRealPaths(['/gone/wt/../x/'], realpath)
    expect(canonical('/gone/wt/../x/')).toEqual({ path: '/gone/x', resolved: false })
  })

  it('a path it was never asked about is unresolved, with its lexical key', async () => {
    const canonical = await resolveRealPaths([], realpath)
    expect(canonical(`${LINK}/.`)).toEqual({ path: LINK, resolved: false })
  })

  it('reads each distinct path once, lexically resolved first', async () => {
    await resolveRealPaths([LINK, LINK, '/link/wt/x/../api'], realpath)
    expect(realpath.mock.calls.map((c) => c[0]).sort()).toEqual([LINK, '/link/wt/api'])
  })
})

describe('presenceFromSets through real paths (delta 4, item C)', () => {
  it('P9: a session working in the worktree through a symlink counts', async () => {
    const sets = { live: new Set([`${LINK}/api`]), inUse: new Set<string>() }
    const canonical = await resolveRealPaths([WT, `${LINK}/api`], async (p) =>
      p.startsWith(LINK) ? WT + p.slice(LINK.length) : p
    )
    expect(presenceFromSets(WT, sets, canonical)).toBe('working')
    expect(presenceFromSets(WT, sets)).toBe('none')
  })

  it('the queried path is compared on its real path too', async () => {
    const sets = { live: new Set([`${WT}/api`]), inUse: new Set<string>() }
    const canonical = await resolveRealPaths([LINK, `${WT}/api`], async (p) =>
      p === LINK ? WT : p
    )
    expect(presenceFromSets(LINK, sets, canonical)).toBe('working')
  })
})

describe('reprobe and recheck on real paths (delta 4, item C)', () => {
  const opts = { removeVolumes: false }
  const lexical: CanonicalPath = (p) => ({ path: p, resolved: true })
  const viaLink: CanonicalPath = (p) =>
    p === LINK || p.startsWith(`${LINK}/`)
      ? { path: WT + p.slice(LINK.length), resolved: true }
      : lexical(p)

  it('P3: a stack run from a symlinked working dir is vetted, stopped and removed', async () => {
    const web = composeIn('web', 'app', `${LINK}/api`)
    const b = scanned([web], viaLink)
    expect(b.stackIds).toEqual(['app'])
    const h = harness({ stacks: groupStacks([web]), links: { [LINK]: WT } })
    const r = await runBundle(b, createGcOps(h.deps), opts)
    expect(r).toMatchObject({ ok: true, haltedAt: null })
    expect(h.stop).toHaveBeenCalledWith(['web'])
    expect(h.removeContainers).toHaveBeenCalledWith(['web'])
  })

  it('P3b: a stack that bind-mounts the worktree through a symlink after the scan refuses', async () => {
    const b = scanned([])
    const web = composeIn('web', 'other', ELSEWHERE, [
      { type: 'bind', source: `${LINK}/data`, name: null }
    ])
    const h = harness({ stacks: groupStacks([web]), links: { [LINK]: WT } })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
  })

  it('a worktree whose real path is the repo path is refused as protected-now', async () => {
    const h = harness({ stacks: [], links: { [LINK]: REPO } })
    const b = bundle({ item: reapItem({ path: LINK }), stackIds: [], ownedVolumes: [] })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({ ok: false, reason: 'protected-now' })
  })

  it.each<[string, string, StackGroup[]]>([
    ['the worktree path', WT, []],
    ['the repo path', REPO, []],
    ['a container folder inside the worktree', `${WT}/api`, []],
    // A container that only bind-mounts a folder above the worktree, which cannot be read.
    [
      'a container folder above the worktree',
      '/ws/org/proj',
      [stack('up', [runWithBind('c5', '/ws/org/proj')])]
    ]
  ])('refuses as path-unresolved when %s cannot be resolved', async (_label, gone, extra) => {
    const h = harness({
      stacks: [stack('app', [container('c1', `${WT}/api`)]), ...extra],
      unresolved: [gone]
    })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'path-unresolved'
    })
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('an unresolved folder that has nothing to do with the worktree changes nothing', async () => {
    const h = harness({
      stacks: [
        stack('app', [container('c1', `${WT}/api`)]),
        stack('x', [container('c9', ELSEWHERE)])
      ],
      unresolved: [ELSEWHERE]
    })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({ ok: true })
  })

  it('recheck refuses a stack started through a symlink to the worktree', async () => {
    const h = harness({
      stacks: [stack('fresh', [container('c7', `${LINK}/worker`)])],
      links: { [LINK]: WT }
    })
    expect(await createGcOps(h.deps).recheck(bundle())).toEqual({
      ok: false,
      reason: 'stack-present'
    })
  })

  it('recheck refuses as path-unresolved when a folder inside the worktree cannot be resolved', async () => {
    const h = harness({
      stacks: [stack('fresh', [container('c7', `${WT}/worker`)])],
      unresolved: [`${WT}/worker`]
    })
    expect(await createGcOps(h.deps).recheck(bundle())).toEqual({
      ok: false,
      reason: 'path-unresolved'
    })
  })
})

// ---- a container that touches an ancestor of the worktree (delta 5, item 1) -------------

// Delta 4, item E refused these; delta 5, item 1 (the orchestrator ruling of 2026-10-08)
// relaxed it: a folder above the worktree is ignored for attribution. The three P8 tests
// below flipped from a refusal to a pass.
describe('P8: a dev container that bind-mounts an ancestor of the worktree (delta 5, item 1)', () => {
  const NESTED = `${REPO}/.claude/worktrees/wt1`
  const dev = composeIn('dev', 'www', REPO, [{ type: 'bind', source: REPO, name: null }])
  const nestedBundle = (): WorktreeBundle =>
    bundle({ item: reapItem({ path: NESTED }), stackIds: [], ownedVolumes: [] })

  it('the reprobe passes when it appears after a scan that saw none', async () => {
    const h = harness({ stacks: groupStacks([dev]) })
    expect(await createGcOps(h.deps).reprobe(nestedBundle())).toEqual({ ok: true })
  })

  it('the recheck does not count it as stack-present', async () => {
    const h = harness({ stacks: groupStacks([dev]) })
    expect(await createGcOps(h.deps).recheck(nestedBundle())).toEqual({ ok: true })
  })

  it('the builder and the reprobe agree: ready at the scan, and the run cleans without touching it', async () => {
    const b = scanned([dev], undefined, NESTED)
    expect(b.stackIds).toEqual([])
    expect(b.sharedStackIds).toEqual([])
    expect(b.bucket).toBe('ready')
    const h = harness({ stacks: groupStacks([dev]) })
    const r = await runBundle(b, createGcOps(h.deps), { removeVolumes: false })
    expect(r).toMatchObject({ ok: true, haltedAt: null })
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.removeContainers).not.toHaveBeenCalled()
    expect(cleanItem).toHaveBeenCalled()
  })

  it('a stack that bind-mounts a folder inside the worktree from above it still refuses', async () => {
    const after = composeIn('dev', 'www', REPO, [
      { type: 'bind', source: `${NESTED}/storage`, name: null }
    ])
    const h = harness({ stacks: groupStacks([after]) })
    expect(await createGcOps(h.deps).reprobe(nestedBundle())).toEqual({
      ok: false,
      reason: 'changed-since-scan'
    })
    expect(await createGcOps(h.deps).recheck(nestedBundle())).toEqual({
      ok: false,
      reason: 'stack-present'
    })
  })

  // A mixed stack (the main checkout's own, reaching into the nested worktree) is shared at
  // the scan, so the scan says review, the reprobe sees the same stack, and the run refuses
  // it as shared: scan and run agree, and the main checkout's stack is never stopped.
  it('the builder and the reprobe agree on a stack run from above that bind-mounts a folder inside', async () => {
    const mixed = composeIn('dev', 'www', REPO, [
      { type: 'bind', source: `${NESTED}/storage`, name: null }
    ])
    const b = scanned([mixed], undefined, NESTED)
    expect(b.stackIds).toEqual([])
    expect(b.sharedStackIds).toEqual(['www'])
    expect(b.bucket).toBe('review')
    expect(b.reason?.code).toBe('shared-stack')
    const h = harness({ stacks: groupStacks([mixed]) })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({ ok: true })
    const r = await runBundle(b, createGcOps(h.deps), { removeVolumes: false, confirmReview: true })
    expect(r).toMatchObject({ ok: false, haltedAt: 'reprobe', error: 'shared-stack' })
    expect(h.stop).not.toHaveBeenCalled()
    expect(h.removeContainers).not.toHaveBeenCalled()
    expect(cleanItem).not.toHaveBeenCalled()
  })
})

// ---- a history-only session never forces path-unresolved (delta 5, item 2) -------------

describe('a history-only session in a deleted subfolder (delta 5, item 2)', () => {
  const GONE = `${WT}/api`
  const historyOnly = new Map([
    [GONE, { presence: 'none' as SessionPresence, lastActivityAt: null }]
  ])
  const goneOnDisk: CanonicalPath = (p) =>
    p === GONE ? { path: p, resolved: false } : { path: p, resolved: true }

  it('is ready at the scan and the run cleans it', async () => {
    const b = scanned([], goneOnDisk, WT, historyOnly)
    expect(b.pathsResolved).toBe(true)
    expect(b.bucket).toBe('ready')
    const h = harness({ stacks: [], unresolved: [GONE] })
    expect(await createGcOps(h.deps).reprobe(b)).toEqual({ ok: true })
    const r = await runBundle(b, createGcOps(h.deps), { removeVolumes: false })
    expect(r).toMatchObject({ ok: true, haltedAt: null })
  })

  it('a live session in an unreadable subfolder still counts for the worktree', async () => {
    const sets = { live: new Set([GONE]), inUse: new Set([GONE]) }
    const canonical = await resolveRealPaths([WT, GONE], async (p) => {
      if (p === GONE) throw new Error('ENOENT')
      return p
    })
    expect(canonical(GONE).resolved).toBe(false)
    expect(presenceFromSets(WT, sets, canonical)).toBe('working')
  })
})

// ---- an unresolved folder above the worktree still refuses (delta 5, item 1) ------------

describe('a container folder above the worktree that cannot be resolved (delta 5, item 1)', () => {
  // Only the ancestor fails to resolve; the worktree and its repo path still resolve, so a
  // refusal here comes from the container folder and nothing else.
  const ABOVE = '/ws/org/proj'
  const stacks = (): StackGroup[] => [
    stack('app', [container('c1', `${WT}/api`)]),
    stack('up', [runWithBind('c5', ABOVE)])
  ]

  it('the reprobe passes when it resolves: a folder above is ignored', async () => {
    const h = harness({ stacks: stacks() })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({ ok: true })
  })

  it('the reprobe refuses as path-unresolved when it does not', async () => {
    const h = harness({ stacks: stacks(), unresolvedExactly: [ABOVE] })
    expect(await createGcOps(h.deps).reprobe(bundle())).toEqual({
      ok: false,
      reason: 'path-unresolved'
    })
  })

  it('the recheck refuses as path-unresolved too', async () => {
    const h = harness({
      stacks: [stack('up', [runWithBind('c5', ABOVE)])],
      unresolvedExactly: [ABOVE]
    })
    expect(await createGcOps(h.deps).recheck(bundle())).toEqual({
      ok: false,
      reason: 'path-unresolved'
    })
  })
})
