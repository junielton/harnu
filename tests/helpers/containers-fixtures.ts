import type {
  ContainerRow,
  ContainersSnapshot,
  ContainersTombstone,
  ContainersTotals,
  ContainersVerdict,
  StackRow
} from '../../src/preload'

/**
 * Deterministic Containers fixtures (T331), modelled on the approved spec's
 * sample data (`docs/specs/2026-09-10-containers-view/spec.html`). Neutral
 * names only (`proj-*`, `api-gateway-dev`) — see CLAUDE.md "Client
 * confidentiality".
 */

export const NOW = 1_800_000_000_000
export const DAY = 86_400_000
const MB = 1_000_000

export function ctr(over: Partial<ContainerRow> & { id: string; name: string }): ContainerRow {
  return {
    service: null,
    image: 'busybox',
    state: 'running',
    running: true,
    startedAt: NOW - 5 * 3_600_000,
    finishedAt: null,
    memBytes: 10 * MB,
    ports: [],
    volumes: [],
    ...over
  }
}

export function stack(
  over: Partial<StackRow> & { id: string; verdict: ContainersVerdict }
): StackRow {
  const containers = over.containers ?? [ctr({ id: `${over.id}-c1`, name: `${over.id}-app-1` })]
  const running = over.running ?? containers.some((c) => c.running)
  return {
    name: over.id,
    kind: 'compose',
    project: over.id,
    attribution: {
      rung: 'compose-label',
      path: `/home/dev/Workspace/org/proj/www/worktrees/${over.id}`,
      folderPath: `/home/dev/Workspace/org/proj/www/worktrees/${over.id}`,
      folderKind: 'worktree'
    },
    running,
    containers,
    ramBytes: containers.reduce((s, c) => s + (c.running ? (c.memBytes ?? 0) : 0), 0),
    ports: [...new Set(containers.flatMap((c) => (c.running ? c.ports : [])))],
    volumes: [],
    volumeBytes: 0,
    lastSessionActivityAt: NOW - 3 * DAY,
    lastContainerEventAt: NOW - 3 * DAY,
    unusedForMs: over.verdict === 'zombie' || over.verdict === 'pending' ? 3 * DAY : null,
    zombieInMs: null,
    liveSessionId: null,
    ...over
  }
}

export function totalsFor(stacks: StackRow[]): ContainersTotals {
  const ramByVerdict = {
    unknown: 0,
    orphan: 0,
    active: 0,
    protected: 0,
    pending: 0,
    zombie: 0
  } as Record<ContainersVerdict, number>
  let zombieRamBytes = 0
  let volumeBytesAtStake = 0
  let needsYou = 0
  let stoppable = 0
  const ports = new Set<number>()
  for (const s of stacks) {
    ramByVerdict[s.verdict] += s.ramBytes
    if (s.verdict !== 'zombie' && s.verdict !== 'orphan') continue
    needsYou++
    volumeBytesAtStake += s.volumeBytes
    if (!s.running) continue
    stoppable++
    zombieRamBytes += s.ramBytes
    for (const p of s.ports) ports.add(p)
  }
  return {
    zombieRamBytes,
    zombiePorts: ports.size,
    volumeBytesAtStake,
    ramByVerdict,
    needsYou,
    stoppable
  }
}

export function snapshotOf(
  stacks: StackRow[],
  recent: ContainersTombstone[] = []
): ContainersSnapshot {
  return {
    scannedAt: NOW - 120_000,
    dockerAvailable: true,
    zombieAfterDays: 2,
    totals: totalsFor(stacks),
    stacks,
    recent
  }
}

