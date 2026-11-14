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
 * 1. **Goal**: the title and the Done when.
 * 2. **Where it is**: the milestone (or step) position and the four counts.
 * 3. **Decided**: the last five Log entries of kind `decision`.
 * 4. **Stopped at**: per session, where it is or where it stopped and what it waited for.
 * 5. **Next step**: the first item of the v4 waiting list, with what it unlocks.
 *
 * At most {@link MISSION_SUMMARY_MAX} characters (about 2,000 tokens). Each of the five parts has its own
 * budget, so a record full of long old texts still keeps all five; the open criteria and the links take
 * what is left and say how many they left out. The summary is a cold-start read, so unlike the waiting
 * list it does clip: the cap is the contract, and the record itself is never changed.
 *
 * An **open step** is one that is neither to do nor done: its criteria are what a fresh session needs to
 * finish. The Log is read the way the verbs write it: `### <time> · <kind> · <step>` headings, where a
 * heading with no kind is a plain note.
 */

import type { AttachRequest, MissionV4, StepV4 } from './model'
import { deriveProgress } from './progress'
import { deriveStepState, type StepInput } from './state'
import { waitingListV4 } from './waiting'

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

export interface MissionSummaryInput {
  /** Per-step input facts keyed by step id (see `state.ts`); with none, states read from the record. */
  inputs?: Readonly<Record<string, StepInput>>
  /** Attach requests; a pending one for this mission can be the next step. */
  attachRequests?: readonly AttachRequest[]
}

/** The budget of each of the five parts, in characters. The rest of the cap is for criteria and links. */
const BUDGET = { goal: 950, whereItIs: 900, decided: 1500, stoppedAt: 1400, nextStep: 900 } as const
/** How many decisions the Decided part shows. */
const DECIDED_COUNT = 5
const DECISION_TEXT_MAX = 260
const LINE_MAX = 200
const SESSIONS_SHOWN = 6

const HEADINGS = {
  goal: '## Goal',
  whereItIs: '## Where it is',
  decided: '## Decided',
  stoppedAt: '## Stopped at',
  nextStep: '## Next step',
  openCriteria: '## Open criteria',
  links: '## Links'
} as const

