import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SNAPSHOT_CAP_BYTES,
  decideRestoreBase,
  isDependencyPath,
  parseShelveRecord,
  parseWorktreeList,
  serializeShelveRecord,
  shelveRefs,
  stashesForBranch,
  type ShelveRecord
} from '../src/main/gc/shelve-core'

const NS = 'refs/archive/feat/x/20261105T100000Z'

function record(over: Partial<ShelveRecord> = {}): ShelveRecord {
  return {
    version: 1,
    createdAt: 1_762_336_800_000,
    repoPath: '/r/repo',
    worktreePath: '/r/trees/feat-x',
    branch: 'feat/x',
    headSha: 'a'.repeat(40),
    namespace: NS,
    tipRef: `${NS}/tip`,
    wipRef: `${NS}/wip`,
    wipCommit: 'b'.repeat(40),
    wipTree: 'c'.repeat(40),
    ignored: {
      ref: `${NS}/shelve/ignored`,
      commit: 'd'.repeat(40),
      tree: 'e'.repeat(40),
      fileCount: 2,
      bytes: 10
    },
    stashes: [{ ref: `${NS}/shelve/stash/0`, sha: 'f'.repeat(40), subject: 'On feat/x: wip' }],
    dependencyDirs: ['node_modules'],
    snapshotCapBytes: DEFAULT_SNAPSHOT_CAP_BYTES,
    ...over
  }
}

describe('shelveRefs', () => {
  it('names the ignored snapshot, the record and one ref per stash under the namespace', () => {
    expect(shelveRefs(NS, 2)).toEqual({
      ignored: `${NS}/shelve/ignored`,
      record: `${NS}/shelve/record`,
      stashes: [`${NS}/shelve/stash/0`, `${NS}/shelve/stash/1`]
    })
    expect(shelveRefs(NS, 0).stashes).toEqual([])
  })
})

describe('the shelve record', () => {
  it('round-trips through JSON', () => {
    const r = record()
    expect(parseShelveRecord(serializeShelveRecord(r))).toEqual(r)
    const noSnapshot = record({ ignored: null, stashes: [], branch: null })
    expect(parseShelveRecord(serializeShelveRecord(noSnapshot))).toEqual(noSnapshot)
  })

  it('rejects anything that is not a version-1 record', () => {
    const base = JSON.parse(serializeShelveRecord(record())) as Record<string, unknown>
    expect(parseShelveRecord('not json')).toBeNull()
    expect(parseShelveRecord('null')).toBeNull()
    expect(parseShelveRecord(JSON.stringify({ ...base, version: 2 }))).toBeNull()
    const { wipTree: _drop, ...noTree } = base
    expect(parseShelveRecord(JSON.stringify(noTree))).toBeNull()
    expect(parseShelveRecord(JSON.stringify({ ...base, stashes: [{ ref: 1 }] }))).toBeNull()
    expect(parseShelveRecord(JSON.stringify({ ...base, ignored: { ref: 'x' } }))).toBeNull()
  })

  it('rejects a record whose refs leave refs/archive/ (a forged record can never aim a write elsewhere)', () => {
    const base = JSON.parse(serializeShelveRecord(record())) as Record<string, unknown>
    expect(parseShelveRecord(JSON.stringify({ ...base, wipRef: 'refs/heads/main' }))).toBeNull()
    expect(
      parseShelveRecord(JSON.stringify({ ...base, tipRef: 'refs/archive/../heads/x' }))
    ).toBeNull()
  })
})

describe('isDependencyPath', () => {
  it('matches the directory itself and everything under it, nothing that merely shares a prefix', () => {
    const deps = ['node_modules', '.venv']
    expect(isDependencyPath('node_modules', deps)).toBe(true)
    expect(isDependencyPath('node_modules/', deps)).toBe(true)
    expect(isDependencyPath('node_modules/a/b.js', deps)).toBe(true)
    expect(isDependencyPath('.venv/lib/x.py', deps)).toBe(true)
    expect(isDependencyPath('src/node_modules/x.js', deps)).toBe(false)
    expect(isDependencyPath('node_modules_x/a', deps)).toBe(false)
    expect(isDependencyPath('.env', deps)).toBe(false)
  })
})

