import { describe, expect, it } from 'vitest'
import {
  expiredArchives,
  groupArchiveRefs,
  type ArchiveRefInfo
} from '../src/main/gc/archives-core'

const DAY = 86_400_000
const STAMP_AT = Date.parse('2026-10-01T10:00:00Z')
const FAR = STAMP_AT + 3650 * DAY
const REPO = '/r/repo'

let n = 0
function ref(name: string): ArchiveRefInfo {
  n += 1
  return { ref: name, sha: n.toString(16).padStart(40, '0'), at: STAMP_AT }
}

const NS = 'refs/archive/feat/x/20261001T100000Z'
const DET = 'refs/archive/detached/20261001T100000Z/wt-aaaaaaaaaaaa'

const sweepRefs = (): ArchiveRefInfo[] => [
  ref(`${NS}/tip`),
  ref(`${NS}/wip`),
  ref(`${NS}/shelve/record`),
  ref(`${NS}/shelve/ignored`),
  ref(`${NS}/shelve/stash/0`)
]

describe('shelve refs in the Archives grouping', () => {
  it('make one shelved entry out of a branch sweep, with every ref as a member', () => {
    const entries = groupArchiveRefs(REPO, sweepRefs())
    expect(entries).toHaveLength(1)
    const e = entries[0]!
    expect(e.shelved).toBe(true)
    expect(e.branch).toBe('feat/x')
    expect(e.namespace).toBe(NS)
    expect(e.members.map((m) => m.ref).sort()).toEqual(
      sweepRefs()
        .map((r) => r.ref)
        .sort()
    )
    expect(e.ageKnown).toBe(true)
  })

  it('do not depend on the order the refs are listed in', () => {
    const entries = groupArchiveRefs(REPO, sweepRefs().reverse())
    expect(entries).toHaveLength(1)
    expect(entries[0]!.shelved).toBe(true)
    expect(entries[0]!.tipRef).toBe(`${NS}/tip`)
    expect(entries[0]!.wipRef).toBe(`${NS}/wip`)
  })

  it('leave an ordinary sweep, and shelve refs without a record, unshelved', () => {
    const plain = groupArchiveRefs(REPO, [ref(`${NS}/tip`), ref(`${NS}/wip`)])
    expect(plain).toHaveLength(1)
    expect(plain[0]!.shelved).toBe(false)
    const noRecord = groupArchiveRefs(REPO, [
      ref(`${NS}/tip`),
      ref(`${NS}/wip`),
      ref(`${NS}/shelve/ignored`)
    ])
    expect(noRecord).toHaveLength(1)
    expect(noRecord[0]!.shelved).toBe(false)
  })

  it('make one shelved entry out of a detached removal', () => {
    const entries = groupArchiveRefs(REPO, [
      { ref: `${DET}/tip`, sha: 'aaaaaaaaaaaa' + '0'.repeat(28), at: STAMP_AT },
      ref(`${DET}/wip`),
      ref(`${DET}/shelve/record`),
      ref(`${DET}/shelve/ignored`)
    ])
    expect(entries).toHaveLength(1)
    expect(entries[0]!.detached).toBe(true)
    expect(entries[0]!.shelved).toBe(true)
    expect(entries[0]!.members).toHaveLength(4)
  })
})

describe('expiredArchives and shelved entries', () => {
  const old = (): ArchiveRefInfo[] => [
    ref('refs/archive/old/20200101T000000Z/tip'),
    ref('refs/archive/old/20200101T000000Z/wip')
  ]

  it('never returns a shelved entry unless the caller proves its branch is gone', () => {
    const entries = groupArchiveRefs(REPO, [...sweepRefs(), ...old()])
    const expired = expiredArchives(entries, 1, FAR)
    expect(expired.map((e) => e.branch)).toEqual(['old'])
  })

  it('returns a shelved entry once its branch is in branchesGone, and not before', () => {
    const entries = groupArchiveRefs(REPO, sweepRefs())
    expect(expiredArchives(entries, 1, FAR, new Set(['other']))).toEqual([])
    expect(expiredArchives(entries, 1, FAR, new Set())).toEqual([])
    expect(expiredArchives(entries, 1, FAR, new Set(['feat/x']))).toHaveLength(1)
  })

  it('never returns a detached shelved entry: it has no branch to be gone', () => {
    const entries = groupArchiveRefs(REPO, [
      { ref: `${DET}/tip`, sha: 'aaaaaaaaaaaa' + '0'.repeat(28), at: STAMP_AT },
      ref(`${DET}/wip`),
      ref(`${DET}/shelve/record`)
    ])
    expect(expiredArchives(entries, 1, FAR, new Set(['feat/x', '']))).toEqual([])
  })
})
