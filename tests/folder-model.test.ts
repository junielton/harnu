import { describe, expect, it } from 'vitest'
import type { SessionEntry } from '../src/main/claude-reader'
import {
  buildFolderEntries,
  buildFolderEntry,
  groupSessionsByFolder,
  type GitMeta
} from '../src/main/folder-model'

/**
 * Minimal `SessionEntry` factory. Building a full entry by hand is verbose and
 * noisy; this returns sensible defaults so each test only spells out the fields
 * it actually asserts on (`sessionId` + `projectPath` in practice). Cast through
 * a partial so future `SessionEntry` field additions don't break every test.
 */
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
    ...overrides
  }
}

describe('groupSessionsByFolder', () => {
  it('groups 3 sessions across 2 distinct projectPaths into 2 groups, preserving first-seen order and grouping same-path sessions together', () => {
    const a1 = makeSession({ sessionId: 'a1', projectPath: '/home/user/alpha' })
    const b1 = makeSession({ sessionId: 'b1', projectPath: '/home/user/beta' })
    const a2 = makeSession({ sessionId: 'a2', projectPath: '/home/user/alpha' })

    const groups = groupSessionsByFolder([a1, b1, a2])

    expect(groups.size).toBe(2)
    // First-seen insertion order: alpha (a1) before beta (b1).
    expect([...groups.keys()]).toEqual(['/home/user/alpha', '/home/user/beta'])
    // Same-path sessions stay together, in input order.
    expect(groups.get('/home/user/alpha')).toEqual([a1, a2])
    expect(groups.get('/home/user/beta')).toEqual([b1])
  })

  it('returns an empty Map for no sessions', () => {
    expect(groupSessionsByFolder([]).size).toBe(0)
  })
})

describe('buildFolderEntry', () => {
  it('derives alias from the path basename and attaches git fields when provided', () => {
    const s = makeSession({ sessionId: 's1', projectPath: '/home/user/alpha' })
    const git: GitMeta = { gitBranch: 'main', repoId: 'repo-1', isMainWorktree: true }

    const entry = buildFolderEntry('/home/user/alpha', [s], git)

    expect(entry.path).toBe('/home/user/alpha')
    expect(entry.alias).toBe('alpha')
    expect(entry.sessions).toEqual([s])
    expect(entry.gitBranch).toBe('main')
    expect(entry.repoId).toBe('repo-1')
    expect(entry.isMainWorktree).toBe(true)
  })

  it('omits undefined git keys entirely when no git is provided', () => {
    const s = makeSession({ sessionId: 's1', projectPath: '/home/user/beta' })

    const entry = buildFolderEntry('/home/user/beta', [s])

    expect(entry.alias).toBe('beta')
    expect(entry.sessions).toEqual([s])
    expect('gitBranch' in entry).toBe(false)
    expect('repoId' in entry).toBe(false)
    expect('isMainWorktree' in entry).toBe(false)
  })

  it('spreads only the defined fields of a partial GitMeta', () => {
    const s = makeSession({ projectPath: '/home/user/gamma' })

    const entry = buildFolderEntry('/home/user/gamma', [s], { gitBranch: 'feat/x' })

    expect(entry.gitBranch).toBe('feat/x')
    expect('repoId' in entry).toBe(false)
    expect('isMainWorktree' in entry).toBe(false)
  })
})

describe('buildFolderEntries', () => {
  it('builds one entry per grouped folder, attaching git only where the map covers it', () => {
    const a1 = makeSession({ sessionId: 'a1', projectPath: '/home/user/alpha' })
    const b1 = makeSession({ sessionId: 'b1', projectPath: '/home/user/beta' })
    const a2 = makeSession({ sessionId: 'a2', projectPath: '/home/user/alpha' })

    const gitByPath = new Map<string, GitMeta>([
      ['/home/user/alpha', { gitBranch: 'main', repoId: 'repo-alpha', isMainWorktree: true }]
    ])

    const entries = buildFolderEntries([a1, b1, a2], gitByPath)

    // Grouped order preserved: alpha then beta.
    expect(entries.map((e) => e.path)).toEqual(['/home/user/alpha', '/home/user/beta'])

    const alpha = entries[0]
    expect(alpha.alias).toBe('alpha')
    expect(alpha.sessions).toEqual([a1, a2])
    expect(alpha.gitBranch).toBe('main')
    expect(alpha.repoId).toBe('repo-alpha')
    expect(alpha.isMainWorktree).toBe(true)

    const beta = entries[1]
    expect(beta.alias).toBe('beta')
    expect(beta.sessions).toEqual([b1])
    expect('gitBranch' in beta).toBe(false)
    expect('repoId' in beta).toBe(false)
    expect('isMainWorktree' in beta).toBe(false)
  })

  it('returns an empty array for no sessions', () => {
    expect(buildFolderEntries([], new Map())).toEqual([])
  })

  it('BUG-56 D5: stamps diskExists per path when a diskExistsByPath map is given', () => {
    const a1 = makeSession({ sessionId: 'a1', projectPath: '/home/user/alpha' })
    const b1 = makeSession({ sessionId: 'b1', projectPath: '/home/user/beta' })

    const diskExistsByPath = new Map<string, boolean>([
      ['/home/user/alpha', true],
      ['/home/user/beta', false]
    ])

    const entries = buildFolderEntries([a1, b1], new Map(), diskExistsByPath)
    expect(entries.find((e) => e.path === '/home/user/alpha')?.diskExists).toBe(true)
    expect(entries.find((e) => e.path === '/home/user/beta')?.diskExists).toBe(false)
  })

  it('omits diskExists entirely when no diskExistsByPath map is given (back-compat)', () => {
    const a1 = makeSession({ sessionId: 'a1', projectPath: '/home/user/alpha' })
    const [entry] = buildFolderEntries([a1], new Map())
    expect('diskExists' in entry).toBe(false)
  })
})
