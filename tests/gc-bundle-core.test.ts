import { describe, it, expect } from 'vitest'
import {
  buildBundles,
  bucketOf,
  containerFolders,
  ownedVolumes,
  type BundleFacts,
  type SessionPresence
} from '../src/main/gc/bundle-core'
import type { FateResult } from '../src/main/gc/fate-core'
import type {
  BranchFacts,
  Checkpoint,
  PrFacts,
  ReapItem,
  ReapItemKind
} from '../src/main/reaper/reaper-core'
import {
  COMPOSE_WORKING_DIR_LABEL,
  type InspectedContainer,
  type StackGroup,
  type VolumeFact
} from '../src/main/containers/containers-core'

const DAY = 86_400_000
const HOUR = 3_600_000
const NOW = Date.parse('2026-10-07T12:00:00Z')
const GRACE_DAYS = 2

const REPO = '/ws/org/proj/www'
const WT_A = '/ws/org/proj/worktrees/PROJ-0000-slug-a'
const WT_B = '/ws/org/proj/worktrees/PROJ-0000-slug-b'
const ELSEWHERE = '/ws/org/other/api-gateway'

const OLD_MERGE = new Date(NOW - 10 * DAY).toISOString()
const TIP_A = 'a'.repeat(40)
const TIP_B = 'b'.repeat(40)

// ---- fixtures -------------------------------------------------------------------

function mergedCheckpoint(at: string | null = OLD_MERGE): Checkpoint {
  return at === null
    ? { id: 'pr-merged', state: 'unknown' }
    : { id: 'pr-merged', state: 'green', detail: at }
}

function item(over: Partial<ReapItem> = {}): ReapItem {
  const path = over.path ?? WT_A
  return {
    id: `${REPO}::worktree::${path}`,
    repoPath: REPO,
    kind: 'worktree',
    branch: 'feat/slug-a',
    path,
    hidden: false,
    ageDays: 12,
    diskBytes: 1_000_000,
    checkpoints: [mergedCheckpoint()],
    verdict: 'harvestable',
    blockers: [],
    needsRemoteDelete: false,
    untracked: [],
    justifiedBy: 'ancestor',
    hydration: null,
    ...over
  }
}

function prFacts(over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 92,
    state: 'MERGED',
    reviewDecision: 'APPROVED',
    ci: 'passing',
    mergedAt: OLD_MERGE,
    headRefOid: TIP_A,
    ...over
  }
}

function facts(over: Partial<BranchFacts> = {}): BranchFacts {
  return {
    kind: 'worktree',
    repoPath: REPO,
    branch: 'feat/slug-a',
    path: WT_A,
    hidden: false,
    sessionLive: false,
    trackedDirty: false,
    untracked: [],
    unpushed: false,
    remoteExists: false,
    ancestorOfDefault: null,
    patchIdContained: null,
    lastCommitAt: null,
    pr: null,
    ghAvailable: true,
    prSetComplete: true,
    prProvenance: 'own-name',
    ...over
  }
}

const MERGED_STRONG: FateResult = { fate: 'merged', signal: 'ancestor', strong: true }

/** A BundleFacts that is a corpse. Each bucketOf test mutates exactly one respect. */
function corpseFacts(over: Partial<BundleFacts> = {}): BundleFacts {
  return {
    item: item(),
    fate: MERGED_STRONG,
    session: 'none',
    lastSignOfLifeAt: NOW - 10 * DAY,
    stackIds: [],
    sharedStackIds: [],
    ownedVolumes: [],
    depsBytes: null,
    keep: false,
    neverClean: false,
    isMainCheckout: false,
    ...over
  }
}

function container(id: string, over: Partial<InspectedContainer> = {}): InspectedContainer {
  return {
    id,
    name: `${id}-1`,
    image: 'postgres:16',
    labels: {},
    state: 'running',
    startedAt: null,
    finishedAt: null,
    createdAt: null,
    ports: [],
    mounts: [],
    ...over
  }
}

/** A compose container whose project lives in `workingDir`. */
function composeContainer(
  id: string,
  project: string,
  workingDir: string | null,
  over: Partial<InspectedContainer> = {}
): InspectedContainer {
  const labels: Record<string, string> = { 'com.docker.compose.project': project }
  if (workingDir !== null) labels[COMPOSE_WORKING_DIR_LABEL] = workingDir
  return container(id, { labels, ...over })
}

function volumeMount(name: string): InspectedContainer['mounts'][number] {
  return { type: 'volume', source: `/var/lib/docker/volumes/${name}/_data`, name }
}

function stack(id: string, containers: InspectedContainer[]): StackGroup {
  return { id, name: id, kind: 'compose', project: id, containers }
}

