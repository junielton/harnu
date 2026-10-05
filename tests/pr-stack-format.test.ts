// @vitest-environment jsdom
// jsdom only for the rendered-card block at the bottom (T274); every other
// suite here is pure and does not care which environment it runs in.
import { describe, it, expect, beforeEach } from 'vitest'
import { createI18n } from 'vue-i18n'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import PrStackCard from '../src/renderer/src/components/PrStackCard.vue'
import type { MergeStateStatus, PrNode } from '../src/main/pr-stack-core'
import {
  prEmptyStateKind,
  refreshFailureKeys
} from '../src/renderer/src/components/pr-stack-format'
import {
  shortAgo,
  formatBytes,
  roleBarClass,
  prStatusInput,
  prStatusSlot,
  prStatusChipClass,
  prStatusLabelKey,
  reviewerHandle,
  prWaitingOn,
  PR_WAITING_CHIP_CLASS,
  compactCount,
  formatDiffSize,
  DIFF_SIZE_CHIP_CLASS,
  type DiffSizeLabels,
  type PrDiffSize,
  autoMergeDetail,
  prThreadChip,
  prThreadsDrawer,
  threadCountText,
  labelChips,
  LABEL_CHIP_CAP,
  prBehindState,
  prBehindChipLabel,
  prBehindDrawerLabel,
  prMergeStateNoteKey,
  type PrBehindState,
  type PrStatusInput,
  type PrStatusSlot
} from '../src/renderer/src/components/pr-stack-format'
import type { PrReviewRequest } from '../src/main/pr-stack-core'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'

/** Every value `parsePrList` can hand the card, `null` (absent) included. */
const ALL_MERGE_STATES: (MergeStateStatus | null)[] = [
  'CLEAN',
  'BEHIND',
  'DIRTY',
  'BLOCKED',
  'UNSTABLE',
  'DRAFT',
  'HAS_HOOKS',
  'UNKNOWN',
  null
]

/** `prStack.foo` → true when the leaf exists and is non-empty in BOTH locales. */
function inBothLocales(key: string): boolean {
  const leaf = key.replace(/^prStack\./, '')
  return [en.prStack, ptBR.prStack].every(
    (bag) =>
      typeof (bag as Record<string, unknown>)[leaf] === 'string' &&
      !!(bag as Record<string, string>)[leaf]
  )
}

/**
 * T273 / spec T272 §4.1 — the PR card's status slot.
 *
 * The point of the slot is that it holds EXACTLY ONE chip and that the choice
 * is a pure function, not a template ladder: six later units (T274..T279) all
 * target the same flex line, and as `v-else-if` branches each would re-litigate
 * its priority in template order with nothing testable left behind. These tests
 * pin the precedence so a later unit has to break a test rather than a card.
 */

const base: PrStatusInput = {
  mergeable: true,
  baseMerged: false,
  reviewDecision: null
}

describe('prStatusSlot — the six slots in isolation', () => {
  it('falls back to the neutral review chip when nothing else applies', () => {
    expect(prStatusSlot(base)).toBe('review')
    // `REVIEW_REQUIRED` is GitHub saying "a review is required", not a verdict.
    expect(prStatusSlot({ ...base, reviewDecision: 'REVIEW_REQUIRED' })).toBe('review')
  })

  it('reports conflicts when GitHub says the tree cannot merge', () => {
    expect(prStatusSlot({ ...base, mergeable: false })).toBe('conflicts')
  })

  it('does not report conflicts while mergeability is still uncomputed', () => {
    expect(prStatusSlot({ ...base, mergeable: null })).toBe('review')
  })

  it('reports retarget when the base branch was merged out from under the PR', () => {
    expect(prStatusSlot({ ...base, baseMerged: true })).toBe('retarget')
  })

  it('reports changesRequested — the state that used to render as neutral review', () => {
    expect(prStatusSlot({ ...base, reviewDecision: 'CHANGES_REQUESTED' })).toBe('changesRequested')
  })

  it('reports approved', () => {
    expect(prStatusSlot({ ...base, reviewDecision: 'APPROVED' })).toBe('approved')
  })

  it('reports blocked when a policy refuses the merge (T274 makes it reachable)', () => {
    expect(prStatusSlot({ ...base, policyBlocked: true })).toBe('blocked')
  })
})

