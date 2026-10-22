// Pure core of the archives category (unit C, AC-C1..C3): grouping `refs/archive/**` refs into
// one entry per archived thing, what has expired, and the restore commands the UI copies.

import { describe, expect, it } from 'vitest'
import {
  confirmedArchives,
  withFolders,
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
      ageKnown: false
    })
    // The commit's date is not when it was archived: the age is unknown, and is never guessed.
    expect(entries[0]!.at).toBeNaN()
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

describe('withFolders', () => {
  it('names the folder a sweep removed from the journal line that wrote the very same refs', () => {
    const entries = groupArchiveRefs(REPO, [
      ref('refs/archive/feat/login/20261002T101500Z/tip', sha('a')),
      ref('refs/archive/feat/login/20261002T101500Z/wip', sha('b')),
      ref('refs/archive/feat/other/20261003T101500Z/tip', sha('c'))
    ])
    const out = withFolders(entries, [
      {
        archiveTipRef: 'refs/archive/feat/login/20261002T101500Z/tip',
        archiveWipRef: 'refs/archive/feat/login/20261002T101500Z/wip',
        trashedPath: '/ws/org/wt-login'
      },
      // A line that trashed nothing (a branch-only sweep) names no folder.
      { archiveTipRef: 'refs/archive/feat/other/20261003T101500Z/tip', archiveWipRef: null }
    ])
    expect(out.find((e) => e.branch === 'feat/login')!.folder).toBe('/ws/org/wt-login')
    expect(out.find((e) => e.branch === 'feat/other')!.folder).toBeNull()
  })
})

describe('ageKnown', () => {
  it('is true only when the stamp in the ref name says when it was archived', () => {
    const entries = groupArchiveRefs(REPO, [
      ref('refs/archive/feat/x/20261002T101500Z/tip', sha('a')),
      ref('refs/archive/hand-made', sha('b'), Date.parse('2020-01-01T00:00:00Z'))
    ])
    expect(entries.find((e) => e.branch === 'feat/x')!.ageKnown).toBe(true)
    expect(entries.find((e) => e.namespace === 'refs/archive/hand-made')!.ageKnown).toBe(false)
  })

  it('an old-looking commit date never expires an unstamped ref', () => {
    const entries = groupArchiveRefs(REPO, [
      ref('refs/archive/hand-made', sha('b'), Date.parse('2020-01-01T00:00:00Z'))
    ])
    expect(expiredArchives(entries, 1, NOW)).toEqual([])
  })
})

// ---- AC-E2: a detached removal is ONE archive, with a date ---------------------------------------

