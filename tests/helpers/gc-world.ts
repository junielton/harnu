// A fake world for the GC engine that answers as one bundle's own facts say, so the real
// reprobe and pipeline decide on those facts alone. Shared by the parity and the Docker tests.

import type { SessionPresence, WorktreeBundle } from '../../src/main/gc/bundle-core'
import type { GcShellDeps } from '../../src/main/gc/gc-shell'
import type { DehydrateDeps } from '../../src/main/reaper/dehydrate-core'
import type { ExecutorDeps } from '../../src/main/reaper/executor-core'
import {
  COMPOSE_WORKING_DIR_LABEL,
  type InspectedContainer,
  type StackGroup
} from '../../src/main/containers/containers-core'
import { NOW, REPO } from '../gc-fixtures'

export const WT = '/ws/org/proj/worktrees/PROJ-0000-slug'
export const TIP = 'a'.repeat(40)

function container(id: string, dir: string): InspectedContainer {
  return {
    id,
    name: `ctr-${id}`,
    image: 'postgres:16',
    labels: { [COMPOSE_WORKING_DIR_LABEL]: dir },
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    createdAt: 1,
    ports: [],
    mounts: []
  }
}

/** Every dependency answers as the bundle's own facts say, so the engine decides on facts alone. */
export function worldFor(b: WorktreeBundle, over: Partial<GcShellDeps> = {}): GcShellDeps {
  const path = b.item.path ?? WT
  let stacks: StackGroup[] = b.stackIds.map((id) => ({
    id,
    name: id,
    kind: 'compose',
    project: id,
    containers: [container(`${id}-c1`, `${path}/api`)]
  }))
  const executor: ExecutorDeps = {
    probeStatus: async () => ({
      trackedDirty: b.item.blockers.includes('dirty'),
      untracked: []
    }),
    hasUnpushed: async () => b.item.blockers.includes('unpushed'),
    trash: async () => undefined,
    git: async () => '',
    resolveSha: async () => TIP,
    archiveTip: async (_repo, ref) => ref,
    archiveWip: async (_repo, ref) => ref,
    detachSidebar: async () => undefined,
    canUnregister: async () => !(b.locked === true || b.reason?.code === 'locked'),
    removeWorktreeAdmin: async () => true,
    appendTombstone: async () => undefined,
    now: () => NOW
  }
  const dehydrate: DehydrateDeps = {
    isSessionLive: async () => false,
    readManifest: async () => ({ ephemeral: ['node_modules'], setup: [] }),
    probeEntries: async () => [
      { path: 'node_modules', presence: 'dir', contained: true, ignored: true, tracked: false }
    ],
    trackedFingerprint: async () => new Map(),
    removeDir: async () => undefined,
    recordDehydrated: async () => undefined
  }
  const ok = (done: string[]): { done: string[]; error: null } => ({ done, error: null })
  return {
    executor,
    dehydrate,
    docker: {
      stop: async (ids) => ok(ids),
      removeContainers: async (ids) => {
        // As docker does: a removed container is gone from every later listing.
        stacks = stacks
          .map((s) => ({ ...s, containers: s.containers.filter((c) => !ids.includes(c.id)) }))
          .filter((s) => s.containers.length > 0)
        return ok(ids)
      },
      removeVolumes: async (names) => ok(names)
    },
    listStacks: async () => ({ stacks }),
    presenceOf: async (): Promise<SessionPresence> => b.session,
    headOf: async () => (typeof b.localTip === 'string' ? b.localTip : null),
    isProtectedNow: () => false,
    realpath: async (p) => (p === b.item.path && !b.pathsResolved ? null : p),
    listWorktrees: async () => [REPO, path, ...b.nestedWorktrees],
    findForeignCheckouts: async () => b.foreignCheckouts,
    ...over
  }
}
