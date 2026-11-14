/**
 * Missions v4 S-6 (AC-10, AC-11) — the writing contract, as code.
 *
 * The contract (spec "The writing contract") is for a reader who is tired, works across several
 * sessions and was not in the session that wrote the text: a line that looks like noise gets skipped.
 * Three layers enforce it and this module is the first: the verbs REFUSE text over a cap or breaking
 * one of five checkable rules and say why; the bundled reference and the skills teach the rest.
 * Harnu never cuts or rewrites text (D-3): a refusal carries the rule, the field and the length, and
 * no text at all, so a caller cannot mistake it for a corrected value.
 *
 * Every constant and pattern below is the spec's, and the list of words is closed: a word is added
 * only by an amendment to the spec, so honest text is not refused by a growing list. The caps and the
 * rules apply on WRITE only, never when a record is read or converted (see `model.ts`).
 *
 * Pure and Electron-free: tests import it with nothing mocked.
 */

// ---- Caps ---------------------------------------------------------------------

/**
 * Length caps, in characters. `ask` and `why` are the next-step wording (a waiting item's, and a
 * blocker's `ask` and `unblocks`); `waiting.ts` already builds its wording to the same two numbers.
 */
export const CAPS = {
  mission: 60,
  milestone: 45,
  step: 50,
  ask: 90,
  why: 60,
  criterion: 70,
  button: 16
} as const

/** The field a cap or a rule applies to. `unblocks` is a blocker's `why`. */
export type ContractField = keyof typeof CAPS | 'reason' | 'unblocks'

// ---- Rule data (the spec's, verbatim) ------------------------------------------

/** A criterion has at least this many words. */
export const CRITERION_MIN_WORDS = 3
/** A blocker `reason` has at least this many words (and one exact reference). */
export const BLOCKER_REASON_MIN_WORDS = 6

/** Internal words refused anywhere in a title, ask, why or criterion (case-insensitive). */
export const INTERNAL_WORDS = [
  'needs-human',
  'self-verified',
  'radiant',
  'declared end',
  'fixed end'
] as const

/** A milestone or step title is never only one of these. */
export const STATE_WORDS = ['in review', 'blocked', 'done', 'running', 'to do', 'driver'] as const

// ---- Results ------------------------------------------------------------------

/** Why a write was refused. */
export type ContractCode =
  | 'OVER_CAP'
  | 'TITLE_EDGE_ID'
  | 'CRITERION_TOO_SHORT'
  | 'BLOCKER_REASON_VAGUE'
  | 'INTERNAL_WORD'
  | 'STATE_WORD_TITLE'

/**
 * Accepted, or refused with the rule (`code`), the field it was applied to and a message that says
 * what to change. An over-cap refusal also names the cap and the length. A refusal never carries the
 * text: nothing was cut or corrected, and the caller writes the replacement.
 */
export type ContractResult =
  | { ok: true }
  | {
      ok: false
      code: ContractCode
      field: ContractField
      message: string
      cap?: number
      length?: number
    }

const OK: ContractResult = { ok: true }

function refuse(
  code: ContractCode,
  field: ContractField,
  message: string,
  extra: { cap?: number; length?: number } = {}
): ContractResult {
  return { ok: false, code, field, message, ...extra }
}

// ---- Helpers ------------------------------------------------------------------

/** Characters as a person counts them: a code point, not half of a surrogate pair. */
function charCount(text: string): number {
  return Array.from(text).length
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w !== '').length
}

/** The cap check: refused when over, naming the cap and the length. Never alters the text. */
function checkCap(field: keyof typeof CAPS, text: string): ContractResult {
  const cap = CAPS[field]
  const length = charCount(text)
  if (length <= cap) return OK
  return refuse(
    'OVER_CAP',
    field,
    `The ${LABEL[field]} is ${length} characters and the cap is ${cap}. Write a shorter one: Harnu never cuts text for you.`,
    { cap, length }
  )
}

const LABEL: Record<keyof typeof CAPS, string> = {
  mission: 'mission title',
  milestone: 'milestone title',
  step: 'step title',
  ask: 'ask',
  why: 'why',
  criterion: 'criterion',
  button: 'button label'
}

