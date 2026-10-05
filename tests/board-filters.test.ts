import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FILTER_STATE,
  deriveExecutedBranch,
  filterCards,
  filterStorageKey,
  groupCards,
  isGroupMode,
  KIND_FILTERS,
  kindChipClass,
  matchesKindFilter,
  matchesSearch,
  matchesWorktreeScope,
  parsePersistedFilters,
  serializeFilters,
  sessionShortId,
  type FilterableCard
} from '../src/renderer/src/lib/board-filters'

function card(overrides: Partial<FilterableCard> = {}): FilterableCard {
  return {
    id: 'T1',
    slug: 't1',
    title: 'Some card',
    column: 'backlog',
    ...overrides
  }
}

describe('KIND_FILTERS', () => {
  it('lists the five kinds in the mockup/spec order', () => {
    expect(KIND_FILTERS).toEqual(['bug', 'feature', 'chore', 'scout', 'review'])
  })
})

describe('matchesSearch', () => {
  it('passes everything on an empty query', () => {
    expect(matchesSearch(card({ id: 'T1', title: 'Anything' }), '')).toBe(true)
    expect(matchesSearch(card({ id: 'T1', title: 'Anything' }), '   ')).toBe(true)
  })

  it('matches against id case-insensitively', () => {
    expect(matchesSearch(card({ id: 'BUG-25', title: 'Whatever' }), 'bug-25')).toBe(true)
  })

  it('matches against title case-insensitively', () => {
    expect(matchesSearch(card({ id: 'T1', title: 'Card modal filter bar' }), 'FILTER')).toBe(true)
  })

  it('rejects a query matching neither id nor title', () => {
    expect(matchesSearch(card({ id: 'T1', title: 'Card modal' }), 'zzz')).toBe(false)
  })
})

describe('matchesKindFilter', () => {
  it('passes everything when no chip is active (mockup semantics)', () => {
    expect(matchesKindFilter('bug', new Set())).toBe(true)
    expect(matchesKindFilter(undefined, new Set())).toBe(true)
  })

  it('passes an unclassified card regardless of the active set', () => {
    expect(matchesKindFilter(undefined, new Set(['bug']))).toBe(true)
  })

  it('passes a kind that is in the active set', () => {
    expect(matchesKindFilter('bug', new Set(['bug', 'feature']))).toBe(true)
  })

  it('rejects a kind that is not in the active set', () => {
    expect(matchesKindFilter('chore', new Set(['bug', 'feature']))).toBe(false)
  })
})

describe('filterCards', () => {
  const cards = [
    card({ id: 'BUG-1', title: 'Fix the thing', kind: 'bug' }),
    card({ id: 'T2', title: 'Add the thing', kind: 'feature' }),
    card({ id: 'T3', title: 'Chore card', kind: 'chore' }),
    card({ id: 'T4', title: 'No kind card' })
  ]

  it('applies both search and kind filters', () => {
    const out = filterCards(cards, { search: 'thing', kinds: new Set(['bug']) })
    expect(out.map((c) => c.id)).toEqual(['BUG-1'])
  })

  it('an empty kind set + empty search passes everything', () => {
    const out = filterCards(cards, { search: '', kinds: new Set() })
    expect(out).toHaveLength(4)
  })

  it('preserves input order (stable filter, no resort)', () => {
    const out = filterCards(cards, { search: '', kinds: new Set(['bug', 'feature', 'chore']) })
    expect(out.map((c) => c.id)).toEqual(['BUG-1', 'T2', 'T3', 'T4'])
  })

  it('T190: an omitted scope behaves exactly like a null-branch scope', () => {
    const scoped = [
      card({ id: 'A', originBranch: 'main' }),
      card({ id: 'B', originBranch: 'feat/x' })
    ]
    expect(filterCards(scoped, { search: '', kinds: new Set() }).map((c) => c.id)).toEqual([
      'A',
      'B'
    ])
    expect(
      filterCards(scoped, { search: '', kinds: new Set(), scope: { branch: null } }).map(
        (c) => c.id
      )
    ).toEqual(['A', 'B'])
  })

  it('T190: ANDs the worktree scope with search + kind filters', () => {
    const scoped = [
      card({ id: 'A', kind: 'bug', executedIn: 'feat/x' }),
      card({ id: 'B', kind: 'feature', executedIn: 'feat/x' }),
      card({ id: 'C', kind: 'bug', executedIn: 'main' })
    ]
    const out = filterCards(scoped, {
      search: '',
      kinds: new Set(['bug']),
      scope: { branch: 'feat/x' }
    })
    expect(out.map((c) => c.id)).toEqual(['A'])
  })
})

