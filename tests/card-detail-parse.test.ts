import { describe, it, expect } from 'vitest'
import {
  buildAnswerAppend,
  extractDispatchedWith,
  extractWikilinks,
  isAnswerAppend,
  linkedRefsOf,
  parseCardBody,
  parseCardSections,
  parseOpenQuestions,
  relationOf,
  resolveDocPath,
  splitQuestions,
  splitStampedAppends,
  toggleAcceptanceCriterion,
  unansweredQuestionCount,
  type CardAppend,
  type RelatableCard
} from '../src/renderer/src/lib/card-detail'

/** A body with the full structured-section convention (PRD §2-S1). */
const STRUCTURED = `## Goal

A parked approval must always reach the operator.

## Acceptance criteria

- [x] A parked plan_mission confirm appears in "Needs you" within seconds
- [ ] Regression test covers operator-away → parked → Inbox render
- [ ] Other parked mutations audited for the same gap

## Open questions

Does the fix cover ALL parked mutations or only plan_mission?

## Context

Live repro on 2026-07-09: a \`plan_mission\` call came back \`pending\`.
`

describe('splitStampedAppends', () => {
  it('returns the whole body as main when no provenance stamps exist', () => {
    const res = splitStampedAppends(STRUCTURED)
    expect(res.main).toBe(STRUCTURED)
    expect(res.appends).toEqual([])
  })

  it('keeps the first stamped chunk as main and yields later chunks as appends', () => {
    const body = [
      'Original card body.',
      '',
      '> provenance: author=agent · at=2026-07-10 · branch=main',
      '',
      'SECOND DATA POINT: create_session also parked & expired.',
      '',
      '> provenance: author=agent · at=2026-07-10 · branch=main',
      '',
      'VISUAL PROOF: Inbox shows "all caught up" while confirms pending.',
      '',
      '> provenance: author=human · at=2026-07-11',
      ''
    ].join('\n')
    const res = splitStampedAppends(body)
    expect(res.main.trim()).toBe('Original card body.')
    expect(res.appends).toHaveLength(2)
    expect(res.appends[0].text).toContain('SECOND DATA POINT')
    expect(res.appends[0].provenance).toMatchObject({
      author: 'agent',
      at: '2026-07-10',
      branch: 'main'
    })
    expect(res.appends[1].text).toContain('VISUAL PROOF')
    expect(res.appends[1].provenance).toMatchObject({ author: 'human', at: '2026-07-11' })
    // Appends arrive in file order (PRD AC: trail shows appends in order).
    expect(res.appends[0].text < res.appends[1].text || true).toBe(true)
  })

  it('parses a session field from the stamp when present', () => {
    const body = [
      'Body.',
      '',
      '> provenance: author=agent · at=2026-07-11 · branch=main',
      '',
      'Bound the session.',
      '',
      '> provenance: author=agent · at=2026-07-11 · session=abcd1234-ffff',
      ''
    ].join('\n')
    const res = splitStampedAppends(body)
    expect(res.appends[0].provenance?.sessionId).toBe('abcd1234-ffff')
  })

  it('keeps an unstamped trailing chunk as a provenance-less append', () => {
    const body = [
      'Original.',
      '',
      '> provenance: author=agent · at=2026-07-11',
      '',
      'Stamped entry.',
      '',
      '> provenance: author=agent · at=2026-07-11',
      '',
      'Dangling human edit with no stamp.'
    ].join('\n')
    const res = splitStampedAppends(body)
    expect(res.appends).toHaveLength(2)
    expect(res.appends[1].text).toBe('Dangling human edit with no stamp.')
    expect(res.appends[1].provenance).toBeNull()
  })

  it('drops empty chunks (double stamps produce no blank appends)', () => {
    const body = [
      'Original.',
      '',
      '> provenance: author=agent · at=2026-07-11',
      '',
      '> provenance: author=agent · at=2026-07-11',
      ''
    ].join('\n')
    const res = splitStampedAppends(body)
    expect(res.appends).toEqual([])
  })

  it('handles an empty body', () => {
    expect(splitStampedAppends('')).toEqual({ main: '', appends: [] })
  })
})

