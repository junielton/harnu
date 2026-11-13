/**
 * Every periodic main-process job and fleet-wide renderer computed the suite measures (T697).
 *
 * Each case runs the REAL function against the generated fleet, with injected fakes only for the
 * things that are not the job's own cost (a judge process, a store file). A case that reaches into
 * the same fleet dimension from inside a loop over another one (a probe of every slug for each
 * session) fails the growth check as well as the 50 ms limit: P4.
 *
 * To cover a new job: add a case here, and, if the job is a timer in `src/main`, remove its entry
 * from `UNCOVERED_TIMERS` in `tests/perf/timer-coverage.perf.ts`.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

import { mainCheckoutRoot } from '../../src/main/data-dir'
import { missionOwnersWithLiveChildren } from '../../src/main/hibernation'
import { createTranscriptLocator } from '../../src/main/your-move/locate'
import { createGateWatch } from '../../src/main/your-move/source-gate'
import { createMidTurnSweep } from '../../src/main/your-move/triggers'
import { emptyState } from '../../src/main/your-move/core'
import type { YourMoveStore } from '../../src/main/your-move/store'
import type { TaskState } from '../../src/main/hook-state'
import { partitionShelved, type ShelvedSource } from '../../src/renderer/src/lib/shelved-sidebar'
import {
  classifyFolder,
  groupByRepo,
  nestByLineage
} from '../../src/renderer/src/stores/folder-zones'
import type { PerfCase, JobContext } from './support/harness'
import type { ScaleFixture } from './support/scale-fixture'

// ---- main process ----------------------------------------------------------------------------

/** `$HOME` for the duration of the suite: the jobs read `os.homedir()`. Restored by `restoreHome()`. */
const realHome = process.env.HOME
export const restoreHome = (): void => {
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
}

/** The task-state hub of the real app: every known session has a state, the live ones are working. */
function taskStates(f: ScaleFixture): Map<string, TaskState> {
  const live = new Set(f.liveSessionIds)
  const m = new Map<string, TaskState>()
  for (const id of f.knownSessionIds) m.set(id, live.has(id) ? 'working' : 'idle')
  for (const id of f.liveSessionIds) m.set(id, 'working')
  return m
}

/**
 * The real transcript locator of the app, pointed at the fixture's `~/.claude/projects` and cut
 * off once the case's deadline passes so a regressed job stays fast. A fresh one per case, so no
 * index survives from a previous run.
 */
const locateFor = (ctx: JobContext): ((id: string) => Promise<string | null>) => {
  const locator = createTranscriptLocator({
    root: path.join(ctx.fixture.home, '.claude', 'projects'),
    fs: { readdir: (dir) => fs.readdir(dir) },
    now: () => Date.now()
  })
  return (id) => (ctx.expired() ? Promise.resolve(null) : locator.locate(id))
}

const fakeStore = (): YourMoveStore =>
  ({
    state: () => emptyState(),
    transact: async (decide: (s: ReturnType<typeof emptyState>) => { result: unknown }) =>
      decide(emptyState()).result,
    onChange: () => () => undefined
  }) as unknown as YourMoveStore

const noRead = (async () => ({ lines: [], nextOffset: 0, size: 0, shrunk: false })) as never

const gateTick: PerfCase = {
  id: 'main/your-move-gate-tick',
  thread: 'main',
  describes: 'Your move human-gate sweep (every 60 s): finds the transcript of every known session',
  prepare(ctx) {
    process.env.HOME = ctx.fixture.home
    const states = taskStates(ctx.fixture)
    const gate = createGateWatch({
      store: fakeStore(),
      mode: () => 'live',
      lane: () => 'live',
      eligible: async () => true,
      locate: locateFor(ctx),
      resolveFolder: async () => '/fixture/folder',
      read: noRead,
      size: async () => 0,
      states: () => states,
      mintId: () => 'card',
      now: () => Date.now()
    })
    return async () => {
      await gate.tick()
      gate.dispose()
    }
  }
}

const midTurnSweep: PerfCase = {
  id: 'main/your-move-mid-turn-sweep',
  thread: 'main',
  describes: 'Your move mid-turn sweep (every 60 s): finds the transcript of every working session',
  prepare(ctx) {
    process.env.HOME = ctx.fixture.home
    const states = taskStates(ctx.fixture)
    const sweep = createMidTurnSweep({
      inspector: { request: async () => 'inspected' as never },
      store: { state: () => emptyState() },
      mode: () => 'live',
      eligible: async () => true,
      locate: locateFor(ctx),
      resolveFolder: async () => '/fixture/folder',
      read: noRead,
      states: () => states,
      now: () => Date.now()
    })
    return async () => {
      await sweep.tick()
      sweep.dispose()
    }
  }
}

const missionOwners: PerfCase = {
  id: 'main/hibernation-mission-owners',
  thread: 'main',
  describes:
    'Hibernation sweep (every 60 s and at each spawn): reads every open mission of the live fleet',
  prepare(ctx) {
    const sessions = ctx.fixture.liveSessionIds.map((sessionKey, i) => ({
      sessionKey,
      cwd: ctx.fixture.worktrees[i % ctx.fixture.worktrees.length].path
    }))
    return () => {
      missionOwnersWithLiveChildren(sessions)
    }
  }
}

