/**
 * Guided walks: the `[harnu-walk]` turns the pane sends the session (spec S-2, AC-8 and AC-47).
 *
 * Pure and Electron-free. The operator never types to drive the pane and the agent never presses its
 * buttons; the only thing that crosses from the pane to the session is one of seven user turns, each
 * naming the walk, the run and the check, so a selected session that knows nothing of the walk can act:
 *
 * ```
 * [harnu-walk] Search box on the notes list — check 3 of 9 · done
 * walk: wlk-5d2e91ab · run: run-81c0ffee (2) · check: c3 · session: <owner session id>
 * The operator pressed Done. Run the read-only check of this check, then answer with walk_report.
 * progress: ✓ 2 · ! 0 · ✗ 0 · - 7
 * ```
 *
 * Rules this module keeps (the lesson precedent, `formatLessonSummary`):
 *  - the first line carries the kind and never a score;
 *  - the glyphs are the skill's own and nothing else (no emoji): `✓ ✗ ! - ⚑ ?`;
 *  - the operator's failure line is THEIR typing and is delivered as theirs, with control characters,
 *    bidi overrides and look-alike delimiters stripped (`sanitizeUntrusted`);
 *  - only an outcome the agent must act on sends a turn: Back, Skip and a Done with nothing to check do
 *    not (D-19), and every turn carries the progress line, so the agent is never behind.
 */
import { sanitizeLabel, sanitizeUntrusted } from '../browser/emit-gate'
import { counts, type Run } from '../../shared/walk-machine'
import type { WalkScript, WalkSource } from '../../shared/walk-schema'

export const WALK_TURN_MARKER = '[harnu-walk]'

export const WALK_TURN_KINDS = [
  'done',
  'failed',
  'explain',
  'simpler',
  'treat-as-failed',
  'escalate',
  'closed'
] as const
export type WalkTurnKind = (typeof WALK_TURN_KINDS)[number]

/** What the operator can do in the pane that this slice knows how to apply to a run. */
export type OperatorOp =
  | 'start'
  | 'done'
  | 'fail'
  | 'skip'
  | 'back'
  | 'try-again'
  | 'follow-anyway'
  | 'treat-as-failed'
  | 'continue-without'
  | 'pick-skipped'
  | 'close-out-with-skipped'
  | 'end'
  | 'explain'
  | 'simpler'
  | 'escalate'

/**
 * The turn an operator outcome owes the session, or `null` when it owes none. A Done sends one only
 * when the check has an agent check; Back, Skip, Try again, Follow anyway and Continue without are the
 * operator's own movement and the next turn's progress line catches the agent up.
 */
export function turnKindFor(
  op: OperatorOp,
  check: { hasAgentCheck: boolean } | null
): WalkTurnKind | null {
  switch (op) {
    case 'done':
      return check?.hasAgentCheck ? 'done' : null
    case 'fail':
      return 'failed'
    case 'explain':
      return 'explain'
    case 'simpler':
      return 'simpler'
    case 'treat-as-failed':
      return 'treat-as-failed'
    case 'escalate':
      return 'escalate'
    default:
      return null
  }
}

// ---- Progress ---------------------------------------------------------------------------------

/** The four glyph counts of a run: verified, caveat or disagreeing, failed, and everything still open. */
export interface Progress {
  verified: number
  unverified: number
  failed: number
  open: number
}

export function progressOf(run: Run): Progress {
  const c = counts(run)
  return {
    verified: c.verified,
    unverified: c.caveat + c.disagrees,
    failed: c.failed,
    open: c.todo + c.awaiting + c.skipped
  }
}

export const progressLine = (p: Progress): string =>
  `progress: ✓ ${p.verified} · ! ${p.unverified} · ✗ ${p.failed} · - ${p.open}`

// ---- The turn ---------------------------------------------------------------------------------

export interface TurnCheck {
  id: string
  title: string
  /** The script's read-only agent check (`check.how`), or `null` when there is none. */
  how: string | null
  /** The check's fixed ordinal among the checks to walk. */
  n: number
}

export interface TurnInput {
  kind: WalkTurnKind
  walkTitle: string
  walkId: string
  runId: string
  runN: number
  /** Total checks to walk (N). */
  total: number
  sessionId: string | null
  source: WalkSource
  progress: Progress
  check?: TurnCheck
  /** `failed`: the operator's line, as they typed it. */
  line?: string
  /** `failed`: the absolute path of the screenshot Harnu saved into the run's folder. */
  shot?: string
  /** `treat-as-failed`: the agent's own evidence. */
  evidence?: string
  /** `escalate`: how many times the operator pressed Failed on this check. */
  attempts?: number
  /** `closed`: the close-out text (the pane's report). */
  closeOut?: string
}

const LINE_MAX = 500
const EVIDENCE_MAX = 500
const CLOSE_OUT_MAX = 4000

/** What the agent does for each source kind after the escalation door (D-10). */
function escalationAct(source: WalkSource): string {
  switch (source.kind) {
    case 'mission':
      return "Send a delta to this step's builder, naming the check and what the operator saw."
    case 'pr':
      return 'Draft a comment for the PR as a DRAFT only: it is outward-facing, so never post it unseen.'
    default:
      return 'Make a bug card for it with create_card.'
  }
}