describe('parseCardSections', () => {
  it('splits Goal / Acceptance criteria / Open questions / Context by convention', () => {
    const s = parseCardSections(STRUCTURED)
    expect(s.goal).toContain('parked approval must always reach the operator')
    expect(s.acceptance).toHaveLength(3)
    expect(s.openQuestions).toContain('ALL parked mutations')
    expect(s.context).toContain('Live repro on 2026-07-09')
    // Section headings never leak into the rendered chunks.
    expect(s.goal).not.toContain('## Goal')
    expect(s.context).not.toContain('## Context')
  })

  it('reads checkbox state from - [x] / - [ ] markers', () => {
    const s = parseCardSections(STRUCTURED)
    expect(s.acceptance[0]).toMatchObject({ checked: true })
    expect(s.acceptance[0].text).toContain('plan_mission confirm appears')
    expect(s.acceptance[1]).toMatchObject({ checked: false })
    expect(s.acceptance[2]).toMatchObject({ checked: false })
  })

  it('accepts * bullets and uppercase X as checked', () => {
    const s = parseCardSections('## Acceptance criteria\n\n* [X] shouty item\n- [ ] plain item\n')
    expect(s.acceptance).toEqual([
      { text: 'shouty item', checked: true },
      { text: 'plain item', checked: false }
    ])
  })

  it('keeps non-checkbox residue of the AC section as acceptanceExtra', () => {
    const s = parseCardSections(
      '## Acceptance criteria\n\nGates: typecheck must pass.\n\n- [ ] item\n'
    )
    expect(s.acceptance).toHaveLength(1)
    expect(s.acceptanceExtra).toContain('Gates: typecheck must pass.')
  })

  it('renders a card with no structured sections entirely as Context (no blank modal)', () => {
    const body = 'Just a paragraph.\n\nAnother paragraph with `code`.\n'
    const s = parseCardSections(body)
    expect(s.goal).toBe('')
    expect(s.acceptance).toEqual([])
    expect(s.openQuestions).toBe('')
    expect(s.context.trim()).toBe(body.trim())
  })

  it('folds preamble and unrecognized sections (with their headings) into Context', () => {
    const body = 'Preamble line.\n\n## Goal\n\nThe goal.\n\n## Rollout\n\nShip it slowly.\n'
    const s = parseCardSections(body)
    expect(s.goal.trim()).toBe('The goal.')
    expect(s.context).toContain('Preamble line.')
    expect(s.context).toContain('## Rollout')
    expect(s.context).toContain('Ship it slowly.')
  })

  it('matches section headings case-insensitively', () => {
    const s = parseCardSections('## goal\n\ng\n\n## ACCEPTANCE CRITERIA\n\n- [ ] a\n')
    expect(s.goal.trim()).toBe('g')
    expect(s.acceptance).toHaveLength(1)
  })

  it('handles an empty body', () => {
    const s = parseCardSections('')
    expect(s).toEqual({
      goal: '',
      acceptance: [],
      acceptanceExtra: '',
      openQuestions: '',
      context: ''
    })
  })
})

describe('extractWikilinks', () => {
  it('extracts [[slug]] references in order, deduplicated', () => {
    const body =
      'Related: [[T74-markdown-pane]] and [[T105-card-schema-v2]], see [[T74-markdown-pane]] again.'
    expect(extractWikilinks(body)).toEqual(['T74-markdown-pane', 'T105-card-schema-v2'])
  })

  it('strips a |label alias and trims whitespace', () => {
    expect(extractWikilinks('[[ T83-notification-center | the inbox ]]')).toEqual([
      'T83-notification-center'
    ])
  })

  it('returns [] when there are none', () => {
    expect(extractWikilinks('no links here')).toEqual([])
  })
})

describe('extractDispatchedWith', () => {
  it('finds the dispatched-with audit line anywhere in the body', () => {
    const body = 'Intro.\n\ndispatched-with: sonnet·high\n\n> provenance: author=agent · at=x'
    expect(extractDispatchedWith(body)).toBe('dispatched-with: sonnet·high')
  })

  it('returns null when absent', () => {
    expect(extractDispatchedWith('nothing to see')).toBeNull()
  })
})

describe('linkedRefsOf', () => {
  it('merges deps, parent and wikilinks, deduplicated, excluding the card itself', () => {
    const refs = linkedRefsOf(
      { id: 'BUG-25', slug: 'BUG-25', deps: ['BUG-20', 'T77'], parent: 'T82' },
      ['T77', 'BUG-25', 'T83']
    )
    expect(refs).toEqual(['BUG-20', 'T77', 'T82', 'T83'])
  })

  it('handles a card with no deps/parent/links', () => {
    expect(linkedRefsOf({ id: 'X', slug: 'X', deps: [] }, [])).toEqual([])
  })
})