describe('a detached removal groups into one archive (AC-E2)', () => {
  /** A Harnu group's folder segment ends in the first 12 hex of its tip's sha: that is what proves it. */
  const TIP = 'abcdef012345'.padEnd(40, 'a')
  const NS = 'refs/archive/detached/20261002T101500Z/bisect-1-abcdef012345'
  const removal = (ns = NS): ArchiveRefInfo[] => [
    ref(`${ns}/tip`, TIP),
    ref(`${ns}/wip`, sha('b')),
    ref(`${ns}/wip-20261002101501`, sha('c')),
    ref(`${ns}/reflog/111111111111`, sha('d')),
    ref(`${ns}/reflog/222222222222`, sha('e')),
    ref(`${ns}/reflog/333333333333`, sha('f'))
  ]

  it('is one entry for tip, wip, the wip sibling and every reflog ref', () => {
    const entries = groupArchiveRefs(REPO, removal())
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      namespace: NS,
      detached: true,
      branch: null,
      tipSha: TIP,
      wipSha: sha('b'),
      hasWip: true,
      reflogCount: 3
    })
    expect(entries[0]!.refs).toHaveLength(6)
    expect(entries[0]!.members.map((m) => m.ref).sort()).toEqual(
      removal()
        .map((r) => r.ref)
        .sort()
    )
    // Each member carries its own sha, so a delete can be checked ref by ref.
    expect(entries[0]!.members.find((m) => m.ref.endsWith('/reflog/222222222222'))?.sha).toBe(
      sha('e')
    )
  })

  it('takes the date from the stamp in the path, so the archive can expire', () => {
    const [e] = groupArchiveRefs(REPO, removal())
    expect(e).toMatchObject({ ageKnown: true, at: Date.parse('2026-10-02T10:15:00Z') })
    expect(expiredArchives([e!], 7, NOW)).toEqual([e])
    expect(expiredArchives([e!], 30, NOW)).toEqual([])
  })

  it('keeps two removals of the same folder at the same commit apart, each with its own date', () => {
    const later = 'refs/archive/detached/20261010T080000Z/bisect-1-abcdef012345'
    const entries = groupArchiveRefs(REPO, [...removal(), ...removal(later)])
    expect(entries.map((e) => e.namespace)).toEqual([later, NS])
    expect(entries.map((e) => e.refs.length)).toEqual([6, 6])
  })

  it('a removal with only a tip is still one entry, with no reflog', () => {
    const [e] = groupArchiveRefs(REPO, [ref(`${NS}/tip`, TIP)])
    expect(e).toMatchObject({ reflogCount: 0, hasWip: false, tipSha: TIP })
    expect(e!.members).toHaveLength(1)
  })

  it('refs an old Harnu wrote without a stamp are grouped too, and their age stays unknown', () => {
    const OLD = 'refs/archive/detached/bisect-1-abcdef012345'
    const entries = groupArchiveRefs(REPO, removal(OLD))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      namespace: OLD,
      detached: true,
      ageKnown: false,
      reflogCount: 3
    })
    expect(entries[0]!.at).toBeNaN()
    expect(expiredArchives(entries, 1, NOW + 3650 * DAY)).toEqual([])
  })

  it('does not swallow a sweep of an ordinary branch, nor another removal', () => {
    const entries = groupArchiveRefs(REPO, [
      ...removal(),
      ref('refs/archive/feat/login/20261002T101500Z/tip', sha('1')),
      ref('refs/archive/feat/login/20261002T101500Z/wip', sha('2'))
    ])
    expect(entries.map((e) => e.namespace).sort()).toEqual([
      NS,
      'refs/archive/feat/login/20261002T101500Z'
    ])
  })

  it('restore commands still name the tip and the working state', () => {
    const [e] = groupArchiveRefs(REPO, removal())
    expect(e!.restoreCommand).toBe(`git branch restored-${TIP.slice(0, 7)} ${TIP}`)
    expect(e!.wipRestoreCommand).toBe(
      `git worktree add --detach ../restored-${'b'.repeat(7)} ${sha('b')}`
    )
  })

  it('a delete asks for exactly the members it was shown, ref by ref and sha by sha', () => {
    const [e] = groupArchiveRefs(REPO, removal())
    const fresh = [e!]
    const shown = {
      namespace: NS,
      tipSha: TIP,
      wipSha: sha('b'),
      members: e!.members.map((m) => ({ ref: m.ref, sha: m.sha }))
    }
    const ok = confirmedArchives(fresh, [shown])
    expect(ok.entries).toHaveLength(1)
    // What is deleted is what was shown: each member against the sha the operator saw.
    expect(ok.entries[0]!.members).toEqual(shown.members)
    // A ref that appeared (or vanished) since the confirm is a change, never a silent extra delete.
    expect(confirmedArchives(fresh, [{ ...shown, members: shown.members.slice(1) }])).toEqual({
      entries: [],
      changed: [NS]
    })
    expect(
      confirmedArchives(fresh, [
        {
          ...shown,
          members: [...shown.members, { ref: `${NS}/reflog/ffffffffffff`, sha: sha('f') }]
        }
      ])
    ).toEqual({ entries: [], changed: [NS] })
  })

  it('a member swapped for another while the count stays the same is a change', () => {
    const [e] = groupArchiveRefs(REPO, removal())
    const members = e!.members.map((m) => ({ ref: m.ref, sha: m.sha }))
    // The operator saw one reflog ref pointing at X; it now points at Y (same count, same names).
    const swapped = members.map((m) =>
      m.ref.endsWith('/reflog/222222222222') ? { ...m, sha: sha('9') } : m
    )
    const fresh = groupArchiveRefs(
      REPO,
      removal().map((r) => (r.ref.endsWith('/reflog/222222222222') ? { ...r, sha: sha('7') } : r))
    )
    const shown = { namespace: NS, tipSha: TIP, wipSha: sha('b'), members: swapped }
    expect(confirmedArchives(fresh, [shown])).toEqual({ entries: [], changed: [NS] })
    // Same names, different set of names (one renamed): also a change.
    const renamed = members.map((m) =>
      m.ref.endsWith('/reflog/222222222222') ? { ...m, ref: `${NS}/reflog/444444444444` } : m
    )
    expect(
      confirmedArchives([e!], [{ namespace: NS, tipSha: TIP, wipSha: sha('b'), members: renamed }])
    ).toEqual({ entries: [], changed: [NS] })
  })

  // ---- delta 1, item 2: only Harnu's own group is recognised ----------------------------------
  describe('a hand-made ref under detached/ is never taken for a Harnu group', () => {
    const handMade = [
      'refs/archive/detached/20261002T101500Z/my-notes',
      'refs/archive/detached/20261002T101500Z/my-notes-abcdef012345',
      'refs/archive/detached/my-notes'
    ]

    it('a folder segment without the tip’s hex stays generic and never expires', () => {
      for (const ns of handMade) {
        const entries = groupArchiveRefs(REPO, [
          ref(`${ns}/tip`, sha('a')),
          ref(`${ns}/wip`, sha('b'))
        ])
        expect(
          entries.map((e) => e.refs.length),
          ns
        ).toEqual([1, 1])
        expect(
          entries.every((e) => !e.ageKnown),
          ns
        ).toBe(true)
        expect(expiredArchives(entries, 1, NOW + 3650 * DAY), ns).toEqual([])
      }
    })

    it('a folder whose hex is NOT the tip’s sha is generic too', () => {
      const ns = 'refs/archive/detached/20261002T101500Z/bisect-1-abcdef012345'
      const entries = groupArchiveRefs(REPO, [
        ref(`${ns}/tip`, sha('9')),
        ref(`${ns}/wip`, sha('b'))
      ])
      expect(entries).toHaveLength(2)
      expect(entries.every((e) => !e.ageKnown)).toBe(true)
      expect(expiredArchives(entries, 1, NOW + 3650 * DAY)).toEqual([])
    })

    it('a group with no tip cannot be proven Harnu’s, so it is generic', () => {
      const entries = groupArchiveRefs(REPO, [
        ref(`${NS}/wip`, sha('b')),
        ref(`${NS}/reflog/111111111111`, sha('d'))
      ])
      expect(entries).toHaveLength(2)
      expect(entries.every((e) => !e.ageKnown)).toBe(true)
    })

    it('the same folder name with the right hex and tip is still a group', () => {
      const [e] = groupArchiveRefs(REPO, removal())
      expect(e).toMatchObject({ ageKnown: true, reflogCount: 3 })
    })
  })
})
