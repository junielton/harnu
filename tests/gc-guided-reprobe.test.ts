// Delta 1: the engine's own reprobe and recheck, run on real code over a fake world, honour what a
// guided prep fixes (`bundle.assume`) and nothing else — that is what makes the dry run a dry run of the
// WHOLE remove, not of the prep.

import { describe, expect, it } from 'vitest'
import { createGcOps } from '../src/main/gc/gc-shell'
import { createDryReprobe } from '../src/main/gc/gc-forced-ops'
import {
  COMPOSE_WORKING_DIR_LABEL,
  type InspectedContainer,
  type StackGroup
} from '../src/main/containers/containers-core'
import { bundle } from './gc-fixtures'
import { WT, worldFor } from './helpers/gc-world'

const review = (over: Parameters<typeof bundle>[2] = {}) =>
  bundle(WT, 'review', { reason: { code: 'dirty', detail: 'x' }, ...over })

const ctr = (id: string, state: string): InspectedContainer =>
  ({
    id,
    name: `n-${id}`,
    image: 'x',
    labels: { [COMPOSE_WORKING_DIR_LABEL]: `${WT}/api` },
    state,
    startedAt: 1,
    finishedAt: null,
    createdAt: 1,
    ports: [],
    mounts: []
  }) as InspectedContainer

const stack = (id: string, state: string): StackGroup => ({
  id,
  name: id,
  kind: 'compose',
  project: id,
  containers: [ctr(`${id}-1`, state)]
})

describe('reprobe with assume', () => {
  it('a locked worktree is refused, unless the unlock is what is being fixed', async () => {
    const b = review({ locked: true })
    const ops = createGcOps(worldFor(b))
    expect(await ops.reprobe(b)).toEqual({ ok: false, reason: 'cannot-unregister' })
    expect(await ops.reprobe({ ...b, assume: { unlock: true } })).toEqual({ ok: true })
  })

  it('assuming the unlock does not hide anything else: a nested worktree still refuses', async () => {
    const b = review({ locked: true, nestedWorktrees: [`${WT}/.claude/worktrees/x`] })
    const ops = createGcOps(worldFor(b))
    const r = await ops.reprobe({ ...b, assume: { unlock: true } })
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).toMatch(/nested/)
  })

  it('assuming the unlock does not hide a scan that was blind to Docker', async () => {
    const b = review({ locked: true, dockerBlind: true })
    const r = await createGcOps(worldFor(b)).reprobe({ ...b, assume: { unlock: true } })
    expect(r).toEqual({ ok: false, reason: 'scan-blind' })
  })

  it('an idle session is tolerated only when closing it is what is being fixed', async () => {
    const b = review({ session: 'open-idle' })
    const ops = createGcOps(worldFor(b))
    expect(await ops.reprobe(b)).toMatchObject({ ok: false, reason: 'session-open' })
    expect(await ops.reprobe({ ...b, assume: { closeSession: true } })).toEqual({ ok: true })
  })

  it('a working session is never tolerated, whatever is assumed', async () => {
    const b = review({ session: 'working' })
    const r = await createGcOps(worldFor(b)).reprobe({ ...b, assume: { closeSession: true } })
    expect(r).toMatchObject({ ok: false })
  })

  it('a shared stack that is being stopped is not a changed stack', async () => {
    const b = review({ sharedStackIds: [] })
    const world = worldFor(b, { listStacks: async () => ({ stacks: [stack('web', 'exited')] }) })
    const ops = createGcOps(world)
    expect(await ops.reprobe(b)).toMatchObject({ ok: false, reason: 'changed-since-scan' })
    expect(await ops.reprobe({ ...b, assume: { stoppedStacks: ['web'] } })).toEqual({ ok: true })
  })
})

describe('recheck with assume', () => {
  it('stopped containers of the stack that was stopped do not refuse the removal', async () => {
    const b = review()
    const world = worldFor(b, { listStacks: async () => ({ stacks: [stack('web', 'exited')] }) })
    const ops = createGcOps(world)
    expect(await ops.recheck(b)).toMatchObject({ ok: false, reason: 'stack-present' })
    expect(await ops.recheck({ ...b, assume: { stoppedStacks: ['web'] } })).toEqual({ ok: true })
  })

  it('a stack that was started again meanwhile does refuse', async () => {
    const b = review()
    const world = worldFor(b, { listStacks: async () => ({ stacks: [stack('web', 'running')] }) })
    const r = await createGcOps(world).recheck({ ...b, assume: { stoppedStacks: ['web'] } })
    expect(r).toMatchObject({ ok: false, reason: 'stack-present' })
  })

  it('a different stack still refuses', async () => {
    const b = review()
    const world = worldFor(b, {
      listStacks: async () => ({ stacks: [stack('web', 'exited'), stack('db', 'exited')] })
    })
    const r = await createGcOps(world).recheck({ ...b, assume: { stoppedStacks: ['web'] } })
    expect(r).toMatchObject({ ok: false, reason: 'stack-present' })
  })
})

