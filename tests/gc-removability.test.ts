// The Remove predicate against main's real refusal functions. The renderer never imports main code,
// so `removability` re-states main's rules from the facts a bundle carries; this table runs the same
// bundles through `refusalFor` and the real forced pipeline, so a rule added or changed on either
// side fails here instead of showing up as "0 cleaned · N need review".

import { describe, expect, it } from 'vitest'
import type { SessionPresence, WorktreeBundle } from '../src/main/gc/bundle-core'
import { refusalFor } from '../src/main/gc/autopilot-core'
import { createForcedGcOps } from '../src/main/gc/gc-forced-ops'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { createGcOps, type GcShellDeps } from '../src/main/gc/gc-shell'
import { runBundle } from '../src/main/gc/pipeline-core'
import type { DehydrateDeps } from '../src/main/reaper/dehydrate-core'
import type { ExecutorDeps } from '../src/main/reaper/executor-core'
import {
  COMPOSE_WORKING_DIR_LABEL,
  type InspectedContainer,
  type StackGroup
} from '../src/main/containers/containers-core'
import {
  bundleRemovability,
  removability,
  shellQuote,
  type RemovalRefusal
} from '../src/renderer/src/lib/gc-removability'
import { buildGcModel } from '../src/renderer/src/lib/gc-model'
import { bundle, DAY, NOW, REPO, reapItem } from './gc-fixtures'

const WT = '/ws/org/proj/worktrees/PROJ-0000-slug'
const TIP = 'a'.repeat(40)

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
function worldFor(b: WorktreeBundle): GcShellDeps {
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
    findForeignCheckouts: async () => b.foreignCheckouts
  }
}

/** What `gc:clean` does with one confirmed id, as `submitManualClean` decides it. */
async function mainSays(b: WorktreeBundle): Promise<string | null> {
  const hard = refusalFor(b, defaultGcPrefs(), { confirmed: true })
  if (hard) return hard
  const forced = b.bucket !== 'ready'
  const deps = worldFor(b)
  const ops = forced ? createForcedGcOps(deps) : createGcOps(deps)
  const r = await runBundle(b, ops, { removeVolumes: false, confirmReview: forced })
  return r.ok ? null : (r.error ?? 'failed').split(':')[0]
}

/** Every main code a predicate reason may surface as (main's names are finer than the operator's). */
const MAIN_CODES: Record<RemovalRefusal, string[]> = {
  'main-checkout': ['main-checkout', 'not-ready', 'protected-now'],
  'never-clean': ['never-clean', 'not-ready'],
  kept: ['kept', 'not-ready'],
  'in-use': ['in-use'],
  'unsupported-kind': ['unsupported-kind'],
  'shared-stack': ['shared-stack'],
  'nested-worktree': ['nested-worktree', 'foreign-checkout'],
  'tip-unknown': ['tip-unknown'],
  'grace-not-elapsed': ['grace-not-elapsed'],
  'path-unresolved': ['path-unresolved', 'changed-since-scan'],
  'session-open': ['session-open'],
  locked: ['cannot-unregister']
}

const wtPath = WT
function b(
  bucket: 'ready' | 'review' | 'in-use',
  over: Parameters<typeof bundle>[2] = {},
  item: Partial<WorktreeBundle['item']> = {}
): WorktreeBundle {
  const made = bundle(wtPath, bucket, {
    stackIds: ['app'],
    ownedVolumes: ['pgdata'],
    ...over
  })
  made.item = reapItem(wtPath, {
    branch: 'feat/PROJ-0000-slug',
    ...(bucket === 'review'
      ? { verdict: 'blocked' as const, blockers: ['dirty'], justifiedBy: null }
      : {}),
    ...item
  })
  return made
}

const CASES: { name: string; bundle: WorktreeBundle; refusal: RemovalRefusal | null }[] = [
  { name: 'a proven ready worktree', bundle: b('ready'), refusal: null },
  {
    name: 'a dirty review worktree (the operator confirmed it)',
    bundle: b('review'),
    refusal: null
  },
  {
    name: 'a detached worktree',
    bundle: b(
      'review',
      { reason: { code: 'detached', detail: 'x' } },
      { kind: 'detached-worktree' }
    ),
    refusal: 'unsupported-kind'
  },
  {
    name: 'a locked worktree',
    bundle: b('review', { locked: true, reason: { code: 'locked', detail: 'x' } }),
    refusal: 'locked'
  },
  {
    name: 'a worktree whose stack another folder shares',
    bundle: b('review', {
      stackIds: [],
      sharedStackIds: ['shared'],
      reason: { code: 'shared-stack', detail: 'x' }
    }),
    refusal: 'shared-stack'
  },
  {
    name: 'a worktree that holds another worktree',
    bundle: b('review', {
      nestedWorktrees: ['/ws/org/proj/worktrees/PROJ-0000-slug/inner'],
      reason: { code: 'nested-worktree', detail: 'x' }
    }),
    refusal: 'nested-worktree'
  },
  {
    name: 'a worktree that holds a foreign checkout',
    bundle: b('review', { foreignCheckouts: [`${WT}/clone/.git`] }),
    refusal: 'nested-worktree'
  },
  {
    name: 'a worktree with an idle session still open',
    bundle: b('review', {
      session: 'open-idle',
      reason: { code: 'open-idle-session', detail: 'x' }
    }),
    refusal: 'session-open'
  },
  {
    name: 'a worktree with no known tip',
    bundle: b('review', { localTip: null, reason: { code: 'unknown-fate', detail: 'x' } }),
    refusal: 'tip-unknown'
  },
  {
    name: 'a worktree whose path does not resolve',
    bundle: b('review', { pathsResolved: false, reason: { code: 'path-unresolved', detail: 'x' } }),
    refusal: 'path-unresolved'
  },
  {
    name: 'a worktree still inside its grace window',
    bundle: b('review', { lastSignOfLifeAt: NOW - DAY / 2 }),
    refusal: 'grace-not-elapsed'
  },
  {
    name: 'a worktree with no sign of life on record',
    bundle: b('review', { lastSignOfLifeAt: null }),
    refusal: 'grace-not-elapsed'
  },
  {
    name: 'the main checkout',
    bundle: b('review', { isMainCheckout: true }),
    refusal: 'main-checkout'
  },
  {
    name: 'a worktree on the neverClean list',
    bundle: b('review', { neverClean: true }),
    refusal: 'never-clean'
  },
  { name: 'a kept worktree', bundle: b('review', { keep: true }), refusal: 'kept' },
  {
    name: 'a worktree an agent is working in',
    bundle: b('in-use', { session: 'working' }),
    refusal: 'in-use'
  }
]

