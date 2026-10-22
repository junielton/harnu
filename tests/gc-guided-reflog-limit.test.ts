// AC-E3 (unit E): the dry run of a guided "Close session and remove" also checks the reflog limit.
//
// A detached worktree whose history holds more reflog-only tips than Harnu keeps for one removal is
// refused by the REAL run, at the archive step. The dry run only planned the tip and the working
// state, so it passed, and the guided action then parked the session for a remove that was always
// going to stop. The dry run now counts those tips (read-only) and refuses with `reflog-limit`
// before any prep step runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createDryReprobe } from '../src/main/gc/gc-forced-ops'
import { submitManualClean, type ManualCleanDeps } from '../src/main/gc/gc-manual'
import { expectedOf } from '../src/main/gc/gc-confirm'
import { createCycleState } from '../src/main/gc/gc-cycle'
import { createJobQueue, type GcJobDone } from '../src/main/gc/gc-jobs-core'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { GcCleanOptions } from '../src/main/gc/gc-wire'
import {
  createReflogArchiver,
  defaultReflogIo,
  type ReflogIo
} from '../src/main/reaper/archive-shell'
import { bundle, NOW, reapItem } from './gc-fixtures'
import { TIP, WT, worldFor } from './helpers/gc-world'

const LIMIT_MESSAGE =
  "reflog-limit: this worktree's history holds 501 separate lines of commits that no branch, tag or ref reaches (one tip each), more than the 500 tips Harnu keeps for one removal. Nothing was removed."

/** A detached worktree with an idle session open in it: what "Close session and remove" is offered on. */
const detachedWithSession = () =>
  bundle(WT, 'review', {
    reason: { code: 'detached', detail: 'x' },
    session: 'open-idle',
    item: reapItem(WT, {
      kind: 'detached-worktree',
      branch: undefined,
      headSha: TIP,
      verdict: 'blocked',
      blockers: ['detached-head'],
      justifiedBy: null
    })
  })

describe('the dry reprobe refuses a worktree over the reflog limit', () => {
  it('refuses with reflog-limit, and writes nothing', async () => {
    const b = detachedWithSession()
    const world = worldFor(b)
    let wrote = 0
    world.executor.archiveTip = async () => (wrote++, 'x')
    world.executor.archiveWip = async () => (wrote++, 'x')
    world.executor.archiveReflog = async () => (wrote++, [])
    world.executor.checkReflog = async () => {
      throw new Error(LIMIT_MESSAGE)
    }
    const r = await createDryReprobe(
      world,
      true
    )({
      ...b,
      assume: { closeSession: true }
    })
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).toMatch(/^archive-failed: reflog-limit/)
    expect(wrote).toBe(0)
  })

  it('says the same thing the real reprobe would say', async () => {
    const b = detachedWithSession()
    const world = worldFor(b)
    world.executor.checkReflog = async () => {
      throw new Error(LIMIT_MESSAGE)
    }
    world.executor.archiveReflog = async () => {
      throw new Error(LIMIT_MESSAGE)
    }
    const dry = await createDryReprobe(world, true)({ ...b, assume: { closeSession: true } })
    const { createForcedGcOps } = await import('../src/main/gc/gc-forced-ops')
    const real = await createForcedGcOps(world).reprobe({ ...b, assume: { closeSession: true } })
    expect(dry).toEqual(real)
  })

  it('passes a worktree within the limit, and one with no reflog check available', async () => {
    const b = detachedWithSession()
    const within = worldFor(b)
    within.executor.checkReflog = vi.fn(async () => undefined)
    expect(await createDryReprobe(within, true)({ ...b, assume: { closeSession: true } })).toEqual({
      ok: true
    })
    expect(within.executor.checkReflog).toHaveBeenCalledWith('/ws/org/proj/www', WT)
    // A world that cannot count (an older caller) judges as before.
    expect(
      await createDryReprobe(worldFor(b), true)({ ...b, assume: { closeSession: true } })
    ).toEqual({ ok: true })
  })

  it('does not look at the reflog of a worktree that has a branch', async () => {
    const b = bundle(WT, 'review', { session: 'open-idle' })
    b.item = { ...b.item, branch: 'feat/x', justifiedBy: null, blockers: ['dirty'] }
    const world = worldFor(b)
    world.executor.checkReflog = vi.fn(async () => {
      throw new Error(LIMIT_MESSAGE)
    })
    expect(await createDryReprobe(world, true)({ ...b, assume: { closeSession: true } })).toEqual({
      ok: true
    })
    expect(world.executor.checkReflog).not.toHaveBeenCalled()
  })
})

