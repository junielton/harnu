/**
 * Shared fixtures for the Containers tests (T330). Not a test file itself —
 * `vitest.config.mts` only collects `*.test.ts`. Paths use the neutral
 * vocabulary from CLAUDE.md (`org/proj/www`, `PROJ-231`).
 */
import {
  COMPOSE_PROJECT_LABEL,
  COMPOSE_SERVICE_LABEL,
  COMPOSE_WORKING_DIR_LABEL,
  type GitCheckout,
  type InspectedContainer,
  type KnownFolder,
  type ScanInput
} from '../src/main/containers/containers-core'
import type {
  ContainerRow,
  ContainersSnapshotAvailable,
  StackRow
} from '../src/main/containers/containers-wire'

export const NOW = Date.parse('2026-09-11T12:00:00.000Z')
export const DAY = 86_400_000
export const HOUR = 3_600_000

export const MAIN = '/home/dev/org/proj/www'
export const WT = `${MAIN}/.claude/worktrees/PROJ-231-wave-1`
export const WT2 = `${MAIN}/.claude/worktrees/PROJ-347-wave-2`
export const GONE = `${MAIN}/.claude/worktrees/PROJ-231-wave-0`

let seq = 0

/** A full-length (64-hex) container id, unique per call. */
export function nextId(): string {
  seq += 1
  return seq.toString(16).padStart(8, '0') + 'c'.repeat(56)
}

export function container(over: Partial<InspectedContainer> = {}): InspectedContainer {
  const id = over.id ?? nextId()
  return {
    name: `ctr-${id.slice(0, 6)}`,
    image: 'busybox',
    labels: {},
    state: 'running',
    startedAt: NOW - 10 * DAY,
    finishedAt: null,
    createdAt: NOW - 10 * DAY,
    ports: [],
    mounts: [],
    ...over,
    id
  }
}

export function composeContainer(
  project: string,
  workingDir: string | null,
  over: Partial<InspectedContainer> & { service?: string } = {}
): InspectedContainer {
  const { service = 'app', ...rest } = over
  return container({
    name: `${project}-${service}-1`,
    ...rest,
    labels: {
      [COMPOSE_PROJECT_LABEL]: project,
      [COMPOSE_SERVICE_LABEL]: service,
      ...(workingDir ? { [COMPOSE_WORKING_DIR_LABEL]: workingDir } : {}),
      ...(rest.labels ?? {})
    }
  })
}

export function knownFolder(path: string, over: Partial<KnownFolder> = {}): KnownFolder {
  return { path, lastActivityAt: null, liveSessionId: null, ...over }
}

const under = (p: string, root: string): boolean => p === root || p.startsWith(`${root}/`)

/**
 * What git would say in the fixture world: WT, WT2 (and the deleted GONE) are
 * linked worktrees of MAIN; anything else under MAIN is the main checkout;
 * anything outside MAIN is not a repo.
 */
export function fixtureGitCheckout(p: string): GitCheckout | null {
  if ([WT, WT2, GONE].some((w) => under(p, w))) return 'linked'
  return under(p, MAIN) ? 'main' : null
}

export function scanInput(over: Partial<ScanInput> = {}): ScanInput {
  return {
    containers: [],
    memById: new Map(),
    volumes: new Map(),
    folders: [knownFolder(MAIN), knownFolder(WT), knownFolder(WT2)],
    pathExists: (p) => !under(p, GONE),
    gitCheckout: fixtureGitCheckout,
    harnuStoppedAt: new Map(),
    now: NOW,
    zombieAfterDays: 2,
    recent: [],
    platform: 'linux',
    ...over
  }
}

export function containerRow(over: Partial<ContainerRow> = {}): ContainerRow {
  const id = over.id ?? nextId()
  const running = over.running ?? true
  return {
    name: `ctr-${id.slice(0, 6)}`,
    service: 'app',
    image: 'busybox',
    state: running ? 'running' : 'exited',
    running,
    startedAt: NOW - 10 * DAY,
    finishedAt: running ? null : NOW - 5 * DAY,
    memBytes: running ? 100_000_000 : null,
    ports: running ? [8080] : [],
    volumes: [],
    ...over,
    id
  }
}

/** A stack row with a chosen verdict — the action tests control tiers directly. */
export function stackRow(over: Partial<StackRow> & { id: string; running?: boolean }): StackRow {
  const running = over.running ?? true
  const containers = over.containers ?? [containerRow({ running })]
  const gone = over.verdict === 'orphan'
  return {
    name: over.id,
    kind: 'compose',
    project: over.id,
    attribution: {
      rung: over.verdict === 'unknown' ? 'none' : 'compose-label',
      path: over.verdict === 'unknown' ? null : gone ? GONE : WT,
      folderPath: over.verdict === 'unknown' || gone ? null : WT,
      folderKind: over.verdict === 'unknown' ? null : gone ? 'gone' : 'worktree'
    },
    verdict: 'zombie',
    ramBytes: containers.reduce((s, c) => s + (c.memBytes ?? 0), 0),
    ports: [...new Set(containers.flatMap((c) => c.ports))],
    volumes: [],
    volumeBytes: 0,
    lastSessionActivityAt: null,
    lastContainerEventAt: NOW - 10 * DAY,
    unusedForMs: 10 * DAY,
    zombieInMs: null,
    liveSessionId: null,
    ...over,
    running: containers.some((c) => c.running),
    containers
  }
}

export function available(stacks: StackRow[]): ContainersSnapshotAvailable {
  return {
    scannedAt: NOW,
    dockerAvailable: true,
    zombieAfterDays: 2,
    totals: {
      zombieRamBytes: 0,
      zombiePorts: 0,
      volumeBytesAtStake: 0,
      ramByVerdict: { unknown: 0, orphan: 0, active: 0, protected: 0, pending: 0, zombie: 0 },
      needsYou: 0,
      stoppable: 0
    },
    stacks,
    recent: []
  }
}
