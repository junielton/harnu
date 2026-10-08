import { describe, it, expect } from 'vitest'
import {
  buildBundles,
  bucketOf,
  canonicalPathKey,
  composeDefaultProject,
  containerFolders,
  ownedVolumes,
  type BundleFacts,
  type CanonicalPath,
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

/** What the Reaper records for a worktree whose tracked files were probed clean. */
const LOCAL_CLEAN: Checkpoint = { id: 'local-clean', state: 'green' }

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
    checkpoints: [mergedCheckpoint(), LOCAL_CLEAN],
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
    pathsResolved: true,
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

/** Volume facts labelling every named volume with one compose project. */
function labelled(project: string, ...names: string[]): Map<string, VolumeFact> {
  return new Map(names.map((name) => [name, { sizeBytes: 1, project }]))
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
  knownFolders?: string[]
  protectedProjects?: Set<string>
  canonical?: CanonicalPath
}

/** Every path is its own real path: no symlink anywhere, everything resolves. */
const LEXICAL: CanonicalPath = (p) => ({ path: p, resolved: true })

/**
 * A fake realpath over a symlink table: a path under an alias resolves to the target, a
 * path under an `unresolved` entry cannot be resolved, anything else is real already.
 */
function aliases(links: Record<string, string>, unresolved: string[] = []): CanonicalPath {
  const under = (p: string, root: string): boolean => p === root || p.startsWith(`${root}/`)
  return (p) => {
    if (unresolved.some((u) => under(p, u))) return { path: p, resolved: false }
    for (const [link, target] of Object.entries(links)) {
      if (under(p, link)) return { path: target + p.slice(link.length), resolved: true }
    }
    return { path: p, resolved: true }
  }
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
    volumes: over.volumes ?? new Map(),
    knownFolders: over.knownFolders ?? [],
    protectedProjects: over.protectedProjects ?? new Set(),
    canonical: over.canonical ?? LEXICAL
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

describe('bucketOf — fails closed on unknown inputs (delta 2, item 3)', () => {
  it('(a) no local-clean checkpoint is decide dirty: the tree was never shown clean', () => {
    const r = bucketOf(
      corpseFacts({ item: item({ checkpoints: [mergedCheckpoint()] }) }),
      NOW,
      GRACE_DAYS
    )
    expect(r.bucket).toBe('decide')
    expect(r.reason?.code).toBe('dirty')
    expect(r.reason?.detail).toMatch(/could not be verified clean/)
  })

  it.each(['unknown', 'red', 'na'] as const)(
    '(a) a local-clean checkpoint in state %s is decide dirty',
    (state) => {
      const unclean = item({ checkpoints: [mergedCheckpoint(), { id: 'local-clean', state }] })
      const r = bucketOf(corpseFacts({ item: unclean }), NOW, GRACE_DAYS)
      expect(r.bucket).toBe('decide')
      expect(r.reason?.code).toBe('dirty')
    }
  )

  it.each([undefined, 'hibernated'])(
    '(b) a session that is not exactly none (%s) is never a corpse',
    (session) => {
      const r = bucketOf(
        corpseFacts({ session: session as unknown as SessionPresence }),
        NOW,
        GRACE_DAYS
      )
      expect(r.bucket).toBe('decide')
      expect(r.reason?.code).toBe('open-idle-session')
      expect(r.reason?.detail).toMatch(/unknown/)
    }
  )

  it.each([NaN, Infinity, -Infinity, -1])(
    '(c) a lastSignOfLifeAt of %s is alive, never old enough',
    (at) => {
      expect(bucketOf(corpseFacts({ lastSignOfLifeAt: at }), NOW, GRACE_DAYS)).toEqual({
        bucket: 'alive',
        reason: null
      })
    }
  )

  it.each([NaN, Infinity, -1])('(c) a grace window of %s days is alive', (grace) => {
    expect(bucketOf(corpseFacts(), NOW, grace)).toEqual({ bucket: 'alive', reason: null })
  })

  it('(c) a clock that is not a number is alive', () => {
    expect(bucketOf(corpseFacts(), NaN, GRACE_DAYS)).toEqual({ bucket: 'alive', reason: null })
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

  it('an open branch with an open-idle session is alive: rule 3 comes before rule 6', () => {
    const open: FateResult = { fate: 'open', signal: null, strong: false }
    const r = bucketOf(corpseFacts({ fate: open, session: 'open-idle' }), NOW, GRACE_DAYS)
    expect(r).toEqual({ bucket: 'alive', reason: null })
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
  it('is the normalized compose working dir plus every bind mount source (delta 3, item 2)', () => {
    const c = composeContainer('web', 'app', `${WT_A}/deploy/`, {
      mounts: [bindMount(ELSEWHERE)]
    })
    expect(containerFolders(c, 'linux')).toEqual([`${WT_A}/deploy`, ELSEWHERE])
  })

  it('lists a bind mount under the working dir once, de-duplicated after normalizing', () => {
    const c = composeContainer('web', 'app', `${WT_A}/`, {
      mounts: [bindMount(WT_A), bindMount(`${WT_A}/data/`), bindMount(`${WT_A}//data`)]
    })
    expect(containerFolders(c, 'linux')).toEqual([WT_A, `${WT_A}/data`])
  })

  it('is just the working dir when the container has no bind mount', () => {
    const c = composeContainer('web', 'app', `${WT_A}/deploy`, { mounts: [volumeMount('pg')] })
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

  it('resolves . and .. segments and folds case on darwin (delta 4, item F)', () => {
    const c = composeContainer('web', 'app', '/Ws/Org/Proj/worktrees/../WWW/.', {
      mounts: [bindMount('/Ws/Org/Proj/WWW/api/..')]
    })
    expect(containerFolders(c, 'darwin')).toEqual(['/ws/org/proj/www'])
    expect(containerFolders(c, 'linux')).toEqual(['/Ws/Org/Proj/WWW'])
  })
})

// ---- canonicalPathKey ---------------------------------------------------------------

describe('canonicalPathKey (delta 4, item F)', () => {
  it.each([
    [`${REPO}/.`, REPO],
    [`${REPO}/./`, REPO],
    ['/ws/org/proj/worktrees/../www', REPO],
    ['/ws/org/proj/www/api/../../www', REPO],
    ['/ws/org//proj/www/', REPO],
    [`${WT_A}/..`, '/ws/org/proj/worktrees']
  ])('resolves %s lexically to %s', (input, expected) => {
    expect(canonicalPathKey(input, 'linux')).toBe(expected)
  })

  it('keeps the root as it is', () => {
    expect(canonicalPathKey('/', 'linux')).toBe('/')
    expect(canonicalPathKey('/..', 'linux')).toBe('/')
  })

  it('folds case on darwin and win32, never on linux', () => {
    expect(canonicalPathKey('/Users/Me/WWW/', 'darwin')).toBe('/users/me/www')
    expect(canonicalPathKey('/Users/Me/WWW/', 'linux')).toBe('/Users/Me/WWW')
    expect(canonicalPathKey('C:\\Work\\Proj\\..\\Api-Gateway\\', 'win32')).toBe(
      'c:/work/api-gateway'
    )
  })

  it('maps an empty path to an empty key, never to the working directory', () => {
    expect(canonicalPathKey('', 'linux')).toBe('')
  })
})

// ---- composeDefaultProject --------------------------------------------------------

describe('composeDefaultProject', () => {
  it('is the folder basename, lowercased, as Compose names a project by default', () => {
    expect(composeDefaultProject(REPO)).toBe('www')
    expect(composeDefaultProject(WT_A)).toBe('proj-0000-slug-a')
  })

  it('drops every character Compose does not allow, and ignores a trailing slash', () => {
    expect(composeDefaultProject('/ws/org/proj/worktrees/PROJ-0000-Slug.v2 (old)/')).toBe(
      'proj-0000-slugv2old'
    )
    expect(composeDefaultProject('/ws/org/my_app')).toBe('my_app')
  })

  it('reads a Windows path by its last segment', () => {
    expect(composeDefaultProject('C:\\Work\\Api-Gateway')).toBe('api-gateway')
  })

  // Delta 4, item G: Compose trims leading underscores and dashes from the normalized name.
  it.each(['/ws/org/_www', '/ws/org/-www', '/ws/org/_-www', '/ws/org/.www', '/ws/org/ _www/'])(
    'trims the leading separators Compose trims (%s is www)',
    (path) => {
      expect(composeDefaultProject(path)).toBe('www')
    }
  )

  it('keeps a separator that is not leading', () => {
    expect(composeDefaultProject('/ws/org/my_app-')).toBe('my_app-')
  })
})

// ---- ownedVolumes -----------------------------------------------------------------

describe('ownedVolumes', () => {
  it('lists the named volumes the bundle stacks mount', () => {
    const db = composeContainer('db', 'app', WT_A, { mounts: [volumeMount('pgdata')] })
    expect(ownedVolumes([stack('app', [db])], [db], labelled('app', 'pgdata'))).toEqual(['pgdata'])
  })

  it('excludes a volume also mounted by a container outside the bundle (Review Focus 3)', () => {
    const db = composeContainer('db', 'app', WT_A, {
      mounts: [volumeMount('pgdata'), volumeMount('shared-cache')]
    })
    const other = composeContainer('other-web', 'other', ELSEWHERE, {
      mounts: [volumeMount('shared-cache')]
    })
    expect(
      ownedVolumes([stack('app', [db])], [db, other], labelled('app', 'pgdata', 'shared-cache'))
    ).toEqual(['pgdata'])
  })

  it('keeps a volume shared only between containers inside the bundle', () => {
    const db = composeContainer('db', 'app', WT_A, { mounts: [volumeMount('data')] })
    const web = composeContainer('web', 'app', WT_A, { mounts: [volumeMount('data')] })
    expect(ownedVolumes([stack('app', [db, web])], [db, web], labelled('app', 'data'))).toEqual([
      'data'
    ])
  })

  it('never reports a bind mount as a volume', () => {
    const db = composeContainer('db', 'app', WT_A, {
      mounts: [{ type: 'bind', source: '/ws/org/proj/data', name: null }, volumeMount('pgdata')]
    })
    expect(ownedVolumes([stack('app', [db])], [db], labelled('app', 'pgdata'))).toEqual(['pgdata'])
  })

  it('returns nothing for a stack with only bind mounts', () => {
    const web = composeContainer('web', 'app', WT_A, {
      mounts: [{ type: 'bind', source: '/ws/org/proj/code', name: null }]
    })
    expect(ownedVolumes([stack('app', [web])], [web], new Map())).toEqual([])
  })

  it('sorts and de-duplicates', () => {
    const a = composeContainer('a', 'app', WT_A, {
      mounts: [volumeMount('zeta'), volumeMount('alpha')]
    })
    const b = composeContainer('b', 'app', WT_A, {
      mounts: [volumeMount('alpha'), volumeMount('mid')]
    })
    expect(
      ownedVolumes([stack('app', [a, b])], [a, b], labelled('app', 'alpha', 'mid', 'zeta'))
    ).toEqual(['alpha', 'mid', 'zeta'])
  })

  describe('volume facts (fail closed on the project label, delta 3 addendum)', () => {
    const db = composeContainer('db', 'app', WT_A, {
      mounts: [volumeMount('app_pg'), volumeMount('projb_pg'), volumeMount('loose')]
    })
    const facts = (entries: Array<[string, string | null]>): Map<string, VolumeFact> =>
      new Map(entries.map(([name, project]) => [name, { sizeBytes: 1, project }]))

    it('drops a volume another compose project created (declared external here) and an unlabelled one', () => {
      const vols = facts([
        ['app_pg', 'app'],
        ['projb_pg', 'projb'],
        ['loose', null]
      ])
      expect(ownedVolumes([stack('app', [db])], [db], vols)).toEqual(['app_pg'])
    })

    it('drops a volume with no fact, unlike buildSnapshot, which keeps it', () => {
      expect(ownedVolumes([stack('app', [db])], [db], facts([['projb_pg', 'projb']]))).toEqual([])
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
          facts([
            ['app_pg', 'app'],
            ['loose', 'app'],
            ['projb_pg', 'projb']
          ])
        )
      ).toEqual(['loose'])
    })
  })

  describe('a project shared with another folder is never owned (delta 3, item 5a)', () => {
    const facts = (entries: Array<[string, string | null]>): Map<string, VolumeFact> =>
      new Map(entries.map(([name, project]) => [name, { sizeBytes: 1, project }]))

    it('drops a volume whose project is the compose default name of another known folder', () => {
      // The worktree runs `-p www`, the main checkout's default; the main checkout ran
      // `compose down`, so nothing of it is left running or stopped.
      const db = composeContainer('db', 'www', WT_A, { mounts: [volumeMount('www_pg')] })
      expect(
        ownedVolumes([stack('www', [db])], [db], facts([['www_pg', 'www']]), [REPO, WT_B])
      ).toEqual([])
    })

    it('drops a volume with no fact, whatever the other folders are', () => {
      const db = composeContainer('db', 'www', WT_A, { mounts: [volumeMount('www_pg')] })
      expect(ownedVolumes([stack('www', [db])], [db], new Map(), [REPO])).toEqual([])
    })

    it('drops a volume whose project a stopped container outside the bundle carries', () => {
      const db = composeContainer('db', 'app', WT_A, { mounts: [volumeMount('app_pg')] })
      const stopped = composeContainer('old-db', 'app', REPO, { state: 'exited' })
      expect(
        ownedVolumes([stack('app', [db])], [db, stopped], facts([['app_pg', 'app']]), [REPO])
      ).toEqual([])
    })

    it.each(['/ws/org/other/_www', '/ws/org/other/-www'])(
      'drops a volume of project www when %s is another known folder (delta 4, item G)',
      (folder) => {
        const db = composeContainer('db', 'www', WT_A, { mounts: [volumeMount('www_pg')] })
        expect(
          ownedVolumes([stack('www', [db])], [db], facts([['www_pg', 'www']]), [folder])
        ).toEqual([])
      }
    )

    it('keeps a volume whose project is unique to the bundle stacks', () => {
      const db = composeContainer('db', 'app', WT_A, { mounts: [volumeMount('app_pg')] })
      const other = composeContainer('other-web', 'other', ELSEWHERE, { state: 'exited' })
      expect(
        ownedVolumes([stack('app', [db])], [db, other], facts([['app_pg', 'app']]), [
          REPO,
          WT_B,
          ELSEWHERE
        ])
      ).toEqual(['app_pg'])
    })
  })

  describe('only a labelled volume of an unprotected project is owned (delta 3, addendum)', () => {
    const facts = (entries: Array<[string, string | null]>): Map<string, VolumeFact> =>
      new Map(entries.map(([name, project]) => [name, { sizeBytes: 1, project }]))
    const db = composeContainer('db', 'app', WT_A, { mounts: [volumeMount('app_pg')] })

    it('drops a volume whose project is protected', () => {
      expect(
        ownedVolumes([stack('app', [db])], [db], facts([['app_pg', 'app']]), [], new Set(['app']))
      ).toEqual([])
    })

    it('drops an unlabelled volume, even one only the bundle stack mounts', () => {
      expect(ownedVolumes([stack('app', [db])], [db], facts([['app_pg', null]]))).toEqual([])
    })

    it('drops a volume with no fact at all', () => {
      expect(ownedVolumes([stack('app', [db])], [db], new Map())).toEqual([])
    })

    it('keeps a labelled volume of a unique, unprotected project', () => {
      expect(
        ownedVolumes(
          [stack('app', [db])],
          [db],
          facts([['app_pg', 'app']]),
          [REPO],
          new Set(['www'])
        )
      ).toEqual(['app_pg'])
    })
  })

  it('returns nothing when the bundle has no stacks', () => {
    const other = composeContainer('other-web', 'other', ELSEWHERE, {
      mounts: [volumeMount('pgdata')]
    })
    expect(ownedVolumes([], [other], labelled('other', 'pgdata'))).toEqual([])
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

  describe('. and .. segments (delta 4, item F)', () => {
    it.each([`${REPO}/.`, '/ws/org/proj/worktrees/../www'])(
      'the main checkout spelled %s is still the main checkout, and in use',
      (path) => {
        const b = only(build({ items: [item({ path, id: `${REPO}::worktree::${path}` })] }))
        expect(b.isMainCheckout).toBe(true)
        expect(b.bucket).toBe('alive')
      }
    )

    it('a repo path spelled with .. still matches the main checkout', () => {
      const main = item({
        path: REPO,
        id: `${REPO}::worktree::${REPO}`,
        repoPath: '/ws/org/proj/worktrees/../www'
      })
      expect(only(build({ items: [main] })).isMainCheckout).toBe(true)
    })

    it('neverClean spelled with .. matches the worktree', () => {
      const b = only(build({ neverClean: new Set([`${WT_A}/api/..`]) }))
      expect(b.neverClean).toBe(true)
      expect(b.bucket).toBe('alive')
    })

    it('a session folder spelled with .. counts when it resolves into the worktree', () => {
      const b = only(
        build({
          sessions: new Map([[`${WT_A}/api/../web`, { presence: 'working', lastActivityAt: NOW }]])
        })
      )
      expect(b.session).toBe('working')
      expect(b.bucket).toBe('alive')
    })

    it('a session folder that leaves the worktree through .. does not count', () => {
      const b = only(
        build({
          sessions: new Map([
            [`${WT_A}/../PROJ-0000-slug-b`, { presence: 'working', lastActivityAt: NOW }]
          ])
        })
      )
      expect(b.session).toBe('none')
      expect(b.bucket).toBe('corpse')
    })

    it('a working dir that leaves the worktree through .. is attributed where it resolves', () => {
      const wtA = item()
      const wtB = item({ path: WT_B, id: `${REPO}::worktree::${WT_B}`, branch: 'feat/slug-b' })
      const db = composeContainer('db', 'projb', `${WT_A}/../PROJ-0000-slug-b/deploy`)
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
        stacks: [stack('projb', [db])],
        containers: [db]
      })
      const a = out.find((b) => b.item.path === WT_A)!
      const b = out.find((x) => x.item.path === WT_B)!
      expect([...a.stackIds, ...a.sharedStackIds]).toEqual([])
      expect(b.stackIds).toEqual(['projb'])
    })

    it('a working dir spelled with . inside the worktree is exclusive to it', () => {
      const db = composeContainer('db', 'app', `${WT_A}/./deploy/../deploy`)
      const b = only(build({ stacks: [stack('app', [db])], containers: [db] }))
      expect(b.stackIds).toEqual(['app'])
    })

    it('a known folder spelled with .. protects its compose project', () => {
      const db = composeContainer('db', 'api-gateway', WT_A, {
        mounts: [volumeMount('api-gateway_pg')]
      })
      const b = only(
        build({
          stacks: [stack('api-gateway', [db])],
          containers: [db],
          volumes: labelled('api-gateway', 'api-gateway_pg'),
          knownFolders: ['/ws/org/other/api-gateway/.']
        })
      )
      expect(b.ownedVolumes).toEqual([])
    })
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

  describe('sessions in a subfolder count (delta 3, item 1)', () => {
    it('a working session in a subfolder keeps the bundle alive and dates its sign of life', () => {
      const activity = NOW - HOUR
      const b = only(
        build({
          sessions: new Map([
            [WT_A, { presence: 'none', lastActivityAt: NOW - 20 * DAY }],
            [`${WT_A}/api`, { presence: 'working', lastActivityAt: activity }]
          ])
        })
      )
      expect(b.session).toBe('working')
      expect(b.lastSignOfLifeAt).toBe(activity)
      expect(b.bucket).toBe('alive')
    })

    it('an idle session in a subfolder sends the bundle to decide, with no exact-path entry', () => {
      const b = only(
        build({
          sessions: new Map([[`${WT_A}/web/`, { presence: 'open-idle', lastActivityAt: null }]])
        })
      )
      expect(b.session).toBe('open-idle')
      expect(b.bucket).toBe('decide')
      expect(b.reason?.code).toBe('open-idle-session')
    })

    it('the strongest presence wins, and the latest activity is kept', () => {
      const later = NOW - 3 * DAY
      const b = only(
        build({
          sessions: new Map([
            [WT_A, { presence: 'open-idle', lastActivityAt: NOW - 9 * DAY }],
            [`${WT_A}/a`, { presence: 'needs-input', lastActivityAt: null }],
            [`${WT_A}/b`, { presence: 'none', lastActivityAt: later }]
          ])
        })
      )
      expect(b.session).toBe('needs-input')
      expect(b.lastSignOfLifeAt).toBe(later)
    })

    it('a sibling folder that only shares a name prefix does not count', () => {
      const b = only(
        build({
          sessions: new Map([
            [WT_A, { presence: 'none', lastActivityAt: null }],
            [`${WT_A}-other`, { presence: 'working', lastActivityAt: NOW - HOUR }],
            [`${WT_A}-other/api`, { presence: 'open-idle', lastActivityAt: NOW - HOUR }]
          ])
        })
      )
      expect(b.session).toBe('none')
      expect(b.lastSignOfLifeAt).toBe(Date.parse(OLD_MERGE))
      expect(b.bucket).toBe('corpse')
    })

    it('a session in a parent folder of the worktree does not count', () => {
      const b = only(
        build({
          sessions: new Map([['/ws/org/proj', { presence: 'working', lastActivityAt: NOW }]])
        })
      )
      expect(b.session).toBe('none')
      expect(b.bucket).toBe('corpse')
    })
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

describe('buildBundles — graceDays', () => {
  it('stamps the grace window the bundle was bucketed with', () => {
    expect(only(build()).graceDays).toBe(GRACE_DAYS)
  })

  it('stamps it on every bundle, whatever the bucket', () => {
    const alive = only(
      build({ sessions: new Map([[WT_A, { presence: 'working', lastActivityAt: null }]]) })
    )
    expect(alive.bucket).toBe('alive')
    expect(alive.graceDays).toBe(GRACE_DAYS)
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
    const b = only(
      build({
        stacks: [stack('app', [db, web])],
        containers: [db, web],
        volumes: labelled('app', 'pgdata')
      })
    )
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

  describe('bind-mounted stacks count (delta 3, item 2)', () => {
    it('a stack run from elsewhere that bind-mounts a folder in the worktree is shared, never a corpse', () => {
      const web = composeContainer('web', 'other', ELSEWHERE, {
        mounts: [bindMount(`${WT_A}/data`)]
      })
      const b = only(build({ stacks: [stack('other', [web])], containers: [web] }))
      expect(b.stackIds).toEqual([])
      expect(b.sharedStackIds).toEqual(['other'])
      expect(b.bucket).toBe('decide')
      expect(b.reason?.code).toBe('shared-stack')
    })

    it('a stack run from the worktree that bind-mounts a system path outside it is shared', () => {
      const web = composeContainer('web', 'app', WT_A, {
        mounts: [bindMount('/var/run/docker.sock')]
      })
      const b = only(build({ stacks: [stack('app', [web])], containers: [web] }))
      expect(b.stackIds).toEqual([])
      expect(b.sharedStackIds).toEqual(['app'])
      expect(b.bucket).toBe('decide')
    })

    it('a stack run from the worktree whose bind mounts all stay inside it is exclusive', () => {
      const web = composeContainer('web', 'app', WT_A, {
        mounts: [bindMount(`${WT_A}/src`), bindMount(`${WT_A}/data`)]
      })
      const b = only(build({ stacks: [stack('app', [web])], containers: [web] }))
      expect(b.stackIds).toEqual(['app'])
      expect(b.sharedStackIds).toEqual([])
    })

    it('a bind mount of a parent folder of the worktree does not tie the stack to it', () => {
      const web = composeContainer('web', 'other', ELSEWHERE, {
        mounts: [bindMount('/ws/org/proj')]
      })
      const b = only(build({ stacks: [stack('other', [web])], containers: [web] }))
      expect(b.stackIds).toEqual([])
      expect(b.sharedStackIds).toEqual([])
      expect(b.bucket).toBe('corpse')
    })
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

  it('nested worktrees that both fully contain one stack share it, so neither owns it', () => {
    const nestedPath = `${WT_A}/nested`
    const outer = item()
    const nested = item({
      path: nestedPath,
      id: `${REPO}::worktree::${nestedPath}`,
      branch: 'feat/slug-nested'
    })
    // Inside the nested worktree, and therefore inside the outer one too.
    const db = composeContainer('db', 'app', `${nestedPath}/deploy`)
    const out = build({
      items: [outer, nested],
      fateInputs: new Map([
        [outer.id, { facts: facts({ ancestorOfDefault: true }), localTip: TIP_A }],
        [
          nested.id,
          {
            facts: facts({ path: nestedPath, branch: 'feat/slug-nested', ancestorOfDefault: true }),
            localTip: TIP_B
          }
        ]
      ]),
      stacks: [stack('app', [db])],
      containers: [db]
    })
    expect(out).toHaveLength(2)
    for (const b of out) {
      expect(b.stackIds).toEqual([])
      expect(b.sharedStackIds).toContain('app')
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

  describe('protected projects and unlabelled volumes through the builder (delta 3, addendum)', () => {
    const db = composeContainer('db', 'app', WT_A, {
      mounts: [volumeMount('app_pg'), volumeMount('loose')]
    })
    const volumes = new Map<string, VolumeFact>([
      ['app_pg', { sizeBytes: 1, project: 'app' }],
      ['loose', { sizeBytes: 1, project: null }]
    ])

    it('a volume whose project is protected is not owned', () => {
      const b = only(
        build({
          stacks: [stack('app', [db])],
          containers: [db],
          volumes,
          protectedProjects: new Set(['app'])
        })
      )
      expect(b.stackIds).toEqual(['app'])
      expect(b.ownedVolumes).toEqual([])
    })

    it('an unlabelled volume is not owned, a labelled unique one is', () => {
      const b = only(build({ stacks: [stack('app', [db])], containers: [db], volumes }))
      expect(b.ownedVolumes).toEqual(['app_pg'])
    })
  })

  describe('a project shared with another known folder through the builder (delta 3, item 5a)', () => {
    const wwwDb = composeContainer('db', 'www', WT_A, { mounts: [volumeMount('www_pg')] })

    it('a worktree sharing the main checkout project, after the main checkout ran compose down, owns no volume', () => {
      const b = only(
        build({
          stacks: [stack('www', [wwwDb])],
          containers: [wwwDb],
          volumes: new Map([['www_pg', { sizeBytes: 1, project: 'www' }]])
        })
      )
      expect(b.stackIds).toEqual(['www'])
      expect(b.ownedVolumes).toEqual([])
    })

    it('a known folder passed in knownFolders counts the same way', () => {
      const db = composeContainer('db', 'api-gateway', WT_A, {
        mounts: [volumeMount('api-gateway_pg')]
      })
      const b = only(
        build({
          stacks: [stack('api-gateway', [db])],
          containers: [db],
          volumes: new Map([['api-gateway_pg', { sizeBytes: 1, project: 'api-gateway' }]]),
          knownFolders: [ELSEWHERE]
        })
      )
      expect(b.ownedVolumes).toEqual([])
    })

    it('a known folder whose name starts with an underscore protects the trimmed project (delta 4, item G)', () => {
      const db = composeContainer('db', 'api-gateway', WT_A, {
        mounts: [volumeMount('api-gateway_pg')]
      })
      const b = only(
        build({
          stacks: [stack('api-gateway', [db])],
          containers: [db],
          volumes: labelled('api-gateway', 'api-gateway_pg'),
          knownFolders: ['/ws/org/other/_api-gateway']
        })
      )
      expect(b.stackIds).toEqual(['api-gateway'])
      expect(b.ownedVolumes).toEqual([])
    })

    it('another worktree item counts as a known folder', () => {
      const wtB = item({ path: WT_B, id: `${REPO}::worktree::${WT_B}`, branch: 'feat/slug-b' })
      const db = composeContainer('db', 'proj-0000-slug-b', WT_A, {
        mounts: [volumeMount('proj-0000-slug-b_pg')]
      })
      const out = build({
        items: [item(), wtB],
        stacks: [stack('proj-0000-slug-b', [db])],
        containers: [db],
        volumes: labelled('proj-0000-slug-b', 'proj-0000-slug-b_pg')
      })
      expect(out.find((b) => b.item.path === WT_A)?.ownedVolumes).toEqual([])
    })

    it('the bundle own folder name does not count against it', () => {
      const db = composeContainer('db', 'proj-0000-slug-a', WT_A, {
        mounts: [volumeMount('proj-0000-slug-a_pg')]
      })
      const b = only(
        build({
          stacks: [stack('proj-0000-slug-a', [db])],
          containers: [db],
          volumes: labelled('proj-0000-slug-a', 'proj-0000-slug-a_pg')
        })
      )
      expect(b.ownedVolumes).toEqual(['proj-0000-slug-a_pg'])
    })
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
        containers: [db, other],
        volumes: labelled('app', 'pgdata', 'shared-cache')
      })
    )
    expect(b.stackIds).toEqual(['app'])
    expect(b.ownedVolumes).toEqual(['pgdata'])
  })
})

// ---- path aliasing (delta 4, item C) ------------------------------------------------

describe('bucketOf — unresolved paths (delta 4, item C)', () => {
  it('a bundle whose paths did not all resolve is review path-unresolved, never ready', () => {
    const r = bucketOf(corpseFacts({ pathsResolved: false }), NOW, GRACE_DAYS)
    expect(r.bucket).toBe('decide')
    expect(r.reason?.code).toBe('path-unresolved')
    expect(r.reason?.detail.length).toBeGreaterThan(0)
  })

  it('fails closed when the flag is absent', () => {
    const { pathsResolved: _omit, ...rest } = corpseFacts()
    const r = bucketOf(rest as BundleFacts, NOW, GRACE_DAYS)
    expect(r.bucket).toBe('decide')
    expect(r.reason?.code).toBe('path-unresolved')
  })

  it('the in-use rules still win: a working session stays in use', () => {
    const r = bucketOf(corpseFacts({ pathsResolved: false, session: 'working' }), NOW, GRACE_DAYS)
    expect(r).toEqual({ bucket: 'alive', reason: null })
  })

  it('comes before the fate rules', () => {
    const closed: FateResult = { fate: 'closed-unmerged', signal: null, strong: false }
    const r = bucketOf(corpseFacts({ pathsResolved: false, fate: closed }), NOW, GRACE_DAYS)
    expect(r.reason?.code).toBe('path-unresolved')
  })
})

describe('buildBundles — real paths (delta 4, item C)', () => {
  const LINK = '/link/wt'

  it('marks a bundle whose every path resolved', () => {
    expect(only(build()).pathsResolved).toBe(true)
  })

  it('P3: a stack whose working dir is a symlink to the worktree is attributed to it', () => {
    const db = composeContainer('db', 'app', `${LINK}/deploy`)
    const b = only(
      build({
        stacks: [stack('app', [db])],
        containers: [db],
        canonical: aliases({ [LINK]: WT_A })
      })
    )
    expect(b.stackIds).toEqual(['app'])
    expect(b.sharedStackIds).toEqual([])
    expect(b.pathsResolved).toBe(true)
  })

  it('P3b: a stack that bind-mounts the worktree through a symlink shares it', () => {
    const web = composeContainer('web', 'other', ELSEWHERE, { mounts: [bindMount(`${LINK}/data`)] })
    const b = only(
      build({
        stacks: [stack('other', [web])],
        containers: [web],
        canonical: aliases({ [LINK]: WT_A })
      })
    )
    expect(b.sharedStackIds).toEqual(['other'])
    expect(b.bucket).toBe('decide')
    expect(b.reason?.code).toBe('shared-stack')
  })

  it('P9: a session working in the worktree through a symlink keeps it in use', () => {
    const b = only(
      build({
        sessions: new Map([[`${LINK}/api`, { presence: 'working', lastActivityAt: NOW }]]),
        canonical: aliases({ [LINK]: WT_A })
      })
    )
    expect(b.session).toBe('working')
    expect(b.bucket).toBe('alive')
  })

  it('a worktree item reached through a symlink is matched on its real path', () => {
    const db = composeContainer('db', 'app', `${WT_A}/deploy`)
    const linked = item({ path: LINK, id: `${REPO}::worktree::${LINK}` })
    const b = only(
      build({
        items: [linked],
        stacks: [stack('app', [db])],
        containers: [db],
        canonical: aliases({ [LINK]: WT_A })
      })
    )
    expect(b.stackIds).toEqual(['app'])
  })

  it('a worktree path that is a symlink to its repo path is the main checkout', () => {
    const linked = item({ path: LINK, id: `${REPO}::worktree::${LINK}` })
    const b = only(build({ items: [linked], canonical: aliases({ [LINK]: REPO }) }))
    expect(b.isMainCheckout).toBe(true)
    expect(b.bucket).toBe('alive')
  })

  it('neverClean and known folders are compared on their real paths', () => {
    const b = only(build({ neverClean: new Set([LINK]), canonical: aliases({ [LINK]: WT_A }) }))
    expect(b.neverClean).toBe(true)

    const db = composeContainer('db', 'api-gateway', WT_A, {
      mounts: [volumeMount('api-gateway_pg')]
    })
    const viaLink = only(
      build({
        stacks: [stack('api-gateway', [db])],
        containers: [db],
        volumes: labelled('api-gateway', 'api-gateway_pg'),
        knownFolders: ['/link/gw'],
        canonical: aliases({ '/link/gw': ELSEWHERE })
      })
    )
    expect(viaLink.ownedVolumes).toEqual([])
  })

  it('a stack attributed through stackPaths is compared on the real path', () => {
    const api = composeContainer('api', 'svc', null)
    const b = only(
      build({
        stacks: [stack('svc', [api])],
        stackPaths: new Map([['svc', `${LINK}/services`]]),
        containers: [api],
        canonical: aliases({ [LINK]: WT_A })
      })
    )
    expect(b.stackIds).toEqual(['svc'])
  })

  describe('an unresolved path can never be ready', () => {
    const expectUnresolved = (b: ReturnType<typeof only>): void => {
      expect(b.pathsResolved).toBe(false)
      expect(b.bucket).toBe('decide')
      expect(b.reason?.code).toBe('path-unresolved')
    }

    it('the worktree path itself', () => {
      expectUnresolved(only(build({ canonical: aliases({}, [WT_A]) })))
    })

    it('the repo path', () => {
      expectUnresolved(only(build({ canonical: aliases({}, [REPO]) })))
    })

    it('a container working dir inside the worktree', () => {
      const db = composeContainer('db', 'app', `${WT_A}/deploy`)
      expectUnresolved(
        only(
          build({
            stacks: [stack('app', [db])],
            containers: [db],
            canonical: aliases({}, [`${WT_A}/deploy`])
          })
        )
      )
    })

    it('a bind source that is an ancestor of the worktree', () => {
      const web = container('web', { mounts: [bindMount('/ws/org/proj')] })
      expectUnresolved(
        only(
          build({
            stacks: [stack('web', [web])],
            containers: [web],
            canonical: aliases({}, ['/ws/org/proj'])
          })
        )
      )
    })

    it('a session folder inside the worktree', () => {
      expectUnresolved(
        only(
          build({
            sessions: new Map([[`${WT_A}/api`, { presence: 'none', lastActivityAt: null }]]),
            canonical: aliases({}, [`${WT_A}/api`])
          })
        )
      )
    })

    it('an unresolved folder unrelated to the worktree changes nothing', () => {
      const web = composeContainer('web', 'other', ELSEWHERE)
      const b = only(
        build({
          stacks: [stack('other', [web])],
          containers: [web],
          sessions: new Map([[`${WT_A}-other`, { presence: 'none', lastActivityAt: null }]]),
          canonical: aliases({}, [ELSEWHERE, `${WT_A}-other`])
        })
      )
      expect(b.pathsResolved).toBe(true)
      expect(b.bucket).toBe('corpse')
    })
  })
})

describe('containerFolders through a resolver (delta 4, item C)', () => {
  it('maps every folder through the real path, then the canonical key', () => {
    const c = composeContainer('web', 'app', '/link/wt', { mounts: [bindMount('/link/wt/data')] })
    expect(containerFolders(c, 'linux', aliases({ '/link/wt': WT_A }))).toEqual([
      WT_A,
      `${WT_A}/data`
    ])
  })

  it('folds a darwin case difference between the link target and the worktree', () => {
    const c = composeContainer('web', 'app', '/link/wt')
    const real = containerFolders(c, 'darwin', aliases({ '/link/wt': '/Users/Me/Proj/WT' }))
    expect(real).toEqual([canonicalPathKey('/users/me/proj/wt', 'darwin')])
  })
})