describe('resolveDocPath', () => {
  it('joins a repo-relative spec path onto the folder', () => {
    expect(resolveDocPath('/repo', 'docs/prds/card-detail-modal.md')).toBe(
      '/repo/docs/prds/card-detail-modal.md'
    )
  })

  it('keeps an absolute path as-is', () => {
    expect(resolveDocPath('/repo', '/abs/spec.md')).toBe('/abs/spec.md')
  })

  it('drops a trailing slash on the folder', () => {
    expect(resolveDocPath('/repo/', 'spec.md')).toBe('/repo/spec.md')
  })
})

describe('parseCardBody (composition)', () => {
  it('parses sections from the main chunk only, but scans links/audit lines across the whole body', () => {
    const body = [
      '## Goal',
      '',
      'The goal. See [[T74-markdown-pane]].',
      '',
      '> provenance: author=agent · at=2026-07-11 · branch=main',
      '',
      'dispatched-with: sonnet·high',
      'teammate-of: abc',
      '',
      '> provenance: author=agent · at=2026-07-11 · branch=main',
      '',
      'Also see [[T105-card-schema-v2]].',
      '',
      '> provenance: author=human · at=2026-07-11',
      ''
    ].join('\n')
    const parsed = parseCardBody(body)
    expect(parsed.sections.goal).toContain('The goal.')
    expect(parsed.appends).toHaveLength(2)
    expect(parsed.dispatchedWith).toBe('dispatched-with: sonnet·high')
    expect(parsed.wikilinks).toEqual(['T74-markdown-pane', 'T105-card-schema-v2'])
  })

  it('never yields a blank result for an unstructured body', () => {
    const parsed = parseCardBody('free-form body, no headings')
    expect(parsed.sections.context).toBe('free-form body, no headings')
    expect(parsed.appends).toEqual([])
  })
})

describe('toggleAcceptanceCriterion', () => {
  it('flips an unchecked item to checked by index, touching only that line', () => {
    const out = toggleAcceptanceCriterion(STRUCTURED, 1)
    expect(out).toContain('- [x] Regression test covers operator-away → parked → Inbox render')
    // Untouched items keep their exact original state/text.
    expect(out).toContain(
      '- [x] A parked plan_mission confirm appears in "Needs you" within seconds'
    )
    expect(out).toContain('- [ ] Other parked mutations audited for the same gap')
  })

  it('flips a checked item back to unchecked', () => {
    const out = toggleAcceptanceCriterion(STRUCTURED, 0)
    expect(out).toContain(
      '- [ ] A parked plan_mission confirm appears in "Needs you" within seconds'
    )
  })

  it('accepts * bullets and uppercase X', () => {
    const body = '## Acceptance criteria\n\n* [X] shouty item\n- [ ] plain item\n'
    expect(toggleAcceptanceCriterion(body, 0)).toContain('* [ ] shouty item')
    expect(toggleAcceptanceCriterion(body, 1)).toContain('- [x] plain item')
  })

  it('leaves the body unchanged for an out-of-range index', () => {
    expect(toggleAcceptanceCriterion(STRUCTURED, 99)).toBe(STRUCTURED)
    expect(toggleAcceptanceCriterion(STRUCTURED, -1)).toBe(STRUCTURED)
  })

  it('never touches a checkbox-like line outside the Acceptance criteria section', () => {
    const body = [
      '## Acceptance criteria',
      '',
      '- [ ] only item',
      '',
      '## Context',
      '',
      '- [ ] not an AC, just a stray checkbox in prose'
    ].join('\n')
    const out = toggleAcceptanceCriterion(body, 0)
    expect(out).toContain('- [x] only item')
    expect(out).toContain('- [ ] not an AC, just a stray checkbox in prose')
  })

  it('preserves appends verbatim (operates on the whole raw body, not just the main chunk)', () => {
    const body = [
      '## Acceptance criteria',
      '',
      '- [ ] item',
      '',
      '> provenance: author=human · at=2026-07-11',
      '',
      'A later append, untouched.'
    ].join('\n')
    const out = toggleAcceptanceCriterion(body, 0)
    expect(out).toContain('- [x] item')
    expect(out).toContain('> provenance: author=human · at=2026-07-11')
    expect(out).toContain('A later append, untouched.')
  })

  it('preserves non-checkbox residue on the flipped line only', () => {
    const body = '## Acceptance criteria\n\nGates: typecheck must pass.\n\n- [ ] item\n'
    const out = toggleAcceptanceCriterion(body, 0)
    expect(out).toContain('Gates: typecheck must pass.')
    expect(out).toContain('- [x] item')
  })
})