// ---- Rule 1: an id or number is not the start or end of a title ------------------

/** The forms the spec names: `T685`, `#256`, `PROJ-231`, `stp-3`, `mls-2`. */
const ID_TOKEN = String.raw`(?:#\d+|T\d+|[A-Z][A-Z0-9]*-\d+|(?:stp|mls)-\d+)`
const ID_AT_START = new RegExp(String.raw`^\s*\(?${ID_TOKEN}\)?(?!\w)`)
const ID_AT_END = new RegExp(String.raw`(?<![\w-])\(?${ID_TOKEN}\)?\s*$`)

/**
 * Rule 1. A title may not start with an id (`T685 E2E round`) or end with one, in parentheses or not
 * (`Load the test files (#256)`): the id goes to the side, dimmed, and the title is the name.
 */
export function checkTitleEdge(title: string, field: ContractField = 'step'): ContractResult {
  if (!ID_AT_START.test(title) && !ID_AT_END.test(title)) return OK
  return refuse(
    'TITLE_EDGE_ID',
    field,
    'A title does not start or end with an id or a number (T685, #256, PROJ-231, stp-3, mls-2). Name what it is; Harnu shows the id at the side.'
  )
}

// ---- Rule 2: a criterion has at least 3 words -------------------------------------

/** Rule 2 on its own: a criterion is a fact that is true when it is done, so it is a sentence. */
function checkCriterionLength(text: string): ContractResult {
  if (wordCount(text) >= CRITERION_MIN_WORDS) return OK
  return refuse(
    'CRITERION_TOO_SHORT',
    'criterion',
    `A criterion is a fact that is true when its step is done, in at least ${CRITERION_MIN_WORDS} words. Say what is true, for example "Every reviewer question has an answer".`
  )
}

// ---- Rule 3: a blocker reason names an exact thing ---------------------------------

/** An exact reference: each pattern is one item of the spec's list. */
const EXACT_REFERENCES: RegExp[] = [
  /(?<![\w])[A-Z][A-Z0-9_]{3,}(?![\w])/, // an ALL-CAPS name of 4 or more characters
  /`[^`\s][^`]*`/, // a backticked token
  /https?:\/\/\S+/i, // a URL
  /#\d+/, // a # number
  /"[^"\n]+"|“[^”\n]+”|(?<![\w])'[^'\n]+'(?![\w])/, // a quoted string (an apostrophe is not a quote)
  /\d/ // a number
]

/** A path: a word that contains `/`, or that ends in a file extension (`corpus.json`, `.env`). */
function hasPath(text: string): boolean {
  for (const raw of text.split(/\s+/)) {
    const word = raw.replace(/[.,;:!?)\]}'"”]+$/, '').replace(/^[([{'"“]+/, '')
    if (word === '') continue
    if (word.includes('/')) return true
    if (/^[\w-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(word) && word !== '.') return true
  }
  return false
}

function hasExactReference(text: string): boolean {
  return EXACT_REFERENCES.some((re) => re.test(text)) || hasPath(text)
}

/**
 * Rule 3. A blocker shows the exact thing needed, never a label ("Blocked on env"): at least 6 words
 * and at least one exact reference (an ALL-CAPS name of 4 or more characters, a backticked token, a
 * path, a URL, a `#` number, a quoted string, or a number).
 */
export function checkBlockerReason(reason: string): ContractResult {
  if (wordCount(reason) < BLOCKER_REASON_MIN_WORDS) {
    return refuse(
      'BLOCKER_REASON_VAGUE',
      'reason',
      `A blocker reason says the exact thing needed, in at least ${BLOCKER_REASON_MIN_WORDS} words. Say what is missing and what to do about it, not a label.`
    )
  }
  if (!hasExactReference(reason)) {
    return refuse(
      'BLOCKER_REASON_VAGUE',
      'reason',
      'A blocker reason names an exact thing: an ALL-CAPS name (HARNU_CORPUS_DIR), a `backticked` token, a path, a URL, a #number, a "quoted" string or a number.'
    )
  }
  return OK
}

// ---- Rule 4: internal words ----------------------------------------------------------

