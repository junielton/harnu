/**
 * Missions v4 · S-6 · AC-10 and AC-11 — the writing contract, as code.
 *
 * `src/main/missions/contract.ts` holds the length caps and the five checkable rules of the spec's
 * writing contract. Every write refuses text that breaks them, says which cap or rule and why, and
 * never cuts or rewrites the text (D-3). The rules table below is the spec's, row for row: each rule
 * has one bad and one good example, and the lists and patterns are the ones the table gives.
 */
import { describe, expect, it } from 'vitest'
import {
  BLOCKER_REASON_MIN_WORDS,
  CAPS,
  CRITERION_MIN_WORDS,
  INTERNAL_WORDS,
  STATE_WORDS,
  checkAsk,
  checkBlocker,
  checkBlockerReason,
  checkButtonLabel,
  checkCriterion,
  checkMilestoneTitle,
  checkMissionTitle,
  checkStepTitle,
  checkTitleEdge,
  checkWhy,
  type ContractResult
} from '../src/main/missions/contract'
import { WAITING_ASK_MAX, WAITING_WHY_MAX } from '../src/main/missions/waiting'

/** Refused with this code, or fail. */
function refusedWith(result: ContractResult, code: string): void {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.code).toBe(code)
}

describe('the caps', () => {
  it('are the spec numbers: mission 60, milestone 45, step 50, ask 90, why 60, criterion 70, button 16', () => {
    expect(CAPS).toEqual({
      mission: 60,
      milestone: 45,
      step: 50,
      ask: 90,
      why: 60,
      criterion: 70,
      button: 16
    })
  })

  it('agree with the waiting list, which already built next-step wording to the same two caps', () => {
    expect(CAPS.ask).toBe(WAITING_ASK_MAX)
    expect(CAPS.why).toBe(WAITING_WHY_MAX)
  })

  // One row per cap: how to check text for it, and a text that is fine at the cap.
  const CHECKS: Array<[string, keyof typeof CAPS, (text: string) => ContractResult]> = [
    ['mission title', 'mission', checkMissionTitle],
    ['milestone title', 'milestone', checkMilestoneTitle],
    ['step title', 'step', checkStepTitle],
    ['next-step ask', 'ask', checkAsk],
    ['next-step why', 'why', checkWhy],
    ['criterion', 'criterion', checkCriterion],
    ['button label', 'button', checkButtonLabel]
  ]

  /** `n` characters of ordinary words, no id, no listed word: honest text. */
  function words(n: number): string {
    let out = ''
    while (out.length < n) out += out === '' ? 'Alpha' : ' beta'
    return out.slice(0, n).replace(/ $/, 'x')
  }

  it('over-cap text is refused and never cut', () => {
    for (const [what, cap, check] of CHECKS) {
      const limit = CAPS[cap]
      // Exactly at the cap is fine; one more character is refused.
      const atCap = words(limit)
      expect(atCap).toHaveLength(limit)
      expect(check(atCap), `${what} at the cap`).toEqual({ ok: true })

      const over = words(limit + 1)
      const result = check(over)
      expect(result.ok, `${what} over the cap`).toBe(false)
      if (result.ok) continue
      expect(result.code).toBe('OVER_CAP')
      // The refusal names the cap and the length ...
      expect(result.cap).toBe(limit)
      expect(result.length).toBe(limit + 1)
      expect(result.message).toContain(String(limit))
      expect(result.message).toContain(String(limit + 1))
      // ... and carries no text of any kind: nothing was cut, nothing was rewritten.
      expect(Object.keys(result).sort()).toEqual([
        'cap',
        'code',
        'field',
        'length',
        'message',
        'ok'
      ])
      expect(JSON.stringify(result)).not.toContain(over.slice(0, 20))
    }

    // The same, with the spec's numbers written out here (not read from CAPS): the proof must fail if
    // a cap moves. Each is accepted at its number and refused one character past it.
    const LITERAL: Array<[(text: string) => ContractResult, number]> = [
      [checkMissionTitle, 60],
      [checkMilestoneTitle, 45],
      [checkStepTitle, 50],
      [checkAsk, 90],
      [checkWhy, 60],
      [checkCriterion, 70],
      [checkButtonLabel, 16]
    ]
    for (const [check, cap] of LITERAL) {
      expect(check(words(cap))).toEqual({ ok: true })
      const r = check(words(cap + 1))
      refusedWith(r, 'OVER_CAP')
      if (!r.ok) expect([r.cap, r.length]).toEqual([cap, cap + 1])
    }
  })

  it('count characters, not code units: a long text of emoji is measured as typed', () => {
    const atCap = '🚀'.repeat(CAPS.button)
    expect(checkButtonLabel(atCap)).toEqual({ ok: true })
    refusedWith(checkButtonLabel(atCap + '🚀'), 'OVER_CAP')
  })

  it('check the cap before any rule, so a long text is told it is long first', () => {
    // 51 characters AND a state word inside would not be a title-only state word anyway; use an id edge.
    const long = `T685 ${'a'.repeat(CAPS.step)}`
    refusedWith(checkStepTitle(long), 'OVER_CAP')
  })

  it('take a blocker as three texts: reason is a rule, ask is capped at 90, unblocks at 60', () => {
    const reason =
      'This machine does not know where HARNU_CORPUS_DIR points, so the run cannot start.'
    expect(checkBlocker({ reason, ask: words(90), unblocks: words(60) })).toEqual({ ok: true })
    const askOver = checkBlocker({ reason, ask: words(91), unblocks: 'The run starts' })
    refusedWith(askOver, 'OVER_CAP')
    if (!askOver.ok) expect(askOver.field).toBe('ask')
    const whyOver = checkBlocker({ reason, ask: 'Set the folder', unblocks: words(61) })
    refusedWith(whyOver, 'OVER_CAP')
    if (!whyOver.ok) expect(whyOver.field).toBe('unblocks')
    // ask and unblocks are optional on a blocker the model reads from an older record.
    expect(checkBlocker({ reason })).toEqual({ ok: true })
  })
})