interface BuildOver {
  items?: ReapItem[]
  fateInputs?: Map<string, { facts: BranchFacts; localTip: string | null }>
  stacks?: StackGroup[]
  stackPaths?: Map<string, string>
  containers?: InspectedContainer[]
  sessions?: Map<string, { presence: SessionPresence; lastActivityAt: number | null }>
  keep?: Set<string>
  neverClean?: Set<string>
  harnuStoppedAt?: ReadonlyMap<string, number>
  volumes?: ReadonlyMap<string, VolumeFact>
}

/** Inputs for a single worktree at WT_A whose branch is merged by ancestry. */
function build(over: BuildOver = {}): ReturnType<typeof buildBundles> {
  const items = over.items ?? [item()]
  const fateInputs =
    over.fateInputs ??
    new Map(
      items.map((i) => [i.id, { facts: facts({ ancestorOfDefault: true }), localTip: TIP_A }])
    )
  const sessions =
    over.sessions ??
    new Map(items.map((i) => [i.path ?? '', { presence: 'none' as const, lastActivityAt: null }]))
  return buildBundles({
    items,
    fateInputs,
    stacks: over.stacks ?? [],
    stackPaths: over.stackPaths ?? new Map(),
    containers: over.containers ?? [],
    sessions,
    keep: over.keep ?? new Set(),
    neverClean: over.neverClean ?? new Set(),
    now: NOW,
    graceDays: GRACE_DAYS,
    ...(over.harnuStoppedAt ? { harnuStoppedAt: over.harnuStoppedAt } : {}),
    ...(over.volumes ? { volumes: over.volumes } : {})
  })
}

function only(bundles: ReturnType<typeof buildBundles>): ReturnType<typeof buildBundles>[number] {
  expect(bundles).toHaveLength(1)
  return bundles[0]!
}

// ---- bucketOf -------------------------------------------------------------------

describe('bucketOf — rules 1 to 11', () => {
  it('11. an untouched corpse fixture is a corpse with no reason', () => {
    expect(bucketOf(corpseFacts(), NOW, GRACE_DAYS)).toEqual({ bucket: 'corpse', reason: null })
  })

  it('1. a main checkout is alive', () => {
    expect(bucketOf(corpseFacts({ isMainCheckout: true }), NOW, GRACE_DAYS)).toEqual({
      bucket: 'alive',
      reason: null
    })
  })

  it('1. a neverClean path is alive', () => {
    expect(bucketOf(corpseFacts({ neverClean: true }), NOW, GRACE_DAYS)).toEqual({
      bucket: 'alive',
      reason: null
    })
  })

  it('2. a working session is alive', () => {
    expect(bucketOf(corpseFacts({ session: 'working' }), NOW, GRACE_DAYS).bucket).toBe('alive')
  })

  it('2. a needs-input session is alive', () => {
    expect(bucketOf(corpseFacts({ session: 'needs-input' }), NOW, GRACE_DAYS).bucket).toBe('alive')
  })

  it('3. an open branch is alive', () => {
    const open: FateResult = { fate: 'open', signal: null, strong: false }
    expect(bucketOf(corpseFacts({ fate: open }), NOW, GRACE_DAYS).bucket).toBe('alive')
  })

  it('4. no sign of life at all is alive (never a corpse)', () => {
    expect(bucketOf(corpseFacts({ lastSignOfLifeAt: null }), NOW, GRACE_DAYS).bucket).toBe('alive')
  })

  it('4. a sign of life within the grace window is alive', () => {
    const recent = corpseFacts({ lastSignOfLifeAt: NOW - GRACE_DAYS * DAY + HOUR })
    expect(bucketOf(recent, NOW, GRACE_DAYS).bucket).toBe('alive')
  })

  it('4. a sign of life exactly at the grace boundary is no longer alive', () => {
    const boundary = corpseFacts({ lastSignOfLifeAt: NOW - GRACE_DAYS * DAY })
    expect(bucketOf(boundary, NOW, GRACE_DAYS)).toEqual({ bucket: 'corpse', reason: null })
  })

  it('5. a keep flag is alive', () => {
    expect(bucketOf(corpseFacts({ keep: true }), NOW, GRACE_DAYS).bucket).toBe('alive')
  })

  it('6. an open-idle session sends the bundle to decide', () => {
    const r = bucketOf(corpseFacts({ session: 'open-idle' }), NOW, GRACE_DAYS)
    expect(r.bucket).toBe('decide')
    expect(r.reason?.code).toBe('open-idle-session')
    expect(r.reason?.detail.length).toBeGreaterThan(0)
  })

  it('7. a stack shared with another bundle sends the bundle to decide, naming the stack', () => {
    const r = bucketOf(corpseFacts({ sharedStackIds: ['app'] }), NOW, GRACE_DAYS)
    expect(r.bucket).toBe('decide')
    expect(r.reason?.code).toBe('shared-stack')
    expect(r.reason?.detail).toContain('app')
  })

  it.each([
    ['closed-unmerged', 'closed-unmerged'],
    ['remote-gone', 'remote-gone'],
    ['detached', 'detached'],
    ['unknown', 'unknown-fate']
  ] as const)('8. fate %s is decide with code %s', (fate, code) => {
    const f: FateResult = { fate, signal: null, strong: false }
    const r = bucketOf(corpseFacts({ fate: f }), NOW, GRACE_DAYS)
    expect(r.bucket).toBe('decide')
    expect(r.reason?.code).toBe(code)
  })

  it('9. a merged but weak signal is decide weak-merge-signal', () => {
    const weak: FateResult = { fate: 'merged', signal: 'gh-merged', strong: false }
    const r = bucketOf(corpseFacts({ fate: weak }), NOW, GRACE_DAYS)
    expect(r.bucket).toBe('decide')
    expect(r.reason?.code).toBe('weak-merge-signal')
  })

  it('10. a dirty blocker is decide dirty', () => {
    const r = bucketOf(corpseFacts({ item: item({ blockers: ['dirty'] }) }), NOW, GRACE_DAYS)
    expect(r.bucket).toBe('decide')
    expect(r.reason?.code).toBe('dirty')
  })

  it('10. an unpushed blocker is decide unpushed', () => {
    const r = bucketOf(corpseFacts({ item: item({ blockers: ['unpushed'] }) }), NOW, GRACE_DAYS)
    expect(r.bucket).toBe('decide')
    expect(r.reason?.code).toBe('unpushed')
  })

  it('10. with both blockers present, dirty is reported first', () => {
    const both = corpseFacts({ item: item({ blockers: ['unpushed', 'dirty'] }) })
    expect(bucketOf(both, NOW, GRACE_DAYS).reason?.code).toBe('dirty')
  })
})