const INTERNAL_RES: Array<[string, RegExp]> = INTERNAL_WORDS.map((word) => [
  word,
  new RegExp(String.raw`(?<![\w-])${word.replace(/ /g, String.raw`\s+`)}(?![\w-])`, 'i')
])

/** Rule 4. Words of the old model that mean nothing to a reader are refused anywhere in the text. */
function checkInternalWords(field: ContractField, text: string): ContractResult {
  for (const [word, re] of INTERNAL_RES) {
    if (re.test(text)) {
      return refuse(
        'INTERNAL_WORD',
        field,
        `"${word}" is an internal word. Say it in words a reader uses, for example "A second session checked it".`
      )
    }
  }
  return OK
}

// ---- Rule 5: never only a state word -----------------------------------------------

/** Rule 5. A milestone or step title is a name, never only a state. */
function checkStateWord(field: ContractField, title: string): ContractResult {
  const plain = title.trim().replace(/\s+/g, ' ').toLowerCase()
  if (!(STATE_WORDS as readonly string[]).includes(plain)) return OK
  return refuse(
    'STATE_WORD_TITLE',
    field,
    `"${plain}" is a state, not a name. Say what the work is, for example "Review the scoring plan".`
  )
}

// ---- Entry points: what each write calls ---------------------------------------------

/** The first refusal of a list of checks, evaluated lazily and in order; accepted when none refuses. */
function firstRefusal(...checks: Array<() => ContractResult>): ContractResult {
  for (const check of checks) {
    const result = check()
    if (!result.ok) return result
  }
  return OK
}

/** A mission title: the cap, no id at either edge, no internal word. */
export function checkMissionTitle(title: string): ContractResult {
  return firstRefusal(
    () => checkCap('mission', title),
    () => checkTitleEdge(title, 'mission'),
    () => checkInternalWords('mission', title)
  )
}

/** A milestone title: the cap, no id at either edge, no internal word, never only a state word. */
export function checkMilestoneTitle(title: string): ContractResult {
  return firstRefusal(
    () => checkCap('milestone', title),
    () => checkTitleEdge(title, 'milestone'),
    () => checkInternalWords('milestone', title),
    () => checkStateWord('milestone', title)
  )
}

/** A step title: the cap, no id at either edge, no internal word, never only a state word. */
export function checkStepTitle(title: string): ContractResult {
  return firstRefusal(
    () => checkCap('step', title),
    () => checkTitleEdge(title, 'step'),
    () => checkInternalWords('step', title),
    () => checkStateWord('step', title)
  )
}

/** An acceptance criterion: the cap, at least 3 words, no internal word. */
export function checkCriterion(text: string): ContractResult {
  return firstRefusal(
    () => checkCap('criterion', text),
    () => checkCriterionLength(text),
    () => checkInternalWords('criterion', text)
  )
}

/** The `ask` of a next step or a blocker: what to do, in at most 90 characters. */
export function checkAsk(text: string): ContractResult {
  return firstRefusal(
    () => checkCap('ask', text),
    () => checkInternalWords('ask', text)
  )
}

/** The `why` of a next step: what it unlocks, in at most 60 characters. */
export function checkWhy(text: string): ContractResult {
  return firstRefusal(
    () => checkCap('why', text),
    () => checkInternalWords('why', text)
  )
}

/** A button label: the cap, and nothing else. */
export function checkButtonLabel(text: string): ContractResult {
  return checkCap('button', text)
}

/**
 * A blocker's three texts. `reason` follows rule 3; `ask` is a next-step ask (90) and `unblocks` is a
 * next-step why (60), so a refusal on either names that field. Both are optional: a blocker read from
 * an older record has neither, and a verb that requires them says so itself.
 */
export function checkBlocker(blocker: {
  reason: string
  ask?: string
  unblocks?: string
}): ContractResult {
  return firstRefusal(
    () => checkBlockerReason(blocker.reason),
    () => (blocker.ask === undefined ? OK : checkAsk(blocker.ask)),
    () => {
      if (blocker.unblocks === undefined) return OK
      const result = checkWhy(blocker.unblocks)
      return result.ok ? result : { ...result, field: 'unblocks' }
    }
  )
}