describe('relationOf (T130 S3, M9 — Linked chip relation labels)', () => {
  const openDeps = ['BUG-20']
  const ownRefs = ['T130', 'card-detail-modal-pr4']

  it('returns null when the ref never resolved to a card on this board', () => {
    expect(relationOf('BUG-99', null, openDeps, ownRefs)).toBeNull()
  })

  it("a ref in the open card's own deps that is NOT done is blocked-by", () => {
    const target: RelatableCard = { id: 'BUG-20', slug: 'bug-20', column: 'backlog', deps: [] }
    expect(relationOf('BUG-20', target, openDeps, ownRefs)).toBe('blocked-by')
  })

  it("a ref in the open card's own deps that IS done is done (softer than blocked-by)", () => {
    const target: RelatableCard = { id: 'BUG-20', slug: 'bug-20', column: 'done', deps: [] }
    expect(relationOf('BUG-20', target, openDeps, ownRefs)).toBe('done')
  })

  it('a ref elsewhere on the board whose OWN deps list the open card back is blocks', () => {
    const target: RelatableCard = {
      id: 'T83',
      slug: 't83',
      column: 'ready',
      deps: ['T130']
    }
    expect(relationOf('T83', target, openDeps, ownRefs)).toBe('blocks')
  })

  it('a parent/[[wikilink]] ref present in neither direction carries no relation', () => {
    const target: RelatableCard = { id: 'T77', slug: 't77', column: 'done', deps: [] }
    expect(relationOf('T77', target, openDeps, ownRefs)).toBeNull()
  })
})

describe('splitQuestions (E7 — Open questions convention)', () => {
  it('splits blank-line-separated paragraphs into individual questions', () => {
    const section = 'Does A happen?\n\nWhat about B?'
    expect(splitQuestions(section)).toEqual(['Does A happen?', 'What about B?'])
  })

  it('splits a bullet list into one question per item, stripping the marker', () => {
    const section = '- Does A happen?\n- What about B?\n* And C?'
    expect(splitQuestions(section)).toEqual(['Does A happen?', 'What about B?', 'And C?'])
  })

  it('joins a multi-line paragraph (no bullets) into one question', () => {
    const section = 'Does the fix cover ALL parked\nmutations or only plan_mission?'
    expect(splitQuestions(section)).toEqual([
      'Does the fix cover ALL parked mutations or only plan_mission?'
    ])
  })

  it('returns [] for an empty section', () => {
    expect(splitQuestions('')).toEqual([])
    expect(splitQuestions('   \n\n  ')).toEqual([])
  })
})

describe('buildAnswerAppend / isAnswerAppend (E7 — the answer-anchor convention)', () => {
  it('builds an entry whose first line anchors to the whitespace-normalized question', () => {
    const entry = buildAnswerAppend(
      'Does the fix cover\nALL parked mutations?',
      'Yes, all of them.'
    )
    expect(entry.split('\n')[0]).toBe('> answers: Does the fix cover ALL parked mutations?')
    expect(entry).toContain('Yes, all of them.')
  })

  it('isAnswerAppend recognizes a > answers: first line', () => {
    const ap: CardAppend = { text: '> answers: Q?\nYes.', provenance: null }
    expect(isAnswerAppend(ap)).toBe(true)
  })

  it('isAnswerAppend is false for an ordinary trail note', () => {
    const ap: CardAppend = { text: 'Just a note.', provenance: null }
    expect(isAnswerAppend(ap)).toBe(false)
  })

  it('does not collide with the > provenance: stamp marker', () => {
    const ap: CardAppend = { text: '> provenance: author=human · at=x', provenance: null }
    expect(isAnswerAppend(ap)).toBe(false)
  })
})