describe('prStatusSlot — precedence, highest first', () => {
  it('conflicts outranks everything: nothing can proceed until the tree merges', () => {
    expect(
      prStatusSlot({
        mergeable: false,
        baseMerged: true,
        reviewDecision: 'CHANGES_REQUESTED',
        policyBlocked: true
      })
    ).toBe('conflicts')
    expect(prStatusSlot({ ...base, mergeable: false, reviewDecision: 'APPROVED' })).toBe(
      'conflicts'
    )
  })

  it('retarget outranks changesRequested: the PR points at a branch that is gone', () => {
    expect(
      prStatusSlot({
        mergeable: true,
        baseMerged: true,
        reviewDecision: 'CHANGES_REQUESTED',
        policyBlocked: true
      })
    ).toBe('retarget')
  })

  it('changesRequested outranks blocked: a human blocked it, not a policy', () => {
    expect(
      prStatusSlot({ ...base, reviewDecision: 'CHANGES_REQUESTED', policyBlocked: true })
    ).toBe('changesRequested')
  })

  it('changesRequested outranks approved when both could be read off one field', () => {
    // Defensive: `reviewDecision` is a single value, so this pins the ladder's
    // ORDER rather than a reachable payload — the branch that answers first wins.
    expect(prStatusSlot({ ...base, reviewDecision: 'CHANGES_REQUESTED' })).not.toBe('approved')
  })

  it('blocked outranks approved: an approved PR a rule still refuses is not ready', () => {
    expect(prStatusSlot({ ...base, reviewDecision: 'APPROVED', policyBlocked: true })).toBe(
      'blocked'
    )
  })

  it('blocked yields to review while a required review is outstanding', () => {
    // GitHub reports BLOCKED for every PR waiting on a required review: the
    // missing review IS the block, and `review` names it more precisely.
    expect(prStatusSlot({ ...base, reviewDecision: 'REVIEW_REQUIRED', policyBlocked: true })).toBe(
      'review'
    )
  })

  it('approved outranks the neutral fallback', () => {
    expect(prStatusSlot({ ...base, reviewDecision: 'APPROVED' })).toBe('approved')
  })

  it('draft never reaches the ladder — it is a card-level state, not a verdict', () => {
    // `isDraft` is deliberately absent from PrStatusInput: a draft with changes
    // requested must still say `changes requested`, which is the actionable half.
    // Feed the flag in anyway, the way the SFC's `PrEntry` carries it, so a later
    // unit that teaches the ladder to read `isDraft` breaks this test.
    const draft = { ...base, isDraft: true }
    expect(prStatusSlot({ ...draft, reviewDecision: 'CHANGES_REQUESTED' })).toBe('changesRequested')
    expect(prStatusSlot({ ...draft, reviewDecision: 'APPROVED' })).toBe('approved')
    expect(prStatusSlot(draft)).toBe('review')
  })
})

