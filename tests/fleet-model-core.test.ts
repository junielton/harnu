import { describe, expect, it } from 'vitest'
import type { SessionEntry } from '../src/main/claude-reader'
import type { FolderEntry, GitMeta } from '../src/main/folder-model'
import {
  EMPTY_FLEET_STATE,
  deriveFolders,
  flattenFolders,
  membershipSignature,
  mergeSlugSessions,
  replaceAllSessions,
  sessionEntriesEqual,
  slugOfPath,
  type FleetState
} from '../src/main/fleet-model-core'

/** Minimal `SessionEntry` factory, mirrors `folder-model.test.ts`'s `makeSession`. */
function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: 'sess-default',
    fullPath: '',
    fileMtime: 0,
    firstPrompt: '',
    summary: '',
    messageCount: 0,
    created: '',
    modified: '',
    gitBranch: '',
    projectPath: '/home/user/proj',
    isSidechain: false,
    status: 'idle',
    agents: [],
    resumable: false,
    bridged: false,
    transcriptState: 'unknown',
    awaySummary: '',
    whatsHappening: '',
    ctxPct: null,
    teamName: '',
    agentName: '',
    ...overrides
  }
}

const ROOT = '/home/user/.claude/projects'

describe('slugOfPath', () => {
  it('extracts the first path segment under rootDir', () => {
    expect(slugOfPath(ROOT, `${ROOT}/-home-user-alpha/abc.jsonl`)).toBe('-home-user-alpha')
  })

  it('returns empty string for a path outside rootDir', () => {
    expect(slugOfPath(ROOT, '/somewhere/else/abc.jsonl')).toBe('')
  })

  it('returns empty string for rootDir itself', () => {
    expect(slugOfPath(ROOT, ROOT)).toBe('')
  })
})

describe('flattenFolders', () => {
  it('flattens sessions across folders and builds a gitByPath map from only-defined fields', () => {
    const s1 = makeSession({ sessionId: 's1', projectPath: '/home/user/alpha' })
    const s2 = makeSession({ sessionId: 's2', projectPath: '/home/user/beta' })
    const folders: FolderEntry[] = [
      { path: '/home/user/alpha', alias: 'alpha', gitBranch: 'main', sessions: [s1] },
      { path: '/home/user/beta', alias: 'beta', sessions: [s2] }
    ]

    const { sessions, gitByPath } = flattenFolders(folders)

    expect(sessions).toEqual([s1, s2])
    expect(gitByPath.get('/home/user/alpha')).toEqual({ gitBranch: 'main' })
    expect(gitByPath.has('/home/user/beta')).toBe(false)
  })

  it('returns empty containers for no folders', () => {
    const { sessions, gitByPath } = flattenFolders([])
    expect(sessions).toEqual([])
    expect(gitByPath.size).toBe(0)
  })
})

describe('replaceAllSessions', () => {
  it('wholesale-replaces sessions and gitByPath, bumping version', () => {
    const s1 = makeSession({ sessionId: 's1' })
    const gitByPath = new Map<string, GitMeta>([['/home/user/proj', { gitBranch: 'main' }]])

    const next = replaceAllSessions(EMPTY_FLEET_STATE, [s1], gitByPath)

    expect(next.sessions).toEqual([s1])
    expect(next.gitByPath).toBe(gitByPath)
    expect(next.version).toBe(EMPTY_FLEET_STATE.version + 1)
  })

  it('does not mutate the prior state', () => {
    const prior: FleetState = {
      sessions: [makeSession({ sessionId: 'old' })],
      gitByPath: new Map(),
      version: 3
    }
    const next = replaceAllSessions(prior, [], new Map())
    expect(prior.sessions.length).toBe(1)
    expect(next.version).toBe(4)
  })

  it('BUG-34: refreshes gitByPath on a full rescan even when the session set is unchanged', () => {
    const s1 = makeSession({ sessionId: 's1', projectPath: '/repo' })
    let state = replaceAllSessions(
      EMPTY_FLEET_STATE,
      [s1],
      new Map([['/repo', { gitBranch: 'main' }]])
    )

    // Same sessions, new probed branch — a full rescan must adopt the fresh
    // metadata even though nothing in the session set itself changed.
    state = replaceAllSessions(state, [s1], new Map([['/repo', { gitBranch: 'feat/x' }]]))

    expect(state.gitByPath.get('/repo')?.gitBranch).toBe('feat/x')
  })
})

