import { describe, it, expect } from 'vitest'
import {
  parsePrList,
  buildGraph,
  layoutGraph,
  applyOverrides,
  pruneOverrides,
  lodForScale,
  clampScale,
  fitToView,
  focusOnBox,
  focusCardHeight,
  resolveFocusTarget,
  shapeKey,
  graphEdges,
  kpis,
  worstCi,
  parseReviewThreads,
  withReviewThreads,
  REVIEW_THREADS_QUERY,
  PR_LIST_LIMIT,
  THREADS_PER_PR_LIMIT,
  behindBaseRef,
  parseBehindCount,
  ROW_PITCH,
  COLUMN_PITCH,
  TOP_INSET,
  type PrEntry,
  type PrThreadCounts
} from '../src/main/pr-stack-core'

/** Minimal PR factory — every test states only the fields it cares about. */
function pr(over: Partial<PrEntry> & { number: number; branch: string; base: string }): PrEntry {
  return {
    title: `PR ${over.number}`,
    state: 'OPEN',
    isDraft: false,
    mergeable: true,
    reviewDecision: 'APPROVED',
    ci: 'passing',
    checks: [],
    url: `https://github.com/o/r/pull/${over.number}`,
    author: 'junielton',
    updatedAt: null,
    headOid: null,
    nodeId: null,
    mergeStateStatus: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    reviewRequests: [],
    labels: [],
    autoMergeRequest: null,
    unresolvedThreads: null,
    outdatedThreads: null,
    threadsTruncated: false,
    ...over
  }
}

