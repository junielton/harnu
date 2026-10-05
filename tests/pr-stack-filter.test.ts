import { describe, it, expect } from 'vitest'
import {
  parseQuery,
  isFilterActive,
  matchNodes,
  buildFilterContext,
  hasToken,
  toggleToken,
  tokenCount,
  facetCounts,
  layoutHidden,
  KPI_PRESETS,
  presetActive,
  normalizeQuery
} from '../src/renderer/src/components/pr-stack-filter'
import { buildGraph, type PrEntry, type PrNode } from '../src/main/pr-stack-core'

function pr(over: Partial<PrEntry> & { number: number }): PrEntry {
  return {
    title: `PR ${over.number}`,
    branch: `feat/${over.number}`,
    base: 'main',
    state: 'OPEN',
    isDraft: false,
    mergeable: true,
    reviewDecision: null,
    ci: 'passing',
    checks: [],
    url: '',
    author: 'alice',
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

/**
 * 1 ◄ 2 ◄ 3 (chain A: 1 on main, 2 on 1, 3 on 2)
 * 4 (chain B, approved + green → merge-next)
 * 5 ◄ 6 (chain C), 5 base is a merged branch → stale
 */
function fixture(): PrNode[] {
  const prs: PrEntry[] = [
    pr({ number: 1, reviewDecision: 'APPROVED', author: 'alice', labels: ['bug'] }),
    pr({
      number: 2,
      branch: 'feat/two',
      base: 'feat/1',
      title: 'Add Dashboard',
      reviewDecision: 'CHANGES_REQUESTED',
      author: 'bob',
      ci: 'failing',
      unresolvedThreads: 2
    }),
    pr({
      number: 3,
      base: 'feat/two',
      isDraft: true,
      author: 'copilot',
      ci: 'pending',
      reviewDecision: 'REVIEW_REQUIRED',
      unresolvedThreads: 0,
      reviewRequests: [{ kind: 'user', login: 'dberri' }]
    }),
    pr({ number: 4, reviewDecision: 'APPROVED', labels: ['Good First Issue', 'bug'] }),
    pr({ number: 5, base: 'gone-branch', mergeStateStatus: 'DIRTY', mergeable: false }),
    pr({ number: 6, base: 'feat/5', author: 'bob' }),
    pr({ number: 99, base: 'main', state: 'MERGED', branch: 'gone-branch' })
  ]
  return buildGraph(prs, 'main').nodes
}

function ids(query: string): number[] {
  const nodes = fixture()
  const ctx = buildFilterContext(nodes)
  return matchNodes(nodes, parseQuery(query), ctx).sort((a, b) => a - b)
}

describe('parseQuery', () => {
  it('splits whitespace-separated terms, lowercases keys and keeps the typed value', () => {
    const q = parseQuery('IS:Tip  review:approved')
    expect(q.terms.map((t) => [t.key, t.value])).toEqual([
      ['is', 'Tip'],
      ['review', 'approved']
    ])
  })

  it('keeps double-quoted values together', () => {
    const q = parseQuery('label:"good first issue" foo')
    expect(q.terms[0]).toMatchObject({ key: 'label', value: 'good first issue', status: 'ok' })
    expect(q.terms[1]).toMatchObject({ key: null, value: 'foo' })
  })

  it('flags negation on qualifiers and on free text', () => {
    const q = parseQuery('-is:draft -foo')
    expect(q.terms.map((t) => t.negated)).toEqual([true, true])
    expect(q.terms[0].key).toBe('is')
    expect(q.terms[1].value).toBe('foo')
  })

  it('marks an unknown key or an unknown enum value as unknown, never dropping the term', () => {
    const q = parseQuery('bogus:x is:nope review:approved')
    expect(q.terms.map((t) => t.status)).toEqual(['unknown', 'unknown', 'ok'])
    expect(q.terms).toHaveLength(3)
  })

  it('treats a qualifier with no value yet as pending (typing), not as unknown', () => {
    const q = parseQuery('is:')
    expect(q.terms[0].status).toBe('pending')
    expect(isFilterActive(q)).toBe(false)
  })

  it('treats a bare dash as pending', () => {
    expect(parseQuery('-').terms[0].status).toBe('pending')
  })

  it('is inactive for an empty or whitespace query', () => {
    expect(isFilterActive(parseQuery(''))).toBe(false)
    expect(isFilterActive(parseQuery('   '))).toBe(false)
  })

  it('is active once any non-pending term exists, even an unknown one', () => {
    expect(isFilterActive(parseQuery('bogus:x'))).toBe(true)
  })
})

describe('matcher — qualifiers', () => {
  it('is:tip matches nodes nothing is based on', () => {
    expect(ids('is:tip')).toEqual([3, 4, 6])
  })

  it('is:merge-next matches the strict merge-next set', () => {
    expect(ids('is:merge-next')).toEqual([1, 4])
  })

  it('is:blocked matches failing CI or a conflicting merge state', () => {
    expect(ids('is:blocked')).toEqual([2, 5])
  })

  it('is:stale matches a PR whose base branch was merged', () => {
    expect(ids('is:stale')).toEqual([5])
  })

  it('is:draft matches drafts', () => {
    expect(ids('is:draft')).toEqual([3])
  })

  it('author: is case-insensitive and tolerates a leading @', () => {
    expect(ids('author:BOB')).toEqual([2, 6])
    expect(ids('author:@copilot')).toEqual([3])
  })

  it('author:@me matches nothing (no login source) without being an error', () => {
    expect(ids('author:@me')).toEqual([])
    expect(parseQuery('author:@me').terms[0].status).toBe('ok')
  })

  it('review: maps the four decisions', () => {
    expect(ids('review:approved')).toEqual([1, 4])
    expect(ids('review:changes')).toEqual([2])
    expect(ids('review:required')).toEqual([3])
    expect(ids('review:none')).toEqual([5, 6])
  })

  it('review-requested: matches a pending reviewer login', () => {
    expect(ids('review-requested:dberri')).toEqual([3])
    expect(ids('review-requested:@dberri')).toEqual([3])
  })

  it('ci: maps the three states', () => {
    expect(ids('ci:failing')).toEqual([2])
    expect(ids('ci:pending')).toEqual([3])
    expect(ids('ci:passing')).toEqual([1, 4, 5, 6])
  })

  it('threads:unresolved / none, with null matching neither', () => {
    expect(ids('threads:unresolved')).toEqual([2])
    expect(ids('threads:none')).toEqual([3])
  })

  it('label: is a case-insensitive exact label name', () => {
    expect(ids('label:bug')).toEqual([1, 4])
    expect(ids('label:"good first issue"')).toEqual([4])
  })

  it('base: matches the base branch', () => {
    expect(ids('base:feat/1')).toEqual([2])
    expect(ids('base:main')).toEqual([1, 4])
  })

  it('chain:#N and chain:N match every PR of the connected chain', () => {
    expect(ids('chain:#2')).toEqual([1, 2, 3])
    expect(ids('chain:3')).toEqual([1, 2, 3])
    expect(ids('chain:#6')).toEqual([5, 6])
  })

  it('chain: for a PR that is not open matches nothing', () => {
    expect(ids('chain:#404')).toEqual([])
  })

  it('free text matches title or branch substrings, case-insensitively', () => {
    expect(ids('dashboard')).toEqual([2])
    expect(ids('feat/two')).toEqual([2])
  })

  it('free text #N matches that PR number exactly', () => {
    expect(ids('#4')).toEqual([4])
    expect(ids('#40')).toEqual([])
  })
})

describe('matcher — composition', () => {
  it('ANDs different keys', () => {
    expect(ids('review:approved ci:passing is:tip')).toEqual([4])
  })

  it('ORs repeated values of the same key', () => {
    expect(ids('review:approved review:changes')).toEqual([1, 2, 4])
  })

  it('negation excludes', () => {
    expect(ids('-is:tip')).toEqual([1, 2, 5])
  })

  it('several negations of one key exclude all of them', () => {
    expect(ids('-review:approved -review:changes')).toEqual([3, 5, 6])
  })

  it('combines a positive and a negative group', () => {
    expect(ids('ci:passing -review:approved')).toEqual([5, 6])
  })

  it('negated free text excludes title matches', () => {
    expect(ids('-dashboard is:blocked')).toEqual([5])
  })

  it('an unknown key matches nothing', () => {
    expect(ids('bogus:x')).toEqual([])
  })

  it('an unknown value matches nothing, even when OR-ed with a valid one', () => {
    expect(ids('is:nope')).toEqual([])
    expect(ids('is:tip is:nope')).toEqual([3, 4, 6])
  })

  it('a negated unknown term excludes nothing', () => {
    expect(ids('-is:nope')).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('pending terms are ignored', () => {
    expect(ids('is:tip is:')).toEqual([3, 4, 6])
  })
})

describe('token ↔ query sync', () => {
  it('hasToken reads a checked option out of the query', () => {
    expect(hasToken('review:approved ci:passing', 'review', 'approved')).toBe(true)
    expect(hasToken('review:approved', 'review', 'changes')).toBe(false)
    expect(hasToken('-review:approved', 'review', 'approved')).toBe(false)
  })

  it('toggleToken appends, then removes, the same token', () => {
    const on = toggleToken('', 'review', 'approved')
    expect(on).toBe('review:approved')
    expect(toggleToken(on, 'review', 'approved')).toBe('')
  })

  it('toggleToken keeps unrelated terms and quotes values with spaces', () => {
    expect(toggleToken('is:tip', 'label', 'good first issue')).toBe(
      'is:tip label:"good first issue"'
    )
    expect(toggleToken('is:tip label:"good first issue"', 'label', 'good first issue')).toBe(
      'is:tip'
    )
  })

  it('tokenCount counts the positive tokens of the given keys', () => {
    expect(
      tokenCount('review:approved review:changes ci:passing threads:unresolved', ['review'])
    ).toBe(2)
    expect(tokenCount('review:approved threads:unresolved', ['review', 'threads'])).toBe(2)
  })
})

describe('facetCounts', () => {
  it('counts each option over the whole snapshot, ignoring the current query', () => {
    const nodes = fixture()
    const counts = facetCounts(nodes, 'review', ['approved', 'changes', 'required', 'none'])
    expect(counts).toEqual({ approved: 2, changes: 1, required: 1, none: 2 })
  })
})

describe('presets', () => {
  it('the three KPI presets are the documented tokens', () => {
    expect(KPI_PRESETS).toEqual({
      ready: 'is:merge-next',
      threads: 'threads:unresolved',
      retarget: 'is:stale'
    })
  })

  it('a preset is active only when it is the whole query', () => {
    expect(presetActive('is:merge-next', 'ready')).toBe(true)
    expect(presetActive('  IS:merge-next ', 'ready')).toBe(true)
    expect(presetActive('is:merge-next ci:passing', 'ready')).toBe(false)
    expect(presetActive('', 'ready')).toBe(false)
  })

  it('normalizeQuery collapses whitespace and case', () => {
    expect(normalizeQuery('  IS:Tip   foo ')).toBe('is:tip foo')
  })
})

describe('layoutHidden', () => {
  function run(query: string) {
    const nodes = fixture()
    const ctx = buildFilterContext(nodes)
    const match = new Set(matchNodes(nodes, parseQuery(query), ctx))
    return layoutHidden({ defaultBranch: 'main', nodes, chains: [] }, match)
  }

  it('lays out only the matches when they connect directly', () => {
    const out = run('review:approved')
    // 1 is on main, 4 is on main — two single-card chains.
    expect(out.placements.map((p) => p.id).sort()).toEqual(['1', '4'])
    expect(out.ghosts).toEqual([])
    expect(out.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(['1->base', '4->base'])
  })

  it('keeps a path to base through a ghost for one skipped ancestor', () => {
    // 3 is the only match; 2 and 1 above/below are hidden.
    const out = run('is:draft')
    expect(out.placements.map((p) => p.id)).toEqual(['3'])
    expect(out.ghosts).toHaveLength(1)
    expect(out.ghosts[0]).toMatchObject({ hidden: [1, 2], matches: [3] })
    const e = out.edges.map((x) => `${x.from}->${x.to}`).sort()
    expect(e).toEqual([`${out.ghosts[0].id}->base`, `3->${out.ghosts[0].id}`].sort())
  })

  it('does not ghost a skipped run that ends at a matching ancestor', () => {
    // 1 and 3 match, 2 is skipped between them.
    const out = run('review:approved review:required')
    // matches: 1, 3, 4 ; 3 sits above hidden 2 above matching 1
    const g = out.ghosts.find((x) => x.hidden.join() === '2')
    expect(g).toBeDefined()
    const e = out.edges.map((x) => `${x.from}->${x.to}`)
    expect(e).toContain(`3->${g!.id}`)
    expect(e).toContain(`${g!.id}->1`)
    expect(e).toContain('1->base')
  })

  it('shares one ghost between sibling matches under the same skipped parent', () => {
    const nodes = buildGraph(
      [
        pr({ number: 10 }),
        pr({ number: 11, base: 'feat/10', author: 'bob' }),
        pr({ number: 12, base: 'feat/10', author: 'bob' })
      ],
      'main'
    ).nodes
    const ctx = buildFilterContext(nodes)
    const match = new Set(matchNodes(nodes, parseQuery('author:bob'), ctx))
    const out = layoutHidden({ defaultBranch: 'main', nodes, chains: [] }, match)
    expect(out.ghosts).toHaveLength(1)
    expect(out.ghosts[0].matches.sort()).toEqual([11, 12])
  })

  it('reports a world that fits the layout, and nothing for zero matches', () => {
    const none = run('is:draft review:approved')
    expect(none.placements).toEqual([])
    expect(none.ghosts).toEqual([])
    const some = run('review:approved')
    expect(some.world.width).toBeGreaterThan(0)
    expect(some.world.height).toBeGreaterThan(0)
  })

  it('a ghost on a merged-base root keeps the orphan edge kind', () => {
    const out = run('author:bob') // matches 2 and 6; 6 sits on 5 whose base merged
    const toBase = out.edges.filter((e) => e.to === 'base')
    expect(toBase.some((e) => e.kind === 'orphan')).toBe(true)
  })
})