describe('prStatusChipClass — design.md §6 readiness chips, spec §4.3 colour budget', () => {
  it('gives the two human verdicts the red pairing', () => {
    expect(prStatusChipClass('conflicts')).toBe('bg-red-soft text-red')
    expect(prStatusChipClass('changesRequested')).toBe('bg-red-soft text-red')
  })

  it('gives approved the green pairing', () => {
    expect(prStatusChipClass('approved')).toBe('bg-green-soft text-green')
  })

  it('keeps red and green off the non-verdict slots', () => {
    // Spec §4.3: red and green are reserved for verdicts. `retarget` is a
    // hazard and `blocked` is a policy state — neither is a human's answer.
    for (const slot of ['retarget', 'blocked', 'review'] as PrStatusSlot[]) {
      expect(prStatusChipClass(slot)).not.toMatch(/red|green/)
    }
    expect(prStatusChipClass('retarget')).toBe('bg-warning/10 text-warning')
    expect(prStatusChipClass('blocked')).toBe('bg-warning/10 text-warning')
    expect(prStatusChipClass('review')).toBe('bg-surface-2 text-text-3')
  })

  it('uses no raw colours — every class is a themes.css-backed utility', () => {
    const slots: PrStatusSlot[] = [
      'conflicts',
      'retarget',
      'changesRequested',
      'blocked',
      'approved',
      'review'
    ]
    for (const slot of slots) {
      expect(prStatusChipClass(slot)).not.toMatch(/#[0-9a-f]{3,8}|rgb|hsl/i)
    }
  })
})

describe('prStatusLabelKey — every slot is translated in both locales', () => {
  const slots: PrStatusSlot[] = [
    'conflicts',
    'retarget',
    'changesRequested',
    'blocked',
    'approved',
    'review'
  ]

  it('maps a slot onto its prStack leaf', () => {
    expect(prStatusLabelKey('changesRequested')).toBe('prStack.changesRequested')
  })

  it('resolves in en and pt-BR — MessageSchema parity is a build gate', () => {
    for (const slot of slots) {
      expect(en.prStack).toHaveProperty(slot)
      expect(ptBR.prStack).toHaveProperty(slot)
      expect((en.prStack as Record<string, unknown>)[slot]).toBeTruthy()
      expect((ptBR.prStack as Record<string, unknown>)[slot]).toBeTruthy()
    }
  })

  it('translates the draft badge in both locales', () => {
    expect(en.prStack.draft).toBeTruthy()
    expect(ptBR.prStack.draft).toBeTruthy()
  })
})

// ── Waiting on reviewer (T277 / spec T272 §5.5) ───────────────────────────

/**
 * The point of this unit: a PR nobody was asked to review and a PR whose
 * reviewer has not answered used to draw the same grey `review` chip. The
 * gate and the `+N` overflow are pure, so both are pinned here rather than in
 * a template.
 */

const user = (login: string): PrReviewRequest => ({ kind: 'user', login })
const team = (login: string): PrReviewRequest => ({ kind: 'team', login })

describe('reviewerHandle — users and teams, never an @ on a non-handle', () => {
  it('prefixes a user login with @', () => {
    expect(reviewerHandle(user('dberri'))).toBe('@dberri')
  })

  it('prefixes a team slug with @', () => {
    expect(reviewerHandle(team('platform-core'))).toBe('@platform-core')
  })

  it('leaves a team display-name fallback as plain text', () => {
    // pr-stack-core keeps the team's `name` when the payload had no `slug`,
    // and says so: it is not an addressable handle, so `@Platform Core` would
    // be a lie about how to reach it.
    expect(reviewerHandle(team('Platform Core'))).toBe('Platform Core')
  })
})

describe('prWaitingOn — zero / one / many / team-only / mixed', () => {
  it('zero: an empty list renders no chip at all, never an empty `waiting`', () => {
    expect(prWaitingOn('review', [])).toBeNull()
  })

  it('one: names the reviewer with no overflow', () => {
    expect(prWaitingOn('review', [user('dberri')])).toEqual({
      lead: '@dberri',
      more: null,
      all: ['@dberri']
    })
  })

  it('many: names the first reviewer and folds the rest into +N', () => {
    expect(prWaitingOn('review', [user('dberri'), user('ana'), user('bo')])).toEqual({
      lead: '@dberri',
      more: '+2',
      all: ['@dberri', '@ana', '@bo']
    })
  })

  it('team-only: a request with no user in it is still a chip, not a crash', () => {
    expect(prWaitingOn('review', [team('platform-core')])).toEqual({
      lead: '@platform-core',
      more: null,
      all: ['@platform-core']
    })
    expect(prWaitingOn('review', [team('Platform Core'), team('infra')])).toEqual({
      lead: 'Platform Core',
      more: '+1',
      all: ['Platform Core', '@infra']
    })
  })

  it('mixed: a person leads over a team, since a person is who you can ping', () => {
    expect(prWaitingOn('review', [team('platform-core'), user('dberri'), team('infra')])).toEqual({
      lead: '@dberri',
      more: '+2',
      all: ['@dberri', '@platform-core', '@infra']
    })
  })

  it('never double-counts a reviewer listed twice', () => {
    expect(prWaitingOn('review', [user('dberri'), user('dberri')])).toEqual({
      lead: '@dberri',
      more: null,
      all: ['@dberri']
    })
  })
})

describe('prWaitingOn — absent and malformed data never draw an empty chip', () => {
  it('treats null and undefined as no request', () => {
    expect(prWaitingOn('review', null)).toBeNull()
    expect(prWaitingOn('review', undefined)).toBeNull()
  })

  it('skips entries with a blank or missing login instead of rendering `@`', () => {
    const junk = [
      { kind: 'user', login: '' },
      { kind: 'team', login: '   ' },
      { kind: 'user' },
      null
    ] as unknown as PrReviewRequest[]
    expect(prWaitingOn('review', junk)).toBeNull()
    expect(prWaitingOn('review', [...junk, user('dberri')])).toEqual({
      lead: '@dberri',
      more: null,
      all: ['@dberri']
    })
  })
})

describe('prWaitingOn — gated on the neutral status slot (spec §5.5)', () => {
  it('shows only when prStatusSlot resolved to the neutral review state', () => {
    const requests = [user('dberri')]
    const verdictSlots: PrStatusSlot[] = [
      'conflicts',
      'retarget',
      'changesRequested',
      'blocked',
      'approved'
    ]
    for (const slot of verdictSlots) expect(prWaitingOn(slot, requests)).toBeNull()
    expect(prWaitingOn('review', requests)).not.toBeNull()
  })

  it('composes with prStatusSlot: a verdict silences a still-pending request', () => {
    // GitHub keeps a second reviewer's request pending after the first one
    // approves. The approval is the news; the leftover request is noise.
    const requests = [user('ana')]
    const approved = prStatusSlot({ ...base, reviewDecision: 'APPROVED' })
    expect(prWaitingOn(approved, requests)).toBeNull()
    const neutral = prStatusSlot({ ...base, reviewDecision: 'REVIEW_REQUIRED' })
    expect(prWaitingOn(neutral, requests)?.lead).toBe('@ana')
  })
})

describe('nobody asked vs nobody answered — the two states must not look alike', () => {
  it('the same neutral PR draws a waiting chip only when a request is pending', () => {
    const slot = prStatusSlot(base)
    expect(slot).toBe('review')
    const nobodyAsked = prWaitingOn(slot, [])
    const nobodyAnswered = prWaitingOn(slot, [user('dberri')])
    expect(nobodyAsked).toBeNull()
    expect(nobodyAnswered).not.toBeNull()
  })
})

describe('waiting chip — neutral tokens, translated in both locales', () => {
  it('is neutral, never a warning — awaiting review is not a bad state', () => {
    expect(PR_WAITING_CHIP_CLASS).toBe('bg-surface-2 text-text-3')
    expect(PR_WAITING_CHIP_CLASS).not.toMatch(/red|green|warning/)
  })

  it('has its chip label and drawer row in en and pt-BR', () => {
    for (const locale of [en, ptBR]) {
      expect(locale.prStack.waiting).toContain('{who}')
      expect(locale.prStack.waitingOn).toBeTruthy()
    }
  })
})

// ── T274: mergeStateStatus through the S1 ladder ──────────────────────────

describe('prStatusInput — GitHub merge verdicts routed through prStatusSlot', () => {
  const pr = {
    mergeable: true as boolean | null,
    reviewDecision: null as string | null,
    mergeStateStatus: null as MergeStateStatus | null,
    isDraft: false,
    ci: 'passing' as 'passing' | 'failing' | 'pending' | 'unknown'
  }
  const slot = (p: Partial<typeof pr>, baseMerged = false): PrStatusSlot =>
    prStatusSlot(prStatusInput({ ...pr, ...p }, baseMerged))

  it('reads DIRTY as conflicts — one conflicts chip, not a second one', () => {
    expect(slot({ mergeStateStatus: 'DIRTY' })).toBe('conflicts')
    // DIRTY wins while GitHub has not finished computing `mergeable`.
    expect(slot({ mergeStateStatus: 'DIRTY', mergeable: null })).toBe('conflicts')
    expect(slot({ mergeStateStatus: 'DIRTY', mergeable: false })).toBe('conflicts')
  })

  it('makes the blocked slot reachable from a real PR payload', () => {
    expect(slot({ mergeStateStatus: 'BLOCKED' })).toBe('blocked')
    expect(slot({ mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED' })).toBe('blocked')
  })

  it('does not double up with the S1 chips', () => {
    // changes requested: a human said no, which outranks a policy.
    expect(slot({ mergeStateStatus: 'BLOCKED', reviewDecision: 'CHANGES_REQUESTED' })).toBe(
      'changesRequested'
    )
    // draft: GitHub folds its deprecated DRAFT state into BLOCKED, and the
    // draft badge already says why — no blocked chip beside it.
    expect(slot({ mergeStateStatus: 'BLOCKED', isDraft: true })).toBe('review')
    expect(slot({ mergeStateStatus: 'DRAFT', isDraft: true })).toBe('review')
    // review required: the missing review IS the block.
    expect(slot({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' })).toBe('review')
  })

  it('lets blocked yield while checks are running — the running chip names that wait', () => {
    // GitHub reports BLOCKED until required checks finish; without this an
    // approved PR would flash `blocked` on every CI run.
    expect(slot({ mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED', ci: 'pending' })).toBe(
      'approved'
    )
    expect(slot({ mergeStateStatus: 'BLOCKED', ci: 'pending' })).toBe('review')
    // A failing required check is a block that stays until someone acts.
    expect(slot({ mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED', ci: 'failing' })).toBe(
      'blocked'
    )
  })

  it('keeps retarget above blocked', () => {
    expect(slot({ mergeStateStatus: 'BLOCKED' }, true)).toBe('retarget')
  })

  it('leaves the slot alone for every value that is not DIRTY or BLOCKED', () => {
    for (const v of ALL_MERGE_STATES) {
      if (v === 'DIRTY' || v === 'BLOCKED') continue
      expect(slot({ mergeStateStatus: v })).toBe('review')
      expect(slot({ mergeStateStatus: v, reviewDecision: 'APPROVED' })).toBe('approved')
    }
  })
})

// ── Diff size (T276 / spec T272 §5.4) ──────────────────────────────────────

/** Plain English labels, so the formatter is exercised without vue-i18n. */
const labels: DiffSizeLabels = {
  files: (n, count) => `${count} ${n === 1 ? 'file' : 'files'}`,
  empty: 'empty diff'
}
const size = (additions: number | null, deletions: number | null, changedFiles: number | null) =>
  ({ additions, deletions, changedFiles }) as PrDiffSize

describe('compactCount — thousands abbreviate, truncating', () => {
  it('leaves anything under a thousand exact', () => {
    expect(compactCount(0)).toBe('0')
    expect(compactCount(412)).toBe('412')
    expect(compactCount(999)).toBe('999')
  })

  it('keeps one decimal below ten thousand, dropping a trailing .0', () => {
    expect(compactCount(1_000)).toBe('1k')
    expect(compactCount(1_234)).toBe('1.2k')
    expect(compactCount(9_999)).toBe('9.9k')
  })

  it('truncates rather than rounds — a size is never overstated', () => {
    expect(compactCount(1_999)).toBe('1.9k')
    expect(compactCount(48_900)).toBe('48k')
    // The boundary rounding would break: 999_999 must never read `1000k`.
    expect(compactCount(999_999)).toBe('999k')
  })

  it('switches to millions', () => {
    expect(compactCount(1_000_000)).toBe('1M')
    expect(compactCount(2_310_000)).toBe('2.3M')
    expect(compactCount(12_900_000)).toBe('12M')
  })
})

describe('formatDiffSize — the card string', () => {
  it('renders the compact string, with U+2212 as the minus sign', () => {
    expect(formatDiffSize(size(412, 38, 9), labels)).toBe('+412 −38 · 9 files')
    expect(formatDiffSize(size(412, 38, 9), labels)).toContain('−')
  })

  it('uses the singular for exactly one file', () => {
    expect(formatDiffSize(size(3, 1, 1), labels)).toBe('+3 −1 · 1 file')
    expect(formatDiffSize(size(3, 1, 2), labels)).toBe('+3 −1 · 2 files')
  })

  it('says `empty diff` for a PR GitHub measured as touching nothing', () => {
    expect(formatDiffSize(size(0, 0, 0), labels)).toBe('empty diff')
    expect(formatDiffSize(size(0, 0, 0), labels)).not.toContain('+0')
  })

  it('keeps a real zero on one side — a rename-only PR is not empty', () => {
    expect(formatDiffSize(size(0, 0, 3), labels)).toBe('+0 −0 · 3 files')
    expect(formatDiffSize(size(120, 0, 2), labels)).toBe('+120 −0 · 2 files')
  })

  it('abbreviates thousands on the chip, file count included', () => {
    expect(formatDiffSize(size(12_408, 3_120, 1_214), labels)).toBe('+12k −3.1k · 1.2k files')
  })

  it('renders exact counts when asked — the drawer row', () => {
    expect(formatDiffSize(size(12_408, 3_120, 1_214), labels, { exact: true })).toBe(
      '+12408 −3120 · 1214 files'
    )
  })

  it('renders nothing when any count is missing — never `+0 −0 · 0 files`', () => {
    expect(formatDiffSize(size(null, null, null), labels)).toBe('')
    expect(formatDiffSize(size(412, null, 9), labels)).toBe('')
    expect(formatDiffSize(size(412, 38, null), labels)).toBe('')
    expect(formatDiffSize(size(null, 0, 0), labels)).toBe('')
    // A `PrEntry` built before T280 simply lacks the fields.
    expect(formatDiffSize({} as PrDiffSize, labels)).toBe('')
  })

  it('renders nothing for a value that is not a count', () => {
    expect(formatDiffSize(size(-1, 0, 1), labels)).toBe('')
    expect(formatDiffSize(size(Number.NaN, 0, 1), labels)).toBe('')
    expect(formatDiffSize(size(1.5, 0, 1), labels)).toBe('')
  })
})

describe('DIFF_SIZE_CHIP_CLASS — the colour decision (spec §4.3)', () => {
  it('is muted: size is not a verdict, so no red and no green', () => {
    expect(DIFF_SIZE_CHIP_CLASS).toBe('bg-surface-2 text-text-3')
    expect(DIFF_SIZE_CHIP_CLASS).not.toMatch(/red|green/)
  })

  it('uses no raw colours', () => {
    expect(DIFF_SIZE_CHIP_CLASS).not.toMatch(/#[0-9a-f]{3,8}|rgb|hsl|\[/i)
  })
})

describe('diff-size messages — the plural the SFC relies on, in both locales', () => {
  // The exact call PrStackCard makes: plural index = the raw count, named `n` =
  // the count as rendered. Pins that the named value wins over vue-i18n's
  // implicit `n`, or `1.2k files` would render as `1214 files`.
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en, 'pt-BR': ptBR } })
  const t = i18n.global.t
  const files = (locale: 'en' | 'pt-BR', n: number, count: string) =>
    t('prStack.diffFiles', n, { named: { n: count }, locale })

  it('picks singular vs plural from the raw count', () => {
    expect(files('en', 1, '1')).toBe('1 file')
    expect(files('en', 9, '9')).toBe('9 files')
    expect(files('pt-BR', 1, '1')).toBe('1 arquivo')
    expect(files('pt-BR', 2, '2')).toBe('2 arquivos')
  })

  it('renders the abbreviated count, not the raw one', () => {
    expect(files('en', 1_214, '1.2k')).toBe('1.2k files')
  })

  it('translates every diff key in both locales', () => {
    for (const key of ['diff', 'diffFiles', 'emptyDiff'] as const) {
      expect(en.prStack[key]).toBeTruthy()
      expect(ptBR.prStack[key]).toBeTruthy()
    }
  })
})

describe('prMergeStateNoteKey — BLOCKED and UNSTABLE surface in the drawer', () => {
  it('names a policy block, and a failing non-required check', () => {
    expect(prMergeStateNoteKey({ mergeStateStatus: 'BLOCKED', isDraft: false })).toBe(
      'prStack.mergeBlocked'
    )
    // UNSTABLE is drawer-only: the CI chip already reads `failing N`.
    expect(prMergeStateNoteKey({ mergeStateStatus: 'UNSTABLE', isDraft: false })).toBe(
      'prStack.mergeUnstable'
    )
  })

  it('says nothing about a draft’s BLOCKED — the draft badge already explains it', () => {
    expect(prMergeStateNoteKey({ mergeStateStatus: 'BLOCKED', isDraft: true })).toBeNull()
  })

  it('adds no row for any other value', () => {
    for (const v of ALL_MERGE_STATES) {
      if (v === 'BLOCKED' || v === 'UNSTABLE') continue
      expect(prMergeStateNoteKey({ mergeStateStatus: v, isDraft: false })).toBeNull()
    }
  })

  it('is translated in both locales', () => {
    expect(inBothLocales('prStack.mergeBlocked')).toBe(true)
    expect(inBothLocales('prStack.mergeUnstable')).toBe(true)
    expect(inBothLocales('prStack.mergeState')).toBe(true)
  })
})

// ── T274: behind its base — GitHub decides, git enriches ──────────────────

describe('prBehindState — absence is never read as zero', () => {
  it('shows behind whenever GitHub says BEHIND, local branch or not', () => {
    // No local branch: the case the old chip silently dropped.
    expect(prBehindState('BEHIND', undefined)).toEqual({ kind: 'behind', count: null })
    // Local branch: the count enriches the chip.
    expect(prBehindState('BEHIND', 5)).toEqual({ kind: 'behind', count: 5 })
  })

  it('lets GitHub beat a stale local zero', () => {
    // Local `0` with GitHub saying BEHIND means this checkout's refs are
    // stale — the chip shows, without a number git got wrong.
    expect(prBehindState('BEHIND', 0)).toEqual({ kind: 'behind', count: null })
  })

  it('renders no chip for an unmeasured PR GitHub does not call BEHIND', () => {
    for (const v of ALL_MERGE_STATES) {
      if (v === 'BEHIND') continue
      const state = prBehindState(v, undefined)
      expect(state).toEqual({ kind: 'unmeasured' })
      expect(prBehindChipLabel(state)).toBeNull()
      expect(prBehindDrawerLabel(state)).toEqual({ key: 'prStack.notMeasured' })
    }
  })

  it('reads a measured zero as up to date, never as "not measured"', () => {
    expect(prBehindState('CLEAN', 0)).toEqual({ kind: 'upToDate' })
    expect(prBehindState(null, 0)).toEqual({ kind: 'upToDate' })
    expect(prBehindDrawerLabel({ kind: 'upToDate' })).toEqual({ key: 'prStack.upToDate' })
  })

  it('keeps a positive local count when GitHub is silent about BEHIND', () => {
    // GitHub reports BEHIND only under a "require up to date" rule, which a PR
    // stacked on another PR's branch never has. Hiding the count here would
    // erase the chip from every stacked PR.
    for (const v of ALL_MERGE_STATES) {
      if (v === 'BEHIND') continue
      expect(prBehindState(v, 3)).toEqual({ kind: 'behind', count: 3 })
    }
  })

  it('treats a malformed local count as unmeasured, not as a number', () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(prBehindState('CLEAN', bad)).toEqual({ kind: 'unmeasured' })
    }
  })
})

// ── Label chips (T278 / spec §4.2, §5.6) ──────────────────────────────────

describe('labelChips — opt-in, budgeted, remainder in the drawer', () => {
  const three = ['no-awareness', 'no-user-docs', 'enhancement']

  it('caps at 2 chips at full zoom', () => {
    expect(LABEL_CHIP_CAP).toBe(2)
    const out = labelChips(three, 'full', true)
    expect(out.chips).toEqual(['no-awareness', 'no-user-docs'])
    expect(out.hidden).toBe(1)
  })

  it('draws no chips below full — compact and far spend their budget elsewhere', () => {
    expect(labelChips(three, 'compact', true).chips).toEqual([])
    expect(labelChips(three, 'compact', true).hidden).toBe(0)
    expect(labelChips(three, 'far', true).chips).toEqual([])
    expect(labelChips(three, 'far', true).hidden).toBe(0)
  })

  it('puts EVERY label in the drawer — a clipped or capped chip is still findable', () => {
    // The chips are the last thing in a track that clips from the trailing
    // edge, so even a "shown" chip can fall off the card; the drawer is the
    // guarantee (spec §4.2: overflow folds into the drawer, never off the card).
    expect(labelChips(three, 'full', true).drawer).toEqual(three)
    expect(labelChips(['one'], 'full', true).drawer).toEqual(['one'])
  })

  it('counts nothing hidden when the list fits under the cap', () => {
    expect(labelChips(['a', 'b'], 'full', true)).toEqual({
      chips: ['a', 'b'],
      hidden: 0,
      drawer: ['a', 'b']
    })
  })

  it('renders nothing anywhere while the toggle is off (the default)', () => {
    for (const lod of ['full', 'compact', 'far'] as const) {
      expect(labelChips(three, lod, false)).toEqual({ chips: [], hidden: 0, drawer: [] })
    }
  })

  it('renders nothing for an empty or absent label list', () => {
    const none = { chips: [], hidden: 0, drawer: [] }
    expect(labelChips([], 'full', true)).toEqual(none)
    expect(labelChips(undefined, 'full', true)).toEqual(none)
    expect(labelChips(null, 'full', true)).toEqual(none)
    // A blank name is not a label, and must not draw an empty pill.
    expect(labelChips(['', '   '], 'full', true)).toEqual(none)
  })

  it('carries names only — nothing it returns can be a raw colour', () => {
    // `PrEntry.labels` is names only (T280); this pins that the formatter adds
    // no colour of its own on the way to the template.
    const out = labelChips(['bug', 'docs', 'ci'], 'full', true)
    for (const value of [...out.chips, ...out.drawer]) {
      expect(typeof value).toBe('string')
      expect(value).not.toMatch(/^#?[0-9a-f]{6}$/i)
    }
    expect(Object.keys(out).sort()).toEqual(['chips', 'drawer', 'hidden'])
  })

  it('translates every label string it relies on, in both locales', () => {
    for (const key of ['labels', 'labelsMore', 'labelsMoreHint'] as const) {
      expect(en.prStack[key]).toBeTruthy()
      expect(ptBR.prStack[key]).toBeTruthy()
    }
    for (const key of ['cardsEyebrow'] as const) {
      expect(en.prStack.settings[key]).toBeTruthy()
      expect(ptBR.prStack.settings[key]).toBeTruthy()
    }
    expect(en.prStack.settings.showLabels.label).toBeTruthy()
    expect(ptBR.prStack.settings.showLabels.label).toBeTruthy()
    expect(en.prStack.settings.showLabels.hint).toBeTruthy()
    expect(ptBR.prStack.settings.showLabels.hint).toBeTruthy()
  })
})

describe('prBehindChipLabel / prBehindDrawerLabel', () => {
  it('degrades the chip from "5 behind" to "behind", never to nothing', () => {
    expect(prBehindChipLabel({ kind: 'behind', count: 5 })).toEqual({
      key: 'prStack.behind',
      n: 5
    })
    expect(prBehindChipLabel({ kind: 'behind', count: null })).toEqual({
      key: 'prStack.behindBare'
    })
    expect(prBehindChipLabel({ kind: 'upToDate' })).toBeNull()
  })

  it('gives every state its own drawer sentence — up to date ≠ not measured', () => {
    const states: PrBehindState[] = [
      { kind: 'behind', count: 5 },
      { kind: 'behind', count: null },
      { kind: 'upToDate' },
      { kind: 'unmeasured' }
    ]
    const keys = states.map((s) => prBehindDrawerLabel(s).key)
    expect(new Set(keys).size).toBe(states.length)
    for (const key of keys) expect(inBothLocales(key)).toBe(true)
    expect(inBothLocales('prStack.behindBare')).toBe(true)
  })
})

// ── T274: the rendered card ───────────────────────────────────────────────

describe('PrStackCard — behind chip and the drawer rows, rendered', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function nodeWith(
    mergeStateStatus: MergeStateStatus | null,
    reviewDecision: string | null = null
  ): PrNode {
    return {
      pr: {
        number: 342,
        title: 'Status slot',
        branch: 'card/T273-pr-stack-review-verdict-chips',
        base: 'main',
        state: 'OPEN',
        isDraft: false,
        mergeable: true,
        reviewDecision,
        ci: 'passing',
        checks: [],
        url: 'https://github.com/o/r/pull/342',
        author: 'someone',
        updatedAt: null,
        headOid: null,
        nodeId: null,
        mergeStateStatus,
        additions: null,
        deletions: null,
        changedFiles: null,
        reviewRequests: [],
        labels: [],
        autoMergeRequest: null
      },
      parent: null,
      children: [],
      baseKind: 'default',
      depth: 0,
      isStagingTip: true,
      carries: 1,
      isMergeNext: false,
      chain: 0
    }
  }

  function mountCard(node: PrNode, behind: number | undefined) {
    return mount(PrStackCard, {
      props: { node, behind, lod: 'full' as const, expanded: true, moved: false, now: 0 },
      global: { plugins: [i18n] }
    })
  }

  const chip = (w: ReturnType<typeof mountCard>) => w.find('[data-test="pr-card-behind"]')
  const vsBase = (w: ReturnType<typeof mountCard>) => w.get('[data-test="pr-card-vs-base"]').text()

  it('shows a bare behind chip for a BEHIND PR whose branch is not local', () => {
    const w = mountCard(nodeWith('BEHIND'), undefined)
    expect(chip(w).text()).toBe('behind')
    expect(vsBase(w)).toBe('behind its base, per GitHub')
  })

  it('enriches it with the local count when the branch is here', () => {
    const w = mountCard(nodeWith('BEHIND'), 5)
    expect(chip(w).text()).toBe('5 behind')
    expect(vsBase(w)).toBe('5 behind its base')
  })

  it('renders no chip, and says so, when nothing could be measured', () => {
    const w = mountCard(nodeWith('CLEAN'), undefined)
    expect(chip(w).exists()).toBe(false)
    expect(vsBase(w)).toBe('could not measure locally')
  })

  it('renders no chip, and says up to date, when git measured zero', () => {
    const w = mountCard(nodeWith('CLEAN'), 0)
    expect(chip(w).exists()).toBe(false)
    expect(vsBase(w)).toBe('up to date locally')
  })

  it('puts a BLOCKED approved PR in the blocked slot and names the rule in the drawer', () => {
    const w = mountCard(nodeWith('BLOCKED', 'APPROVED'), 0)
    expect(w.get('[data-status]').attributes('data-status')).toBe('blocked')
    expect(w.get('[data-test="pr-card-merge-state"]').text()).toBe('blocked by branch protection')
  })

  it('keeps UNSTABLE out of the status slot and in the drawer', () => {
    const w = mountCard(nodeWith('UNSTABLE', 'APPROVED'), 0)
    expect(w.get('[data-status]').attributes('data-status')).toBe('approved')
    expect(w.get('[data-test="pr-card-merge-state"]').text()).toBe(
      'a non-required check is failing'
    )
  })
})

// ── The pre-existing formatters, previously untested ──────────────────────

// ── T275 / spec T272 §5.3 — unresolved review threads ─────────────────────

describe('prThreadChip — absence is not zero', () => {
  it('draws the count of unresolved, current threads', () => {
    expect(
      prThreadChip({ unresolvedThreads: 3, outdatedThreads: 4, threadsTruncated: false })
    ).toEqual({ count: '3' })
  })

  it('draws no chip when the threads could not be read', () => {
    expect(
      prThreadChip({ unresolvedThreads: null, outdatedThreads: null, threadsTruncated: false })
    ).toBeNull()
    // A payload from before the field existed must not render a count either.
    expect(prThreadChip({})).toBeNull()
  })

  it('draws no chip for a measured zero, even when outdated threads exist', () => {
    expect(
      prThreadChip({ unresolvedThreads: 0, outdatedThreads: 5, threadsTruncated: false })
    ).toBeNull()
  })

  it('marks a truncated count as a lower bound', () => {
    expect(
      prThreadChip({ unresolvedThreads: 100, outdatedThreads: 0, threadsTruncated: true })
    ).toEqual({ count: '100+' })
  })
})

describe('prThreadsDrawer — where outdated threads are broken out', () => {
  it('is null — the row is omitted — when the threads could not be read', () => {
    expect(
      prThreadsDrawer({ unresolvedThreads: null, outdatedThreads: null, threadsTruncated: false })
    ).toBeNull()
    expect(prThreadsDrawer({})).toBeNull()
  })

  it('states a measured zero, which the chip deliberately does not', () => {
    expect(
      prThreadsDrawer({ unresolvedThreads: 0, outdatedThreads: 0, threadsTruncated: false })
    ).toEqual({ unresolved: '0', outdated: null })
  })

  it('breaks outdated threads out beside the unresolved ones', () => {
    expect(
      prThreadsDrawer({ unresolvedThreads: 3, outdatedThreads: 4, threadsTruncated: false })
    ).toEqual({ unresolved: '3', outdated: '4' })
  })

  it('carries the lower-bound mark on both counts', () => {
    expect(
      prThreadsDrawer({ unresolvedThreads: 2, outdatedThreads: 98, threadsTruncated: true })
    ).toEqual({ unresolved: '2+', outdated: '98+' })
  })

  it('formats counts with the same rule as the chip', () => {
    expect(threadCountText(7, false)).toBe('7')
    expect(threadCountText(7, true)).toBe('7+')
  })
})

describe('thread copy — every key exists in both locales with its placeholders', () => {
  const keys: Array<[string, string[]]> = [
    ['unresolved', ['{n}']],
    ['threadsTitle', ['{n}']],
    ['threads', []],
    ['threadsBreakdown', ['{n}', '{outdated}']],
    ['kpisWithThreads', ['{open}', '{chains}', '{ready}', '{threads}', '{retarget}']]
  ]
  for (const [key, placeholders] of keys) {
    it(`prStack.${key}`, () => {
      for (const locale of [en, ptBR]) {
        const value = (locale.prStack as Record<string, unknown>)[key]
        expect(typeof value).toBe('string')
        for (const p of placeholders) expect(value as string).toContain(p)
      }
    })
  }

  // The card's title/aria-label picks a form by the numeric count, so a single
  // thread must not read "1 unresolved review threads".
  it('prStack.threadsTitle carries a singular and a plural form', () => {
    for (const locale of [en, ptBR]) {
      const forms = (locale.prStack.threadsTitle as string).split(' | ')
      expect(forms).toHaveLength(2)
      for (const form of forms) expect(form).toContain('{n}')
      expect(forms[0]).not.toBe(forms[1])
    }
  })
})

describe('shortAgo', () => {
  const now = Date.parse('2026-09-03T12:00:00Z')

  it('renders nothing without a timestamp', () => {
    expect(shortAgo(null, now)).toBe('')
    expect(shortAgo('not a date', now)).toBe('')
  })

  it('walks minutes → hours → days', () => {
    expect(shortAgo('2026-09-03T11:59:30Z', now)).toBe('now')
    expect(shortAgo('2026-09-03T11:48:00Z', now)).toBe('12m')
    expect(shortAgo('2026-09-03T06:00:00Z', now)).toBe('6h')
    expect(shortAgo('2026-09-01T12:00:00Z', now)).toBe('2d')
  })
})

describe('formatBytes', () => {
  it('floors at 0 MB rather than rendering a negative size', () => {
    expect(formatBytes(-1)).toBe('0 MB')
    expect(formatBytes(Number.NaN)).toBe('0 MB')
  })

  it('switches to GB past 1024 MB', () => {
    expect(formatBytes(120 * 1024 * 1024)).toBe('120 MB')
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB')
  })
})

describe('roleBarClass — the one signal that survives every zoom', () => {
  const role = { isStagingTip: false, isMergeNext: false, baseMerged: false, blocked: false }

  it('ranks blocked over every other role', () => {
    expect(roleBarClass({ ...role, blocked: true, isStagingTip: true })).toBe('bg-red')
  })

  it('falls back to the quiet border tone for a roleless PR', () => {
    expect(roleBarClass(role)).toBe('bg-border-2')
  })
})

// ── Auto-merge (T279 / spec T272 §5.7) ────────────────────────────────────

describe('autoMergeDetail — the drawer names the method and who armed it', () => {
  it('names both when GitHub reported both', () => {
    expect(autoMergeDetail({ mergeMethod: 'SQUASH', enabledBy: 'junielton' })).toEqual({
      key: 'prStack.autoMergeMethodBy',
      params: { method: 'squash', actor: '@junielton' }
    })
  })

  it('drops whichever half GitHub did not report', () => {
    expect(autoMergeDetail({ mergeMethod: 'REBASE', enabledBy: null })).toEqual({
      key: 'prStack.autoMergeMethod',
      params: { method: 'rebase' }
    })
    expect(autoMergeDetail({ mergeMethod: null, enabledBy: 'junielton' })).toEqual({
      key: 'prStack.autoMergeBy',
      params: { actor: '@junielton' }
    })
  })

  it('still says armed when neither half was readable — presence is the signal', () => {
    expect(autoMergeDetail({ mergeMethod: null, enabledBy: null })).toEqual({
      key: 'prStack.autoMergeArmed',
      params: {}
    })
  })

  it('resolves every key it can return, plus the marker and row labels, in both locales', () => {
    const leaves = [
      'autoMerge',
      'autoMergeTitle',
      'autoMergeMethodBy',
      'autoMergeMethod',
      'autoMergeBy',
      'autoMergeArmed'
    ]
    for (const leaf of leaves) {
      expect((en.prStack as Record<string, unknown>)[leaf]).toBeTruthy()
      expect((ptBR.prStack as Record<string, unknown>)[leaf]).toBeTruthy()
    }
  })
})

describe('empty state and refresh failure copy (BUG-148)', () => {
  it('names the empty state after what actually happened', () => {
    expect(prEmptyStateKind({ ghAvailable: false, ghFailure: null })).toBe('unavailable')
    expect(prEmptyStateKind({ ghAvailable: true, ghFailure: 'timeout' })).toBe('failed')
    expect(prEmptyStateKind({ ghAvailable: true, ghFailure: null })).toBe('empty')
  })

  it('a refresh that failed before any snapshot exists is "failed", never "empty"', () => {
    expect(prEmptyStateKind(null, 'other')).toBe('failed')
    expect(prEmptyStateKind(null, null)).toBe('empty')
  })

  it('never reports a transient failure as the CLI being unavailable', () => {
    for (const f of ['timeout', 'outputTooLarge', 'network', 'other'] as const) {
      expect(prEmptyStateKind({ ghAvailable: true, ghFailure: f })).not.toBe('unavailable')
    }
  })

  it('maps each failure to a title/body key pair', () => {
    expect(refreshFailureKeys('timeout')).toEqual({
      title: 'prStack.refreshFailed.timeout.title',
      body: 'prStack.refreshFailed.timeout.body'
    })
    expect(refreshFailureKeys('other').title).toBe('prStack.refreshFailed.other.title')
  })
})