describe('mergeSlugSessions', () => {
  it('drops sessions belonging to a changed slug and appends the fresh ones', () => {
    const oldA = makeSession({
      sessionId: 'old-a',
      fullPath: `${ROOT}/-home-user-alpha/old-a.jsonl`,
      projectPath: '/home/user/alpha'
    })
    const untouchedB = makeSession({
      sessionId: 'b1',
      fullPath: `${ROOT}/-home-user-beta/b1.jsonl`,
      projectPath: '/home/user/beta'
    })
    const state: FleetState = { sessions: [oldA, untouchedB], gitByPath: new Map(), version: 1 }

    const freshA = makeSession({
      sessionId: 'new-a',
      fullPath: `${ROOT}/-home-user-alpha/new-a.jsonl`,
      projectPath: '/home/user/alpha'
    })

    const next = mergeSlugSessions(state, ROOT, ['-home-user-alpha'], [freshA], new Map())

    // old-a is gone (its slug was re-scanned and no longer contains it),
    // b1 (untouched slug) is preserved by reference, new-a is appended.
    expect(next.sessions).toEqual([untouchedB, freshA])
    expect(next.sessions[0]).toBe(untouchedB) // reference-preserved, not just equal
    expect(next.version).toBe(2)
  })

  it('a session removal (empty fresh list) drops every session of that slug', () => {
    const a1 = makeSession({
      sessionId: 'a1',
      fullPath: `${ROOT}/-home-user-alpha/a1.jsonl}`,
      projectPath: '/home/user/alpha'
    })
    const state: FleetState = { sessions: [a1], gitByPath: new Map(), version: 5 }

    const next = mergeSlugSessions(state, ROOT, ['-home-user-alpha'], [], new Map())

    expect(next.sessions).toEqual([])
  })

  it('overwrites gitByPath only for paths present in the fresh map, keeping others intact', () => {
    const gitByPath = new Map<string, GitMeta>([
      ['/home/user/alpha', { gitBranch: 'old-branch' }],
      ['/home/user/beta', { gitBranch: 'main' }]
    ])
    const state: FleetState = { sessions: [], gitByPath, version: 1 }

    const freshGit = new Map<string, GitMeta>([['/home/user/alpha', { gitBranch: 'new-branch' }]])
    const next = mergeSlugSessions(state, ROOT, ['-home-user-alpha'], [], freshGit)

    expect(next.gitByPath.get('/home/user/alpha')).toEqual({ gitBranch: 'new-branch' })
    expect(next.gitByPath.get('/home/user/beta')).toEqual({ gitBranch: 'main' })
  })

  it('does not mutate the prior state (pure)', () => {
    const a1 = makeSession({
      sessionId: 'a1',
      fullPath: `${ROOT}/-home-user-alpha/a1.jsonl`,
      projectPath: '/home/user/alpha'
    })
    const state: FleetState = { sessions: [a1], gitByPath: new Map(), version: 1 }
    mergeSlugSessions(state, ROOT, ['-home-user-alpha'], [], new Map())
    expect(state.sessions).toEqual([a1])
    expect(state.version).toBe(1)
  })

  it('never duplicates a session whose fullPath is empty (legacy index entry) across repeated merges', () => {
    // A legacy sessions-index.json entry can omit fullPath → slugOfPath yields
    // '' → the slug filter alone would keep the old row while the fresh scan
    // re-appends the same sessionId: +1 duplicate per refresh, forever.
    const legacy = makeSession({
      sessionId: 'legacy-1',
      fullPath: '', // <- the hole
      projectPath: '/home/user/alpha'
    })
    let state: FleetState = { sessions: [legacy], gitByPath: new Map(), version: 1 }

    // Simulate three watcher-driven refreshes, each re-reporting the session.
    for (let i = 0; i < 3; i++) {
      const fresh = makeSession({
        sessionId: 'legacy-1',
        fullPath: '',
        projectPath: '/home/user/alpha'
      })
      state = mergeSlugSessions(state, ROOT, ['-home-user-alpha'], [fresh], new Map())
    }

    expect(state.sessions.filter((s) => s.sessionId === 'legacy-1')).toHaveLength(1)
  })

  it('never duplicates a session whose fullPath is outside rootDir across repeated merges', () => {
    const outside = makeSession({
      sessionId: 'out-1',
      fullPath: '/somewhere/else/out-1.jsonl', // resolves slug '' — same hole
      projectPath: '/home/user/alpha'
    })
    let state: FleetState = { sessions: [outside], gitByPath: new Map(), version: 1 }

    // A field-different fresh row (a field-equal one is a no-op pass that keeps
    // the old object — AC-28), so the merge actually runs the duplicate guard.
    const fresh = makeSession({
      sessionId: 'out-1',
      fullPath: '/somewhere/else/out-1.jsonl',
      projectPath: '/home/user/alpha',
      messageCount: 1
    })
    state = mergeSlugSessions(state, ROOT, ['-home-user-alpha'], [fresh], new Map())

    expect(state.sessions.filter((s) => s.sessionId === 'out-1')).toHaveLength(1)
    // The fresh row won (it is the current truth).
    expect(state.sessions.find((s) => s.sessionId === 'out-1')).toBe(fresh)
  })

  it('never drops a kept ""-id session in an unchanged slug just because the fresh sessions also contain a ""-id row (N1)', () => {
    // A falsy sessionId is an absence of identity, not an identity of its own
    // — it must never participate in the id-based duplicate guard. Two
    // unrelated ''-id sessions (one kept from an untouched slug, one freshly
    // scanned from a changed slug) must both survive; only the slug filter
    // governs the kept one.
    const keptEmptyId = makeSession({
      sessionId: '',
      fullPath: `${ROOT}/-home-user-beta/legacy.jsonl`,
      projectPath: '/home/user/beta'
    })
    const state: FleetState = { sessions: [keptEmptyId], gitByPath: new Map(), version: 1 }

    const freshEmptyId = makeSession({
      sessionId: '',
      fullPath: `${ROOT}/-home-user-alpha/other-legacy.jsonl`,
      projectPath: '/home/user/alpha'
    })

    const next = mergeSlugSessions(state, ROOT, ['-home-user-alpha'], [freshEmptyId], new Map())

    // Both ''-id rows survive: keptEmptyId because its slug (-home-user-beta)
    // was never touched, freshEmptyId because it's the fresh scan result.
    expect(next.sessions).toEqual([keptEmptyId, freshEmptyId])
    expect(next.sessions).toContain(keptEmptyId) // reference-preserved
  })
})