describe('bucketOf — rule precedence', () => {
  it('alive beats shared-stack', () => {
    const r = bucketOf(
      corpseFacts({ session: 'working', sharedStackIds: ['app'] }),
      NOW,
      GRACE_DAYS
    )
    expect(r).toEqual({ bucket: 'alive', reason: null })
  })

  it('alive (grace) beats a non-merged fate', () => {
    const closed: FateResult = { fate: 'closed-unmerged', signal: null, strong: false }
    const r = bucketOf(corpseFacts({ fate: closed, lastSignOfLifeAt: NOW - HOUR }), NOW, GRACE_DAYS)
    expect(r.bucket).toBe('alive')
  })

  it('open-idle-session beats shared-stack', () => {
    const r = bucketOf(
      corpseFacts({ session: 'open-idle', sharedStackIds: ['app'] }),
      NOW,
      GRACE_DAYS
    )
    expect(r.reason?.code).toBe('open-idle-session')
  })

  it('shared-stack beats the weak-signal rule', () => {
    const weak: FateResult = { fate: 'merged', signal: 'gh-merged', strong: false }
    const r = bucketOf(corpseFacts({ fate: weak, sharedStackIds: ['app'] }), NOW, GRACE_DAYS)
    expect(r.reason?.code).toBe('shared-stack')
  })

  it('shared-stack beats a non-merged fate', () => {
    const closed: FateResult = { fate: 'closed-unmerged', signal: null, strong: false }
    const r = bucketOf(corpseFacts({ fate: closed, sharedStackIds: ['app'] }), NOW, GRACE_DAYS)
    expect(r.reason?.code).toBe('shared-stack')
  })

  it('the weak-signal rule beats the blockers', () => {
    const weak: FateResult = { fate: 'merged', signal: 'gh-merged', strong: false }
    const r = bucketOf(
      corpseFacts({ fate: weak, item: item({ blockers: ['dirty'] }) }),
      NOW,
      GRACE_DAYS
    )
    expect(r.reason?.code).toBe('weak-merge-signal')
  })
})

// ---- containerFolders -------------------------------------------------------------

function bindMount(source: string): InspectedContainer['mounts'][number] {
  return { type: 'bind', source, name: null }
}

