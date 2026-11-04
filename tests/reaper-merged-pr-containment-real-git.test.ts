// U1 — `probeMergedPrContainment` against a real repository. The pure rules live in
// reaper-scan-core.test.ts / gc-fate-core.test.ts; what only git can answer is pinned here:
// which branches are probed at all, that a PR head or merge commit this clone never fetched
// reads `null` (not `false`), that the probe writes nothing (no fetch, no ref), and that an
// answer is remembered per (repo, tip, head).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { PrFacts } from '../src/main/reaper/reaper-core'
import type { LocalBranchRef } from '../src/main/reaper/scan-core'

vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir(), isPackaged: false },
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))
// scanner-shell pulls in the PTY layer and the fleet model; the probe needs neither.
vi.mock('../src/main/pty', () => ({ liveSessionKeys: () => new Set<string>() }))
vi.mock('../src/main/fleet-model', () => ({ getFleetFolders: async () => [] }))
vi.mock('../src/main/hook-bridge', () => ({ getTaskStates: () => new Map() }))

import { probeMergedPrContainment } from '../src/main/reaper/scanner-shell'

let repo = ''

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function commit(file: string, message: string): string {
  writeFileSync(path.join(repo, file), message)
  git('add', file)
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}

function ref(branch: string, sha: string): LocalBranchRef {
  return { branch, sha, committedAt: 1, upstream: null }
}

function pr(over: Partial<PrFacts>): PrFacts {
  return {
    number: 84,
    state: 'MERGED',
    reviewDecision: null,
    ci: 'unknown',
    mergedAt: 'x',
    headRefOid: null,
    baseRefName: 'main',
    mergeCommitOid: null,
    ...over
  }
}