describe('removability agrees with what main does (parity)', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const verdict = bundleRemovability(c.bundle, NOW)
      const main = await mainSays(c.bundle)
      if (c.refusal === null) {
        expect(main, 'main takes it').toBeNull()
        expect(verdict).toEqual({ ok: true })
        return
      }
      expect(main, 'main refuses it').not.toBeNull()
      expect(verdict.ok).toBe(false)
      if (verdict.ok) return
      expect(verdict.reason).toBe(c.refusal)
      expect(MAIN_CODES[verdict.reason], `main said ${main}`).toContain(main)
    })
  }

  it('covers every refusal reason the predicate can give', () => {
    const covered = new Set(CASES.map((c) => c.refusal))
    for (const reason of Object.keys(MAIN_CODES) as RemovalRefusal[]) {
      expect(covered.has(reason), reason).toBe(true)
    }
  })
})

describe('removability of a block', () => {
  it('lets an orphan volume through: its refusals are only known to main, at the click', () => {
    const m = buildGcModel({
      scannedAt: NOW,
      bundles: [],
      orphanVolumes: [
        {
          id: 'volume:pg',
          name: 'pg',
          sizeBytes: 1,
          project: null,
          reason: { code: 'no-known-worktree', detail: 'x' }
        }
      ],
      docker: { buildCacheReclaimableBytes: null, danglingImages: null },
      prefs: defaultGcPrefs(),
      lastCycle: null,
      nextCycleAt: null
    })
    expect(removability(m.byId.get('volume:pg')!, NOW)).toEqual({ ok: true })
  })

  it('names the command that fixes a locked worktree, and a detached one', () => {
    const locked = bundleRemovability(
      b('review', { locked: true, reason: { code: 'locked', detail: 'x' } }),
      NOW
    )
    expect(locked).toEqual({ ok: false, reason: 'locked', hint: `git worktree unlock ${WT}` })
    const detached = bundleRemovability(b('review', {}, { kind: 'detached-worktree' }), NOW)
    expect(detached).toEqual({
      ok: false,
      reason: 'unsupported-kind',
      hint: `git worktree remove ${WT}`
    })
  })

  it('judges a bucket reason code as a fact too (the row shows it to the operator)', () => {
    const v = bundleRemovability(
      b('review', { reason: { code: 'nested-worktree', detail: 'x' } }),
      NOW
    )
    expect(v).toMatchObject({ ok: false, reason: 'nested-worktree' })
  })

  it('does not offer Remove for a demoted item main keeps refusing, and says the real reason', () => {
    const demoted = b('review', { reason: { code: 'cleanup-failed', detail: 'x' } })
    demoted.reprobeRefusal = { code: 'cannot-unregister', count: 2 }
    expect(bundleRemovability(demoted, NOW)).toEqual({
      ok: false,
      reason: 'cannot-unregister',
      hint: 'git worktree list --porcelain'
    })
  })

  it.each([
    ['protected-now', 'protected-now'],
    ['stack-present', 'stack-present'],
    ['tip-unknown', 'tip-unknown'],
    ['path-unresolved', 'path-unresolved'],
    ['nested-worktree', 'nested-worktree'],
    ['foreign-checkout', 'nested-worktree'],
    ['shared-stack', 'shared-stack']
  ])('a demoted %s refusal reads as %s', (code, reason) => {
    const demoted = b('review', { reason: { code: 'cleanup-failed', detail: 'x' } })
    demoted.reprobeRefusal = { code, count: 2 }
    expect(bundleRemovability(demoted, NOW)).toMatchObject({ ok: false, reason })
  })

  it('a ready item marked after one refusal may still be retried on purpose', () => {
    const marked = b('ready')
    marked.reprobeRefusal = { code: 'cannot-unregister', count: 1 }
    expect(bundleRemovability(marked, NOW)).toEqual({ ok: true })
  })

  it('quotes a path with spaces so the command can be pasted', () => {
    expect(shellQuote('/ws/a b/c')).toBe("'/ws/a b/c'")
    expect(shellQuote("/ws/it's")).toBe("'/ws/it'\\''s'")
    expect(shellQuote('/ws/plain-path_1.x')).toBe('/ws/plain-path_1.x')
  })
})