describe('containerFolders', () => {
  it('is the normalized compose working dir when the container has one', () => {
    const c = composeContainer('web', 'app', `${WT_A}/deploy/`, {
      mounts: [bindMount(ELSEWHERE)]
    })
    expect(containerFolders(c, 'linux')).toEqual([`${WT_A}/deploy`])
  })

  it('falls back to the normalized bind mount sources of a labelless container', () => {
    const c = container('web', {
      mounts: [bindMount(`${WT_A}/src/`), volumeMount('pgdata'), bindMount(ELSEWHERE)]
    })
    expect(containerFolders(c, 'linux')).toEqual([`${WT_A}/src`, ELSEWHERE])
  })

  it('skips a bind mount with an empty source', () => {
    const c = container('web', { mounts: [bindMount(''), bindMount(WT_A)] })
    expect(containerFolders(c, 'linux')).toEqual([WT_A])
  })

  it('is empty for a container with neither a label nor a bind mount', () => {
    expect(
      containerFolders(container('web', { mounts: [volumeMount('pgdata')] }), 'linux')
    ).toEqual([])
  })

  it('normalizes Windows paths', () => {
    const c = container('web', { mounts: [bindMount('C:\\Work\\Proj\\')] })
    expect(containerFolders(c, 'win32')).toEqual(['c:/work/proj'])
  })
})

// ---- ownedVolumes -----------------------------------------------------------------

describe('ownedVolumes', () => {
  it('lists the named volumes the bundle stacks mount', () => {
    const db = composeContainer('db', 'app', WT_A, { mounts: [volumeMount('pgdata')] })
    expect(ownedVolumes([stack('app', [db])], [db])).toEqual(['pgdata'])
  })

  it('excludes a volume also mounted by a container outside the bundle (Review Focus 3)', () => {
    const db = composeContainer('db', 'app', WT_A, {
      mounts: [volumeMount('pgdata'), volumeMount('shared-cache')]
    })
    const other = composeContainer('other-web', 'other', ELSEWHERE, {
      mounts: [volumeMount('shared-cache')]
    })
    expect(ownedVolumes([stack('app', [db])], [db, other])).toEqual(['pgdata'])
  })

  it('keeps a volume shared only between containers inside the bundle', () => {
    const db = composeContainer('db', 'app', WT_A, { mounts: [volumeMount('data')] })
    const web = composeContainer('web', 'app', WT_A, { mounts: [volumeMount('data')] })
    expect(ownedVolumes([stack('app', [db, web])], [db, web])).toEqual(['data'])
  })

  it('never reports a bind mount as a volume', () => {
    const db = composeContainer('db', 'app', WT_A, {
      mounts: [{ type: 'bind', source: '/ws/org/proj/data', name: null }, volumeMount('pgdata')]
    })
    expect(ownedVolumes([stack('app', [db])], [db])).toEqual(['pgdata'])
  })

  it('returns nothing for a stack with only bind mounts', () => {
    const web = composeContainer('web', 'app', WT_A, {
      mounts: [{ type: 'bind', source: '/ws/org/proj/code', name: null }]
    })
    expect(ownedVolumes([stack('app', [web])], [web])).toEqual([])
  })

  it('sorts and de-duplicates', () => {
    const a = composeContainer('a', 'app', WT_A, {
      mounts: [volumeMount('zeta'), volumeMount('alpha')]
    })
    const b = composeContainer('b', 'app', WT_A, {
      mounts: [volumeMount('alpha'), volumeMount('mid')]
    })
    expect(ownedVolumes([stack('app', [a, b])], [a, b])).toEqual(['alpha', 'mid', 'zeta'])
  })

  describe('with volume facts (the cross-project rule buildSnapshot applies)', () => {
    const db = composeContainer('db', 'app', WT_A, {
      mounts: [volumeMount('app_pg'), volumeMount('projb_pg'), volumeMount('loose')]
    })
    const facts = (entries: Array<[string, string | null]>): Map<string, VolumeFact> =>
      new Map(entries.map(([name, project]) => [name, { sizeBytes: 1, project }]))

    it('drops a volume another compose project created (declared external here)', () => {
      const vols = facts([
        ['app_pg', 'app'],
        ['projb_pg', 'projb'],
        ['loose', null]
      ])
      expect(ownedVolumes([stack('app', [db])], [db], vols)).toEqual(['app_pg', 'loose'])
    })

    it('keeps a volume with no fact, as buildSnapshot does', () => {
      expect(ownedVolumes([stack('app', [db])], [db], facts([['projb_pg', 'projb']]))).toEqual([
        'app_pg',
        'loose'
      ])
    })

    it('drops a labelled volume a standalone (project-less) stack mounts', () => {
      const run = container('runner', { mounts: [volumeMount('app_pg')] })
      const standalone: StackGroup = {
        id: 'runner',
        name: 'runner',
        kind: 'container',
        project: null,
        containers: [run]
      }
      expect(ownedVolumes([standalone], [run], facts([['app_pg', 'app']]))).toEqual([])
    })

    it('drops a volume when any bundle stack mounting it belongs to another project', () => {
      const web = composeContainer('web', 'web', WT_A, { mounts: [volumeMount('app_pg')] })
      expect(
        ownedVolumes(
          [stack('app', [db]), stack('web', [web])],
          [db, web],
          facts([['app_pg', 'app']])
        )
      ).toEqual(['loose', 'projb_pg'])
    })
  })

  it('returns nothing when the bundle has no stacks', () => {
    const other = composeContainer('other-web', 'other', ELSEWHERE, {
      mounts: [volumeMount('pgdata')]
    })
    expect(ownedVolumes([], [other])).toEqual([])
  })
})

