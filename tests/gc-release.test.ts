import { describe, it, expect } from 'vitest'
import {
  AS_GIVEN,
  buildBundles,
  staleReleases,
  type ReleaseGone,
  type SessionPresence
} from '../src/main/gc/bundle-core'
import {
  defaultGcPrefs,
  mergeIncomingPrefs,
  normalizeGcPrefs,
  withReleased,
  withoutReleased
} from '../src/main/gc/gc-prefs'
import { planCycle } from '../src/main/gc/autopilot-core'
import {
  COMPOSE_WORKING_DIR_LABEL,
  type InspectedContainer
} from '../src/main/containers/containers-core'
import type { BranchFacts, PrFacts, ReapItem } from '../src/main/reaper/reaper-core'
import { DAY, NOW, MAIN, WT_READY, reapItem } from './gc-snapshot-fixtures'

/**
 * T445 — the release mark. `released` lives in the GC prefs and is honored where the
 * bundle is judged: a released bundle skips the grace window and nothing else.
 */

const TIP = 'a'.repeat(40)
const GRACE = 2

function facts(over: Partial<BranchFacts> = {}): BranchFacts {
  return {
    kind: 'worktree',
    repoPath: MAIN,
    branch: 'feat/slug',
    path: WT_READY,
    hidden: false,
    sessionLive: false,
    trackedDirty: false,
    untracked: [],
    unpushed: false,
    remoteExists: false,
    ancestorOfDefault: true,
    patchIdContained: null,
    lastCommitAt: null,
    pr: null,
    ghAvailable: true,
    prSetComplete: true,
    prProvenance: 'own-name',
    ...over
  }
}

function pr(over: Partial<PrFacts> = {}): PrFacts {
  return {
    number: 1,
    state: 'MERGED',
    reviewDecision: 'APPROVED',
    ci: 'passing',
    mergedAt: new Date(NOW).toISOString(),
    headRefOid: TIP,
    ...over
  }
}

interface Over {
  item?: Partial<ReapItem>
  facts?: Partial<BranchFacts>
  presence?: SessionPresence
  lastActivityAt?: number | null
  keep?: boolean
  neverClean?: boolean
  released?: ReadonlyMap<string, number> | null
  /** The tip each mark was made at; defaults to the bundle's own tip. null passes none. */
  releasedTips?: ReadonlyMap<string, string> | null
  /** The local tip the fate is judged on; defaults to TIP. */
  localTip?: string | null
  mergedAgo?: number
}

/** A merged worktree whose merge landed `mergedAgo` ago (default: an hour, inside grace). */
function build(over: Over = {}) {
  const mergedAt = new Date(NOW - (over.mergedAgo ?? 3_600_000)).toISOString()
  const it = reapItem(WT_READY, {
    checkpoints: [
      { id: 'pr-merged', state: 'green', detail: mergedAt },
      { id: 'local-clean', state: 'green' }
    ],
    ...over.item
  })
  const released =
    over.released === null ? undefined : (over.released ?? new Map([[it.id, NOW - 60_000]]))
  return buildBundles({
    items: [it],
    fateInputs: new Map([
      [
        it.id,
        { facts: facts(over.facts), localTip: 'localTip' in over ? (over.localTip ?? null) : TIP }
      ]
    ]),
    stacks: [],
    stackPaths: new Map(),
    containers: [],
    sessions: new Map([
      [WT_READY, { presence: over.presence ?? 'none', lastActivityAt: over.lastActivityAt ?? null }]
    ]),
    keep: new Set(over.keep ? [it.id] : []),
    neverClean: new Set(over.neverClean ? [WT_READY] : []),
    now: NOW,
    graceDays: GRACE,
    volumes: new Map(),
    knownFolders: [],
    protectedProjects: new Set<string>(),
    canonical: AS_GIVEN,
    ...(released ? { released } : {}),
    ...(over.releasedTips === null
      ? {}
      : { releasedTips: over.releasedTips ?? new Map([[it.id, TIP]]) })
  })[0]!
}

describe('released prefs (T445)', () => {
  it('defaults to nothing released', () => {
    expect(defaultGcPrefs().released).toEqual({})
  })

  it('normalizes junk: only finite non-negative times under non-empty ids survive', () => {
    const p = normalizeGcPrefs({
      released: { a: 5, '': 1, b: 'x', c: Infinity, d: -1, e: null }
    })
    expect(p.released).toEqual({ a: 5 })
    expect(normalizeGcPrefs({ released: [1, 2] }).released).toEqual({})
  })

  it('withReleased / withoutReleased add and drop marks without touching Keep', () => {
    const base = { ...defaultGcPrefs(), keep: { k: 'merged' } }
    const one = withReleased(base, 'x', 7)
    expect(one.released).toEqual({ x: 7 })
    expect(one.keep).toEqual({ k: 'merged' })
    expect(withoutReleased(one, ['x', 'nope']).released).toEqual({})
  })

  it('a whole-object write from the renderer cannot wipe the marks', () => {
    const current = withReleased(defaultGcPrefs(), 'x', 7)
    const next = mergeIncomingPrefs(current, { ...defaultGcPrefs(), released: {} })
    expect(next.released).toEqual({ x: 7 })
  })
})