describe('parsePrList', () => {
  it('reads the fields the canvas needs, including baseRefName', () => {
    const [entry] = parsePrList(
      JSON.stringify([
        {
          number: 412,
          title: 'Wave 4',
          headRefName: 'wave-4',
          baseRefName: 'main',
          state: 'OPEN',
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          url: 'https://github.com/o/r/pull/412',
          author: { login: 'junielton' },
          statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }]
        }
      ])
    )
    expect(entry.number).toBe(412)
    expect(entry.branch).toBe('wave-4')
    expect(entry.base).toBe('main')
    expect(entry.mergeable).toBe(true)
    expect(entry.author).toBe('junielton')
    expect(entry.ci).toBe('passing')
  })

  it('maps CONFLICTING to mergeable:false and an unknown value to null', () => {
    const rows = parsePrList(
      JSON.stringify([
        { number: 1, headRefName: 'a', baseRefName: 'main', mergeable: 'CONFLICTING' },
        { number: 2, headRefName: 'b', baseRefName: 'main', mergeable: 'UNKNOWN' }
      ])
    )
    expect(rows[0].mergeable).toBe(false)
    expect(rows[1].mergeable).toBe(null)
  })

  it('returns [] rather than throwing on malformed or non-array payloads', () => {
    expect(parsePrList('not json')).toEqual([])
    expect(parsePrList('{"nope":1}')).toEqual([])
    expect(parsePrList('')).toEqual([])
  })

  it('skips rows without a head branch or a number', () => {
    const rows = parsePrList(
      JSON.stringify([
        { number: 1, baseRefName: 'main' },
        { headRefName: 'x', baseRefName: 'main' },
        { number: 3, headRefName: 'ok', baseRefName: 'main' }
      ])
    )
    expect(rows.map((r) => r.number)).toEqual([3])
  })

  // ── T280: the widened query surface ────────────────────────────────────
  // Each field is exercised three ways — present, absent, malformed —
  // because the whole point of this widening is that "we could not read it"
  // stays distinguishable from "we read it, and it is zero/empty".

  describe('mergeStateStatus', () => {
    it('reads every documented value, UNKNOWN included', () => {
      const rows = parsePrList(
        JSON.stringify(
          ['CLEAN', 'BEHIND', 'DIRTY', 'BLOCKED', 'UNSTABLE', 'DRAFT', 'HAS_HOOKS', 'UNKNOWN'].map(
            (v, i) => ({
              number: i + 1,
              headRefName: `b${i}`,
              baseRefName: 'main',
              mergeStateStatus: v
            })
          )
        )
      )
      expect(rows.map((r) => r.mergeStateStatus)).toEqual([
        'CLEAN',
        'BEHIND',
        'DIRTY',
        'BLOCKED',
        'UNSTABLE',
        'DRAFT',
        'HAS_HOOKS',
        'UNKNOWN'
      ])
    })

    it('is null when absent, and null — not a cast — when the value is unknown to us', () => {
      const rows = parsePrList(
        JSON.stringify([
          { number: 1, headRefName: 'a', baseRefName: 'main' },
          { number: 2, headRefName: 'b', baseRefName: 'main', mergeStateStatus: 'MOSTLY_FINE' },
          { number: 3, headRefName: 'c', baseRefName: 'main', mergeStateStatus: 42 },
          { number: 4, headRefName: 'd', baseRefName: 'main', mergeStateStatus: null }
        ])
      )
      expect(rows.map((r) => r.mergeStateStatus)).toEqual([null, null, null, null])
    })
  })

  describe('diff size', () => {
    it('reads additions, deletions and changedFiles', () => {
      const [row] = parsePrList(
        JSON.stringify([
          {
            number: 1,
            headRefName: 'a',
            baseRefName: 'main',
            additions: 412,
            deletions: 38,
            changedFiles: 9
          }
        ])
      )
      expect(row.additions).toBe(412)
      expect(row.deletions).toBe(38)
      expect(row.changedFiles).toBe(9)
    })

    it('keeps a real zero, which is a measurement', () => {
      const [row] = parsePrList(
        JSON.stringify([
          {
            number: 1,
            headRefName: 'a',
            baseRefName: 'main',
            additions: 0,
            deletions: 0,
            changedFiles: 0
          }
        ])
      )
      expect(row.additions).toBe(0)
      expect(row.deletions).toBe(0)
      expect(row.changedFiles).toBe(0)
    })

    it('is null when absent — never coerced to 0', () => {
      const [row] = parsePrList(
        JSON.stringify([{ number: 1, headRefName: 'a', baseRefName: 'main' }])
      )
      expect(row.additions).toBeNull()
      expect(row.deletions).toBeNull()
      expect(row.changedFiles).toBeNull()
    })

    it('is null when malformed', () => {
      const [row] = parsePrList(
        JSON.stringify([
          {
            number: 1,
            headRefName: 'a',
            baseRefName: 'main',
            additions: '412',
            deletions: null,
            changedFiles: -1
          }
        ])
      )
      expect(row.additions).toBeNull()
      expect(row.deletions).toBeNull()
      expect(row.changedFiles).toBeNull()
    })
  })

  describe('reviewRequests', () => {
    it('reads a user request', () => {
      const [row] = parsePrList(
        JSON.stringify([
          {
            number: 1,
            headRefName: 'a',
            baseRefName: 'main',
            reviewRequests: [{ __typename: 'User', login: 'dberri' }]
          }
        ])
      )
      expect(row.reviewRequests).toEqual([{ kind: 'user', login: 'dberri' }])
    })

    it('parses a team-only request without throwing — a team payload carries no login', () => {
      const [row] = parsePrList(
        JSON.stringify([
          {
            number: 1,
            headRefName: 'a',
            baseRefName: 'main',
            reviewRequests: [{ __typename: 'Team', name: 'Platform Core', slug: 'platform-core' }]
          }
        ])
      )
      expect(row.reviewRequests).toEqual([{ kind: 'team', login: 'platform-core' }])
    })

    it('mixes users and teams in one list, in payload order', () => {
      const [row] = parsePrList(
        JSON.stringify([
          {
            number: 1,
            headRefName: 'a',
            baseRefName: 'main',
            reviewRequests: [
              { __typename: 'User', login: 'dberri' },
              { __typename: 'Team', name: 'Platform Core', slug: 'platform-core' }
            ]
          }
        ])
      )
      expect(row.reviewRequests).toEqual([
        { kind: 'user', login: 'dberri' },
        { kind: 'team', login: 'platform-core' }
      ])
    })

    it('falls back to the team name when the slug is missing', () => {
      const [row] = parsePrList(
        JSON.stringify([
          {
            number: 1,
            headRefName: 'a',
            baseRefName: 'main',
            reviewRequests: [{ __typename: 'Team', name: 'Platform Core' }]
          }
        ])
      )
      expect(row.reviewRequests).toEqual([{ kind: 'team', login: 'Platform Core' }])
    })

    it('is [] when absent, and drops unusable entries when malformed', () => {
      const rows = parsePrList(
        JSON.stringify([
          { number: 1, headRefName: 'a', baseRefName: 'main' },
          { number: 2, headRefName: 'b', baseRefName: 'main', reviewRequests: 'nope' },
          {
            number: 3,
            headRefName: 'c',
            baseRefName: 'main',
            reviewRequests: [null, 7, {}, { __typename: 'User' }, { __typename: 'Team' }]
          }
        ])
      )
      expect(rows[0].reviewRequests).toEqual([])
      expect(rows[1].reviewRequests).toEqual([])
      expect(rows[2].reviewRequests).toEqual([])
    })
  })

  describe('labels', () => {
    it('carries names only — never the hex colour GitHub also sends', () => {
      const [row] = parsePrList(
        JSON.stringify([
          {
            number: 1,
            headRefName: 'a',
            baseRefName: 'main',
            labels: [
              { id: 'LA_1', name: 'no-user-docs', description: '', color: '2700AF' },
              { id: 'LA_2', name: 'external', description: 'outside', color: 'ee2329' }
            ]
          }
        ])
      )
      expect(row.labels).toEqual(['no-user-docs', 'external'])
      // The guard that matters: no `#RRGGBB` may reach the renderer.
      expect(JSON.stringify(row)).not.toContain('2700AF')
      expect(JSON.stringify(row)).not.toContain('ee2329')
    })

    it('is [] when absent, and drops unusable entries when malformed', () => {
      const rows = parsePrList(
        JSON.stringify([
          { number: 1, headRefName: 'a', baseRefName: 'main' },
          { number: 2, headRefName: 'b', baseRefName: 'main', labels: { name: 'nope' } },
          {
            number: 3,
            headRefName: 'c',
            baseRefName: 'main',
            labels: [null, 'bare', { color: 'ff0000' }, { name: '' }, { name: 'kept' }]
          }
        ])
      )
      expect(rows[0].labels).toEqual([])
      expect(rows[1].labels).toEqual([])
      expect(rows[2].labels).toEqual(['kept'])
    })
  })

  describe('autoMergeRequest', () => {
    it('reads the merge method and flattens enabledBy to a login', () => {
      const [row] = parsePrList(
        JSON.stringify([
          {
            number: 1,
            headRefName: 'a',
            baseRefName: 'main',
            autoMergeRequest: {
              authorEmail: 'x@example.com',
              commitBody: null,
              commitHeadline: null,
              mergeMethod: 'SQUASH',
              enabledAt: '2026-09-01T13:07:01Z',
              enabledBy: { id: 'MDQ6', is_bot: false, login: 'junielton', name: 'Junielton' }
            }
          }
        ])
      )
      expect(row.autoMergeRequest).toEqual({ mergeMethod: 'SQUASH', enabledBy: 'junielton' })
    })

    it('is null when auto-merge is not armed', () => {
      const rows = parsePrList(
        JSON.stringify([
          { number: 1, headRefName: 'a', baseRefName: 'main' },
          { number: 2, headRefName: 'b', baseRefName: 'main', autoMergeRequest: null }
        ])
      )
      expect(rows[0].autoMergeRequest).toBeNull()
      expect(rows[1].autoMergeRequest).toBeNull()
    })

    it('stays armed with null members when the payload is malformed', () => {
      const rows = parsePrList(
        JSON.stringify([
          { number: 1, headRefName: 'a', baseRefName: 'main', autoMergeRequest: {} },
          {
            number: 2,
            headRefName: 'b',
            baseRefName: 'main',
            autoMergeRequest: { mergeMethod: 7, enabledBy: 'junielton' }
          },
          { number: 3, headRefName: 'c', baseRefName: 'main', autoMergeRequest: 'SQUASH' },
          { number: 4, headRefName: 'd', baseRefName: 'main', autoMergeRequest: [] }
        ])
      )
      expect(rows[0].autoMergeRequest).toEqual({ mergeMethod: null, enabledBy: null })
      // `enabledBy` is an actor object on the wire; a bare string is not one.
      expect(rows[1].autoMergeRequest).toEqual({ mergeMethod: null, enabledBy: null })
      // Not an object at all ⇒ not armed.
      expect(rows[2].autoMergeRequest).toBeNull()
      expect(rows[3].autoMergeRequest).toBeNull()
    })
  })

  it('leaves every widened field at its absent value for a minimal row', () => {
    const [row] = parsePrList(
      JSON.stringify([{ number: 1, headRefName: 'a', baseRefName: 'main' }])
    )
    expect(row).toMatchObject({
      mergeStateStatus: null,
      additions: null,
      deletions: null,
      changedFiles: null,
      reviewRequests: [],
      labels: [],
      autoMergeRequest: null,
      // T275 — never on this payload; the thread query fills them in later.
      unresolvedThreads: null,
      outdatedThreads: null,
      threadsTruncated: false
    })
  })
})