// ---- buildBundles -----------------------------------------------------------------

describe('buildBundles — fate, including AC-6', () => {
  it('AC-6: a branch reused after its merge (PR head differs from the local tip) is weak, never a corpse', () => {
    const b = only(
      build({
        fateInputs: new Map([
          [item().id, { facts: facts({ pr: prFacts({ headRefOid: TIP_A }) }), localTip: TIP_B }]
        ])
      })
    )
    expect(b.fate.fate).toBe('merged')
    expect(b.fate.signal).toBe('gh-merged')
    expect(b.fate.strong).toBe(false)
    expect(b.bucket).toBe('decide')
    expect(b.reason?.code).toBe('weak-merge-signal')
    expect(b.bucket).not.toBe('corpse')
  })

  it('AC-6: the same fixture with the local tip on the PR head is strong and a corpse', () => {
    const b = only(
      build({
        fateInputs: new Map([
          [item().id, { facts: facts({ pr: prFacts({ headRefOid: TIP_A }) }), localTip: TIP_A }]
        ])
      })
    )
    expect(b.fate.strong).toBe(true)
    expect(b.bucket).toBe('corpse')
    expect(b.reason).toBeNull()
  })

  it('a missing fateInputs entry fails closed to fate unknown', () => {
    const b = only(build({ fateInputs: new Map() }))
    expect(b.fate.fate).toBe('unknown')
    expect(b.fate.strong).toBe(false)
    expect(b.bucket).toBe('decide')
    expect(b.reason?.code).toBe('unknown-fate')
  })

  it('a detached-worktree item gets fate detached, with or without facts', () => {
    const detached = item({
      kind: 'detached-worktree',
      branch: undefined,
      id: `${REPO}::detached-worktree::${WT_A}`
    })
    const b = only(build({ items: [detached], fateInputs: new Map() }))
    expect(b.fate).toEqual({ fate: 'detached', signal: null, strong: false })
    expect(b.bucket).toBe('decide')
    expect(b.reason?.code).toBe('detached')
  })

  it('a detached-worktree item with facts present still gets fate detached, ignoring the facts', () => {
    const detached = item({
      kind: 'detached-worktree',
      branch: undefined,
      id: `${REPO}::detached-worktree::${WT_A}`,
      headSha: TIP_B
    })
    const b = only(
      build({
        items: [detached],
        fateInputs: new Map([
          [detached.id, { facts: facts({ ancestorOfDefault: true }), localTip: TIP_A }]
        ])
      })
    )
    expect(b.fate).toEqual({ fate: 'detached', signal: null, strong: false })
    expect(b.bucket).toBe('decide')
    expect(b.reason?.code).toBe('detached')
    // The checked-out commit, not the facts' tip, is what the reprobe re-checks.
    expect(b.localTip).toBe(TIP_B)
  })

  it('carries the scanned local tip so the reprobe can re-check it', () => {
    expect(only(build()).localTip).toBe(TIP_A)
  })

  it('has a null local tip when the facts are missing', () => {
    expect(only(build({ fateInputs: new Map() })).localTip).toBeNull()
  })

  it('has a null local tip for a detached worktree with no recorded head', () => {
    const detached = item({
      kind: 'detached-worktree',
      branch: undefined,
      id: `${REPO}::detached-worktree::${WT_A}`
    })
    expect(only(build({ items: [detached], fateInputs: new Map() })).localTip).toBeNull()
  })

  it('a plain merged-by-ancestry worktree past grace is a corpse', () => {
    const b = only(build())
    expect(b.fate).toEqual({ fate: 'merged', signal: 'ancestor', strong: true })
    expect(b.bucket).toBe('corpse')
    expect(b.item.id).toBe(item().id)
  })
})

describe('buildBundles — which items become bundles', () => {
  it.each<ReapItemKind>(['remote-branch', 'local-branch'])(
    'a %s item has no folder and produces no bundle',
    (kind) => {
      const noFolder = item({ kind, path: undefined, id: `${REPO}::${kind}::feat/slug-a` })
      expect(build({ items: [noFolder] })).toEqual([])
    }
  )

  it('a worktree item without a path produces no bundle', () => {
    const noPath = item({ path: undefined, id: `${REPO}::worktree::feat/slug-a` })
    expect(build({ items: [noPath] })).toEqual([])
  })

  it('keeps one bundle per folder item and drops the rest', () => {
    const wtA = item()
    const wtB = item({ path: WT_B, id: `${REPO}::worktree::${WT_B}`, branch: 'feat/slug-b' })
    const remote = item({ kind: 'remote-branch', path: undefined, id: `${REPO}::remote::x` })
    const out = build({ items: [wtA, remote, wtB] })
    expect(out.map((b) => b.item.id)).toEqual([wtA.id, wtB.id])
  })
})

