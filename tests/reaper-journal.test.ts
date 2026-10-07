import { describe, it, expect } from 'vitest'
import {
  serializeTombstone,
  parseJournal,
  restoreHintFor,
  type Tombstone
} from '../src/main/reaper/journal'

function tombstone(over: Partial<Tombstone> = {}): Tombstone {
  return {
    at: 1_800_000_000_000,
    repoPath: '/repo',
    kind: 'worktree',
    branch: 'feat/x',
    sha: 'abc123',
    deleted: ['trash-folder', 'worktree-prune', 'branch-delete', 'journal'],
    justifiedBy: 'gh-merged',
    restoreHint: 'git branch feat/x abc123',
    archiveTipRef: 'refs/archive/feat/x/20260828T182233Z/tip',
    archiveWipRef: 'refs/archive/feat/x/20260828T182233Z/wip',
    ...over
  }
}

describe('serializeTombstone / parseJournal round-trip', () => {
  it('round-trips a single tombstone through one JSON line', () => {
    const t = tombstone()
    const line = serializeTombstone(t)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.split('\n')).toHaveLength(2) // one content line + trailing empty
    const parsed = parseJournal(line, 50)
    expect(parsed).toEqual([t])
  })

  it('returns newest first', () => {
    const older = tombstone({ at: 1, branch: 'a' })
    const newer = tombstone({ at: 2, branch: 'b' })
    const content = serializeTombstone(older) + serializeTombstone(newer)
    const parsed = parseJournal(content, 50)
    expect(parsed.map((t) => t.branch)).toEqual(['b', 'a'])
  })

  it('skips malformed lines and keeps the valid ones', () => {
    const valid = tombstone()
    const content = 'not json\n' + serializeTombstone(valid) + '{"incomplete":true}\n'
    const parsed = parseJournal(content, 50)
    expect(parsed).toEqual([valid])
  })

  it('respects the limit', () => {
    const content = [1, 2, 3, 4, 5].map((n) => serializeTombstone(tombstone({ at: n }))).join('')
    const parsed = parseJournal(content, 2)
    expect(parsed).toHaveLength(2)
    expect(parsed.map((t) => t.at)).toEqual([5, 4])
  })

  it('returns [] for empty content', () => {
    expect(parseJournal('', 50)).toEqual([])
  })

  it('keeps both archive ref names through the round-trip', () => {
    const parsed = parseJournal(serializeTombstone(tombstone()), 50)
    expect(parsed[0].archiveTipRef).toBe('refs/archive/feat/x/20260828T182233Z/tip')
    expect(parsed[0].archiveWipRef).toBe('refs/archive/feat/x/20260828T182233Z/wip')
  })

  it('reads a pre-T254 line that has no archive refs, normalizing them to null', () => {
    const legacy = {
      at: 1_800_000_000_000,
      repoPath: '/repo',
      kind: 'worktree',
      branch: 'feat/old',
      sha: 'abc123',
      deleted: ['trash-folder'],
      justifiedBy: 'gh-merged',
      restoreHint: 'git branch feat/old abc123'
    }
    const parsed = parseJournal(JSON.stringify(legacy) + '\n', 50)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].archiveTipRef).toBeNull()
    expect(parsed[0].archiveWipRef).toBeNull()
  })
})

describe('restoreHintFor', () => {
  it('builds a git branch restore command when both branch and sha are present', () => {
    expect(restoreHintFor('feat/x', 'abc123')).toBe('git branch feat/x abc123')
  })

  it('returns null when branch is missing', () => {
    expect(restoreHintFor(null, 'abc123')).toBeNull()
  })

  it('returns null when sha is missing', () => {
    expect(restoreHintFor('feat/x', null)).toBeNull()
  })

  it('returns null when both are missing', () => {
    expect(restoreHintFor(null, null)).toBeNull()
  })

  it('leaves ordinary branch/sha unquoted (safe bare words)', () => {
    expect(restoreHintFor('feature/nested-name', 'a1b2c3d')).toBe(
      'git branch feature/nested-name a1b2c3d'
    )
  })

  it('single-quotes a branch carrying shell metacharacters (command injection)', () => {
    expect(restoreHintFor('feat/x;echo pwned', 'abc123')).toBe(
      "git branch 'feat/x;echo pwned' abc123"
    )
  })

  it('single-quotes a command-substitution branch so it stays literal', () => {
    expect(restoreHintFor('feat/$(id)', 'abc123')).toBe("git branch 'feat/$(id)' abc123")
  })

  it('escapes embedded single quotes safely', () => {
    expect(restoreHintFor("feat/o'brien", 'abc123')).toBe("git branch 'feat/o'\\''brien' abc123")
  })
})

describe('tombstone actor (T441)', () => {
  it('round-trips an autopilot actor', () => {
    const t = tombstone({ actor: 'autopilot' })
    expect(parseJournal(serializeTombstone(t), 50)).toEqual([t])
  })

  it('reads a line written before the actor existed as having none', () => {
    const t = tombstone()
    const [parsed] = parseJournal(serializeTombstone(t), 50)
    expect(parsed!.actor).toBeUndefined()
  })

  it('drops a line whose actor is not a known value', () => {
    const line = JSON.stringify({ ...tombstone(), actor: 'robot' }) + '\n'
    expect(parseJournal(line, 50)).toEqual([])
  })
})