// ── T275: unresolved review threads ─────────────────────────────────────────

/** The `gh api graphql` response shape, around a list of PR nodes. */
function threadsPayload(prs: unknown[]): string {
  return JSON.stringify({ data: { repository: { pullRequests: { nodes: prs } } } })
}

function prThreads(
  number: number,
  threads: Array<{ isResolved: unknown; isOutdated: unknown } | unknown>,
  totalCount = threads.length
): unknown {
  return { number, reviewThreads: { totalCount, nodes: threads } }
}

const RESOLVED = { isResolved: true, isOutdated: false }
const RESOLVED_OUTDATED = { isResolved: true, isOutdated: true }
const OPEN = { isResolved: false, isOutdated: false }
const OPEN_OUTDATED = { isResolved: false, isOutdated: true }

describe('parseReviewThreads', () => {
  it('counts nothing on a PR whose threads are all resolved — outdated or not', () => {
    const map = parseReviewThreads(
      threadsPayload([prThreads(1, [RESOLVED, RESOLVED_OUTDATED, RESOLVED])])
    )
    expect(map?.get(1)).toEqual({ unresolved: 0, outdated: 0, truncated: false })
  })

  it('splits a mixed PR: only unresolved AND current threads reach the chip count', () => {
    // The real shape of #337 on this repo, 2026-09-10: 3 current, 4 outdated.
    const map = parseReviewThreads(
      threadsPayload([
        prThreads(337, [
          OPEN_OUTDATED,
          OPEN_OUTDATED,
          OPEN,
          OPEN,
          OPEN_OUTDATED,
          OPEN_OUTDATED,
          OPEN,
          RESOLVED
        ])
      ])
    )
    expect(map?.get(337)).toEqual({ unresolved: 3, outdated: 4, truncated: false })
  })

  it('files an all-outdated PR under outdated only — noise, not a pending action', () => {
    const map = parseReviewThreads(threadsPayload([prThreads(2, [OPEN_OUTDATED, OPEN_OUTDATED])]))
    expect(map?.get(2)).toEqual({ unresolved: 0, outdated: 2, truncated: false })
  })

  it('reads a PR with no threads as a measured zero, not as absent', () => {
    const map = parseReviewThreads(threadsPayload([prThreads(3, [])]))
    expect(map?.has(3)).toBe(true)
    expect(map?.get(3)).toEqual({ unresolved: 0, outdated: 0, truncated: false })
  })

  it('reads a repo with no open PRs as an empty map, not as a failure', () => {
    expect(parseReviewThreads(threadsPayload([]))).toEqual(new Map())
  })

  it('returns null — no thread data at all — for a malformed payload', () => {
    expect(parseReviewThreads('')).toBeNull()
    expect(parseReviewThreads('not json')).toBeNull()
    expect(parseReviewThreads('[]')).toBeNull()
    expect(parseReviewThreads('{"data":{}}')).toBeNull()
    expect(parseReviewThreads('{"data":{"repository":{"pullRequests":{"nodes":7}}}}')).toBeNull()
    // A GraphQL error body: `gh` failing auth, a spent rate limit, an unknown repo.
    expect(
      parseReviewThreads(
        JSON.stringify({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'limit' }] })
      )
    ).toBeNull()
  })

  it('leaves a PR whose own threads are unreadable absent from the map', () => {
    const map = parseReviewThreads(
      threadsPayload([
        { number: 4 },
        { number: 5, reviewThreads: { nodes: 'nope' } },
        { reviewThreads: { totalCount: 0, nodes: [] } },
        null,
        prThreads(6, [OPEN])
      ])
    )
    expect([...(map?.keys() ?? [])]).toEqual([6])
  })

  it('marks the counts as a lower bound when GitHub holds more threads than were read', () => {
    const map = parseReviewThreads(threadsPayload([prThreads(7, [OPEN, OPEN_OUTDATED], 140)]))
    expect(map?.get(7)).toEqual({ unresolved: 1, outdated: 1, truncated: true })
  })

  it('skips a thread it cannot classify and marks the counts a lower bound, never a guess', () => {
    const map = parseReviewThreads(
      threadsPayload([
        prThreads(8, [OPEN, { isResolved: false }, { isResolved: 'no', isOutdated: false }, 7])
      ])
    )
    expect(map?.get(8)).toEqual({ unresolved: 1, outdated: 0, truncated: true })
  })
})