/**
 * The spec's "Checkable rules" table, row for row. A bad example is refused with the rule's code; a
 * good example is accepted by the rule and by the entry points that apply it.
 */
describe('the checkable rules', () => {
  it('each rule refuses its bad example and accepts its good one', () => {
    // Row 1 — an id or number is not the start or end of a title.
    for (const bad of ['T685 E2E round', 'Load the test files (#256)'])
      refusedWith(checkTitleEdge(bad), 'TITLE_EDGE_ID')
    expect(checkTitleEdge('Run the tool on the whole test set')).toEqual({ ok: true })

    // Row 2 — a criterion has at least 3 words.
    for (const bad of ['Done', 'Gate green'])
      refusedWith(checkCriterion(bad), 'CRITERION_TOO_SHORT')
    expect(checkCriterion('Every reviewer question has an answer')).toEqual({ ok: true })

    // Row 3 — a blocker reason has at least 6 words and one exact reference.
    for (const bad of ['Blocked on env', 'Waiting for the thing'])
      refusedWith(checkBlockerReason(bad), 'BLOCKER_REASON_VAGUE')
    const goodReason =
      "This machine doesn't know where the private test files are. Set HARNU_CORPUS_DIR to their folder and the run starts."
    expect(checkBlockerReason(goodReason)).toEqual({ ok: true })

    // Row 4 — internal words are refused anywhere in a title, ask, why or criterion.
    const internal = 'Second pass, self-verified'
    refusedWith(checkStepTitle(internal), 'INTERNAL_WORD')
    refusedWith(checkMissionTitle(internal), 'INTERNAL_WORD')
    refusedWith(checkMilestoneTitle(internal), 'INTERNAL_WORD')
    refusedWith(checkAsk(internal), 'INTERNAL_WORD')
    refusedWith(checkWhy(internal), 'INTERNAL_WORD')
    refusedWith(checkCriterion('The second pass is self-verified'), 'INTERNAL_WORD')
    expect(checkStepTitle('A second session checked it')).toEqual({ ok: true })
    expect(checkCriterion('A second session checked it')).toEqual({ ok: true })

    // Row 5 — a milestone or step title is never only a state word.
    refusedWith(checkStepTitle('In review'), 'STATE_WORD_TITLE')
    refusedWith(checkMilestoneTitle('In review'), 'STATE_WORD_TITLE')
    expect(checkStepTitle('Review the scoring plan')).toEqual({ ok: true })
    expect(checkMilestoneTitle('Review the scoring plan')).toEqual({ ok: true })

    // The exact lists and thresholds the table gives, written out again: a list that moves fails here.
    expect([...INTERNAL_WORDS]).toEqual([
      'needs-human',
      'self-verified',
      'radiant',
      'declared end',
      'fixed end'
    ])
    expect([...STATE_WORDS]).toEqual(['in review', 'blocked', 'done', 'running', 'to do', 'driver'])
    for (const word of INTERNAL_WORDS)
      refusedWith(checkAsk(`Check the ${word} here`), 'INTERNAL_WORD')
    for (const word of STATE_WORDS) refusedWith(checkStepTitle(word), 'STATE_WORD_TITLE')
    refusedWith(checkCriterion('Two words'), 'CRITERION_TOO_SHORT')
    expect(checkCriterion('Exactly three words')).toEqual({ ok: true })
    refusedWith(checkBlockerReason('Set HARNU_CORPUS_DIR to continue now'), 'BLOCKER_REASON_VAGUE')
    expect(checkBlockerReason('Set HARNU_CORPUS_DIR to the folder now')).toEqual({ ok: true })
    refusedWith(
      checkBlockerReason('The run cannot start until you set DIR'),
      'BLOCKER_REASON_VAGUE'
    )
    expect(checkBlockerReason('The run cannot start until you set HOME')).toEqual({ ok: true })
    for (const id of ['T685', '#256', 'PROJ-231', 'stp-3', 'mls-2']) {
      refusedWith(checkTitleEdge(`${id} Load the files`), 'TITLE_EDGE_ID')
      refusedWith(checkTitleEdge(`Load the files (${id})`), 'TITLE_EDGE_ID')
    }
  })

  describe('row 1: an id or number is not the start or end of a title', () => {
    const IDS = ['T685', '#256', 'PROJ-231', 'stp-3', 'mls-2']
    it('refuses every listed form at the start of a title', () => {
      for (const id of IDS) {
        refusedWith(checkTitleEdge(`${id} Load the test files`), 'TITLE_EDGE_ID')
        refusedWith(checkTitleEdge(`(${id}) Load the test files`), 'TITLE_EDGE_ID')
      }
    })
    it('refuses every listed form at the end of a title, in parentheses or not', () => {
      for (const id of IDS) {
        refusedWith(checkTitleEdge(`Load the test files ${id}`), 'TITLE_EDGE_ID')
        refusedWith(checkTitleEdge(`Load the test files (${id})`), 'TITLE_EDGE_ID')
      }
    })
    it('does not refuse honest text that ends in a lowercase hyphenated word and a number (delta 1)', () => {
      // The pattern is case-sensitive: `utf-8` and `sha-256` are words, `stp-3` is an id.
      expect(checkTitleEdge('Save every file as utf-8')).toEqual({ ok: true })
      expect(checkTitleEdge('Hash the ids with sha-256')).toEqual({ ok: true })
      expect(checkStepTitle('Save every file as utf-8')).toEqual({ ok: true })
      expect(checkMilestoneTitle('Hash the ids with sha-256')).toEqual({ ok: true })
      expect(checkTitleEdge('utf-8 files are saved')).toEqual({ ok: true })
      // Every id shape the spec lists is still caught, lowercase `stp-3` and `mls-2` included.
      for (const id of ['T685', '#256', 'PROJ-231', 'stp-3', 'mls-2']) {
        refusedWith(checkTitleEdge(`${id} Load the files`), 'TITLE_EDGE_ID')
        refusedWith(checkTitleEdge(`Load the files (${id})`), 'TITLE_EDGE_ID')
      }
    })
    it('allows an id in the middle of a title and words that only look like one', () => {
      expect(checkTitleEdge('Merge #256 and then run the tool')).toEqual({ ok: true })
      expect(checkTitleEdge('Tools for the test set')).toEqual({ ok: true })
      expect(checkTitleEdge('Teach the T-shirt printer')).toEqual({ ok: true })
      expect(checkTitleEdge('Stop the stp-3 leak in the middle of it')).toEqual({ ok: true })
    })
    it('is part of every title entry point and of no other text', () => {
      refusedWith(checkMissionTitle('T685 Measure the spec'), 'TITLE_EDGE_ID')
      refusedWith(checkMilestoneTitle('A test set we can trust (#256)'), 'TITLE_EDGE_ID')
      refusedWith(checkStepTitle('Load the test files (#256)'), 'TITLE_EDGE_ID')
      // A criterion or an ask may end in an exact reference: that is what makes it checkable.
      expect(checkCriterion('The pull request #256 is merged')).toEqual({ ok: true })
      expect(checkAsk('Look over pull request #256')).toEqual({ ok: true })
    })
  })

  describe('row 2: a criterion has at least 3 words', () => {
    it('counts words, not characters', () => {
      expect(CRITERION_MIN_WORDS).toBe(3)
      refusedWith(checkCriterion(''), 'CRITERION_TOO_SHORT')
      refusedWith(checkCriterion('   '), 'CRITERION_TOO_SHORT')
      refusedWith(checkCriterion('Supercalifragilisticexpialidocious'), 'CRITERION_TOO_SHORT')
      refusedWith(checkCriterion('Two words'), 'CRITERION_TOO_SHORT')
      expect(checkCriterion('Exactly three words')).toEqual({ ok: true })
      expect(checkCriterion('Spaced   out   words')).toEqual({ ok: true })
    })
  })

  describe('row 3: a blocker reason has 6 words and one exact reference', () => {
    it('needs at least 6 words', () => {
      expect(BLOCKER_REASON_MIN_WORDS).toBe(6)
      // Five words, with a reference: still too short.
      refusedWith(
        checkBlockerReason('Set HARNU_CORPUS_DIR to continue now'),
        'BLOCKER_REASON_VAGUE'
      )
      expect(checkBlockerReason('Set HARNU_CORPUS_DIR to the folder now')).toEqual({ ok: true })
    })

    it('needs one exact reference, and the table lists them all', () => {
      const filler = 'The run cannot start until you set'
      const ACCEPTED: Record<string, string> = {
        'an ALL-CAPS name of 4 or more characters': `${filler} HARNU_CORPUS_DIR`,
        'a backticked token': `${filler} \`corpus_dir\` first`,
        'a path with a slash': `${filler} the folder at docs/corpus`,
        'a path with a file extension': `${filler} the file corpus.json`,
        'a URL': `${filler} up http://localhost:5173/report`,
        'a # number': `${filler} up pull request #256`,
        'a double-quoted string': `${filler} the field "corpus dir"`,
        'a curly-quoted string': `${filler} the field “corpus dir”`,
        'a single-quoted string': `${filler} the field 'corpus dir' first`,
        'a number': `${filler} up 12 test files`
      }
      for (const [what, text] of Object.entries(ACCEPTED))
        expect(checkBlockerReason(text), what).toEqual({ ok: true })

      const REFUSED: Record<string, string> = {
        'no reference at all': 'The run cannot start until you set the folder',
        'an ALL-CAPS word of 3 characters': 'The run cannot start until you set the DIR',
        'an apostrophe is not a quoted string':
          "This machine doesn't know where the files are stored",
        'a sentence-ending period is not an extension':
          'The run cannot start until you set the folder.'
      }
      for (const text of Object.values(REFUSED))
        refusedWith(checkBlockerReason(text), 'BLOCKER_REASON_VAGUE')
    })

    it('says what is missing: how many words, or which reference', () => {
      const short = checkBlockerReason('Blocked on env')
      const vague = checkBlockerReason('The run cannot start until you set the folder')
      expect(!short.ok && short.message).toMatch(/6 words/)
      expect(!vague.ok && vague.message).toMatch(/exact/)
    })
  })

  describe('row 4: internal words are refused anywhere in a title, ask, why or criterion', () => {
    it('is exactly this list', () => {
      expect([...INTERNAL_WORDS]).toEqual([
        'needs-human',
        'self-verified',
        'radiant',
        'declared end',
        'fixed end'
      ])
    })
    it('matches each word case-insensitively, as a whole word', () => {
      for (const word of INTERNAL_WORDS) {
        for (const text of [
          `The step is ${word}`,
          `${word.toUpperCase()} comes first`,
          `A ${word[0].toUpperCase()}${word.slice(1)}, then more`
        ])
          refusedWith(checkAsk(text), 'INTERNAL_WORD')
      }
      expect(checkAsk('Ask the declared ending of the run')).toEqual({ ok: true })
      expect(checkAsk('Fix the irradiant glow')).toEqual({ ok: true })
      expect(checkAsk('Move the fixed endpoint')).toEqual({ ok: true })
    })
    it('allows a space or several between the two words of a phrase', () => {
      refusedWith(checkWhy('Update the declared   end'), 'INTERNAL_WORD')
    })
    it('names the word it refused', () => {
      const r = checkCriterion('The fixed end is verified here')
      expect(!r.ok && r.message).toContain('fixed end')
    })
  })

  describe('row 5: a milestone or step title is never only a state word', () => {
    it('is exactly this list', () => {
      expect([...STATE_WORDS]).toEqual([
        'in review',
        'blocked',
        'done',
        'running',
        'to do',
        'driver'
      ])
    })
    it('refuses a title that is only one of them, in any case and spacing', () => {
      for (const word of STATE_WORDS) {
        refusedWith(checkStepTitle(word), 'STATE_WORD_TITLE')
        refusedWith(checkMilestoneTitle(word.toUpperCase()), 'STATE_WORD_TITLE')
        refusedWith(checkStepTitle(`  ${word}  `), 'STATE_WORD_TITLE')
      }
      refusedWith(checkStepTitle('In   review'), 'STATE_WORD_TITLE')
    })
    it('allows a title that merely contains one, and a mission title of one', () => {
      expect(checkStepTitle('Review what is blocked')).toEqual({ ok: true })
      expect(checkStepTitle('Mark the work done')).toEqual({ ok: true })
      // The rule is for milestone and step titles; the table does not give it to the mission.
      expect(checkMissionTitle('Done')).toEqual({ ok: true })
    })
  })

  it('apply nothing else: the list is closed', () => {
    // Words a reader might expect to be banned are not, until an amendment to the spec adds them.
    expect(checkStepTitle('Verifier gate for the sign-off')).toEqual({ ok: true })
    expect(checkStepTitle('Blocked until the key arrives')).toEqual({ ok: true })
    expect(checkMilestoneTitle('The driver for the printer works')).toEqual({ ok: true })
  })
})

describe('what a refusal looks like', () => {
  it('names the rule, the field and a way out, and never carries the text', () => {
    const r = checkStepTitle('T685 E2E round')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('TITLE_EDGE_ID')
    expect(r.field).toBe('step')
    expect(r.message.length).toBeGreaterThan(20)
    expect(Object.keys(r)).not.toContain('text')
  })
})
