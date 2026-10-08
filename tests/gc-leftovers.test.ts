import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  leftBehind,
  pruneLeftovers,
  readLeftovers,
  toDirMap,
  withLeftovers,
  writeLeftovers
} from '../src/main/gc/gc-leftovers'
import { planHousekeeping, type HousekeepingVolume } from '../src/main/gc/housekeeping-core'
import { orphanVolumeItems } from '../src/main/gc/gc-housekeeping-input'
import { createCycleState, runGcCycle, type GcCycleDeps } from '../src/main/gc/gc-cycle'
import { createJobQueue } from '../src/main/gc/gc-jobs-core'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { GcOps } from '../src/main/gc/pipeline-core'
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  type InspectedContainer
} from '../src/main/containers/containers-core'
import { bundle, NOW } from './gc-fixtures'

// D1 (2026-10-08): worktree cleanup never removes a volume. What it leaves behind has to
// show up as an orphan volume for the operator to decide on. After the stack's containers are
// gone, nothing on the machine says which folder the project ran from, so the cleanup
// remembers it.

const WT = '/ws/org/proj/worktrees/PROJ-0000-slug'
const PROJECT = 'proj-0000-slug'
const volume = (name: string, project: string | null = PROJECT): HousekeepingVolume => ({
  name,
  project,
  sizeBytes: 4_096
})

describe('leftBehind: what a cleaned worktree leaves in Docker', () => {
  it('lists one entry per project, with the worktree folder it ran from', () => {
    const b = bundle(WT, 'ready', { stackIds: [PROJECT], ownedVolumes: ['a_data', 'b_data'] })
    const out = leftBehind(b, [volume('a_data'), volume('b_data'), volume('c_data', 'other')])
    expect(out).toEqual([{ project: PROJECT, dir: WT }])
  })

  it('skips a volume without a project label: nothing could tie it to the folder', () => {
    const b = bundle(WT, 'ready', { ownedVolumes: ['a_data'] })
    expect(leftBehind(b, [volume('a_data', null)])).toEqual([])
  })

  it('skips a volume it has no fact for, and a bundle without a path', () => {
    expect(leftBehind(bundle(WT, 'ready', { ownedVolumes: ['ghost'] }), [])).toEqual([])
  })
})