/** `s` on one line, cut to `max` characters with an ellipsis when it was cut. */
function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1))}…`
}

/** A block kept to `max` characters, cutting on a line break where it can. */
function clipBlock(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, Math.max(0, max - 1))
  const nl = cut.lastIndexOf('\n')
  return `${nl > max / 2 ? cut.slice(0, nl) : cut}…`
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

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

// ---- The parts -------------------------------------------------------------------

function goalPart(m: MissionV4): string {
  return `${clip(m.title, 300)}\nDone when: ${clip(m.doneWhen, 600)}`
}

function wherePart(m: MissionV4, progress: ReturnType<typeof deriveProgress>): string {
  const lines: string[] = []
  const unit = progress.unit === 'milestones' ? 'milestone' : 'step'
  if (progress.current) {
    const title =
      progress.unit === 'milestones'
        ? progress.milestones.find((x) => x.id === progress.current?.id)?.title
        : m.steps.find((x) => x.id === progress.current?.id)?.title
    const label = unit === 'milestone' ? 'Milestone' : 'Step'
    lines.push(
      `${label} ${progress.current.ordinal} of ${progress.total}${title ? `: ${clip(title, 120)}` : ''}`
    )
  } else if (progress.total > 0) {
    lines.push(`Every ${unit} is done`)
  } else {
    lines.push('Nothing is planned yet')
  }
  if (progress.total > 0) lines.push(`${progress.done} of ${progress.total} ${unit}s done`)
  const c = progress.counts
  const blocked = c.blocked > 0 ? ` (${c.blocked} blocked)` : ''
  lines.push(
    `Steps: ${c.done} done · ${c.running} running · ${c.waitingReview} waiting for review${blocked} · ${c.todo} to do`
  )
  if (m.status === 'closed') {
    lines.push(`The mission is closed${m.closedAs ? ` as ${m.closedAs}` : ''}`)
  } else if (progress.missionState === 'ready-to-close') {
    lines.push('Ready to close')
  }
  if (m.closeRequested) lines.push('The session asked to close the mission')
  return lines.join('\n')
}

function decidedPart(entries: readonly LogEntry[]): string {
  const decisions = entries.filter((e) => e.kind === 'decision').slice(-DECIDED_COUNT)
  if (decisions.length === 0) return 'Nothing was decided yet.'
  return decisions
    .map(
      (e) =>
        `- ${e.at.slice(0, 10)}${e.stepId ? ` · ${e.stepId}` : ''}: ${clip(e.text, DECISION_TEXT_MAX)}`
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
      ? ` at ${at.step}${titleOf(at.step) ? ` ${clip(titleOf(at.step), 60)}` : ''}`
      : ''
    const waiting = at?.waitingFor ? `, waiting for ${clip(at.waitingFor, 80)}` : ''
    return clip(`- ${who}: ${s.to === null ? 'working' : `stopped${where}`}${waiting}`, LINE_MAX)
  })
  const shown = rows.slice(-SESSIONS_SHOWN)
  const left = rows.length - shown.length
  return [...(left > 0 ? [`- …and ${plural(left, 'earlier session')}`] : []), ...shown].join('\n')
}

function nextPart(list: ReturnType<typeof waitingListV4>): string {
  const lines: string[] = []
  if (list.next) {
    lines.push(`${list.next.ask} — ${list.next.why}`)
    if (list.moreLine) lines.push(list.moreLine)
  } else {
    lines.push('Nothing waits on the operator.')
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

/** Lines added while they fit `budget`; what does not fit is counted in one closing line. */
function fitLines(lines: readonly string[], budget: number, noun: string): string {
  const out: string[] = []
  let used = 0
  const reserve = 48
  for (let i = 0; i < lines.length; i++) {
    const cost = lines[i].length + 1
    if (used + cost > budget - reserve) {
      const left = lines.length - i
      out.push(`…and ${left} more ${noun}${left === 1 ? '' : 's'} not shown`)
      return clipBlock(out.join('\n'), Math.max(budget, 0))
    }
    out.push(lines[i])
    used += cost
  }
  return out.join('\n')
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
  const progress = deriveProgress(mission, inputs)
  const list = waitingListV4(mission, { inputs, progress, attachRequests: opts.attachRequests })
  const entries = parseLog(log)

  const open = mission.steps
    .map((step) => ({ step, result: deriveStepState(step, inputs[step.id] ?? {}) }))
    .filter(({ result }) => result.state !== 'todo' && result.state !== 'done')

  const criteria: string[] = []
  const links: string[] = []
  const seen = new Set<string>()
  const addLink = (kind: string, ref: string, stepId?: string): void => {
    const label = kind === 'pr' ? `pull request ${prLabel(ref)}` : `${kind}: ${ref}`
    const line = clip(`- ${label}${stepId ? ` (${stepId})` : ''}`, LINE_MAX)
    if (!seen.has(line)) {
      seen.add(line)
      links.push(line)
    }
  }
  for (const l of mission.links) addLink(l.kind, l.ref)
  for (const { step, result } of open) {
    criteria.push(clip(`- ${step.id} ${step.title}${result.blocked ? ' (blocked)' : ''}`, LINE_MAX))
    for (const c of result.open) criteria.push(clip(`  - ${c.text} (${who(c)})`, LINE_MAX))
    for (const l of step.links ?? []) addLink(l.kind, l.ref, step.id)
  }

  const head: Omit<MissionSummaryParts, 'openCriteria' | 'links'> = {
    goal: clipBlock(goalPart(mission), BUDGET.goal),
    whereItIs: clipBlock(wherePart(mission, progress), BUDGET.whereItIs),
    decided: clipBlock(decidedPart(entries), BUDGET.decided),
    stoppedAt: clipBlock(stoppedPart(mission), BUDGET.stoppedAt),
    nextStep: clipBlock(nextPart(list), BUDGET.nextStep)
  }

  const title = `# Mission ${mission.id}`
  const section = (heading: string, body: string): string => `${heading}\n${body}`
  const fixed = [
    title,
    section(HEADINGS.goal, head.goal),
    section(HEADINGS.whereItIs, head.whereItIs),
    section(HEADINGS.decided, head.decided),
    section(HEADINGS.stoppedAt, head.stoppedAt),
    section(HEADINGS.nextStep, head.nextStep)
  ]
  // What is left after the five parts and the two headings still to come, split between criteria
  // (two thirds) and links (one third); a part that uses less leaves its share to nothing: no padding.
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
  // The five parts are budgeted so this never fires; it is the cap's last line of defence.
  if (text.length > MISSION_SUMMARY_MAX) text = clipBlock(text, MISSION_SUMMARY_MAX)
  return { text, parts }
}