describe('buildBundles — flags', () => {
  it('isMainCheckout when the item path is the repo path, and it is alive', () => {
    const main = item({ path: REPO, id: `${REPO}::worktree::${REPO}` })
    const b = only(build({ items: [main] }))
    expect(b.isMainCheckout).toBe(true)
    expect(b.bucket).toBe('alive')
  })

  it('a linked worktree is not a main checkout', () => {
    expect(only(build()).isMainCheckout).toBe(false)
  })

  it('neverClean matches the worktree path', () => {
    const b = only(build({ neverClean: new Set([WT_A]) }))
    expect(b.neverClean).toBe(true)
    expect(b.bucket).toBe('alive')
  })

  it('neverClean matches the repo path', () => {
    const b = only(build({ neverClean: new Set([REPO]) }))
    expect(b.neverClean).toBe(true)
    expect(b.bucket).toBe('alive')
  })

  it('neverClean does not match an unrelated path', () => {
    expect(only(build({ neverClean: new Set([ELSEWHERE]) })).neverClean).toBe(false)
  })

  it('keep matches the item id', () => {
    const b = only(build({ keep: new Set([item().id]) }))
    expect(b.keep).toBe(true)
    expect(b.bucket).toBe('alive')
  })

  it('keep does not match a different id', () => {
    expect(only(build({ keep: new Set(['something-else']) })).keep).toBe(false)
  })

  it('carries the session presence looked up by item path', () => {
    const b = only(
      build({ sessions: new Map([[WT_A, { presence: 'open-idle', lastActivityAt: null }]]) })
    )
    expect(b.session).toBe('open-idle')
    expect(b.bucket).toBe('decide')
    expect(b.reason?.code).toBe('open-idle-session')
  })

  it('finds the session by the normalized path when the item path has a trailing slash', () => {
    const b = only(
      build({
        items: [item({ path: `${WT_A}/` })],
        sessions: new Map([[WT_A, { presence: 'open-idle', lastActivityAt: null }]])
      })
    )
    expect(b.session).toBe('open-idle')
  })

  it('prefers the session keyed by the raw item path over the normalized one', () => {
    const b = only(
      build({
        items: [item({ path: `${WT_A}/` })],
        sessions: new Map([
          [`${WT_A}/`, { presence: 'working', lastActivityAt: null }],
          [WT_A, { presence: 'open-idle', lastActivityAt: null }]
        ])
      })
    )
    expect(b.session).toBe('working')
  })

  it('depsBytes comes from the hydration reclaimable bytes', () => {
    const hydrated = item({
      hydration: {
        state: 'hydrated',
        removable: [`${WT_A}/node_modules`],
        skipped: [],
        reclaimableBytes: 123_456,
        canRehydrate: true,
        rehydrateChanged: []
      }
    })
    expect(only(build({ items: [hydrated] })).depsBytes).toBe(123_456)
  })

  it('depsBytes is null without hydration info or when unmeasured', () => {
    expect(only(build()).depsBytes).toBeNull()
    const unmeasured = item({
      hydration: {
        state: 'hydrated',
        removable: [],
        skipped: [],
        reclaimableBytes: null,
        canRehydrate: false,
        rehydrateChanged: []
      }
    })
    expect(only(build({ items: [unmeasured] })).depsBytes).toBeNull()
  })
})