const checkoutRoots: PerfCase = {
  id: 'main/main-checkout-root',
  thread: 'main',
  describes: 'mainCheckoutRoot for every worktree (statSync walk, several times a minute)',
  prepare(ctx) {
    const dirs = ctx.fixture.worktrees.map((w) => `${w.path}/src/deep/nest`)
    return () => {
      for (const d of dirs) mainCheckoutRoot(d)
    }
  }
}

export const MAIN_CASES: PerfCase[] = [gateTick, midTurnSweep, missionOwners, checkoutRoots]

// ---- renderer --------------------------------------------------------------------------------

interface FleetSession {
  sessionId: string
  status: 'active' | 'idle' | 'archived'
  taskState?: TaskState
  modified: string
  isShellTerminal?: boolean
  isSidechain?: boolean
}
interface FleetFolder {
  path: string
  pinned: boolean
  repoId?: string
  isMainWorktree?: boolean
  gitListed?: boolean
  bornFrom?: string
  sessions: FleetSession[]
}

/**
 * What the sessions store holds at reference scale: one folder per slug with its sessions, the main
 * checkout of a repo with its linked worktrees (some cut by the orchestrator at the main one), and
 * the folders of shelved worktrees, which the scan still reports because their transcripts remain.
 */
function fleetFolders(
  f: ScaleFixture,
  reads?: { n: number }
): { folders: FleetFolder[]; shelved: ShelvedSource[] } {
  const repoPath = '/home/dev/Workspace/org/main'
  const repoId = `${repoPath}/.git`
  const perFolder = Math.max(1, Math.round(f.spec.knownSessions / f.spec.slugs))
  const mk = (folder: number, n: number): FleetSession => ({
    sessionId: `s-${folder}-${n}`,
    status: n === 0 && folder % 40 === 0 ? 'active' : 'idle',
    taskState: n === 0 && folder % 40 === 0 ? 'working' : 'idle',
    modified: new Date(1_760_000_000_000 + folder * 60_000 + n).toISOString()
  })
  const folders: FleetFolder[] = []
  for (let i = 0; i < f.spec.slugs; i++) {
    folders.push({
      path: `/home/dev/Workspace/org/proj${i}/www`,
      pinned: i % 25 === 0,
      sessions: Array.from({ length: perFolder }, (_, n) => mk(i, n))
    })
  }
  folders.push({
    path: repoPath,
    pinned: true,
    repoId,
    isMainWorktree: true,
    sessions: [mk(9000, 0)]
  })
  for (let w = 0; w < f.spec.worktrees; w++) {
    folders.push({
      path: `/home/dev/Workspace/org/main-wt${w}`,
      pinned: false,
      repoId,
      gitListed: true,
      bornFrom: repoPath,
      sessions: [mk(9100 + w, 0), mk(9100 + w, 1)]
    })
  }
  const shelved: ShelvedSource[] = []
  for (let w = 0; w < f.spec.worktrees; w++) {
    const worktreePath = `/home/dev/Workspace/org/main-shelved${w}`
    folders.push({ path: worktreePath, pinned: false, repoId, sessions: [mk(9500 + w, 0)] })
    shelved.push({
      id: `shelved-${w}`,
      repoPath,
      worktreePath,
      branch: `card/T${w}-old`,
      shelvedAt: 1_760_000_000_000 - w * 86_400_000
    })
  }
  // The counting pass: every read of a folder's path is counted, so a loop over every folder inside a
  // loop over every shelved worktree is an exact quadratic, not a timing.
  if (reads) {
    for (const fo of folders) {
      const path = fo.path
      Object.defineProperty(fo, 'path', {
        get() {
          reads.n++
          return path
        }
      })
    }
  }
  return { folders, shelved }
}

const partitionCase: PerfCase = {
  id: 'renderer/partition-shelved',
  thread: 'renderer',
  describes: 'sidebar shelvedPartition computed: every folder against every shelved worktree',
  prepare(ctx) {
    const { folders, shelved } = fleetFolders(ctx.fixture, ctx.counting ? ctx.reads : undefined)
    return () => {
      partitionShelved(folders, shelved, 1_760_000_000_000)
    }
  }
}

const groupingCase: PerfCase = {
  id: 'renderer/zones-and-repo-groups',
  thread: 'renderer',
  describes: 'sidebar zone classification and repo grouping of the whole fleet',
  prepare(ctx) {
    const { folders } = fleetFolders(ctx.fixture, ctx.counting ? ctx.reads : undefined)
    const zoneCtx = {
      nowMs: 1_760_000_000_000,
      activeWindowMs: 3_600_000,
      hiddenPaths: new Set<string>(),
      livePtySessionIds: new Set(ctx.fixture.liveSessionIds)
    }
    return () => {
      const listed = folders.filter((fo) => classifyFolder(fo, zoneCtx) !== 'hidden')
      groupByRepo(listed, new Set(), {}, new Map())
    }
  }
}

const lineageCase: PerfCase = {
  id: 'renderer/nest-by-lineage',
  thread: 'renderer',
  describes: 'sidebar worktree lineage nesting of the whole fleet',
  prepare(ctx) {
    const { folders } = fleetFolders(ctx.fixture, ctx.counting ? ctx.reads : undefined)
    return () => {
      nestByLineage(folders, new Set())
    }
  }
}

export const RENDERER_CASES: PerfCase[] = [partitionCase, groupingCase, lineageCase]

export const ALL_CASES: PerfCase[] = [...MAIN_CASES, ...RENDERER_CASES]