const HEADLINE: Record<Exclude<WalkTurnKind, 'closed'>, string> = {
  done: 'The operator pressed Done. Run the read-only check of this check, then answer with walk_report (kind check, pass or fail, with evidence).',
  failed:
    'The operator pressed Failed. Give ONE correction with walk_report (kind correction); the same check is then served again.',
  explain:
    'The operator asked for more on this check. Answer with walk_extend: more (at most 400 characters) and extra (at most 6 sub-checks, each with its see).',
  simpler:
    'The operator did not get this step. Answer with walk_extend simpler (text of at most 240 characters, do of at most 5 items each with its see). Do not advance, and never answer "as I said above".',
  'treat-as-failed':
    'The operator treats this check as failed, with your own evidence as the symptom. Give ONE correction with walk_report (kind correction).',
  escalate: 'The operator pressed the escalation door.'
}

/** Format one `[harnu-walk]` turn. */
export function formatTurn(input: TurnInput): string {
  const title = sanitizeLabel(input.walkTitle, 120)
  const first =
    input.kind === 'closed' || !input.check
      ? `${WALK_TURN_MARKER} ${title} — closed`
      : `${WALK_TURN_MARKER} ${title} — check ${input.check.n} of ${input.total} · ${input.kind}`
  const ids = [
    `walk: ${input.walkId}`,
    `run: ${input.runId} (${input.runN})`,
    ...(input.check && input.kind !== 'closed' ? [`check: ${input.check.id}`] : []),
    `session: ${input.sessionId ?? "the folder's selected session"}`
  ].join(' · ')

  const body: string[] = []
  if (input.kind === 'closed') {
    body.push(
      'The operator ended the walk. This is the close-out they read; the pane already shows it.'
    )
    body.push('Answer in at most three lines: offer cards for what is owed, nothing else.')
    if (input.closeOut) body.push(sanitizeUntrusted(input.closeOut, CLOSE_OUT_MAX))
  } else {
    body.push(HEADLINE[input.kind])
    if (input.check) {
      body.push(`check title: ${sanitizeLabel(input.check.title, 120)}`)
      body.push(
        input.check.how
          ? `how to check: ${sanitizeLabel(input.check.how, 240)}`
          : 'how to check: nothing from here'
      )
    }
    if (input.kind === 'failed') {
      // the operator's own typing, delivered as theirs: stripped, never fenced as page data
      if (input.line) body.push(`operator's line: ${sanitizeUntrusted(input.line, LINE_MAX)}`)
      if (input.shot) body.push(`screenshot: ${input.shot}`)
    }
    if (input.kind === 'treat-as-failed' && input.evidence)
      body.push(`your evidence: ${sanitizeUntrusted(input.evidence, EVIDENCE_MAX)}`)
    if (input.kind === 'escalate') {
      body.push(`source: ${input.source.kind}`)
      if (input.attempts !== undefined) body.push(`failed ${input.attempts} times`)
      body.push(escalationAct(input.source))
      body.push('The pane created nothing; whatever follows is yours to do.')
    }
  }
  return [first, ids, ...body, progressLine(input.progress)].join('\n')
}

// ---- The close-out the session gets -----------------------------------------------------------

const HOW_WORDS: Record<string, string> = {
  'done-check': 'verified, Done plus the check',
  'done-nothing': 'verified, you confirmed, nothing to check from here',
  continued: 'caveat, you continued without the check',
  'follow-anyway': 'caveat, you followed anyway, my check disagreed',
  'pre-closed': 'verified before the walk',
  'ended-before-agent': 'caveat, ended before the agent answered'
}

/**
 * The default close-out text: a counts line and one line per check that did not pass. The pane (S-3)
 * may send its own, which is the same words; this is what the session gets when it sends none.
 */
export function closeOutText(run: Run, script: WalkScript): string {
  const c = counts(run)
  const unverified = c.caveat + c.disagrees
  const head = `${c.verified} verified · ${unverified} unverified · ${c.skipped} skipped${c.failed ? ` · ${c.failed} failed` : ''}`
  const titles = new Map(script.checks.map((k) => [k.id, k.title]))
  const lines: string[] = []
  for (const k of run.checks) {
    if (!k.countable) continue
    const t = sanitizeLabel(titles.get(k.id) ?? k.id, 120)
    if (k.state === 'verified') continue
    if (k.state === 'caveat')
      lines.push(`! ${k.id} ${t}: ${HOW_WORDS[k.closedHow ?? ''] ?? 'caveat'}`)
    else if (k.state === 'failed') lines.push(`✗ ${k.id} ${t}: failed`)
    else if (k.state === 'disagrees') lines.push(`! ${k.id} ${t}: my check disagreed`)
    else lines.push(`- ${k.id} ${t}: ${k.state === 'skipped' ? 'skipped' : 'not reached'}`)
  }
  return [head, ...lines].join('\n')
}