describe('Close session and remove: the session is NOT parked when the remove cannot run', () => {
  function rig(b = detachedWithSession()) {
    const world = worldFor(b)
    world.executor.checkReflog = async () => {
      throw new Error(LIMIT_MESSAGE)
    }
    const log: string[] = []
    const done: GcJobDone[] = []
    let n = 0
    const deps: ManualCleanDeps = {
      prefs: () => defaultGcPrefs(),
      gather: async () => ({ bundles: [structuredClone(b)], orphanVolumes: [] }),
      gatherFresh: async () => ({ bundles: [structuredClone(b)], orphanVolumes: [] }),
      prepare: async (prep, _b, o) => {
        log.push(`${o?.dry ? 'validate' : 'prepare'} ${prep.kind}`)
        return o?.dry
          ? { ok: true as const }
          : { ok: true as const, undo: async () => void log.push(`undo ${prep.kind}`) }
      },
      dryReprobe: (x, forced) => createDryReprobe(world, true)(x).then((r) => (forced, r)),
      opsFor: () => {
        throw new Error('the remove must not start')
      },
      freshOrphans: async () => [],
      workStampOf: async () => null,
      removeOrphanVolumes: async () => ({
        buildCacheBytes: 0,
        imageBytes: 0,
        volumeBytes: 0,
        errors: []
      }),
      queue: createJobQueue({
        newId: () => `job-${++n}`,
        emitProgress: () => undefined,
        emitDone: (d) => done.push(d)
      }),
      state: createCycleState(),
      now: () => NOW
    }
    return { deps, log, done, b }
  }

  it('refuses with reflog-limit before the session is parked', async () => {
    const r = rig()
    const opts: GcCleanOptions = structuredClone({
      expected: { [r.b.item.id]: expectedOf(r.b) },
      confirmed: [r.b.item.id],
      prepare: { [r.b.item.id]: { kind: 'close-session' } }
    })
    submitManualClean(r.deps, [r.b.item.id], opts)
    await r.deps.queue.idle()
    const res = r.done[0]!.results[0]!
    expect(res).toMatchObject({ ok: false, haltedAt: 'reprobe' })
    expect(res.error).toMatch(/reflog-limit/)
    // Only the validation ran: the session was never closed, and so nothing needed undoing.
    expect(r.log).toEqual(['validate close-session'])
  })
})

// ---- the check itself, against a real repository ---------------------------------------------------

describe('checkReflog is the archiver’s own count, read-only', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  let root: string
  let repo: string
  let wt: string

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'harnu-e3-'))
    repo = path.join(root, 'repo')
    mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.email', 't@example.com')
    git(repo, 'config', 'user.name', 't')
    writeFileSync(path.join(repo, 'f.txt'), 'a\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'A')
    wt = path.join(root, 'wt')
    git(repo, 'worktree', 'add', '-q', '--detach', wt)
    // Three commits only this worktree's reflog reaches.
    const tree = git(repo, 'rev-parse', 'HEAD^{tree}')
    for (let i = 0; i < 3; i++) {
      git(
        wt,
        'update-ref',
        '-m',
        'move',
        'HEAD',
        git(repo, 'commit-tree', tree, '-p', 'HEAD', '-m', `leaf ${i}`)
      )
    }
    git(wt, 'update-ref', '-m', 'back', 'HEAD', git(repo, 'rev-parse', 'main'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const counting = (): { io: ReflogIo; calls: string[][] } => {
    const calls: string[][] = []
    return {
      calls,
      io: {
        run: (cwd, args) => (calls.push(args), defaultReflogIo.run(cwd, args)),
        runIn: (cwd, args, input) => (calls.push(args), defaultReflogIo.runIn(cwd, args, input))
      }
    }
  }

  it('refuses over the limit with the very message the archive step gives, and writes no ref', async () => {
    const c = counting()
    const archiver = createReflogArchiver({ io: c.io, limit: 2 })
    await expect(archiver.check(repo, wt)).rejects.toThrow(/^reflog-limit: .*3 separate lines/s)
    await expect(archiver.archive(repo, 'refs/archive/detached/x/reflog', wt)).rejects.toThrow(
      /^reflog-limit: .*3 separate lines/s
    )
    // The check never asked git to write: no update-ref in any of its calls.
    const checkOnly = counting()
    await createReflogArchiver({ io: checkOnly.io, limit: 2 })
      .check(repo, wt)
      .catch(() => undefined)
    expect(checkOnly.calls.some((a) => a[0] === 'update-ref')).toBe(false)
    expect(git(repo, 'for-each-ref', 'refs/archive').trim()).toBe('')
  })

  it('passes within the limit, and a worktree with nothing to keep', async () => {
    await expect(createReflogArchiver({ limit: 3 }).check(repo, wt)).resolves.toBeUndefined()
    const bare = path.join(root, 'bare')
    git(repo, 'worktree', 'add', '-q', '--detach', bare)
    await expect(createReflogArchiver({ limit: 1 }).check(repo, bare)).resolves.toBeUndefined()
  })
})