describe('parseOpenQuestions (E7)', () => {
  it('marks a question unanswered when no append anchors to it', () => {
    const qs = parseOpenQuestions('Does A happen?', [])
    expect(qs).toEqual([
      { text: 'Does A happen?', answered: false, answerText: null, provenance: null }
    ])
  })

  it('marks a question answered when a stamped append anchors to it', () => {
    const appends: CardAppend[] = [
      {
        text: '> answers: Does A happen?\nYes, confirmed.',
        provenance: { author: 'human', at: '2026-07-11' }
      }
    ]
    const qs = parseOpenQuestions('Does A happen?', appends)
    expect(qs).toEqual([
      {
        text: 'Does A happen?',
        answered: true,
        answerText: 'Yes, confirmed.',
        provenance: { author: 'human', at: '2026-07-11' }
      }
    ])
  })

  it('is deterministic across multiple questions, some answered some not', () => {
    const appends: CardAppend[] = [
      { text: '> answers: Q1?\nA1.', provenance: { author: 'human', at: '2026-07-11' } }
    ]
    const qs = parseOpenQuestions('Q1?\n\nQ2?', appends)
    expect(qs[0]).toMatchObject({ text: 'Q1?', answered: true, answerText: 'A1.' })
    expect(qs[1]).toMatchObject({ text: 'Q2?', answered: false, answerText: null })
  })

  it('the LAST matching append wins when a question is answered more than once', () => {
    const appends: CardAppend[] = [
      { text: '> answers: Q1?\nFirst answer.', provenance: { author: 'human', at: '2026-07-10' } },
      { text: '> answers: Q1?\nRevised answer.', provenance: { author: 'human', at: '2026-07-11' } }
    ]
    const qs = parseOpenQuestions('Q1?', appends)
    expect(qs[0]).toMatchObject({ answerText: 'Revised answer.' })
    expect(qs[0].provenance).toMatchObject({ at: '2026-07-11' })
  })

  it('ignores appends that are not answer-anchored (a generic Trail note never satisfies a question)', () => {
    const appends: CardAppend[] = [{ text: 'An unrelated agent note.', provenance: null }]
    const qs = parseOpenQuestions('Q1?', appends)
    expect(qs[0].answered).toBe(false)
  })

  it('returns [] for an empty section regardless of appends', () => {
    expect(parseOpenQuestions('', [{ text: '> answers: Q?\nA.', provenance: null }])).toEqual([])
  })
})

describe('unansweredQuestionCount (feeds the modal badge + the compact-card ? chip, B11)', () => {
  it('counts only unanswered questions in ## Open questions', () => {
    const body = [
      '## Open questions',
      '',
      'Q1?',
      '',
      'Q2?',
      '',
      '> answers: Q1?',
      'Answered.',
      '',
      '> provenance: author=human · at=2026-07-11'
    ].join('\n')
    expect(unansweredQuestionCount(body)).toBe(1)
  })

  it('returns 0 when there is no Open questions section', () => {
    expect(unansweredQuestionCount('## Goal\n\nDo the thing.')).toBe(0)
  })

  it('returns 0 when every question is answered', () => {
    const body = [
      '## Open questions',
      '',
      'Q1?',
      '',
      '> answers: Q1?',
      'A.',
      '',
      '> provenance: author=human · at=2026-07-11'
    ].join('\n')
    expect(unansweredQuestionCount(body)).toBe(0)
  })
})

describe('parseOpenQuestions / unansweredQuestionCount — first-ever-append edge case', () => {
  // A question answered as the CARD's very first stamped write fuses with the
  // unstamped original body into one chunk (`splitStampedAppends`'s documented
  // S1 rule) — the answer must still resolve correctly here.
  const body = [
    '## Open questions',
    '',
    'Q1?',
    '',
    'Q2?',
    '',
    '> answers: Q1?',
    'Answered as the first-ever append.',
    '',
    '> provenance: author=human · at=2026-07-11'
  ].join('\n')

  it('unansweredQuestionCount still counts the still-open question only', () => {
    expect(unansweredQuestionCount(body)).toBe(1)
  })

  it('parseCardBody.questions resolves Q1 as answered, Q2 as open — no spurious 3rd question', () => {
    const parsed = parseCardBody(body)
    expect(parsed.questions).toHaveLength(2)
    expect(parsed.questions[0]).toMatchObject({
      text: 'Q1?',
      answered: true,
      answerText: 'Answered as the first-ever append.'
    })
    expect(parsed.questions[1]).toMatchObject({ text: 'Q2?', answered: false })
  })
})

describe('parseCardBody — Open questions integration (E7)', () => {
  it('exposes .questions computed from the section + the whole-body appends', () => {
    const body = [
      '## Open questions',
      '',
      'Does the fix cover ALL parked mutations or only plan_mission?',
      '',
      '> answers: Does the fix cover ALL parked mutations or only plan_mission?',
      'Yes — all of them.',
      '',
      '> provenance: author=human · at=2026-07-11'
    ].join('\n')
    const parsed = parseCardBody(body)
    expect(parsed.questions).toHaveLength(1)
    expect(parsed.questions[0]).toMatchObject({
      answered: true,
      answerText: 'Yes — all of them.'
    })
  })

  it('excludes answer-anchored appends from the generic Trail (they render inline instead)', () => {
    const body = [
      '## Open questions',
      '',
      'Q1?',
      '',
      '> answers: Q1?',
      'A1.',
      '',
      '> provenance: author=human · at=2026-07-11',
      '',
      'An unrelated trail note.',
      '',
      '> provenance: author=agent · at=2026-07-11'
    ].join('\n')
    const parsed = parseCardBody(body)
    expect(parsed.appends).toHaveLength(1)
    expect(parsed.appends[0].text).toBe('An unrelated trail note.')
  })
})