const ABSENT = 'f'.repeat(40)

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'harnu-u1-probe-'))
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  commit('base.txt', 'c0')
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('probeMergedPrContainment (U1)', () => {
  it('tip contained in the merged PR head, merged straight into default → true / true', async () => {
    git('checkout', '-q', '-b', 'feat/a')
    const tip = commit('a.txt', 'a1')
    const head = commit('a2.txt', 'a2') // the PR head moved on past the local tip
    const out = await probeMergedPrContainment(
      repo,
      'main',
      [ref('feat/a', tip)],
      new Map([['feat/a', pr({ headRefOid: head })]])
    )
    expect(out.tipInPrHead.get('feat/a')).toBe(true)
    expect(out.landed.get('feat/a')).toBe(true)
  })

  it('a branch reused after its merge (tip carries commits the PR head lacks) → false', async () => {
    git('checkout', '-q', '-b', 'feat/b')
    const head = commit('b1.txt', 'b1')
    const tip = commit('b2.txt', 'b2')
    const out = await probeMergedPrContainment(
      repo,
      'main',
      [ref('feat/b', tip)],
      new Map([['feat/b', pr({ headRefOid: head })]])
    )
    expect(out.tipInPrHead.get('feat/b')).toBe(false)
  })

  it('a PR head this clone never fetched → null, never false', async () => {
    git('checkout', '-q', '-b', 'feat/c')
    const tip = commit('c1.txt', 'c1')
    const out = await probeMergedPrContainment(
      repo,
      'main',
      [ref('feat/c', tip)],
      new Map([['feat/c', pr({ headRefOid: ABSENT })]])
    )
    expect(out.tipInPrHead.get('feat/c')).toBeNull()
    expect(out.landed.get('feat/c')).toBeNull()
  })

  it('probes only MERGED PRs whose head differs from the tip', async () => {
    git('checkout', '-q', '-b', 'feat/same')
    const same = commit('s1.txt', 's1')
    git('checkout', '-q', 'main')
    git('checkout', '-q', '-b', 'feat/open')
    const open = commit('o1.txt', 'o1')
    git('checkout', '-q', 'main')
    git('checkout', '-q', '-b', 'feat/nopr')
    const nopr = commit('n1.txt', 'n1')
    const out = await probeMergedPrContainment(
      repo,
      'main',
      [ref('feat/same', same), ref('feat/open', open), ref('feat/nopr', nopr)],
      new Map([
        ['feat/same', pr({ headRefOid: same })], // head === tip: already strong today
        ['feat/open', pr({ state: 'OPEN', headRefOid: same })]
      ])
    )
    expect([...out.tipInPrHead.keys()]).toEqual([])
    expect([...out.landed.keys()]).toEqual([])
  })

  describe('stacked landing', () => {
    // main ── c0 ; feat/base ── b1 ── M(merge of the child PR head) ── b3
    // The child PR merged into feat/base; feat/base's own PR then merged into main.
    let tip = ''
    let childHead = ''
    let merge = ''
    let baseHead = ''

    beforeEach(() => {
      git('checkout', '-q', '-b', 'feat/base')
      commit('b1.txt', 'b1')
      git('checkout', '-q', '-b', 'feat/child')
      tip = commit('k1.txt', 'k1')
      childHead = commit('k2.txt', 'k2')
      git('checkout', '-q', 'feat/base')
      git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.com',
        'merge',
        '--no-ff',
        '-q',
        '-m',
        'merge child',
        'feat/child'
      )
      merge = git('rev-parse', 'HEAD')
      baseHead = commit('b3.txt', 'b3')
    })

    const run = (childPr: Partial<PrFacts>, basePr: Partial<PrFacts> | null) =>
      probeMergedPrContainment(
        repo,
        'main',
        [ref('feat/child', tip)],
        new Map<string, PrFacts>([
          [
            'feat/child',
            pr({
              headRefOid: childHead,
              baseRefName: 'feat/base',
              mergeCommitOid: merge,
              ...childPr
            })
          ],
          ...(basePr
            ? ([['feat/base', pr({ number: 97, headRefOid: baseHead, ...basePr })]] as Array<
                [string, PrFacts]
              >)
            : [])
        ])
      )

    it('landed when the base PR merged into default and its head contains the merge commit', async () => {
      const out = await run({}, {})
      expect(out.tipInPrHead.get('feat/child')).toBe(true)
      expect(out.landed.get('feat/child')).toBe(true)
    })

    it('not landed when the base PR head does not contain the merge commit', async () => {
      const out = await run({ mergeCommitOid: git('rev-parse', 'main') }, {})
      // main's commit is an ancestor of the base head too, so use a commit the base lacks
      git('checkout', '-q', 'main')
      const stray = commit('stray.txt', 'stray')
      const out2 = await run({ mergeCommitOid: stray }, {})
      expect(out.landed.get('feat/child')).toBe(true)
      expect(out2.landed.get('feat/child')).toBe(false)
    })

    it('not landed while the base PR is OPEN', async () => {
      expect((await run({}, { state: 'OPEN' })).landed.get('feat/child')).toBe(false)
    })

    it('unknown when the base PR is not in the list or the merge commit is absent locally', async () => {
      expect((await run({}, null)).landed.get('feat/child')).toBeNull()
      expect((await run({ mergeCommitOid: ABSENT }, {})).landed.get('feat/child')).toBeNull()
    })
  })

  it('writes nothing: no fetch, no new ref', async () => {
    git('checkout', '-q', '-b', 'feat/ro')
    const tip = commit('r1.txt', 'r1')
    const head = commit('r2.txt', 'r2')
    const before = git('for-each-ref', '--format=%(refname) %(objectname)')
    const objectsBefore = git('count-objects', '-v')
    await probeMergedPrContainment(
      repo,
      'main',
      [ref('feat/ro', tip), ref('feat/ro2', tip)],
      new Map([
        ['feat/ro', pr({ headRefOid: head })],
        ['feat/ro2', pr({ headRefOid: ABSENT })]
      ])
    )
    expect(git('for-each-ref', '--format=%(refname) %(objectname)')).toBe(before)
    expect(git('count-objects', '-v')).toBe(objectsBefore)
  })

  it('remembers a definite answer per (repo, tip, head)', async () => {
    git('checkout', '-q', '-b', 'feat/memo')
    const tip = commit('m1.txt', 'm1')
    const head = commit('m2.txt', 'm2')
    const refs = [ref('feat/memo', tip)]
    const prs = new Map([['feat/memo', pr({ headRefOid: head })]])
    const first = await probeMergedPrContainment(repo, 'main', refs, prs)
    expect(first.tipInPrHead.get('feat/memo')).toBe(true)
    // Make git unable to answer: only a remembered answer can still say true.
    const moved = `${repo}-moved`
    renameSync(repo, moved)
    try {
      const second = await probeMergedPrContainment(repo, 'main', refs, prs)
      expect(second.tipInPrHead.get('feat/memo')).toBe(true)
    } finally {
      renameSync(moved, repo)
    }
  })
})