describe('REVIEW_THREADS_QUERY — the bounds, stated and pinned', () => {
  it('asks for exactly as many open PRs as gh pr list does, in the same order', () => {
    // `gh pr list --state all --limit N` is CREATED_AT DESC over every state;
    // the first N OPEN PRs in that order are a superset of the open ones it
    // returns, so no drawn card falls outside the thread query (spec §7.3).
    expect(PR_LIST_LIMIT).toBe(100)
    expect(REVIEW_THREADS_QUERY).toContain(
      `pullRequests(first: ${PR_LIST_LIMIT}, states: OPEN, orderBy: { field: CREATED_AT, direction: DESC })`
    )
  })

  it('reads the newest 100 threads per PR and asks for totalCount to detect truncation', () => {
    // The connection is oldest-first, so `last` keeps the threads likeliest to
    // be open inside the window when a PR has more than the limit.
    expect(THREADS_PER_PR_LIMIT).toBe(100)
    expect(REVIEW_THREADS_QUERY).toContain(`reviewThreads(last: ${THREADS_PER_PR_LIMIT})`)
    expect(REVIEW_THREADS_QUERY).toContain('totalCount')
    expect(REVIEW_THREADS_QUERY).toContain('isResolved')
    expect(REVIEW_THREADS_QUERY).toContain('isOutdated')
  })
})

describe('withReviewThreads', () => {
  const graph = buildGraph(
    [pr({ number: 1, branch: 'a', base: 'main' }), pr({ number: 2, branch: 'b', base: 'a' })],
    'main'
  )

  it('lands measured counts on their PR and leaves an unmeasured PR at null', () => {
    const threads = new Map<number, PrThreadCounts>([
      [1, { unresolved: 3, outdated: 4, truncated: true }]
    ])
    const out = withReviewThreads(graph, threads)
    const one = out.nodes.find((n) => n.pr.number === 1)?.pr
    const two = out.nodes.find((n) => n.pr.number === 2)?.pr
    expect(one).toMatchObject({ unresolvedThreads: 3, outdatedThreads: 4, threadsTruncated: true })
    expect(two).toMatchObject({
      unresolvedThreads: null,
      outdatedThreads: null,
      threadsTruncated: false
    })
  })

  it('keeps every PR at null when the call failed — absence is not zero', () => {
    const out = withReviewThreads(graph, null)
    for (const n of out.nodes) expect(n.pr.unresolvedThreads).toBeNull()
  })

  it('does not touch the topology or mutate its input', () => {
    const out = withReviewThreads(
      graph,
      new Map([[2, { unresolved: 1, outdated: 0, truncated: false }]])
    )
    expect(out.chains).toEqual(graph.chains)
    expect(out.nodes.map((n) => [n.pr.number, n.parent, n.depth])).toEqual(
      graph.nodes.map((n) => [n.pr.number, n.parent, n.depth])
    )
    expect(graph.nodes.every((n) => n.pr.unresolvedThreads === null)).toBe(true)
  })
})