describe('buildBundles — lastSignOfLifeAt', () => {
  const merged = Date.parse('2026-09-20T00:00:00Z')
  const withMerge = (at: number | null = merged): ReapItem =>
    item({ checkpoints: [mergedCheckpoint(at === null ? null : new Date(at).toISOString())] })

  it('is the merge time from the pr-merged checkpoint when nothing else is known', () => {
    expect(only(build({ items: [withMerge()] })).lastSignOfLifeAt).toBe(merged)
  })

  it('is null when every source is absent', () => {
    const b = only(build({ items: [withMerge(null)] }))
    expect(b.lastSignOfLifeAt).toBeNull()
    expect(b.bucket).toBe('alive')
  })

  it('ignores a pr-merged checkpoint whose detail is not a date', () => {
    const odd = item({
      checkpoints: [{ id: 'pr-merged', state: 'red', detail: 'PR closed without merge' }]
    })
    expect(only(build({ items: [odd] })).lastSignOfLifeAt).toBeNull()
  })

  it('takes a later session activity over an earlier merge', () => {
    const later = merged + 3 * DAY
    const b = only(
      build({
        items: [withMerge()],
        sessions: new Map([[WT_A, { presence: 'none', lastActivityAt: later }]])
      })
    )
    expect(b.lastSignOfLifeAt).toBe(later)
  })

  it('takes a later merge over an earlier session activity', () => {
    const b = only(
      build({
        items: [withMerge()],
        sessions: new Map([[WT_A, { presence: 'none', lastActivityAt: merged - 5 * DAY }]])
      })
    )
    expect(b.lastSignOfLifeAt).toBe(merged)
  })

  it('takes a later container start over an earlier merge', () => {
    const started = merged + 4 * DAY
    const db = composeContainer('db', 'app', WT_A, { startedAt: started })
    const b = only(build({ items: [withMerge()], stacks: [stack('app', [db])], containers: [db] }))
    expect(b.lastSignOfLifeAt).toBe(started)
  })

  it('counts a container stop that Harnu did not cause', () => {
    const started = merged + 1 * DAY
    const finished = merged + 5 * DAY
    const db = composeContainer('db', 'app', WT_A, { startedAt: started, finishedAt: finished })
    const b = only(build({ items: [withMerge()], stacks: [stack('app', [db])], containers: [db] }))
    expect(b.lastSignOfLifeAt).toBe(finished)
  })

  it('does not count a container stop that Harnu itself caused', () => {
    const started = merged + 1 * DAY
    const finished = merged + 5 * DAY
    const db = composeContainer('db', 'app', WT_A, { startedAt: started, finishedAt: finished })
    const b = only(
      build({
        items: [withMerge()],
        stacks: [stack('app', [db])],
        containers: [db],
        harnuStoppedAt: new Map([['db', finished]])
      })
    )
    expect(b.lastSignOfLifeAt).toBe(started)
  })

  it('is the max of all three sources', () => {
    const started = merged + 2 * DAY
    const activity = merged + 6 * DAY
    const db = composeContainer('db', 'app', WT_A, { startedAt: started })
    const b = only(
      build({
        items: [withMerge()],
        stacks: [stack('app', [db])],
        containers: [db],
        sessions: new Map([[WT_A, { presence: 'none', lastActivityAt: activity }]])
      })
    )
    expect(b.lastSignOfLifeAt).toBe(activity)
  })
})