describe('deriveFolders', () => {
  it('groups the flat session list back into folders, sorted most-recent-first', () => {
    const older = makeSession({
      sessionId: 'older',
      projectPath: '/home/user/alpha',
      modified: '2026-01-01T00:00:00.000Z'
    })
    const newer = makeSession({
      sessionId: 'newer',
      projectPath: '/home/user/beta',
      modified: '2026-06-01T00:00:00.000Z'
    })
    const state: FleetState = { sessions: [older, newer], gitByPath: new Map(), version: 1 }

    const folders = deriveFolders(state)

    expect(folders.map((f) => f.path)).toEqual(['/home/user/beta', '/home/user/alpha'])
  })

  it('returns an empty array for an empty model', () => {
    expect(deriveFolders(EMPTY_FLEET_STATE)).toEqual([])
  })
})

describe('mergeSlugSessions — version bumps only on real change (AC-28)', () => {
  const s1 = makeSession({
    sessionId: 'a',
    fullPath: `${ROOT}/slug-a/a.jsonl`,
    projectPath: '/w/a',
    fileMtime: 10,
    ctxPct: 12
  })
  const base = replaceAllSessions(
    EMPTY_FLEET_STATE,
    [s1],
    new Map([['/w/a', { gitBranch: 'main' }]])
  )

  it('returns the same state (no version bump) when fresh sessions and git meta are field-equal', () => {
    const next = mergeSlugSessions(
      base,
      ROOT,
      ['slug-a'],
      [{ ...s1 }],
      new Map([['/w/a', { gitBranch: 'main' }]])
    )
    expect(next).toBe(base)
    expect(next.version).toBe(base.version)
  })

  it('bumps when only ctxPct changed', () => {
    const next = mergeSlugSessions(
      base,
      ROOT,
      ['slug-a'],
      [{ ...s1, ctxPct: 40 }],
      new Map([['/w/a', { gitBranch: 'main' }]])
    )
    expect(next.version).toBe(base.version + 1)
  })

  it('bumps when only fileMtime changed', () => {
    const next = mergeSlugSessions(
      base,
      ROOT,
      ['slug-a'],
      [{ ...s1, fileMtime: 11 }],
      new Map([['/w/a', { gitBranch: 'main' }]])
    )
    expect(next.version).toBe(base.version + 1)
  })

  it('bumps when git meta changed', () => {
    const next = mergeSlugSessions(
      base,
      ROOT,
      ['slug-a'],
      [{ ...s1 }],
      new Map([['/w/a', { gitBranch: 'feat/x' }]])
    )
    expect(next.version).toBe(base.version + 1)
  })

  it('bumps when a session disappeared from the slug', () => {
    const next = mergeSlugSessions(base, ROOT, ['slug-a'], [], new Map())
    expect(next.version).toBe(base.version + 1)
    expect(next.sessions).toEqual([])
  })

  it('sessionEntriesEqual compares agents by id/mtime/status', () => {
    const a = makeSession({ agents: [{ agentId: 'x', fileMtime: 1, status: 'running' } as never] })
    const b = makeSession({ agents: [{ agentId: 'x', fileMtime: 2, status: 'running' } as never] })
    expect(sessionEntriesEqual(a, a)).toBe(true)
    expect(sessionEntriesEqual(a, b)).toBe(false)
  })
})