describe('worstCi', () => {
  it('lets failing beat pending beat passing', () => {
    expect(
      worstCi([
        { name: 'a', state: 'passing', detail: '' },
        { name: 'b', state: 'pending', detail: '' },
        { name: 'c', state: 'failing', detail: '' }
      ])
    ).toBe('failing')
    expect(
      worstCi([
        { name: 'a', state: 'passing', detail: '' },
        { name: 'b', state: 'pending', detail: '' }
      ])
    ).toBe('pending')
    expect(worstCi([{ name: 'a', state: 'passing', detail: '' }])).toBe('passing')
    expect(worstCi([])).toBe('unknown')
  })
})

describe('buildGraph', () => {
  const stack = [
    pr({ number: 412, branch: 'wave-4', base: 'main' }),
    pr({ number: 418, branch: 'modular', base: 'wave-4' }),
    pr({ number: 423, branch: 'normalise', base: 'modular', ci: 'failing' })
  ]

  it('threads a 3-PR stack into one chain rooted on the default branch', () => {
    const g = buildGraph(stack, 'main')
    expect(g.chains).toHaveLength(1)
    const byNumber = new Map(g.nodes.map((n) => [n.pr.number, n]))
    expect(byNumber.get(412)!.depth).toBe(0)
    expect(byNumber.get(418)!.depth).toBe(1)
    expect(byNumber.get(423)!.depth).toBe(2)
    expect(byNumber.get(423)!.parent).toBe(418)
  })

  it('marks the leaf as the staging tip and counts what it carries', () => {
    const byNumber = new Map(buildGraph(stack, 'main').nodes.map((n) => [n.pr.number, n]))
    expect(byNumber.get(423)!.isStagingTip).toBe(true)
    expect(byNumber.get(423)!.carries).toBe(3)
    expect(byNumber.get(418)!.isStagingTip).toBe(false)
  })

  it('marks the base-most green+approved PR as merge-next, at the OTHER end', () => {
    const byNumber = new Map(buildGraph(stack, 'main').nodes.map((n) => [n.pr.number, n]))
    expect(byNumber.get(412)!.isMergeNext).toBe(true)
    // The tip is never merge-next unless it is also the root.
    expect(byNumber.get(423)!.isMergeNext).toBe(false)
  })

  it('makes a one-PR chain both tip and merge-next', () => {
    const [node] = buildGraph([pr({ number: 401, branch: 'solo', base: 'main' })], 'main').nodes
    expect(node.isStagingTip).toBe(true)
    expect(node.isMergeNext).toBe(true)
    expect(node.carries).toBe(1)
  })

  it('withholds merge-next from red, conflicted, unapproved and draft PRs', () => {
    const cases: Array<Partial<PrEntry>> = [
      { ci: 'failing' },
      { ci: 'pending' },
      { mergeable: false },
      { reviewDecision: null },
      { reviewDecision: 'CHANGES_REQUESTED' },
      { isDraft: true }
    ]
    for (const over of cases) {
      const [node] = buildGraph(
        [pr({ number: 1, branch: 'b', base: 'main', ...over })],
        'main'
      ).nodes
      expect(node.isMergeNext, JSON.stringify(over)).toBe(false)
    }
  })

  it('flags a PR whose base branch was merged — the silent-retarget hazard', () => {
    const prs = [
      pr({ number: 396, branch: 'wave-3', base: 'main', state: 'MERGED' }),
      pr({ number: 398, branch: 'cloudfront', base: 'wave-3' })
    ]
    const node = buildGraph(prs, 'main').nodes.find((n) => n.pr.number === 398)!
    expect(node.baseKind).toBe('merged')
    expect(node.parent).toBe(null)
    expect(node.depth).toBe(0)
  })

  it('calls a base that never had a PR "missing", not "merged"', () => {
    const node = buildGraph([pr({ number: 9, branch: 'x', base: 'ghost' })], 'main').nodes[0]
    expect(node.baseKind).toBe('missing')
  })

  it('keeps both siblings when two PRs share one base', () => {
    const prs = [
      pr({ number: 1, branch: 'root', base: 'main' }),
      pr({ number: 2, branch: 'left', base: 'root' }),
      pr({ number: 3, branch: 'right', base: 'root' })
    ]
    const g = buildGraph(prs, 'main')
    expect(g.chains).toHaveLength(1)
    const tips = g.nodes
      .filter((n) => n.isStagingTip)
      .map((n) => n.pr.number)
      .sort()
    expect(tips).toEqual([2, 3])
  })

  it('ignores closed and merged PRs as nodes', () => {
    const prs = [
      pr({ number: 1, branch: 'a', base: 'main' }),
      pr({ number: 2, branch: 'b', base: 'main', state: 'CLOSED' }),
      pr({ number: 3, branch: 'c', base: 'main', state: 'MERGED' })
    ]
    expect(buildGraph(prs, 'main').nodes.map((n) => n.pr.number)).toEqual([1])
  })

  it('orders chains deepest-first so the costliest stack takes the left column', () => {
    const prs = [
      pr({ number: 10, branch: 'shallow', base: 'main' }),
      pr({ number: 20, branch: 'deep-root', base: 'main' }),
      pr({ number: 21, branch: 'deep-mid', base: 'deep-root' }),
      pr({ number: 22, branch: 'deep-tip', base: 'deep-mid' })
    ]
    const g = buildGraph(prs, 'main')
    expect(g.chains[0]).toContain(20)
    expect(g.chains[1]).toEqual([10])
  })

  it('survives a base cycle instead of hanging', () => {
    const prs = [
      pr({ number: 1, branch: 'a', base: 'b' }),
      pr({ number: 2, branch: 'b', base: 'a' })
    ]
    expect(() => buildGraph(prs, 'main')).not.toThrow()
  })
})