describe('matchesWorktreeScope (T190 — union match, D3)', () => {
  it('a null scope matches everything, regardless of the card', () => {
    expect(matchesWorktreeScope(card({}), { branch: null })).toBe(true)
    expect(
      matchesWorktreeScope(card({ originBranch: 'main', executedIn: 'feat/x' }), { branch: null })
    ).toBe(true)
  })

  it('matches on origin alone (executed-in absent)', () => {
    const c = card({ originBranch: 'feat/x' })
    expect(matchesWorktreeScope(c, { branch: 'feat/x' })).toBe(true)
  })

  it('matches on executedIn alone (origin absent)', () => {
    const c = card({ executedIn: 'feat/x' })
    expect(matchesWorktreeScope(c, { branch: 'feat/x' })).toBe(true)
  })

  it('matches when BOTH origin and executedIn equal the scope', () => {
    const c = card({ originBranch: 'feat/x', executedIn: 'feat/x' })
    expect(matchesWorktreeScope(c, { branch: 'feat/x' })).toBe(true)
  })

  it('matches when origin and executedIn disagree but either equals the scope', () => {
    const c = card({ originBranch: 'main', executedIn: 'feat/x' })
    expect(matchesWorktreeScope(c, { branch: 'feat/x' })).toBe(true)
    expect(matchesWorktreeScope(c, { branch: 'main' })).toBe(true)
  })

  it('rejects a card with neither origin nor executedIn set', () => {
    const c = card({})
    expect(matchesWorktreeScope(c, { branch: 'feat/x' })).toBe(false)
  })

  it('rejects a card whose origin/executedIn are both a DIFFERENT branch', () => {
    const c = card({ originBranch: 'main', executedIn: 'other' })
    expect(matchesWorktreeScope(c, { branch: 'feat/x' })).toBe(false)
  })

  it('is case-sensitive, same as git branch names', () => {
    const c = card({ executedIn: 'Feat/X' })
    expect(matchesWorktreeScope(c, { branch: 'feat/x' })).toBe(false)
  })
})

describe('deriveExecutedBranch (T190 — runtime-only substring fallback, D4)', () => {
  it('returns the single branch whose name embeds the card id', () => {
    expect(deriveExecutedBranch('T190', ['card/T190-worktree-provenance', 'main'])).toBe(
      'card/T190-worktree-provenance'
    )
  })

  it('returns undefined on zero matches', () => {
    expect(deriveExecutedBranch('T190', ['main', 'feat/unrelated'])).toBeUndefined()
  })

  it('returns undefined on an ambiguous (>1) match — never guesses', () => {
    expect(deriveExecutedBranch('T19', ['card/T190-a', 'card/T191-b', 'main'])).toBeUndefined()
  })

  it('a card id that is a substring of an UNRELATED branch still counts as a match', () => {
    // "T1" is a substring of "card/T190-x" despite T1 and T190 being different
    // cards — this is the exact gotcha the substring rule inherits from
    // `findExistingWorkForSlug`, so the derivation must reproduce it faithfully
    // rather than silently being "smarter" than the rule it mirrors.
    expect(deriveExecutedBranch('T1', ['card/T190-worktree-provenance'])).toBe(
      'card/T190-worktree-provenance'
    )
  })

  it('returns undefined for an empty card id', () => {
    expect(deriveExecutedBranch('', ['main', 'feat/x'])).toBeUndefined()
  })

  it('returns undefined against an empty branch list', () => {
    expect(deriveExecutedBranch('T190', [])).toBeUndefined()
  })
})