describe('membershipSignature (D1)', () => {
  const s = (id: string, p: string): SessionEntry => makeSession({ sessionId: id, projectPath: p })
  it('ignores append-only fields', () => {
    const a = replaceAllSessions(EMPTY_FLEET_STATE, [s('1', '/w/a')], new Map())
    const b = replaceAllSessions(
      EMPTY_FLEET_STATE,
      [{ ...s('1', '/w/a'), ctxPct: 99, fileMtime: 5 }],
      new Map()
    )
    expect(membershipSignature(a)).toBe(membershipSignature(b))
  })
  it('changes on a session add, a folder move, or a git identity change', () => {
    const a = replaceAllSessions(EMPTY_FLEET_STATE, [s('1', '/w/a')], new Map())
    expect(membershipSignature(a)).not.toBe(
      membershipSignature(replaceAllSessions(a, [s('1', '/w/a'), s('2', '/w/a')], new Map()))
    )
    expect(membershipSignature(a)).not.toBe(
      membershipSignature(replaceAllSessions(a, [s('1', '/w/b')], new Map()))
    )
    expect(membershipSignature(a)).not.toBe(
      membershipSignature(
        replaceAllSessions(a, [s('1', '/w/a')], new Map([['/w/a', { repoId: '/r/.git' }]]))
      )
    )
  })
})