describe('layoutGraph', () => {
  it('bottom-aligns chains so depth reads as column height', () => {
    const g = buildGraph(
      [
        pr({ number: 412, branch: 'wave-4', base: 'main' }),
        pr({ number: 418, branch: 'modular', base: 'wave-4' }),
        pr({ number: 401, branch: 'solo', base: 'main' })
      ],
      'main'
    )
    const { placements } = layoutGraph(g)
    const at = (id: string): { x: number; y: number } => placements.find((p) => p.id === id)!
    // Both chain roots share the bottom row...
    expect(at('412').y).toBe(at('401').y)
    // ...and the dependent PR sits exactly one row pitch above its base.
    expect(at('412').y - at('418').y).toBe(ROW_PITCH)
    // Separate chains never share a column.
    expect(at('412').x).not.toBe(at('401').x)
    expect(at('418').x).toBe(at('412').x)
  })

  it('insets the top row so a tip card is never born under the controls', () => {
    const g = buildGraph([pr({ number: 1, branch: 'a', base: 'main' })], 'main')
    expect(layoutGraph(g).placements[0].y).toBe(TOP_INSET)
  })

  it('widens a branching chain into sub-columns instead of overlapping', () => {
    const g = buildGraph(
      [
        pr({ number: 1, branch: 'root', base: 'main' }),
        pr({ number: 2, branch: 'left', base: 'root' }),
        pr({ number: 3, branch: 'right', base: 'root' }),
        pr({ number: 4, branch: 'other', base: 'main' })
      ],
      'main'
    )
    const { placements } = layoutGraph(g)
    const at = (id: string): { x: number; y: number } => placements.find((p) => p.id === id)!
    expect(at('2').x).not.toBe(at('3').x)
    // The next chain starts clear of the widened one.
    expect(at('4').x).toBeGreaterThanOrEqual(at('2').x + COLUMN_PITCH)
    expect(at('4').x).toBeGreaterThanOrEqual(at('3').x + COLUMN_PITCH)
  })
})

describe('applyOverrides / pruneOverrides', () => {
  it('lets a moved card win while untouched ones keep flowing', () => {
    const base = [
      { id: '1', x: 0, y: 0 },
      { id: '2', x: 304, y: 0 }
    ]
    const { placements, movedCount } = applyOverrides(base, { '1': { x: 999, y: 42 } })
    expect(movedCount).toBe(1)
    expect(placements[0]).toEqual({ id: '1', x: 999, y: 42 })
    expect(placements[1]).toEqual({ id: '2', x: 304, y: 0 })
  })

  it('drops the override of a PR that is no longer on the board', () => {
    const pruned = pruneOverrides({ '1': { x: 1, y: 1 }, '2': { x: 2, y: 2 } }, ['2'])
    expect(pruned).toEqual({ '2': { x: 2, y: 2 } })
  })
})

describe('zoom', () => {
  it('sheds detail at the documented thresholds', () => {
    expect(lodForScale(1)).toBe('full')
    expect(lodForScale(0.71)).toBe('full')
    expect(lodForScale(0.7)).toBe('compact')
    expect(lodForScale(0.45)).toBe('compact')
    expect(lodForScale(0.44)).toBe('far')
  })

  it('clamps to the usable range and survives NaN', () => {
    expect(clampScale(99)).toBe(2)
    expect(clampScale(0.001)).toBe(0.2)
    expect(clampScale(Number.NaN)).toBe(1)
  })

  it('fits a wide world down and centres it', () => {
    const fit = fitToView({ width: 4000, height: 1000 }, { width: 1000, height: 800 })
    expect(fit.scale).toBeLessThan(1)
    expect(fit.x).toBeCloseTo((1000 - 4000 * fit.scale) / 2)
  })

  it('never zooms a small graph past natural size', () => {
    expect(fitToView({ width: 300, height: 200 }, { width: 1600, height: 900 }).scale).toBe(1)
  })
})

describe('shapeKey', () => {
  it('changes when a PR is added, so fit re-runs on a shape change', () => {
    const a = buildGraph([pr({ number: 1, branch: 'a', base: 'main' })], 'main')
    const b = buildGraph(
      [pr({ number: 1, branch: 'a', base: 'main' }), pr({ number: 2, branch: 'b', base: 'a' })],
      'main'
    )
    expect(shapeKey(a)).not.toBe(shapeKey(b))
  })

  it('does NOT change when only readiness moves — the view must not jump mid-read', () => {
    const green = buildGraph([pr({ number: 1, branch: 'a', base: 'main' })], 'main')
    const red = buildGraph([pr({ number: 1, branch: 'a', base: 'main', ci: 'failing' })], 'main')
    expect(shapeKey(green)).toBe(shapeKey(red))
  })
})

