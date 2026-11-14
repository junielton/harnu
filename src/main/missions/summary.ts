/**
 * Missions v4 S-8 (AC-19) — the mission summary, pure.
 *
 * One deterministic function from a v4 record and its Log text to the text a fresh session starts from.
 * It replaces the post-compaction Mission Brief (D-5): it is served to the leader after a compaction and
 * at the start of a hand-off. Nothing here reads a file, starts `git` or `gh`, or looks at a clock: the
 * record and the Log are the input, and the optional per-step facts are the caller's last-known values.
 *
 * Five parts, in this order, then the open criteria of the open steps and the links:
 *
 * 1. **Goal**: the title (never shortened) and the Done when.
 * 2. **Where it is**: the milestone (or step) position, the counts, each blocked step with what its
 *    blocker needs, and the steps that wait for review, by title.
 * 3. **Decided**: the last five Log entries of kind `decision`.
 * 4. **Stopped at**: per session, where it is or where it stopped and what it waited for.
 * 5. **Next step**: the first item of the v4 waiting list, with what it unlocks.
 *
 * At most {@link MISSION_SUMMARY_MAX} characters (about 2,000 tokens). The five parts are bounded by what
 * each of their lines may hold, so a record full of long old texts still keeps all five; the open
 * criteria and the links take what is left, drop WHOLE lines that do not fit, and say how many they left
 * out. A text that must be shortened ends at a sentence or a clause and says `(more in the Log)`: the
 * summary never stops in the middle of a thought. A link is never shortened: it is shown whole or not at
 * all. The record itself is never changed.
 *
 * An **open step** is one that is neither to do nor done: its criteria are what a fresh session needs to
 * finish. The Log is read the way the verbs write it: `### <time> · <kind> · <step>` headings, where a
 * heading with no kind is a plain note.
 */

import { STATE_LABELS, type MissionV4, type StepV4 } from './model'
import { deriveProgress, type MissionProgress } from './progress'
import { type StepInput } from './state'
import {
  WAITING_EMPTY_LINE,
  deriveStepResults,
  waitingListV4,
  type StepResults,
  type WaitingListV4
} from './waiting'

/** The most characters a summary may have. */
export const MISSION_SUMMARY_MAX = 8000

/** The five parts, then the open criteria and the links; each is the part's body without its heading. */
export interface MissionSummaryParts {
  goal: string
  whereItIs: string
  decided: string
  stoppedAt: string
  nextStep: string
  openCriteria: string
  links: string
}

export interface MissionSummary {
  /** The whole summary: a title line, then every part under its heading. */
  text: string
  parts: MissionSummaryParts
}

/** What a view needs beyond the record. All optional; derive `progress` and `results` once and share. */
export interface MissionSummaryInput {
  /** Per-step input facts keyed by step id (see `state.ts`); with none, states read from the record. */
  inputs?: Readonly<Record<string, StepInput>>
  /** The mission's progress, when the caller already derived it from the same inputs. */
  progress?: MissionProgress
  /** Every step's derived state, when the caller already derived it ({@link deriveStepResults}). */
  results?: StepResults
}

/** How many decisions the Decided part shows. */
const DECISION_COUNT = 5
/** What each kind of line may hold before its text is shortened at a sentence or a clause. */
const MAX = {
  doneWhen: 600,
  decision: 260,
  position: 120,
  blocker: 160,
  waitingFor: 100,
  criterion: 170,
  nextAsk: 500,
  nextWhy: 200
} as const
/** How many sessions the Stopped at part names; the earlier ones are counted in one line. */
const SESSIONS_SHOWN = 6
/** The room the blocked and waiting-for-review lists of "Where it is" may take. */
const WHERE_BLOCKED_ROOM = 650
const WHERE_REVIEW_ROOM = 500

const HEADINGS = {
  goal: '## Goal',
  whereItIs: '## Where it is',
  decided: '## Decided',
  stoppedAt: '## Stopped at',
  nextStep: '## Next step',
  openCriteria: '## Open criteria',
  links: '## Links'
} as const

const MORE_IN_LOG = ' (more in the Log)'

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * `text` on one line, kept to `max` characters. When it is longer, it ends at the last sentence that
 * fits, else the last clause, else the last word, and says `(more in the Log)`; it is never cut inside
 * a word unless it has no break at all. A text that fits is returned as written.
 */