describe('groupCards', () => {
  const cardsById = new Map<string, FilterableCard>([
    ['T82', card({ id: 'T82', slug: 'T82', title: 'Agent-owned task manager' })]
  ])

  it('mode "none" returns one unlabeled group with everything', () => {
    const cards = [card({ id: 'A' }), card({ id: 'B' })]
    const groups = groupCards(cards, 'none', cardsById)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBeNull()
    expect(groups[0].cards.map((c) => c.id)).toEqual(['A', 'B'])
  })

  it('mode "none" on an empty list returns no groups', () => {
    expect(groupCards([], 'none', cardsById)).toEqual([])
  })

  it('mode "kind" buckets by kind, trailing unlabeled bucket last', () => {
    const cards = [
      card({ id: 'A', kind: 'bug' }),
      card({ id: 'B' }),
      card({ id: 'C', kind: 'feature' }),
      card({ id: 'D', kind: 'bug' })
    ]
    const groups = groupCards(cards, 'kind', cardsById)
    expect(groups.map((g) => g.label)).toEqual(['bug', 'feature', null])
    expect(groups.map((g) => g.count)).toEqual([2, 1, 1])
    expect(groups[0].cards.map((c) => c.id)).toEqual(['A', 'D'])
    expect(groups[2].cards.map((c) => c.id)).toEqual(['B'])
  })

  it('mode "epic" resolves the parent card id + title', () => {
    const cards = [
      card({ id: 'A', parent: 'T82' }),
      card({ id: 'B', parent: 'T82' }),
      card({ id: 'C' })
    ]
    const groups = groupCards(cards, 'epic', cardsById)
    expect(groups).toHaveLength(2)
    expect(groups[0].label).toBe('T82 · Agent-owned task manager')
    expect(groups[0].cards.map((c) => c.id)).toEqual(['A', 'B'])
    expect(groups[1].label).toBeNull()
    expect(groups[1].cards.map((c) => c.id)).toEqual(['C'])
  })

  it('mode "epic" falls back to the raw parent ref when the parent is off-board', () => {
    const cards = [card({ id: 'A', parent: 'GHOST-1' })]
    const groups = groupCards(cards, 'epic', cardsById)
    expect(groups[0].label).toBe('GHOST-1')
  })

  it('mode "epic" puts the unlabeled bucket last regardless of first-appearance order', () => {
    const cards = [card({ id: 'A' }), card({ id: 'B', parent: 'T82' })]
    const groups = groupCards(cards, 'epic', cardsById)
    expect(groups.map((g) => g.label)).toEqual(['T82 · Agent-owned task manager', null])
  })
})

describe('kindChipClass', () => {
  it('colors bug red-soft/red', () => {
    expect(kindChipClass('bug')).toContain('bg-red-soft')
    expect(kindChipClass('bug')).toContain('text-red')
  })

  it('colors feature accent-soft/accent', () => {
    expect(kindChipClass('feature')).toContain('bg-accent-soft')
    expect(kindChipClass('feature')).toContain('text-accent')
  })

  it('every other kind (and undefined) stays the quiet surface-2 pill', () => {
    for (const k of ['chore', 'scout', 'review', undefined]) {
      expect(kindChipClass(k)).toContain('bg-surface-2')
      expect(kindChipClass(k)).toContain('text-text-3')
    }
  })
})

describe('sessionShortId', () => {
  it('truncates to the first 7 characters', () => {
    expect(sessionShortId('d507f674abcd')).toBe('d507f67')
  })

  it('leaves a short id untouched', () => {
    expect(sessionShortId('abc')).toBe('abc')
  })
})

describe('filterStorageKey', () => {
  it('namespaces under om2tab.roadmap.filters', () => {
    expect(filterStorageKey('/home/x/repo')).toBe('om2tab.roadmap.filters./home/x/repo')
  })
})

describe('isGroupMode', () => {
  it('accepts the three valid modes', () => {
    expect(isGroupMode('epic')).toBe(true)
    expect(isGroupMode('kind')).toBe(true)
    expect(isGroupMode('none')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isGroupMode('epics')).toBe(false)
    expect(isGroupMode(42)).toBe(false)
    expect(isGroupMode(undefined)).toBe(false)
  })
})

describe('DEFAULT_FILTER_STATE', () => {
  it('has every kind active, grouped by epic, done hidden', () => {
    expect(new Set(DEFAULT_FILTER_STATE.kinds)).toEqual(new Set(KIND_FILTERS))
    expect(DEFAULT_FILTER_STATE.group).toBe('epic')
    expect(DEFAULT_FILTER_STATE.hideDone).toBe(true)
  })
})

describe('serializeFilters / parsePersistedFilters', () => {
  it('round-trips a valid state', () => {
    const state = { kinds: ['bug', 'feature'], group: 'kind' as const, hideDone: false }
    expect(parsePersistedFilters(serializeFilters(state))).toEqual(state)
  })

  it('rejects null / missing raw value', () => {
    expect(parsePersistedFilters(null)).toBeNull()
  })

  it('rejects corrupt JSON', () => {
    expect(parsePersistedFilters('{not json')).toBeNull()
  })

  it('rejects a shape missing required keys', () => {
    expect(parsePersistedFilters(JSON.stringify({ kinds: ['bug'] }))).toBeNull()
  })

  it('rejects an invalid group mode', () => {
    expect(
      parsePersistedFilters(JSON.stringify({ kinds: [], group: 'nope', hideDone: true }))
    ).toBeNull()
  })

  it('rejects non-string entries in kinds', () => {
    expect(
      parsePersistedFilters(JSON.stringify({ kinds: [1, 2], group: 'none', hideDone: true }))
    ).toBeNull()
  })
})