describe('graphEdges', () => {
  it('gives every node exactly one outgoing edge', () => {
    const g = buildGraph(
      [pr({ number: 1, branch: 'a', base: 'main' }), pr({ number: 2, branch: 'b', base: 'a' })],
      'main'
    )
    const edges = graphEdges(g)
    expect(edges).toHaveLength(2)
    expect(edges.find((e) => e.from === '2')!.to).toBe('1')
    expect(edges.find((e) => e.from === '1')!.to).toBe('base')
  })

  it('marks the edge of a merged-base PR as the hazard', () => {
    const g = buildGraph(
      [
        pr({ number: 396, branch: 'wave-3', base: 'main', state: 'MERGED' }),
        pr({ number: 398, branch: 'cloudfront', base: 'wave-3' })
      ],
      'main'
    )
    expect(graphEdges(g)[0].kind).toBe('orphan')
  })

  it('hangs a PR-less worktree off its bornFrom mother and omits harvestable ones', () => {
    const g = buildGraph([], 'main')
    const edges = graphEdges(g, [
      {
        path: '/w/mother',
        branch: 'mother',
        title: 'Mother',
        bornFrom: null,
        sessionLive: false,
        harvestable: false,
        mergedPr: null,
        sizeBytes: 0
      },
      {
        path: '/w/child',
        branch: 'child',
        title: 'Child',
        bornFrom: '/w/mother',
        sessionLive: true,
        harvestable: false,
        mergedPr: null,
        sizeBytes: 0
      },
      {
        path: '/w/done',
        branch: 'done',
        title: 'Done',
        bornFrom: '/w/mother',
        sessionLive: false,
        harvestable: true,
        mergedPr: 396,
        sizeBytes: 88
      }
    ])
    expect(edges).toEqual([{ from: 'wt:/w/child', to: 'wt:/w/mother', kind: 'lineage' }])
  })
})

describe('kpis', () => {
  it('counts what the header claims', () => {
    const g = buildGraph(
      [
        pr({ number: 412, branch: 'wave-4', base: 'main' }),
        pr({ number: 418, branch: 'modular', base: 'wave-4', ci: 'failing' }),
        pr({ number: 401, branch: 'solo', base: 'main' }),
        pr({ number: 396, branch: 'wave-3', base: 'main', state: 'MERGED' }),
        pr({ number: 398, branch: 'cloudfront', base: 'wave-3', ci: 'failing' })
      ],
      'main'
    )
    expect(kpis(g)).toEqual({
      open: 4,
      chains: 3,
      readyToMerge: 2, // 412 and 401; 398 is red, 418 is not a root
      needsRetarget: 1,
      stagingTips: 3,
      withUnresolvedThreads: null // no thread data was merged in
    })
  })

  // T279 / spec T272 §5.7 — `readyToMerge` is a to-do count, and a PR that
  // lands itself is not a to-do.
  describe('readyToMerge and auto-merge', () => {
    const armed = { mergeMethod: 'SQUASH', enabledBy: 'junielton' }

    it('does not count a merge-next PR with auto-merge armed', () => {
      const g = buildGraph(
        [pr({ number: 501, branch: 'armed', base: 'main', autoMergeRequest: armed })],
        'main'
      )
      // The role is a fact about the chain; arming does not change it.
      expect(g.nodes[0].isMergeNext).toBe(true)
      expect(kpis(g).readyToMerge).toBe(0)
    })

    it('counts a merge-next PR with auto-merge not armed', () => {
      const g = buildGraph([pr({ number: 502, branch: 'unarmed', base: 'main' })], 'main')
      expect(g.nodes[0].isMergeNext).toBe(true)
      expect(kpis(g).readyToMerge).toBe(1)
    })

    it('counts only the unarmed one when both sit on the default branch', () => {
      const g = buildGraph(
        [
          pr({ number: 501, branch: 'armed', base: 'main', autoMergeRequest: armed }),
          pr({ number: 502, branch: 'unarmed', base: 'main' })
        ],
        'main'
      )
      expect(kpis(g).readyToMerge).toBe(1)
    })

    it('still excludes an armed PR whose method and actor were unreadable', () => {
      // `autoMergeOf` keeps the object with null members: presence IS the signal.
      const g = buildGraph(
        [
          pr({
            number: 503,
            branch: 'armed-opaque',
            base: 'main',
            autoMergeRequest: { mergeMethod: null, enabledBy: null }
          })
        ],
        'main'
      )
      expect(kpis(g).readyToMerge).toBe(0)
    })

    it('leaves every other count alone', () => {
      const g = buildGraph(
        [pr({ number: 501, branch: 'armed', base: 'main', autoMergeRequest: armed })],
        'main'
      )
      expect(kpis(g)).toEqual({
        open: 1,
        chains: 1,
        readyToMerge: 0,
        needsRetarget: 0,
        stagingTips: 1,
        withUnresolvedThreads: null
      })
    })
  })

  it('counts PRs with an unresolved, current thread — outdated-only ones do not count', () => {
    const g = withReviewThreads(
      buildGraph(
        [
          pr({ number: 1, branch: 'a', base: 'main' }),
          pr({ number: 2, branch: 'b', base: 'main' }),
          pr({ number: 3, branch: 'c', base: 'main' }),
          pr({ number: 4, branch: 'd', base: 'main' })
        ],
        'main'
      ),
      new Map<number, PrThreadCounts>([
        [1, { unresolved: 2, outdated: 0, truncated: false }],
        [2, { unresolved: 0, outdated: 5, truncated: false }],
        [3, { unresolved: 0, outdated: 0, truncated: false }]
        // 4 unmeasured — it counts toward neither side
      ])
    )
    expect(kpis(g).withUnresolvedThreads).toBe(1)
  })

  it('is a measured zero when threads were read and none is open', () => {
    const g = withReviewThreads(
      buildGraph([pr({ number: 1, branch: 'a', base: 'main' })], 'main'),
      new Map([[1, { unresolved: 0, outdated: 0, truncated: false }]])
    )
    expect(kpis(g).withUnresolvedThreads).toBe(0)
  })

  it('is null, not 0, when no PR could be measured', () => {
    const g = withReviewThreads(
      buildGraph([pr({ number: 1, branch: 'a', base: 'main' })], 'main'),
      null
    )
    expect(kpis(g).withUnresolvedThreads).toBeNull()
  })
})