function shorten(text: string, max: number): string {
  const t = oneLine(text)
  if (t.length <= max) return t
  const room = Math.max(0, max - MORE_IN_LOG.length)
  const head = t.slice(0, room + 1) // one past the room, to see whether a break falls exactly there
  /** The end of the last match whose end fits the room; `cutAt` picks the end of a match. */
  const lastFit = (re: RegExp, cutAt: (m: RegExpMatchArray) => number): number => {
    let at = -1
    for (const m of head.matchAll(re)) {
      const end = cutAt(m)
      if (end <= room) at = end
    }
    return at
  }
  // A sentence ends at . ! or ? (with an optional closing quote or bracket) followed by a space; a
  // clause ends before , ; or : followed by a space (the mark itself is dropped); else a word.
  let end = lastFit(/[.!?]["')\]]?(?=\s)/g, (m) => (m.index ?? 0) + m[0].length)
  if (end < 0) end = lastFit(/[,;:](?=\s)/g, (m) => m.index ?? 0)
  if (end < 0) end = head.lastIndexOf(' ') // a word
  if (end < 0) end = room // no break at all
  return `${head.slice(0, Math.min(end, room)).trimEnd()}${MORE_IN_LOG}`
}

// ---- The Log ---------------------------------------------------------------------

interface LogEntry {
  at: string
  kind: string
  stepId?: string
  text: string
}

const LOG_KINDS: ReadonlySet<string> = new Set(['note', 'decision', 'surprise'])

/** The entries of a Log body, oldest first. Text before the first `### ` heading is not an entry. */
function parseLog(log: string): LogEntry[] {
  const entries: LogEntry[] = []
  let current: (LogEntry & { lines: string[] }) | null = null
  const flush = (): void => {
    if (current) entries.push({ ...current, text: current.lines.join(' ') })
    current = null
  }
  for (const line of log.split(/\r?\n/)) {
    if (line.startsWith('### ')) {
      flush()
      const [at, ...rest] = line.slice(4).trim().split(' · ')
      const kind = rest[0] !== undefined && LOG_KINDS.has(rest[0]) ? rest[0] : 'note'
      const stepId = kind === rest[0] ? rest[1] : undefined
      current = { at: at ?? '', kind, stepId, text: '', lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  flush()
  return entries
}

// ---- Lines that fit ----------------------------------------------------------------

/** Lines added whole while they fit `budget`; what does not fit is counted in one closing line. */
function fitLines(lines: readonly string[], budget: number, noun: string): string {
  const out: string[] = []
  let used = 0
  const reserve = 48
  for (let i = 0; i < lines.length; i++) {
    const cost = lines[i].length + 1
    if (used + cost > budget - reserve) {
      const left = lines.length - i
      out.push(`…and ${left} more ${noun}${left === 1 ? '' : 's'} not shown`)
      return out.join('\n')
    }
    out.push(lines[i])
    used += cost
  }
  return out.join('\n')
}

// ---- The parts -------------------------------------------------------------------

function goalPart(m: MissionV4): string {
  return `${oneLine(m.title)}\nDone when: ${shorten(m.doneWhen, MAX.doneWhen)}`
}

function wherePart(
  m: MissionV4,
  progress: MissionProgress,
  results: StepResults,
  blockedTopLevel: readonly string[]
): string {
  const lines: string[] = []
  const unit = progress.unit === 'milestones' ? 'milestone' : 'step'
  if (progress.current) {
    const title =
      progress.unit === 'milestones'
        ? progress.milestones.find((x) => x.id === progress.current?.id)?.title
        : m.steps.find((x) => x.id === progress.current?.id)?.title
    lines.push(
      `${capitalize(unit)} ${progress.current.ordinal} of ${progress.total}${
        title ? `: ${shorten(title, MAX.position)}` : ''
      }`
    )
  } else if (progress.total > 0) {
    lines.push(`Every ${unit} is done`)
  } else {
    lines.push('Nothing is planned yet')
  }
  if (progress.total > 0)
    lines.push(
      `${progress.done} of ${progress.total} ${unit}${progress.total === 1 ? '' : 's'} done`
    )

  // Each count says what it counts: blocked is a mark on a step, so it is counted on its own.
  const c = progress.counts
  const L = STATE_LABELS
  lines.push(
    `Steps: ${c.done} ${L.done} · ${c.running} ${L.running} · ${c.waitingReview} ${L['waiting-review']} · ${c.todo} ${L.todo}` +
      (c.blocked > 0 ? ` · ${c.blocked} blocked` : '')
  )
  if (m.status === 'closed') {
    lines.push(`The mission is ${L.closed}${m.closedAs ? ` as ${m.closedAs}` : ''}`)
  } else if (progress.missionState === 'ready-to-close') {
    lines.push(capitalize(L['ready-to-close']))
  }
  if (m.closeRequested) lines.push('The session asked to close the mission')

  // What a fresh session needs to carry on: what is blocked and on what, and what waits for review.
  const blocked = [
    ...blockedTopLevel,
    ...m.steps.flatMap((step) =>
      (results[step.id]?.blockers ?? []).map(
        (b) => `- ${step.id} ${oneLine(step.title)}: ${shorten(b.ask ?? b.reason, MAX.blocker)}`
      )
    )
  ]
  if (blocked.length > 0) {
    lines.push('Blocked:', fitLines(blocked, WHERE_BLOCKED_ROOM, 'blocker'))
  }
  const reviewing = m.steps
    .filter((step) => results[step.id]?.state === 'waiting-review')
    .map((step) => `- ${oneLine(step.title)}`)
  if (reviewing.length > 0) {
    lines.push('Waiting for review:', fitLines(reviewing, WHERE_REVIEW_ROOM, 'step'))
  }
  return lines.join('\n')
}

function decidedPart(entries: readonly LogEntry[]): string {
  const decisions = entries.filter((e) => e.kind === 'decision').slice(-DECISION_COUNT)
  if (decisions.length === 0) return 'Nothing was decided yet.'
  return decisions
    .map(
      (e) =>
        `- ${e.at.slice(0, 10)}${e.stepId ? ` · ${e.stepId}` : ''}: ${shorten(e.text, MAX.decision)}`
    )
    .join('\n')
}

function stoppedPart(m: MissionV4): string {
  if (m.sessions.length === 0) return 'No session is attached.'
  const titleOf = (id: string): string => m.steps.find((s) => s.id === id)?.title ?? ''
  const rows = m.sessions.map((s) => {
    const who = `${s.id.slice(0, 8)} (${s.role === 'leads' ? 'leads the mission' : 'worked on it'})`
    if (s.to === null && !s.stoppedAt) return `- ${who}: working now`
    const at = s.stoppedAt
    const where = at?.step
      ? ` at ${at.step}${titleOf(at.step) ? ` "${shorten(titleOf(at.step), 60)}"` : ''}`
      : ''
    const waiting = at?.waitingFor ? `, waiting for ${shorten(at.waitingFor, MAX.waitingFor)}` : ''
    return `- ${who}: ${s.to === null ? 'working' : `stopped${where}`}${waiting}`
  })
  const shown = rows.slice(-SESSIONS_SHOWN)
  const left = rows.length - shown.length
  return [...(left > 0 ? [`- …and ${plural(left, 'earlier session')}`] : []), ...shown].join('\n')
}

function nextPart(list: WaitingListV4): string {
  const lines: string[] = []
  if (list.next) {
    lines.push(`${shorten(list.next.ask, MAX.nextAsk)} — ${shorten(list.next.why, MAX.nextWhy)}`)
    if (list.moreLine) lines.push(list.moreLine)
  } else {
    lines.push(WAITING_EMPTY_LINE)
  }
  if (list.peopleLine) lines.push(list.peopleLine)
  return lines.join('\n')
}

/** How a criterion gets settled, in words a fresh session can act on. */
function who(c: StepV4['acs'][number]): string {
  switch (c.by) {
    case 'fact':
      return `automatic: ${c.fact ?? 'a fact'}`
    case 'session':
      return 'a second session'
    case 'operator':
      return 'the operator'
    case 'person':
      return c.person ?? 'another person'
  }
}

const prLabel = (ref: string): string => {
  const n = /(\d+)\s*$/.exec(ref)?.[1]
  return n ? `#${n}` : ref
}

// ---- The summary -----------------------------------------------------------------

/**
 * Build the summary of a v4 mission from its record and its Log text.
 *
 * @param log the Log body of the record file (`readMissionRecordLog`); `''` for none
 */
export function buildMissionSummary(
  mission: MissionV4,
  log: string,
  opts: MissionSummaryInput = {}
): MissionSummary {
  const inputs = opts.inputs ?? {}
  const progress = opts.progress ?? deriveProgress(mission, inputs)
  const results = opts.results ?? deriveStepResults(mission, inputs)
  const list = waitingListV4(mission, { inputs, progress, results })
  const entries = parseLog(log)

  const open = mission.steps.filter((step) => {
    const state = results[step.id]?.state
    return state !== undefined && state !== 'todo' && state !== 'done'
  })

  const missionBlockers = (mission.blockers ?? []).map(
    (b) => `- The mission: ${shorten(b.ask ?? b.reason, MAX.blocker)}`
  )

  const criteria: string[] = []
  const links: string[] = []
  const seen = new Set<string>()
  const addLink = (kind: string, ref: string, stepId?: string): void => {
    const label = kind === 'pr' ? `pull request ${prLabel(ref)}` : `${kind}: ${ref}`
    const line = `- ${label}${stepId ? ` (${stepId})` : ''}`
    if (!seen.has(line)) {
      seen.add(line)
      links.push(line)
    }
  }
  for (const l of mission.links) addLink(l.kind, l.ref)
  for (const step of open) {
    const result = results[step.id]
    // A step starts at the margin; its criteria are indented under it, never trimmed.
    criteria.push(`- ${step.id} ${oneLine(step.title)}${result.blocked ? ' (blocked)' : ''}`)
    for (const c of result.open) {
      criteria.push(`  - ${shorten(c.text, MAX.criterion)} (${who(c)})`)
    }
    for (const l of step.links ?? []) addLink(l.kind, l.ref, step.id)
  }

  const head: Omit<MissionSummaryParts, 'openCriteria' | 'links'> = {
    goal: goalPart(mission),
    whereItIs: wherePart(mission, progress, results, missionBlockers),
    decided: decidedPart(entries),
    stoppedAt: stoppedPart(mission),
    nextStep: nextPart(list)
  }

  const section = (heading: string, body: string): string => `${heading}\n${body}`
  const fixed = [
    `# Mission ${mission.id}`,
    section(HEADINGS.goal, head.goal),
    section(HEADINGS.whereItIs, head.whereItIs),
    section(HEADINGS.decided, head.decided),
    section(HEADINGS.stoppedAt, head.stoppedAt),
    section(HEADINGS.nextStep, head.nextStep)
  ]
  // What is left after the five parts and the two headings still to come goes to the criteria (two
  // thirds) and the links (one third); a part that uses less leaves the rest unused: no padding.
  const overhead = HEADINGS.openCriteria.length + HEADINGS.links.length + 8
  const room = Math.max(0, MISSION_SUMMARY_MAX - fixed.join('\n\n').length - 2 * 2 - overhead)
  const linksBudget = Math.floor(room / 3)
  const criteriaBudget = room - linksBudget
  const openCriteria =
    criteria.length > 0 ? fitLines(criteria, criteriaBudget, 'line') : 'No step is open.'
  const linksPart = links.length > 0 ? fitLines(links, linksBudget, 'link') : 'No links.'

  const parts: MissionSummaryParts = { ...head, openCriteria, links: linksPart }
  let text = [
    ...fixed,
    section(HEADINGS.openCriteria, openCriteria),
    section(HEADINGS.links, linksPart)
  ].join('\n\n')
  // Only a record whose title alone is thousands of characters gets here: the cap is the contract, and
  // the title is the one thing the summary never shortens, so the last line of defence cuts the whole.
  if (text.length > MISSION_SUMMARY_MAX) text = `${text.slice(0, MISSION_SUMMARY_MAX - 1)}…`
  return { text, parts }
}

/**
 * The one-line row of a mission, for `mission_list`: its title, its progress in words, and the next
 * thing the operator must do, or the one empty line. Nothing else: no step, criterion or link.
 */
export function missionListRow(mission: MissionV4, opts: MissionSummaryInput = {}): string {
  const inputs = opts.inputs ?? {}
  const progress = opts.progress ?? deriveProgress(mission, inputs)
  const results = opts.results ?? deriveStepResults(mission, inputs)
  const list = waitingListV4(mission, { inputs, progress, results })
  const unit = progress.unit === 'milestones' ? 'milestone' : 'step'
  const words =
    mission.status === 'closed'
      ? STATE_LABELS.closed
      : progress.total > 0
        ? `${progress.done} of ${progress.total} ${unit}${progress.total === 1 ? '' : 's'} done`
        : 'nothing planned yet'
  return oneLine(`${mission.title} · ${words} · ${list.next?.ask ?? WAITING_EMPTY_LINE}`)
}
