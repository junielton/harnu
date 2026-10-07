import { describe, it, expect } from 'vitest'
import { buildBundles, type SessionPresence } from '../src/main/gc/bundle-core'
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
import { DAY, NOW, MAIN, WT_CORPSE, reapItem } from './gc-snapshot-fixtures'

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
    path: WT_CORPSE,
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
  mergedAgo?: number
}

/** A merged worktree whose merge landed `mergedAgo` ago (default: an hour, inside grace). */
function build(over: Over = {}) {
  const mergedAt = new Date(NOW - (over.mergedAgo ?? 3_600_000)).toISOString()
  const it = reapItem(WT_CORPSE, {
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
    fateInputs: new Map([[it.id, { facts: facts(over.facts), localTip: TIP }]]),
    stacks: [],
    stackPaths: new Map(),
    containers: [],
    sessions: new Map([
      [
        WT_CORPSE,
        { presence: over.presence ?? 'none', lastActivityAt: over.lastActivityAt ?? null }
      ]
    ]),
    keep: new Set(over.keep ? [it.id] : []),
    neverClean: new Set(over.neverClean ? [WT_CORPSE] : []),
    now: NOW,
    graceDays: GRACE,
    ...(released ? { released } : {})
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
  it('AC-3: without a release, a merged bundle inside its grace is alive', () => {
    expect(build({ released: null }).bucket).toBe('alive')
  })

  it('AC-3: a release skips the grace, so the same bundle is a corpse', () => {
    const b = build()
    expect(b.bucket).toBe('corpse')
    expect(b.graceDays).toBe(0)
  })

  it('AC-3: with no sign of life at all, the release time stands in for one', () => {
    const b = build({ item: { checkpoints: [{ id: 'local-clean', state: 'green' }] } })
    expect(b.lastSignOfLifeAt).toBe(NOW - 60_000)
    expect(b.bucket).toBe('corpse')
  })

  it('AC-3: a release never makes a bundle that was already past grace worse off', () => {
    expect(build({ mergedAgo: 10 * DAY }).bucket).toBe('corpse')
  })

  it('AC-3: a mark for another bundle changes nothing', () => {
    expect(build({ released: new Map([['some-other-id', NOW - 1]]) }).bucket).toBe('alive')
  })

  it('AC-3: a release has no effect unless the fate is merged and strong', () => {
    const open = build({
      facts: { ancestorOfDefault: false, pr: pr({ state: 'OPEN', mergedAt: null }) }
    })
    expect(open.fate.fate).toBe('open')
    expect(open.bucket).toBe('alive')
    expect(open.graceDays).toBe(GRACE)

    const closed = build({
      facts: { ancestorOfDefault: false, pr: pr({ state: 'CLOSED', mergedAt: null }) }
    })
    expect(closed.fate.fate).toBe('closed-unmerged')
    expect(closed.bucket).toBe('alive')

    const weak = build({
      facts: { ancestorOfDefault: null, pr: pr({ headRefOid: 'b'.repeat(40) }) }
    })
    expect(weak.fate.strong).toBe(false)
    expect(weak.bucket).not.toBe('corpse')
  })

  describe('AC-4: a release never bypasses a safety rule', () => {
    it('dirty tracked files', () => {
      const b = build({ item: { blockers: ['dirty'] } })
      expect(b.bucket).toBe('decide')
      expect(b.reason?.code).toBe('dirty')
    })

    it('unpushed commits', () => {
      const b = build({ item: { blockers: ['unpushed'] } })
      expect(b.bucket).toBe('decide')
      expect(b.reason?.code).toBe('unpushed')
    })

    it('a working or needs-input session', () => {
      expect(build({ presence: 'working' }).bucket).toBe('alive')
      expect(build({ presence: 'needs-input' }).bucket).toBe('alive')
    })

    it('an open but idle session', () => {
      const b = build({ presence: 'open-idle' })
      expect(b.bucket).toBe('decide')
      expect(b.reason?.code).toBe('open-idle-session')
    })

    it('keep', () => {
      expect(build({ keep: true }).bucket).toBe('alive')
    })

    it('neverClean', () => {
      expect(build({ neverClean: true }).bucket).toBe('alive')
    })

    it('a stack shared with another worktree', () => {
      const it = reapItem(WT_CORPSE)
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
      const containers = [ctr('db', WT_CORPSE), ctr('web', '/home/dev/org/elsewhere')]
      const b = buildBundles({
        items: [it],
        fateInputs: new Map([[it.id, { facts: facts(), localTip: TIP }]]),
        stacks: [{ id: 'app', name: 'app', kind: 'compose', project: 'app', containers }],
        stackPaths: new Map(),
        containers,
        sessions: new Map([[WT_CORPSE, { presence: 'none' as const, lastActivityAt: null }]]),
        keep: new Set(),
        neverClean: new Set(),
        now: NOW,
        graceDays: GRACE,
        released: new Map([[it.id, NOW - 60_000]])
      })[0]!
      expect(b.sharedStackIds).toEqual(['app'])
      expect(b.bucket).toBe('decide')
      expect(b.reason?.code).toBe('shared-stack')
    })

    it('a released bundle that is not a corpse is never planned for cleaning', () => {
      const prefs = { ...defaultGcPrefs(), autopilot: true, firstReportAcknowledged: true }
      const dirty = build({ item: { blockers: ['dirty'] } })
      expect(planCycle([dirty], prefs).toClean).toEqual([])
      expect(planCycle([build()], prefs).toClean).toHaveLength(1)
    })
  })
})