describe('behind count — the local enrichment of the behind chip (T274)', () => {
  it('keeps a measured 0 — the only evidence for "up to date locally"', () => {
    expect(parseBehindCount('0\n')).toBe(0)
    expect(parseBehindCount('5\n')).toBe(5)
  })

  it('reads anything that is not a count as "could not measure"', () => {
    expect(parseBehindCount('')).toBeNull()
    expect(parseBehindCount('-1')).toBeNull()
    expect(parseBehindCount('fatal: bad revision')).toBeNull()
  })

  it('counts every PR against the branch it really merges into', () => {
    const g = buildGraph(
      [
        pr({ number: 1, branch: 'root', base: 'main' }),
        pr({ number: 2, branch: 'child', base: 'root' }),
        pr({ number: 3, branch: 'hotfix', base: 'release/2.1' }),
        pr({ number: 4, branch: 'gone-base', base: 'wave-3' }),
        pr({ number: 5, branch: 'wave-3', base: 'main', state: 'MERGED' })
      ],
      'main'
    )
    const baseOf = (n: number): string =>
      behindBaseRef(
        g.nodes.find((x) => x.pr.number === n)!,
        g.defaultBranch
      )
    expect(baseOf(1)).toBe('main')
    expect(baseOf(2)).toBe('root')
    // Neither the default branch nor an open PR: used to be counted against main.
    expect(baseOf(3)).toBe('release/2.1')
    // Base merged away: a leftover local copy of it is the wrong yardstick.
    expect(baseOf(4)).toBe('main')
  })
})

describe('focusOnBox', () => {
  const VIEW = { width: 1000, height: 600 }

  it('centres the card and keeps the zoom when it fits', () => {
    const v = focusOnBox({ x: 100, y: 50, w: 272, h: 101 }, VIEW, 1)
    expect(v.scale).toBe(1)
    expect(v.x).toBe(500 - (100 + 136))
    expect(v.y).toBe(300 - (50 + 50.5))
  })

  it('accounts for the current zoom when centring', () => {
    const v = focusOnBox({ x: 100, y: 50, w: 272, h: 101 }, VIEW, 0.5)
    expect(v.scale).toBe(0.5)
    expect(v.x).toBe(500 - 236 * 0.5)
  })

  it('shrinks just enough when the card would not fit the viewport', () => {
    const v = focusOnBox({ x: 0, y: 0, w: 272, h: 101 }, { width: 200, height: 600 }, 1)
    expect(v.scale).toBeCloseTo((200 - 64) / 272, 5)
    expect(v.x).toBeCloseTo(100 - 136 * v.scale, 5)
  })
})

describe('focusCardHeight', () => {
  it('follows the canvas card heights by zoom level', () => {
    expect(focusCardHeight('far')).toBe(32)
    expect(focusCardHeight('compact')).toBe(62)
    expect(focusCardHeight('full')).toBe(101)
  })
})

describe('resolveFocusTarget', () => {
  const placements = [
    { id: '412', x: 0, y: 0 },
    { id: 'wt:/x', x: 5, y: 5 }
  ]

  it('finds the placement keyed by the PR number', () => {
    expect(resolveFocusTarget({ number: 412, repo: '/r' }, '/r', placements)).toBe(placements[0])
  })

  it('is null without a request, without the card, or on another repo', () => {
    expect(resolveFocusTarget(null, '/r', placements)).toBeNull()
    expect(resolveFocusTarget({ number: 9, repo: '/r' }, '/r', placements)).toBeNull()
    expect(resolveFocusTarget({ number: 412, repo: '/other' }, '/r', placements)).toBeNull()
  })

  it('accepts any repo when the request names none', () => {
    expect(resolveFocusTarget({ number: 412, repo: null }, '/r', placements)).toBe(placements[0])
  })
})
