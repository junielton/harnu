import { describe, it, expect } from 'vitest'
import {
  parseWorktreeList,
  toWorktreeListing,
  type WorktreeListEntry
} from '../src/main/worktree-core'

describe('parseWorktreeList', () => {
  it('parses a multi-record porcelain dump (branch, detached, bare)', () => {
    const porcelain = [
      'worktree /home/u/repo',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /home/u/repo/.claude/worktrees/feat-login',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/feat/login',
      '',
      'worktree /home/u/repo/.claude/worktrees/wip',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
      'worktree /home/u/repo/.bare',
      'bare',
      ''
    ].join('\n')

    expect(parseWorktreeList(porcelain)).toEqual([
      {
        path: '/home/u/repo',
        head: '1111111111111111111111111111111111111111',
        branch: 'main',
        detached: false,
        bare: false
      },
      {
        path: '/home/u/repo/.claude/worktrees/feat-login',
        head: '2222222222222222222222222222222222222222',
        branch: 'feat/login',
        detached: false,
        bare: false
      },
      {
        path: '/home/u/repo/.claude/worktrees/wip',
        head: '3333333333333333333333333333333333333333',
        branch: '',
        detached: true,
        bare: false
      },
      {
        path: '/home/u/repo/.bare',
        head: '',
        branch: '',
        detached: false,
        bare: true
      }
    ])
  })

  it('returns an empty array for empty input', () => {
    expect(parseWorktreeList('')).toEqual([])
  })

  it('tolerates CRLF line endings and a missing trailing blank line', () => {
    const porcelain = 'worktree /r\r\nHEAD deadbeef\r\nbranch refs/heads/topic'
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: '/r', head: 'deadbeef', branch: 'topic', detached: false, bare: false }
    ])
  })

  it('turns locked/prunable annotation lines into flags (AC-12)', () => {
    const porcelain = [
      'worktree /r/wt',
      'HEAD abc123',
      'branch refs/heads/topic',
      'locked because reasons',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\n')
    expect(parseWorktreeList(porcelain)).toEqual([
      {
        path: '/r/wt',
        head: 'abc123',
        branch: 'topic',
        detached: false,
        bare: false,
        locked: true,
        prunable: true
      }
    ])
  })
})

describe('toWorktreeListing (T44 S3b — compact, redacted git truth)', () => {
  const entry = (over: Partial<WorktreeListEntry>): WorktreeListEntry => ({
    path: '/home/u/repo',
    head: '1111111111111111111111111111111111111111',
    branch: 'main',
    detached: false,
    bare: false,
    ...over
  })

  it('projects compact rows: alias, short head, branch, controllable (= not blocked), dirty', () => {
    const rows = toWorktreeListing(
      [
        entry({ path: '/home/u/repo', branch: 'main' }),
        entry({ path: '/home/u/wt/feat', branch: 'feat', head: '2222222222223333' })
      ],
      {
        denyFolders: ['/home/u/repo'],
        dirtyByPath: { '/home/u/wt/feat': true },
        redactPaths: true
      }
    )
    expect(rows).toEqual([
      {
        alias: 'repo',
        branch: 'main',
        head: '111111111111',
        detached: false,
        controllable: false,
        dirty: false
      },
      {
        alias: 'feat',
        branch: 'feat',
        head: '222222222222',
        detached: false,
        controllable: true,
        dirty: true
      }
    ])
  })

  it('with NO blocks, every worktree is controllable (the default posture)', () => {
    // Pins the reversal at the disclosure layer: a worktree the agent JUST created
    // must read `controllable: true` immediately. Under the old allowlist it read
    // `false`, so an agent asked to work in a fresh worktree stood down in it.
    const rows = toWorktreeListing(
      [entry({ path: '/home/u/repo', branch: 'main' }), entry({ path: '/fresh/wt', branch: 'f' })],
      { dirtyByPath: {}, redactPaths: true }
    )
    expect(rows.every((r) => r.controllable)).toBe(true)
  })

  it('a block covers the SUBTREE — a worktree inside a blocked repo is not controllable', () => {
    const rows = toWorktreeListing(
      [
        entry({ path: '/home/u/repo', branch: 'main' }),
        entry({ path: '/home/u/repo/.claude/worktrees/wt', branch: 'wt' })
      ],
      { denyFolders: ['/home/u/repo'], dirtyByPath: {}, redactPaths: true }
    )
    expect(rows.every((r) => !r.controllable)).toBe(true)
  })

  it('drops bare entries and sorts by path', () => {
    const rows = toWorktreeListing(
      [
        entry({ path: '/z', branch: 'z' }),
        entry({ path: '/a', bare: true }),
        entry({ path: '/m', branch: 'm' })
      ],
      { denyFolders: [], dirtyByPath: {}, redactPaths: true }
    )
    expect(rows.map((r) => r.alias)).toEqual(['m', 'z'])
  })

  it('leaks the absolute path only when redactPaths is false', () => {
    const [redacted] = toWorktreeListing([entry({})], {
      denyFolders: [],
      dirtyByPath: {},
      redactPaths: true
    })
    expect('path' in redacted).toBe(false)
    const [open] = toWorktreeListing([entry({})], {
      denyFolders: [],
      dirtyByPath: {},
      redactPaths: false
    })
    expect(open.path).toBe('/home/u/repo')
  })
})

describe('parseWorktreeList — prunable/locked and unusual paths (AC-12, review focus 5)', () => {
  it('reports prunable and locked only when present, keeping the old shape otherwise', () => {
    const out = parseWorktreeList(
      [
        'worktree /r',
        'HEAD 1',
        'branch refs/heads/main',
        '',
        'worktree /r/wt gone',
        'HEAD 2',
        'branch refs/heads/x',
        'prunable gitdir file points to non-existent location',
        '',
        'worktree /r/wt-locked',
        'HEAD 3',
        'detached',
        'locked',
        ''
      ].join('\n')
    )
    expect(out[0]).toEqual({ path: '/r', head: '1', branch: 'main', detached: false, bare: false })
    expect(out[1]).toMatchObject({ path: '/r/wt gone', prunable: true })
    expect(out[2]).toMatchObject({ locked: true, detached: true })
  })
  it('reports a locked line that carries a reason', () => {
    const out = parseWorktreeList(
      'worktree /r/l\nHEAD 4\nbranch refs/heads/l\nlocked on a usb disk\n'
    )
    expect(out[0]).toMatchObject({ locked: true })
    expect(out[0].prunable).toBeUndefined()
  })
  it('keeps spaces and non-ASCII characters in paths intact', () => {
    const out = parseWorktreeList('worktree /r/árvore com espaço\nHEAD 9\nbranch refs/heads/b\n')
    expect(out).toHaveLength(1)
    expect(out[0].path).toBe('/r/árvore com espaço')
  })
  it('toWorktreeListing output is unchanged by the new fields', () => {
    const base = parseWorktreeList('worktree /r\nHEAD 1\nbranch refs/heads/main\n')
    const withFlags = base.map((e) => ({ ...e, locked: true, prunable: true }))
    const opts = { dirtyByPath: {}, redactPaths: false }
    expect(toWorktreeListing(withFlags, opts)).toEqual(toWorktreeListing(base, opts))
  })
})
