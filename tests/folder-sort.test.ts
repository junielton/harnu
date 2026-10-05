import { describe, it, expect } from 'vitest'
import { sortFolders, type FolderSortMode } from '../src/renderer/src/components/folder-sort'

/**
 * Unit net for the folder sort (folder-sort spec §3/§10). Mirrors
 * `session-sort.test.ts`: pure + stable, new array, and the anti-jump
 * regression that pins the reported bug (a background session bumping its
 * folder to the top under `recent` but NOT under `name`).
 */

type TestFolder = {
  alias: string
  sessions: Array<{ modified: string; fileMtime: number }>
}

function folder(alias: string, sessions: TestFolder['sessions'] = []): TestFolder {
  return { alias, sessions }
}

function s(modified: string, fileMtime = 0): { modified: string; fileMtime: number } {
  return { modified, fileMtime }
}

function aliases(folders: TestFolder[], mode: FolderSortMode): string[] {
  return sortFolders(folders, mode).map((f) => f.alias)
}

describe('sortFolders — recent', () => {
  it('orders by most-recent session activity, newest first', () => {
    const folders = [
      folder('old', [s('2026-06-01T00:00:00.000Z')]),
      folder('new', [s('2026-06-20T00:00:00.000Z')]),
      folder('mid', [s('2026-06-10T00:00:00.000Z')])
    ]
    expect(aliases(folders, 'recent')).toEqual(['new', 'mid', 'old'])
  })

  it('uses the MAX session activity within a folder', () => {
    const folders = [
      folder('a', [s('2026-06-01T00:00:00.000Z'), s('2026-06-15T00:00:00.000Z')]),
      folder('b', [s('2026-06-10T00:00:00.000Z')])
    ]
    expect(aliases(folders, 'recent')).toEqual(['a', 'b'])
  })

  it('falls back to fileMtime when modified is unparseable', () => {
    const folders = [
      folder('parsed', [s('2026-06-05T00:00:00.000Z')]),
      folder('mtime', [s('not-a-date', Date.parse('2026-06-20T00:00:00.000Z'))])
    ]
    expect(aliases(folders, 'recent')).toEqual(['mtime', 'parsed'])
  })

  it('sinks a folder with no sessions (-Infinity) to the end but keeps it', () => {
    const folders = [folder('empty', []), folder('has', [s('2026-06-10T00:00:00.000Z')])]
    expect(aliases(folders, 'recent')).toEqual(['has', 'empty'])
  })
})

describe('sortFolders — name', () => {
  it('orders case-insensitively A→Z by alias', () => {
    const folders = [folder('zeta'), folder('Alpha'), folder('beta')]
    expect(aliases(folders, 'name')).toEqual(['Alpha', 'beta', 'zeta'])
  })

  it('ignores session activity entirely', () => {
    const folders = [
      folder('b', [s('2026-06-20T00:00:00.000Z')]),
      folder('a', [s('2026-06-01T00:00:00.000Z')])
    ]
    expect(aliases(folders, 'name')).toEqual(['a', 'b'])
  })
})

describe('sortFolders — purity & stability', () => {
  it('returns a new array and never mutates the input', () => {
    const input = [folder('b'), folder('a')]
    const snapshot = input.map((f) => f.alias)
    const out = sortFolders(input, 'name')
    expect(out).not.toBe(input)
    expect(input.map((f) => f.alias)).toEqual(snapshot)
  })

  it('keeps input order for equal keys (stable)', () => {
    const folders = [
      folder('dup', [s('2026-06-10T00:00:00.000Z')]),
      folder('dup', [s('2026-06-10T00:00:00.000Z')])
    ]
    const out = sortFolders(folders, 'recent')
    // Same key → first input element stays first (referential identity check).
    expect(out[0]).toBe(folders[0])
    expect(out[1]).toBe(folders[1])
  })
})

describe('sortFolders — anti-jump regression (the reported bug)', () => {
  it('recent reorders when a session is bumped; name does not', () => {
    const top = folder('top', [s('2026-06-20T00:00:00.000Z')])
    const bottom = folder('bottom', [s('2026-06-01T00:00:00.000Z')])
    const folders = [top, bottom]

    // Baseline: `recent` floats the most active; `name` is alphabetical.
    expect(aliases(folders, 'recent')).toEqual(['top', 'bottom'])
    expect(aliases(folders, 'name')).toEqual(['bottom', 'top'])

    // A background session in `bottom` emits output → its activity jumps to now.
    bottom.sessions[0].modified = '2026-06-25T00:00:00.000Z'

    // `recent` now reshuffles `bottom` to the top (the visible "jump").
    expect(aliases(folders, 'recent')).toEqual(['bottom', 'top'])
    // `name` is unaffected — the whole point of the feature.
    expect(aliases(folders, 'name')).toEqual(['bottom', 'top'])
  })
})