describe('buildBundles — stack attribution', () => {
  it('a stack whose containers all run from the bundle path is exclusive, with its owned volumes', () => {
    const db = composeContainer('db', 'app', WT_A, { mounts: [volumeMount('pgdata')] })
    const web = composeContainer('web', 'app', `${WT_A}/deploy`)
    const b = only(build({ stacks: [stack('app', [db, web])], containers: [db, web] }))
    expect(b.stackIds).toEqual(['app'])
    expect(b.sharedStackIds).toEqual([])
    expect(b.ownedVolumes).toEqual(['pgdata'])
    expect(b.bucket).toBe('corpse')
  })

  it('a stack attributed only through stackPaths is exclusive when that path is inside the bundle', () => {
    const api = composeContainer('api', 'svc', null)
    const b = only(
      build({
        stacks: [stack('svc', [api])],
        stackPaths: new Map([['svc', `${WT_A}/services`]]),
        containers: [api]
      })
    )
    expect(b.stackIds).toEqual(['svc'])
    expect(b.sharedStackIds).toEqual([])
  })

  it('a labelless stack is attributed through its bind mount sources (the reprobe rule)', () => {
    const web = container('web', { mounts: [{ type: 'bind', source: `${WT_A}/src`, name: null }] })
    const b = only(build({ stacks: [stack('web', [web])], containers: [web] }))
    expect(b.stackIds).toEqual(['web'])
    expect(b.sharedStackIds).toEqual([])
  })

  it('a labelless stack that also bind-mounts a folder outside the bundle is shared', () => {
    const web = container('web', {
      mounts: [
        { type: 'bind', source: `${WT_A}/src`, name: null },
        { type: 'bind', source: ELSEWHERE, name: null }
      ]
    })
    const b = only(build({ stacks: [stack('web', [web])], containers: [web] }))
    expect(b.stackIds).toEqual([])
    expect(b.sharedStackIds).toEqual(['web'])
  })

  it('a stack that runs from elsewhere belongs to no bundle', () => {
    const web = composeContainer('web', 'other', ELSEWHERE)
    const b = only(build({ stacks: [stack('other', [web])], containers: [web] }))
    expect(b.stackIds).toEqual([])
    expect(b.sharedStackIds).toEqual([])
    expect(b.bucket).toBe('corpse')
  })

  it('does not match a sibling directory that merely shares a name prefix', () => {
    const web = composeContainer('web', 'app', `${WT_A}-old`)
    const b = only(build({ stacks: [stack('app', [web])], containers: [web] }))
    expect(b.stackIds).toEqual([])
    expect(b.sharedStackIds).toEqual([])
  })

  it('Review Focus 2: two worktrees in ONE compose project share the stack, so neither owns it', () => {
    const wtA = item()
    const wtB = item({ path: WT_B, id: `${REPO}::worktree::${WT_B}`, branch: 'feat/slug-b' })
    const dbA = composeContainer('db-a', 'app', WT_A, { mounts: [volumeMount('pgdata')] })
    const dbB = composeContainer('db-b', 'app', WT_B)
    const shared = stack('app', [dbA, dbB])
    const out = build({
      items: [wtA, wtB],
      fateInputs: new Map([
        [wtA.id, { facts: facts({ ancestorOfDefault: true }), localTip: TIP_A }],
        [
          wtB.id,
          {
            facts: facts({ path: WT_B, branch: 'feat/slug-b', ancestorOfDefault: true }),
            localTip: TIP_B
          }
        ]
      ]),
      stacks: [shared],
      containers: [dbA, dbB]
    })
    expect(out).toHaveLength(2)
    for (const b of out) {
      expect(b.stackIds).toEqual([])
      expect(b.sharedStackIds).toEqual(['app'])
      expect(b.ownedVolumes).toEqual([])
      expect(b.bucket).toBe('decide')
      expect(b.reason?.code).toBe('shared-stack')
    }
  })

  it('a stack with containers in this bundle AND in the main checkout is shared', () => {
    const inWt = composeContainer('web', 'app', WT_A)
    const inMain = composeContainer('db', 'app', REPO)
    const b = only(build({ stacks: [stack('app', [inWt, inMain])], containers: [inWt, inMain] }))
    expect(b.stackIds).toEqual([])
    expect(b.sharedStackIds).toEqual(['app'])
    expect(b.bucket).toBe('decide')
    expect(b.reason?.code).toBe('shared-stack')
  })

  it('a stack attributed to the bundle through stackPaths but with a container labelled elsewhere is shared', () => {
    const labelled = composeContainer('web', 'app', ELSEWHERE)
    const b = only(
      build({
        stacks: [stack('app', [labelled])],
        stackPaths: new Map([['app', WT_A]]),
        containers: [labelled]
      })
    )
    expect(b.stackIds).toEqual([])
    expect(b.sharedStackIds).toEqual(['app'])
  })

  it('an exclusive stack stays exclusive while another bundle owns a different stack', () => {
    const wtA = item()
    const wtB = item({ path: WT_B, id: `${REPO}::worktree::${WT_B}`, branch: 'feat/slug-b' })
    const dbA = composeContainer('db-a', 'proja', WT_A)
    const dbB = composeContainer('db-b', 'projb', WT_B)
    const out = build({
      items: [wtA, wtB],
      fateInputs: new Map([
        [wtA.id, { facts: facts({ ancestorOfDefault: true }), localTip: TIP_A }],
        [
          wtB.id,
          {
            facts: facts({ path: WT_B, branch: 'feat/slug-b', ancestorOfDefault: true }),
            localTip: TIP_B
          }
        ]
      ]),
      stacks: [stack('proja', [dbA]), stack('projb', [dbB])],
      containers: [dbA, dbB]
    })
    expect(out.find((b) => b.item.path === WT_A)?.stackIds).toEqual(['proja'])
    expect(out.find((b) => b.item.path === WT_B)?.stackIds).toEqual(['projb'])
    expect(out.every((b) => b.sharedStackIds.length === 0)).toBe(true)
  })

  it('I4 through the builder: a volume labelled with another compose project is not owned', () => {
    const db = composeContainer('db', 'app', WT_A, {
      mounts: [volumeMount('app_pg'), volumeMount('projb_pg')]
    })
    const b = only(
      build({
        stacks: [stack('app', [db])],
        containers: [db],
        volumes: new Map([
          ['app_pg', { sizeBytes: 1, project: 'app' }],
          ['projb_pg', { sizeBytes: 1, project: 'projb' }]
        ])
      })
    )
    expect(b.stackIds).toEqual(['app'])
    expect(b.ownedVolumes).toEqual(['app_pg'])
  })

  it('Review Focus 3 through the builder: a volume also mounted outside the bundle is not owned', () => {
    const db = composeContainer('db', 'app', WT_A, {
      mounts: [volumeMount('pgdata'), volumeMount('shared-cache')]
    })
    const other = composeContainer('other-web', 'other', ELSEWHERE, {
      mounts: [volumeMount('shared-cache')]
    })
    const b = only(
      build({
        stacks: [stack('app', [db]), stack('other', [other])],
        containers: [db, other]
      })
    )
    expect(b.stackIds).toEqual(['app'])
    expect(b.ownedVolumes).toEqual(['pgdata'])
  })
})