describe('the remembered folders', () => {
  it('adds a dir to a project without duplicating it', () => {
    let file = withLeftovers({ version: 1, projects: {} }, [{ project: 'p', dir: '/a' }])
    file = withLeftovers(file, [
      { project: 'p', dir: '/a' },
      { project: 'p', dir: '/b' }
    ])
    expect(file.projects).toEqual({ p: ['/a', '/b'] })
  })

  it('forgets a project once none of its volumes is left in Docker', () => {
    const file = { version: 1 as const, projects: { p: ['/a'], q: ['/b'] } }
    expect(pruneLeftovers(file, [volume('x', 'p')]).projects).toEqual({ p: ['/a'] })
  })

  it('turns into the dir map the orphan planner reads', () => {
    expect(toDirMap({ version: 1, projects: { p: ['/a'] } })).toEqual(new Map([['p', ['/a']]]))
  })

  it('survives a missing, empty or junk file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gc-left-'))
    try {
      expect(readLeftovers(join(dir, 'none.json'))).toEqual({ version: 1, projects: {} })
      writeFileSync(join(dir, 'junk.json'), '{"projects": 7}')
      expect(readLeftovers(join(dir, 'junk.json'))).toEqual({ version: 1, projects: {} })
      writeFileSync(join(dir, 'half.json'), '{"projects": {"p": ["/a", 3], "q": "x"}}')
      expect(readLeftovers(join(dir, 'half.json')).projects).toEqual({ p: ['/a'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('round-trips through the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gc-left-'))
    try {
      const file = withLeftovers({ version: 1, projects: {} }, [{ project: 'p', dir: '/a' }])
      writeLeftovers(join(dir, 'l.json'), file)
      expect(readLeftovers(join(dir, 'l.json'))).toEqual(file)
      expect(readFileSync(join(dir, 'l.json'), 'utf8').endsWith('\n')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

const ORPHANS_ON = { cacheMaxAgeDays: 7, danglingImages: true, orphanVolumes: true }

describe("a cleaned worktree's volume surfaces for review on the next gather (D1)", () => {
  const containerOf: InspectedContainer = {
    id: 'c'.repeat(64),
    name: `${PROJECT}-db-1`,
    image: 'postgres:16',
    labels: { [COMPOSE_PROJECT_LABEL]: PROJECT, [COMPOSE_WORKING_DIR_LABEL]: WT },
    state: 'exited',
    startedAt: null,
    finishedAt: null,
    createdAt: null,
    ports: [],
    mounts: []
  } as InspectedContainer

  it('is not an orphan while the containers still tell where the project ran', () => {
    const plan = planHousekeeping(ORPHANS_ON, [volume('proj_data')], [containerOf], () => false, [])
    expect(plan.orphanVolumes).toEqual(['proj_data'])
  })

  it('is invisible once the containers are gone, unless the folder was remembered', () => {
    const none = planHousekeeping(ORPHANS_ON, [volume('proj_data')], [], () => false, [])
    expect(none.orphanVolumes).toEqual([])
    const remembered = new Map([[PROJECT, [WT]]])
    const plan = planHousekeeping(
      ORPHANS_ON,
      [volume('proj_data')],
      [],
      () => false,
      [],
      new Set(),
      remembered
    )
    expect(plan.orphanVolumes).toEqual(['proj_data'])
  })

  it('stays out of the way when the remembered folder exists again', () => {
    const plan = planHousekeeping(
      ORPHANS_ON,
      [volume('proj_data')],
      [],
      (p) => p === WT,
      [],
      new Set(),
      new Map([[PROJECT, [WT]]])
    )
    expect(plan.orphanVolumes).toEqual([])
  })

  it('still keeps it when a live folder shares the project name', () => {
    const plan = planHousekeeping(
      ORPHANS_ON,
      [volume('proj_data')],
      [],
      (p) => p !== WT,
      ['/ws/org/other/PROJ-0000-slug'],
      new Set(),
      new Map([[PROJECT, [WT]]])
    )
    expect(plan.orphanVolumes).toEqual([])
  })

  it('still keeps it when a live folder pins the project name', () => {
    const plan = planHousekeeping(
      ORPHANS_ON,
      [volume('proj_data')],
      [],
      () => false,
      [],
      new Set([PROJECT]),
      new Map([[PROJECT, [WT]]])
    )
    expect(plan.orphanVolumes).toEqual([])
  })

  it('is offered as a review item with its size and project, ready to be confirmed per id', () => {
    const items = orphanVolumeItems(
      ['proj_data'],
      new Map([['proj_data', { sizeBytes: 4_096, project: PROJECT }]])
    )
    expect(items[0]).toMatchObject({
      id: 'volume:proj_data',
      sizeBytes: 4_096,
      project: PROJECT,
      reason: { code: 'no-known-worktree' }
    })
  })
})

describe('the cycle remembers what it leaves behind (D1)', () => {
  function rig(over: Partial<GcOps> = {}) {
    const removed: string[][] = []
    const remembered: Array<{ project: string; dir: string }> = []
    const ops: GcOps = {
      reprobe: async () => ({ ok: true }),
      stopStacks: async () => undefined,
      removeContainers: async () => undefined,
      removeVolumes: async (names) => {
        removed.push(names)
      },
      dropDeps: async () => 0,
      recheck: async () => ({ ok: true }),
      cleanGit: async () => undefined,
      ...over
    }
    let n = 0
    const b = bundle(WT, 'ready', { stackIds: [PROJECT], ownedVolumes: ['proj_data'] })
    const deps: GcCycleDeps = {
      prefs: () => ({ ...defaultGcPrefs(), autopilot: true, firstReportAcknowledged: true }),
      gather: async () => ({
        bundles: [b],
        housekeeping: {
          volumes: [volume('proj_data')],
          containers: [],
          dirExists: () => true,
          knownFolders: [],
          protectedProjects: new Set(),
          rememberedDirs: new Map()
        }
      }),
      opsFor: () => ops,
      queue: createJobQueue({
        newId: () => `j${++n}`,
        emitProgress: () => undefined,
        emitDone: () => undefined
      }),
      housekeeping: vi.fn(async () => ({
        buildCacheBytes: 0,
        imageBytes: 0,
        volumeBytes: 0,
        errors: []
      })),
      rememberLeftovers: (entries) => remembered.push(...entries),
      notify: () => undefined,
      emitCycle: () => undefined,
      state: createCycleState(),
      now: () => NOW
    }
    return { deps, removed, remembered }
  }

  it('records the project and folder of a worktree it cleaned, and removes no volume', async () => {
    const r = rig()
    await runGcCycle(r.deps, 'timer')
    expect(r.remembered).toEqual([{ project: PROJECT, dir: WT }])
    expect(r.removed).toEqual([])
  })

  it('records nothing for a worktree whose cleanup halted', async () => {
    const r = rig({
      reprobe: async () => ({ ok: false, reason: 'session-open' })
    })
    await runGcCycle(r.deps, 'timer')
    expect(r.remembered).toEqual([])
  })
})
