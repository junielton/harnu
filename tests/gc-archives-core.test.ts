// Pure core of the archives category (unit C, AC-C1..C3): grouping `refs/archive/**` refs into
// one entry per archived thing, what has expired, and the restore commands the UI copies.

import { describe, expect, it } from 'vitest'
import {
  expiredArchives,
  groupArchiveRefs,
  parseArchiveStamp,
  type ArchiveRefInfo
} from '../src/main/gc/archives-core'

const REPO = '/ws/org/proj/www'
const DAY = 86_400_000
const NOW = Date.parse('2026-10-12T12:00:00Z')
const sha = (c: string): string => c.repeat(40)

const ref = (name: string, sha_: string, at = NOW): ArchiveRefInfo => ({
  ref: name,
  sha: sha_,
  at
})

describe('parseArchiveStamp', () => {
  it('reads the compact ISO stamp the Reaper writes', () => {
    expect(parseArchiveStamp('20261002T101500Z')).toBe(Date.parse('2026-10-02T10:15:00Z'))
  })

  it('answers null for anything else', () => {
    expect(parseArchiveStamp('2026-10-02')).toBeNull()
    expect(parseArchiveStamp('')).toBeNull()
    expect(parseArchiveStamp('20261340T251500Z')).toBeNull()
  })
})

describe('groupArchiveRefs', () => {
  it('pairs a tip and a wip of one sweep into ONE entry', () => {
    const entries = groupArchiveRefs(REPO, [
      ref('refs/archive/feat/login/20261002T101500Z/tip', sha('a')),
      ref('refs/archive/feat/login/20261002T101500Z/wip', sha('b'))
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      repoPath: REPO,
      namespace: 'refs/archive/feat/login/20261002T101500Z',
      branch: 'feat/login',
      tipSha: sha('a'),
      wipSha: sha('b'),
      hasWip: true,
      at: Date.parse('2026-10-02T10:15:00Z')
    })
    expect(entries[0]!.refs).toEqual([
      'refs/archive/feat/login/20261002T101500Z/tip',
      'refs/archive/feat/login/20261002T101500Z/wip'
    ])
  })

  it('a tip with no wip has no wip (a branch-only sweep)', () => {
    const [e] = groupArchiveRefs(REPO, [ref('refs/archive/feat/x/20261002T101500Z/tip', sha('a'))])
    expect(e).toMatchObject({ hasWip: false, wipRef: null, wipSha: null })
  })

  it('keeps two sweeps of the same branch apart, newest first', () => {
    const entries = groupArchiveRefs(REPO, [
      ref('refs/archive/card/T1-x/20260901T000000Z/tip', sha('a')),
      ref('refs/archive/card/T1-x/20261001T000000Z/tip', sha('b'))
    ])
    expect(entries.map((e) => e.tipSha)).toEqual([sha('b'), sha('a')])
    expect(entries.every((e) => e.branch === 'card/T1-x')).toBe(true)
  })

  it('lists a ref of any other shape generically, one entry per ref, source unknown', () => {
    const entries = groupArchiveRefs(REPO, [
      ref('refs/archive/odd-name', sha('c'), Date.parse('2026-09-01T00:00:00Z'))
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      namespace: 'refs/archive/odd-name',
      branch: null,
      tipSha: sha('c'),
      hasWip: false,
      at: Date.parse('2026-09-01T00:00:00Z')
    })
  })

  it("reads a `detached/` namespace as a detached archive, never as a branch called 'detached'", () => {
    const [e] = groupArchiveRefs(REPO, [
      ref('refs/archive/detached/20261002T101500Z/tip', sha('d')),
      ref('refs/archive/detached/20261002T101500Z/wip', sha('e'))
    ])
    expect(e).toMatchObject({ branch: null, detached: true, hasWip: true })
  })

  it('a wip with no tip is still an entry (the archive of a detached folder)', () => {
    const [e] = groupArchiveRefs(REPO, [
      ref('refs/archive/detached/20261002T101500Z/wip', sha('e'))
    ])
    expect(e).toMatchObject({ tipRef: null, tipSha: null, hasWip: true })
  })

  it('names a copyable restore command with the tip sha and a shell-safe branch', () => {
    const [plain, hostile] = groupArchiveRefs(REPO, [
      ref('refs/archive/feat/login/20261002T101500Z/tip', sha('a')),
      ref('refs/archive/feat/$(id)/20261001T101500Z/tip', sha('b'))
    ])
    expect(plain!.restoreCommand).toBe(`git branch feat/login ${sha('a')}`)
    expect(hostile!.restoreCommand).toBe(`git branch 'feat/$(id)' ${sha('b')}`)
  })

  it('a detached entry restores to a fresh branch name derived from the sha, not a quoted ref', () => {
    const [e] = groupArchiveRefs(REPO, [
      ref('refs/archive/detached/20261002T101500Z/tip', sha('d'))
    ])
    expect(e!.restoreCommand).toBe(`git branch restored-${'d'.repeat(7)} ${sha('d')}`)
  })

  it('a wip gets its own restore command: a detached worktree on the working-state commit', () => {
    const [e] = groupArchiveRefs(REPO, [
      ref('refs/archive/feat/login/20261002T101500Z/tip', sha('a')),
      ref('refs/archive/feat/login/20261002T101500Z/wip', sha('b'))
    ])
    expect(e!.wipRestoreCommand).toBe(
      `git worktree add --detach ../restored-${'b'.repeat(7)} ${sha('b')}`
    )
  })

  it('a ref name that git would not accept as a shell word never reaches a command unquoted', () => {
    const [e] = groupArchiveRefs(REPO, [ref("refs/archive/it's/20261002T101500Z/tip", sha('a'))])
    expect(e!.restoreCommand).toBe(`git branch 'it'\\''s' ${sha('a')}`)
  })
})

describe('expiredArchives', () => {
  const entries = groupArchiveRefs(REPO, [
    ref('refs/archive/old/20260801T000000Z/tip', sha('a')),
    ref('refs/archive/edge/20260912T120000Z/tip', sha('b')),
    ref('refs/archive/new/20261010T000000Z/tip', sha('c'))
  ])

  it('is the entries strictly older than the retention, oldest first', () => {
    const out = expiredArchives(entries, 30, NOW)
    expect(out.map((e) => e.branch)).toEqual(['old'])
  })

  it('an entry exactly at the retention is kept, not expired', () => {
    // edge: 2026-09-12T12:00Z is exactly 30 days before NOW.
    expect(expiredArchives(entries, 30, NOW).some((e) => e.branch === 'edge')).toBe(false)
    expect(expiredArchives(entries, 29, NOW).some((e) => e.branch === 'edge')).toBe(true)
  })

  it('a non-positive or non-finite retention expires nothing (fail closed)', () => {
    expect(expiredArchives(entries, 0, NOW)).toEqual([])
    expect(expiredArchives(entries, -5, NOW)).toEqual([])
    expect(expiredArchives(entries, Number.NaN, NOW)).toEqual([])
  })

  it('an entry whose date is unknown is never expired', () => {
    const unknown = groupArchiveRefs(REPO, [
      { ref: 'refs/archive/mystery', sha: sha('f'), at: Number.NaN }
    ])
    expect(expiredArchives(unknown, 1, NOW + 400 * DAY)).toEqual([])
  })
})