describe('buildBundles honors a release (T445)', () => {
  it('AC-3: without a release, a merged bundle inside its grace is in-use', () => {
    expect(build({ released: null }).bucket).toBe('in-use')
  })

  it('AC-3: a release skips the grace, so the same bundle is ready', () => {
    const b = build()
    expect(b.bucket).toBe('ready')
    expect(b.graceDays).toBe(0)
  })

  it('AC-3: with no sign of life at all, the release time stands in for one', () => {
    const b = build({ item: { checkpoints: [{ id: 'local-clean', state: 'green' }] } })
    expect(b.lastSignOfLifeAt).toBe(NOW - 60_000)
    expect(b.bucket).toBe('ready')
  })

  it('AC-3: a release never makes a bundle that was already past grace worse off', () => {
    expect(build({ mergedAgo: 10 * DAY }).bucket).toBe('ready')
  })

  it('AC-3: a mark for another bundle changes nothing', () => {
    expect(build({ released: new Map([['some-other-id', NOW - 1]]) }).bucket).toBe('in-use')
  })

  it('AC-3: a release has no effect unless the fate is merged and strong', () => {
    const open = build({
      facts: { ancestorOfDefault: false, pr: pr({ state: 'OPEN', mergedAt: null }) }
    })
    expect(open.fate.fate).toBe('open')
    expect(open.bucket).toBe('in-use')
    expect(open.graceDays).toBe(GRACE)

    const closed = build({
      facts: { ancestorOfDefault: false, pr: pr({ state: 'CLOSED', mergedAt: null }) }
    })
    expect(closed.fate.fate).toBe('closed-unmerged')
    expect(closed.bucket).toBe('in-use')

    const weak = build({
      facts: { ancestorOfDefault: null, pr: pr({ headRefOid: 'b'.repeat(40) }) }
    })
    expect(weak.fate.strong).toBe(false)
    expect(weak.bucket).not.toBe('ready')
  })

  describe('AC-4: a release never bypasses a safety rule', () => {
    it('dirty tracked files', () => {
      const b = build({ item: { blockers: ['dirty'] } })
      expect(b.bucket).toBe('review')
      expect(b.reason?.code).toBe('dirty')
    })

    it('unpushed commits', () => {
      const b = build({ item: { blockers: ['unpushed'] } })
      expect(b.bucket).toBe('review')
      expect(b.reason?.code).toBe('unpushed')
    })

    it('a working or needs-input session', () => {
      expect(build({ presence: 'working' }).bucket).toBe('in-use')
      expect(build({ presence: 'needs-input' }).bucket).toBe('in-use')
    })

    it('an open but idle session', () => {
      const b = build({ presence: 'open-idle' })
      expect(b.bucket).toBe('review')
      expect(b.reason?.code).toBe('open-idle-session')
    })

    it('keep', () => {
      expect(build({ keep: true }).bucket).toBe('in-use')
    })

    it('neverClean', () => {
      expect(build({ neverClean: true }).bucket).toBe('in-use')
    })

    it('a stack shared with another worktree', () => {
      const it = reapItem(WT_READY)
      const ctr = (id: string, dir: string): InspectedContainer => ({
        id,
        name: id,
        image: 'postgres:16',
        labels: { 'com.docker.compose.project': 'app', [COMPOSE_WORKING_DIR_LABEL]: dir },
        state: 'running',
        startedAt: null,
        finishedAt: null,
        createdAt: null,
        ports: [],
        mounts: []
      })
      const containers = [ctr('db', WT_READY), ctr('web', '/srv/ws/org/elsewhere')]
      const b = buildBundles({
        items: [it],
        fateInputs: new Map([[it.id, { facts: facts(), localTip: TIP }]]),
        stacks: [{ id: 'app', name: 'app', kind: 'compose', project: 'app', containers }],
        stackPaths: new Map(),
        containers,
        sessions: new Map([[WT_READY, { presence: 'none' as const, lastActivityAt: null }]]),
        keep: new Set(),
        neverClean: new Set(),
        now: NOW,
        graceDays: GRACE,
        volumes: new Map(),
        knownFolders: [],
        protectedProjects: new Set<string>(),
        canonical: AS_GIVEN,
        released: new Map([[it.id, NOW - 60_000]])
      })[0]!
      expect(b.sharedStackIds).toEqual(['app'])
      expect(b.bucket).toBe('review')
      expect(b.reason?.code).toBe('shared-stack')
    })

    it('a released bundle that is not ready is never planned for cleaning', () => {
      const prefs = { ...defaultGcPrefs(), autopilot: true, firstReportAcknowledged: true }
      const dirty = build({ item: { blockers: ['dirty'] } })
      expect(planCycle([dirty], prefs).toClean).toEqual([])
      expect(planCycle([build()], prefs).toClean).toHaveLength(1)
    })
  })
})