describe('stashesForBranch', () => {
  const entries = [
    { sha: '1'.repeat(40), subject: 'On feat/x: a' },
    { sha: '2'.repeat(40), subject: 'WIP on feat/x: abc1234 msg' },
    { sha: '3'.repeat(40), subject: 'On feat/x-2: b' },
    { sha: '4'.repeat(40), subject: 'WIP on main: abc1234 msg' },
    { sha: '5'.repeat(40), subject: 'On fix/a.b+c: c' },
    { sha: '6'.repeat(40), subject: 'On fixXa.b+c: d' }
  ]

  it('keeps only entries whose subject names exactly this branch', () => {
    expect(stashesForBranch(entries, 'feat/x').map((e) => e.sha)).toEqual([
      '1'.repeat(40),
      '2'.repeat(40)
    ])
  })

  it('matches a branch name with regex metacharacters literally', () => {
    expect(stashesForBranch(entries, 'fix/a.b+c').map((e) => e.sha)).toEqual(['5'.repeat(40)])
  })

  it('matches nothing for an empty branch name', () => {
    expect(stashesForBranch(entries, '')).toEqual([])
  })
})

describe('parseWorktreeList', () => {
  it('reads path, branch, head and prunable from porcelain output', () => {
    const out = [
      'worktree /r/repo',
      `HEAD ${'a'.repeat(40)}`,
      'branch refs/heads/main',
      '',
      'worktree /r/trees/gone',
      `HEAD ${'b'.repeat(40)}`,
      'branch refs/heads/feat/x',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree /r/trees/det',
      `HEAD ${'c'.repeat(40)}`,
      'detached',
      ''
    ].join('\n')
    expect(parseWorktreeList(out)).toEqual([
      { path: '/r/repo', branch: 'main', head: 'a'.repeat(40), prunable: false },
      { path: '/r/trees/gone', branch: 'feat/x', head: 'b'.repeat(40), prunable: true },
      { path: '/r/trees/det', branch: null, head: 'c'.repeat(40), prunable: false }
    ])
  })
})

describe('decideRestoreBase', () => {
  const rec = { branch: 'feat/x', headSha: 'a'.repeat(40) }
  const target = '/r/trees/feat-x'

  it('re-attaches the branch only when it still points at the archived HEAD and is free', () => {
    expect(
      decideRestoreBase({
        record: rec,
        branchTip: 'a'.repeat(40),
        checkedOutAt: null,
        targetPath: target
      })
    ).toEqual({
      mode: 'branch',
      reason: null
    })
  })

  it('treats a stale registration at the very same path as free', () => {
    expect(
      decideRestoreBase({
        record: rec,
        branchTip: 'a'.repeat(40),
        checkedOutAt: target,
        targetPath: target
      }).mode
    ).toBe('branch')
  })

  it('goes detached, with the reason, when the branch moved, is gone, is busy elsewhere or never existed', () => {
    expect(
      decideRestoreBase({
        record: rec,
        branchTip: 'b'.repeat(40),
        checkedOutAt: null,
        targetPath: target
      })
    ).toEqual({
      mode: 'detached',
      reason: 'branch-moved'
    })
    expect(
      decideRestoreBase({ record: rec, branchTip: null, checkedOutAt: null, targetPath: target })
    ).toEqual({
      mode: 'detached',
      reason: 'branch-missing'
    })
    expect(
      decideRestoreBase({
        record: rec,
        branchTip: 'a'.repeat(40),
        checkedOutAt: '/r/other',
        targetPath: target
      })
    ).toEqual({
      mode: 'detached',
      reason: 'branch-checked-out-elsewhere'
    })
    expect(
      decideRestoreBase({
        record: { branch: null, headSha: 'a'.repeat(40) },
        branchTip: null,
        checkedOutAt: null,
        targetPath: target
      })
    ).toEqual({
      mode: 'detached',
      reason: 'no-branch'
    })
  })
})