// Found live: the dry run must judge the item exactly as the confirmed remove will — the review path
// waives the dirty / unpushed guards (it archives first) — and must write nothing while doing it.

describe('the dry reprobe is the remove’s own reprobe, read-only', () => {
  const unpushed = () => {
    const b = review()
    b.item = { ...b.item, justifiedBy: null, blockers: ['unpushed'] }
    return b
  }

  it('a confirmed review item with unpushed commits passes (the forced path waives it)', async () => {
    const b = unpushed()
    expect(await createDryReprobe(worldFor(b), true)(b)).toEqual({ ok: true })
  })

  it('the ordinary (ready) path still refuses unpushed commits', async () => {
    const b = unpushed()
    expect(await createDryReprobe(worldFor(b), false)(b)).toMatchObject({
      ok: false,
      reason: 'unpushed'
    })
  })

  it('writes nothing: no archive ref, no trash', async () => {
    const b = unpushed()
    const world = worldFor(b)
    const archiveTip = (world.executor.archiveTip = async () => {
      throw new Error('the dry run archived')
    })
    void archiveTip
    await expect(createDryReprobe(world, true)(b)).resolves.toEqual({ ok: true })
  })
})

// Delta 2 item 7: the dry run is as exact as the remove.
describe('assume.unlock still asks git whether the worktree can be unregistered (delta 2)', () => {
  it('asks canUnregister as if unlocked, instead of skipping the question', async () => {
    const asked: Array<boolean | undefined> = []
    const b = review({ locked: true })
    const world = worldFor(b)
    world.executor.canUnregister = async (_r, _p, o) => (asked.push(o?.assumeUnlocked), true)
    expect(await createGcOps(world).reprobe({ ...b, assume: { unlock: true } })).toEqual({
      ok: true
    })
    expect(asked).toEqual([true])
  })

  it('an ambiguous registration still refuses, lock or no lock', async () => {
    const b = review({ locked: true })
    const world = worldFor(b)
    world.executor.canUnregister = async () => false
    expect(await createGcOps(world).reprobe({ ...b, assume: { unlock: true } })).toEqual({
      ok: false,
      reason: 'cannot-unregister'
    })
  })

  it('the real reprobe, without the assumption, asks the ordinary question', async () => {
    const asked: Array<boolean | undefined> = []
    const b = review()
    const world = worldFor(b)
    world.executor.canUnregister = async (_r, _p, o) => (asked.push(o?.assumeUnlocked), true)
    await createGcOps(world).reprobe(b)
    expect(asked).toEqual([undefined])
  })
})

describe('the dry reprobe checks the archive is possible, read-only (delta 2)', () => {
  const forcedItem = () => {
    const b = review()
    b.item = { ...b.item, branch: 'feat/x', justifiedBy: null, blockers: ['dirty'] }
    return b
  }

  it('a tip that cannot be resolved refuses, before anything is parked', async () => {
    const b = forcedItem()
    const world = worldFor(b)
    world.executor.resolveSha = async () => null
    const r = await createDryReprobe(world, true)(b)
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).toMatch(/^archive-failed/)
  })

  it('a worktree with no branch has nothing to archive under, so it refuses', async () => {
    const b = forcedItem()
    b.item = { ...b.item, branch: null }
    const r = await createDryReprobe(worldFor(b), true)(b)
    expect((r as { reason: string }).reason).toMatch(/^archive-failed/)
  })

  it('and never writes a ref while checking', async () => {
    const b = forcedItem()
    const world = worldFor(b)
    let wrote = 0
    world.executor.archiveTip = async () => (wrote++, 'x')
    world.executor.archiveWip = async () => (wrote++, 'x')
    await createDryReprobe(world, true)(b)
    expect(wrote).toBe(0)
  })

  it('the ordinary path has no archive to check', async () => {
    const b = review()
    const world = worldFor(b)
    world.executor.resolveSha = async () => null
    expect(await createDryReprobe(world, false)(b)).toEqual({ ok: true })
  })
})