describe('staleReleases: when a release mark is dropped (T445 delta 1)', () => {
  const marks = { [reapItem(WT_READY).id]: NOW - 1000 }

  it('keeps every mark on a startup gather that has no Reaper snapshot (zero bundles)', () => {
    expect(staleReleases([], marks)).toEqual([])
  })

  it('keeps the marks of a repo that dropped out of the scan', () => {
    const otherRepo = build({ released: null }) // a bundle, but not the marked one
    const other = { ...otherRepo, item: { ...otherRepo.item, id: 'other-repo::worktree::/x' } }
    expect(staleReleases([other], marks)).toEqual([])
  })

  it('keeps a mark whose bundle is still strongly merged', () => {
    expect(staleReleases([build()], marks)).toEqual([])
  })

  it('drops a mark whose bundle is present and no longer strongly merged', () => {
    const reopened = build({
      facts: { ancestorOfDefault: false, pr: pr({ state: 'OPEN', mergedAt: null }) }
    })
    expect(staleReleases([reopened], marks)).toEqual([reapItem(WT_READY).id])
    const weak = build({
      facts: { ancestorOfDefault: null, pr: pr({ headRefOid: 'b'.repeat(40) }) }
    })
    expect(staleReleases([weak], marks)).toEqual([reapItem(WT_READY).id])
  })
})

describe('staleReleases: a cleaned worktree drops its mark (T445 delta 1 ruling)', () => {
  const id = reapItem(WT_READY).id
  const marks = { [id]: NOW - 1000 }
  const from = { [id]: { repoPath: MAIN, path: WT_READY, localTip: TIP } }
  const gone = (over: Partial<ReleaseGone> = {}): ReleaseGone => ({
    scannedRepos: new Set([MAIN]),
    from,
    missingPaths: new Set([WT_READY]),
    ...over
  })

  it('drops a mark when the repo was scanned, the bundle is absent and the path is gone', () => {
    expect(staleReleases([], marks, gone())).toEqual([id])
  })

  it('keeps it when there was no Reaper snapshot (no repo was scanned)', () => {
    expect(staleReleases([], marks, gone({ scannedRepos: new Set() }))).toEqual([])
  })

  it('keeps it when the repo was not part of the scan', () => {
    expect(staleReleases([], marks, gone({ scannedRepos: new Set(['/srv/ws/other']) }))).toEqual([])
  })

  it('keeps it when the path still exists', () => {
    expect(staleReleases([], marks, gone({ missingPaths: new Set() }))).toEqual([])
  })

  it('keeps a mark that recorded no path (it cannot be shown cleaned)', () => {
    expect(staleReleases([], marks, gone({ from: {} }))).toEqual([])
  })

  it('compares paths after normalizing them (trailing slash)', () => {
    expect(staleReleases([], marks, gone({ scannedRepos: new Set([`${MAIN}/`]) }))).toEqual([id])
    expect(staleReleases([], marks, gone({ missingPaths: new Set([`${WT_READY}/`]) }))).toEqual([
      id
    ])
  })

  it('keeps a mark whose bundle is present and strongly merged, even if the path set says missing', () => {
    expect(staleReleases([build()], marks, gone())).toEqual([])
  })

  it('without the extra input the rule is unchanged (an absent bundle is never stale)', () => {
    expect(staleReleases([], marks)).toEqual([])
  })
})

