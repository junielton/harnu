import { describe, it, expect, vi } from 'vitest'
import { AS_GIVEN, buildBundles } from '../src/main/gc/bundle-core'
import { createCycleState, runGcCycle, type GcCycleDeps } from '../src/main/gc/gc-cycle'
import { createJobQueue } from '../src/main/gc/gc-jobs-core'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { volumeGuards } from '../src/main/gc/gc-housekeeping-input'
import type { GcOps } from '../src/main/gc/pipeline-core'
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  groupStacks,
  type InspectedContainer,
  type VolumeFact
} from '../src/main/containers/containers-core'
import { NOW, WT, collect, scanInput } from './gc-scan-fixtures'

// The graders' scenario (T441 delta 1, item 1): a ready item worktree and a live sibling share a
// compose project, the ready item owns the only containers, and the project's volume holds the
// sibling's data. With the default prefs the autopilot must NOT remove that volume.

const PROJECT = 'proj-0000-slug'
const VOLUME = `${PROJECT}_pgdata`

const container: InspectedContainer = {
  id: 'c'.repeat(64),
  name: `${PROJECT}-db-1`,
  image: 'postgres:16',
  labels: { [COMPOSE_PROJECT_LABEL]: PROJECT, [COMPOSE_WORKING_DIR_LABEL]: WT },
  state: 'exited',
  startedAt: NOW - 20 * 86_400_000,
  finishedAt: NOW - 19 * 86_400_000,
  createdAt: NOW - 20 * 86_400_000,
  ports: [],
  mounts: [{ type: 'volume', name: VOLUME, source: '/var/lib/docker/volumes/x/_data' }]
} as InspectedContainer

const df = new Map<string, VolumeFact>([[VOLUME, { sizeBytes: 5_000, project: PROJECT }]])

type Sibling = { path: string; env?: string; compose?: string }

/** Bundles for the ready item worktree, built the way the gather builds them. */
function bundlesWith(siblings: Sibling[]) {
  const { items, fateInputs } = collect(scanInput())
  const guards = volumeGuards([{ path: WT }, ...siblings], () => true)
  return buildBundles({
    items,
    fateInputs,
    stacks: groupStacks([container]),
    stackPaths: new Map(),
    containers: [container],
    sessions: new Map(),
    keep: new Set(),
    neverClean: new Set(),
    now: NOW,
    graceDays: 2,
    volumes: df,
    knownFolders: guards.knownFolders,
    protectedProjects: guards.protectedProjects,
    canonical: AS_GIVEN
  })
}

function cycleOver(bundles: ReturnType<typeof bundlesWith>) {
  const removed: string[][] = []
  const ops: GcOps = {
    reprobe: async () => ({ ok: true }),
    stopStacks: async () => undefined,
    removeContainers: async () => undefined,
    removeVolumes: async (names) => {
      removed.push(names)
    },
    dropDeps: async () => 0,
    recheck: async () => ({ ok: true }),
    cleanGit: async () => undefined
  }
  let n = 0
  const deps: GcCycleDeps = {
    prefs: () => ({ ...defaultGcPrefs(), autopilot: true, firstReportAcknowledged: true }),
    gather: async () => ({
      bundles,
      housekeeping: {
        volumes: [],
        containers: [],
        dirExists: () => true,
        knownFolders: [],
        protectedProjects: new Set()
      }
    }),
    opsFor: () => ops,
    queue: createJobQueue({
      newId: () => `job-${++n}`,
      emitProgress: () => undefined,
      emitDone: () => undefined
    }),
    housekeeping: vi.fn(async () => ({
      buildCacheBytes: 0,
      imageBytes: 0,
      volumeBytes: 0,
      errors: []
    })),
    notify: () => undefined,
    emitCycle: () => undefined,
    state: createCycleState(),
    now: () => NOW
  }
  return { deps, removed }
}

describe('the autopilot never removes a volume a live sibling shares (delta 1, item 1)', () => {
  it('baseline: with no sibling the ready item owns the volume, and the cycle still removes nothing (D1)', async () => {
    const bundles = bundlesWith([])
    expect(bundles[0]!.bucket).toBe('ready')
    expect(bundles[0]!.ownedVolumes).toEqual([VOLUME])
    const { deps, removed } = cycleOver(bundles)
    await runGcCycle(deps, 'timer')
    // D1: worktree cleanup never removes a volume. It is offered for review afterwards.
    expect(removed).toEqual([])
  })

  it('a sibling folder with the same basename (the same default project) keeps the volume', async () => {
    const bundles = bundlesWith([{ path: '/ws/org/other/PROJ-0000-slug' }])
    expect(bundles[0]!.ownedVolumes).toEqual([])
    const { deps, removed } = cycleOver(bundles)
    await runGcCycle(deps, 'timer')
    expect(removed).toEqual([])
  })

  it('a sibling that pins the project in its .env keeps the volume', async () => {
    const bundles = bundlesWith([
      { path: '/ws/org/other/app', env: `COMPOSE_PROJECT_NAME=${PROJECT}\n` }
    ])
    expect(bundles[0]!.ownedVolumes).toEqual([])
    const { deps, removed } = cycleOver(bundles)
    await runGcCycle(deps, 'timer')
    expect(removed).toEqual([])
  })

  it('a sibling that pins it with a compose name: keeps the volume', async () => {
    const bundles = bundlesWith([{ path: '/ws/org/other/app', compose: `name: ${PROJECT}\n` }])
    expect(bundles[0]!.ownedVolumes).toEqual([])
  })

  it('a sibling whose folder is gone does not protect anything', async () => {
    const { items, fateInputs } = collect(scanInput())
    const guards = volumeGuards(
      [
        { path: WT },
        { path: '/ws/org/other/PROJ-0000-slug', env: `COMPOSE_PROJECT_NAME=${PROJECT}` }
      ],
      (p) => p === WT
    )
    const [b] = buildBundles({
      items,
      fateInputs,
      stacks: groupStacks([container]),
      stackPaths: new Map(),
      containers: [container],
      sessions: new Map(),
      keep: new Set(),
      neverClean: new Set(),
      now: NOW,
      graceDays: 2,
      volumes: df,
      knownFolders: guards.knownFolders,
      protectedProjects: guards.protectedProjects,
      canonical: AS_GIVEN
    })
    expect(b!.ownedVolumes).toEqual([VOLUME])
  })
})