/** The spec's master list, trimmed to one of each shape. */
export function specStacks(): StackRow[] {
  return [
    stack({
      id: 'proj-82',
      verdict: 'zombie',
      containers: [
        ctr({ id: 'a1', name: 'proj-82-app-1', memBytes: 612 * MB, ports: [8082, 5182] }),
        ctr({ id: 'a2', name: 'proj-82-mysql-1', memBytes: 176 * MB, ports: [3382] })
      ],
      volumes: [{ name: 'proj-82_mysql', sizeBytes: 249_200_000, shared: false }],
      volumeBytes: 249_200_000
    }),
    stack({
      id: 'proj-11',
      verdict: 'zombie',
      containers: [
        ctr({
          id: 'b1',
          name: 'proj-11-app-1',
          state: 'exited',
          running: false,
          memBytes: null,
          finishedAt: NOW - 2 * DAY
        })
      ],
      volumes: [{ name: 'proj-11_mysql', sizeBytes: 212_100_000, shared: false }],
      volumeBytes: 212_100_000
    }),
    stack({
      id: 'proj-27',
      verdict: 'orphan',
      attribution: {
        rung: 'compose-label',
        path: '/home/dev/Workspace/org/proj/www/worktrees/PROJ-541-gone',
        folderPath: null,
        folderKind: 'gone'
      },
      containers: [
        ctr({
          id: 'c1',
          name: 'proj-27-app-1',
          state: 'exited',
          running: false,
          memBytes: null,
          finishedAt: NOW - 3 * DAY
        })
      ],
      volumes: [{ name: 'proj-27_mysql', sizeBytes: 657_900_000, shared: false }],
      volumeBytes: 657_900_000,
      unusedForMs: null
    }),
    stack({
      id: 'proj-71',
      verdict: 'active',
      liveSessionId: 'session-71',
      containers: [ctr({ id: 'd1', name: 'proj-71-app-1', memBytes: 548 * MB, ports: [8071] })]
    }),
    stack({
      id: 'proj-20',
      verdict: 'protected',
      attribution: {
        rung: 'compose-label',
        path: '/home/dev/Workspace/org/proj/www',
        folderPath: '/home/dev/Workspace/org/proj/www',
        folderKind: 'main-checkout'
      },
      containers: [ctr({ id: 'e1', name: 'proj-20-app-1', memBytes: 521 * MB, ports: [8020] })]
    }),
    stack({
      id: 'proj-44',
      verdict: 'pending',
      zombieInMs: DAY + 1,
      unusedForMs: 20 * 3_600_000,
      containers: [ctr({ id: 'f1', name: 'proj-44-app-1', memBytes: 90 * MB })]
    }),
    stack({
      id: 'postgres-scratch',
      verdict: 'unknown',
      kind: 'container',
      project: null,
      attribution: { rung: 'none', path: null, folderPath: null, folderKind: null },
      containers: [ctr({ id: 'g1', name: 'postgres-scratch', memBytes: 48 * MB, ports: [5432] })]
    })
  ]
}

export const STOP_TOMB: ContainersTombstone = {
  at: NOW - DAY,
  actor: 'operator',
  verb: 'stop',
  stacks: [
    {
      stack: 'proj-54',
      name: 'proj-54',
      path: '/home/dev/Workspace/org/proj/www/worktrees/PROJ-360-story-cards',
      containerIds: ['3f9a1c', '8b2e44'],
      freed: { ramBytes: 812 * MB, ports: [8054, 3354], volumes: [], volumeBytes: 0 }
    }
  ],
  restoreHint: 'docker start 3f9a1c 8b2e44'
}

export const BULK_TOMB: ContainersTombstone = {
  at: NOW - 60_000,
  actor: 'operator',
  verb: 'stop',
  stacks: ['proj-82', 'proj-33', 'api-gateway-dev'].map((id, i) => ({
    stack: id,
    name: id,
    path: `/home/dev/Workspace/org/proj/www/worktrees/${id}`,
    containerIds: [`${i}a`, `${i}b`, `${i}c`],
    freed: { ramBytes: 500 * MB, ports: [9000 + i], volumes: [], volumeBytes: 0 }
  })),
  restoreHint: 'docker start 0a 0b 0c 1a 1b 1c 2a 2b 2c'
}

export const REMOVE_TOMB: ContainersTombstone = {
  at: NOW - 4 * DAY,
  actor: 'operator',
  verb: 'remove',
  stacks: [
    {
      stack: 'proj-19',
      name: 'proj-19',
      path: '/home/dev/Workspace/org/proj/www/worktrees/PROJ-377-blog-foundation',
      containerIds: ['x1', 'x2', 'x3', 'x4'],
      freed: { ramBytes: 0, ports: [], volumes: [], volumeBytes: 0 },
      keptVolumes: ['proj-19_mysql'],
      keptVolumeBytes: 233_500_000
    }
  ],
  restoreHint:
    'docker compose --project-directory /home/dev/Workspace/org/proj/www/worktrees/PROJ-377-blog-foundation up -d'
}