describe('releasedFrom prefs (T445 delta 1 ruling)', () => {
  const id = 'www::worktree::feat::abc'

  it('defaults to nothing recorded', () => {
    expect(defaultGcPrefs().releasedFrom).toEqual({})
  })

  it('withReleased records where the worktree was, withoutReleased forgets it', () => {
    const p = withReleased(defaultGcPrefs(), id, 7, { repoPath: MAIN, path: WT_READY })
    expect(p.released).toEqual({ [id]: 7 })
    expect(p.releasedFrom).toEqual({ [id]: { repoPath: MAIN, path: WT_READY } })
    const q = withoutReleased(p, [id])
    expect(q.released).toEqual({})
    expect(q.releasedFrom).toEqual({})
  })

  it('withReleased without a location records none', () => {
    expect(withReleased(defaultGcPrefs(), id, 7).releasedFrom).toEqual({})
  })

  it('normalizes junk: only entries with two non-empty strings survive', () => {
    const p = normalizeGcPrefs({
      releasedFrom: {
        ok: { repoPath: MAIN, path: WT_READY },
        a: { repoPath: '', path: 'x' },
        b: { repoPath: 'x' },
        c: 'nope',
        '': { repoPath: 'x', path: 'y' }
      }
    })
    expect(p.releasedFrom).toEqual({ ok: { repoPath: MAIN, path: WT_READY } })
    expect(normalizeGcPrefs({ releasedFrom: [1] }).releasedFrom).toEqual({})
  })

  it('a whole-object write from the renderer cannot wipe them', () => {
    const current = withReleased(defaultGcPrefs(), id, 7, { repoPath: MAIN, path: WT_READY })
    const next = mergeIncomingPrefs(current, { ...defaultGcPrefs(), releasedFrom: {} })
    expect(next.releasedFrom).toEqual(current.releasedFrom)
  })
})

describe('a release is tied to the tip it was made at (T445 delta 2, 4)', () => {
  const NEW_TIP = 'c'.repeat(40)
  const id = reapItem(WT_READY).id

  it('applies while the bundle’s tip is the tip of the release', () => {
    const b = build()
    expect(b.localTip).toBe(TIP)
    expect(b.bucket).toBe('ready')
    expect(b.graceDays).toBe(0)
  })

  it('does not apply once new commits moved the tip, even if the new tip is strongly merged', () => {
    // Released at TIP; the branch then got new commits (NEW_TIP) and merged again.
    const b = build({
      localTip: NEW_TIP,
      facts: { pr: pr({ headRefOid: NEW_TIP }), ancestorOfDefault: true }
    })
    expect(b.fate.strong).toBe(true)
    expect(b.localTip).toBe(NEW_TIP)
    expect(b.graceDays).toBe(GRACE)
    expect(b.bucket).toBe('in-use')
  })

  it('does not apply to a mark that recorded no tip (a legacy mark cannot be shown to match)', () => {
    const b = build({ releasedTips: null })
    expect(b.graceDays).toBe(GRACE)
    expect(b.bucket).toBe('in-use')
  })

  it('does not apply when the bundle has no tip to compare', () => {
    const b = build({ localTip: null })
    expect(b.bucket).not.toBe('ready')
  })

  describe('staleReleases drops a mark whose tip moved or was never recorded', () => {
    const marks = { [id]: NOW - 1000 }
    const gone = (tip?: string): ReleaseGone => ({
      scannedRepos: new Set([MAIN]),
      from: { [id]: { repoPath: MAIN, path: WT_READY, ...(tip ? { localTip: tip } : {}) } },
      missingPaths: new Set()
    })

    it('keeps it at the same tip', () => {
      expect(staleReleases([build()], marks, gone(TIP))).toEqual([])
    })

    it('drops it after new commits followed by a strong merge', () => {
      const moved = build({
        localTip: NEW_TIP,
        facts: { pr: pr({ headRefOid: NEW_TIP }), ancestorOfDefault: true }
      })
      expect(moved.fate.strong).toBe(true)
      expect(staleReleases([moved], marks, gone(TIP))).toEqual([id])
    })

    it('drops a legacy mark that recorded no tip', () => {
      expect(staleReleases([build()], marks, gone())).toEqual([id])
    })

    it('without the context the rule stays fate-only', () => {
      const moved = build({
        localTip: NEW_TIP,
        facts: { pr: pr({ headRefOid: NEW_TIP }), ancestorOfDefault: true }
      })
      expect(staleReleases([moved], marks)).toEqual([])
    })
  })

  describe('prefs', () => {
    it('keeps the tip in releasedFrom and ignores a non-string tip', () => {
      const p = normalizeGcPrefs({
        releasedFrom: {
          a: { repoPath: MAIN, path: WT_READY, localTip: TIP },
          b: { repoPath: MAIN, path: WT_READY, localTip: 5 },
          c: { repoPath: MAIN, path: WT_READY }
        }
      })
      expect(p.releasedFrom.a!.localTip).toBe(TIP)
      expect(p.releasedFrom.b).toEqual({ repoPath: MAIN, path: WT_READY })
      expect(p.releasedFrom.c).toEqual({ repoPath: MAIN, path: WT_READY })
    })

    it('withReleased records the tip', () => {
      const p = withReleased(defaultGcPrefs(), id, 7, {
        repoPath: MAIN,
        path: WT_READY,
        localTip: TIP
      })
      expect(p.releasedFrom[id]).toEqual({ repoPath: MAIN, path: WT_READY, localTip: TIP })
    })
  })
})
