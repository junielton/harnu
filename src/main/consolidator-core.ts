/**
 * Campaign ch.6 (T598, spec §3.6) — the close-out consolidator, pure.
 *
 * When an agent asks to close a mission or campaign, Harnu runs ONE consolidation pass over the
 * STRUCTURED record — steps, the Log, the ledger, the PRs and commits linked to the steps — and
 * drafts (1) the `outcome`, and (2) the memory the operator may choose to keep: `decisions.md`
 * entries, lesson candidates and a refreshed `hot.md`. Nothing here writes: the drafts wait in the
 * end dialog and only a tick writes one (AC-6.2).
 *
 * It never reads a transcript. That is a property of what the pass is GIVEN, not of its manners:
 * {@link ConsolidatorInput} has no transcript field, {@link CONSOLIDATOR_ALLOW_VERBS} names the two
 * structured reads and nothing that discloses a session, and {@link consolidatorReadRefusal} turns
 * away any file that is not a mission or campaign record. The consolidator is deterministic — no
 * model call — so what a draft says is traceable to the line of the record it came from; every
 * draft carries that citation, and a candidate with nothing to cite is dropped, never invented.
 */

import { HOT_MAX_WORDS, MEMORY_ENTRY_MAX_CHARS } from './mcp/memory-core'
import { isEntryId } from './mcp/memory-entries'
import type { DeclaredEnd, LedgerRow } from './mission-core'

// ── the allowlist, as data ───────────────────────────────────────────────────

/** Verbs the pass may call: the two reads of the structured record. Neither exposes a transcript. */
export const CONSOLIDATOR_ALLOW_VERBS = ['mission_get', 'campaign_get'] as const

/** Built-in tools of an observe-mode tick: read-only, and only over {@link consolidatorReadRefusal}'s roots. */
export const CONSOLIDATOR_NATIVE_TOOLS = ['Read', 'Grep', 'Glob'] as const

const RECORD_FILE = /(?:^|[\\/])\.harnu[\\/](?:missions|campaigns)[\\/][^\\/]+\.md$/
const TRANSCRIPT_PATH = /(?:[\\/]\.claude[\\/]projects[\\/]|\.jsonl$)/

/** `null` when `filePath` is a mission or campaign record; otherwise why the pass must not read it. */
export function consolidatorReadRefusal(filePath: string): string | null {
  if (TRANSCRIPT_PATH.test(filePath)) {
    return `${filePath} is a session transcript — the consolidator reads the structured record only, never a transcript.`
  }
  if (!RECORD_FILE.test(filePath)) {
    return `${filePath} is not the structured record — the consolidator reads .harnu/missions/*.md and .harnu/campaigns/*.md only.`
  }
  return null
}

// ── input ────────────────────────────────────────────────────────────────────

/** A Log entry, read off its `### <time> · <kind> · <step>` heading. */
export interface LogEntry {
  at: string
  kind: 'note' | 'decision' | 'surprise' | 'steward'
  stepId?: string
  text: string
}

/** One step (or, for a campaign, one chapter) as the pass sees it. */
export interface ConsolidatorStep {
  id: string
  title: string
  kind: 'custom' | 'fixed-end' | 'fixed-start'
  proof: 'unproven' | 'claimed' | 'verified' | 'self-verified'
  required: boolean
  addedAt?: string
  addedReason?: string
  /** A decision node: the question, its options and the index the operator chose. */
  decision?: { title: string; options: string[]; chosen?: number }
}

/** Everything the pass reads. There is deliberately no transcript field. */
export interface ConsolidatorInput {
  kind: 'mission' | 'campaign'
  id: string
  title: string
  declaredEnd: DeclaredEnd
  createdAt: string
  /** Repo-relative scope paths; they become the drafts' `watches`. */
  scopePaths: string[]
  steps: ConsolidatorStep[]
  /**
   * Whether the end was reached, when the steps cannot say (a campaign has chapters, not a fixed
   * end step). Absent → read from the `fixed-end` step's proof.
   */
  endState?: 'verified' | 'unverified'
  log: LogEntry[]
  ledger: LedgerRow[]
  /** Commits beyond the PR base, per step (from the step's linked worktrees). */
  commits?: Record<string, number>
  /** Head commit per step, when known (cited as the step's commit). */
  heads?: Record<string, string>
  /** The current `hot.md` body, so the refresh keeps what is still true. */
  currentHot?: string
}

// ── output ───────────────────────────────────────────────────────────────────

/** Spec §3.6. */
export interface Outcome {
  declaredEnd: DeclaredEnd
  actualEnd: string
  deviations: string[]
  blockers: { reason: string; resolution: string }[]
  verificationGaps: string[]
  surprises: string[]
  perStep: {
    stepId: string
    openedAt: string
    mergedAt?: string
    commits?: number
    reverifications?: number
  }[]
  nothingNotable?: true
}

export interface Citation {
  kind: 'step' | 'pr' | 'commit'
  ref: string
}

/** One thing the operator may choose to write to memory. */
export interface MemoryDraft {
  id: string
  kind: 'decision' | 'lesson' | 'hot'
  /** The memory page it would be appended to (`hot` replaces). */
  page: 'decisions' | 'hot'
  entry: string
  cites: Citation[]
  mission: string
  validFrom: string
  watches?: string[]
  /** An entry id the draft says it replaces — only ever taken from the record's own words. */
  supersedes?: string
}

export interface Consolidation {
  outcome: Outcome
  drafts: MemoryDraft[]
  nothingNotable: boolean
}

// ── the Log ──────────────────────────────────────────────────────────────────

const LOG_KIND_SET: ReadonlySet<string> = new Set(['note', 'decision', 'surprise', 'steward'])
const STEP_REF = /^(?:stp|chp)-\d+$/

/** Parse a Log body into entries. Anything before the first heading is not an entry. */
export function parseLogEntries(log: string): LogEntry[] {
  const out: LogEntry[] = []
  const heading = /^### (\S+)([^\n]*)\n/gm
  const marks = [...log.matchAll(heading)]
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i]
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < marks.length ? (marks[i + 1].index ?? log.length) : log.length
    let kind: LogEntry['kind'] = 'note'
    let stepId: string | undefined
    for (const tag of m[2]
      .split('·')
      .map((t) => t.trim())
      .filter(Boolean)) {
      if (LOG_KIND_SET.has(tag)) kind = tag as LogEntry['kind']
      else if (STEP_REF.test(tag)) stepId = tag
    }
    out.push({ at: m[1], kind, ...(stepId ? { stepId } : {}), text: log.slice(start, end).trim() })
  }
  return out
}

// ── the pass ─────────────────────────────────────────────────────────────────

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

const words = (s: string): number => (s.trim() === '' ? 0 : s.trim().split(/\s+/).length)

function citesFor(input: ConsolidatorInput, stepId: string | undefined): Citation[] {
  if (!stepId) return []
  const cites: Citation[] = [{ kind: 'step', ref: stepId }]
  const rows = input.ledger.filter((r) => r.stepId === stepId && r.pr !== undefined)
  const merged =
    rows.find((r) => r.kind === 'pr-merged') ?? rows.find((r) => r.kind === 'pr-opened')
  if (merged) cites.push({ kind: 'pr', ref: `#${merged.pr}` })
  const head = input.heads?.[stepId]
  if (head) cites.push({ kind: 'commit', ref: head.slice(0, 7) })
  return cites
}

function sourceLine(input: ConsolidatorInput, cites: Citation[]): string {
  const refs = cites.map((c) =>
    c.kind === 'commit' ? `commit ${c.ref}` : c.kind === 'pr' ? `PR ${c.ref}` : c.ref
  )
  return `Source: ${input.kind} ${input.id} (${clip(input.title, 60)})${refs.length > 0 ? ` — ${refs.join(', ')}` : ''}.`
}

function buildOutcome(input: ConsolidatorInput): Outcome {
  const end = input.steps.find((s) => s.kind === 'fixed-end')
  const reached = input.endState ? input.endState === 'verified' : end?.proof === 'verified'
  const actualEnd = reached
    ? `Delivered and verified: ${clip(input.declaredEnd.target, 200)}`
    : `Closed without a verified end (${end?.proof ?? 'no end step'}): ${clip(input.declaredEnd.target, 200)}`

  const deviations = input.steps
    .filter((s) => s.addedReason)
    .map(
      (s) => `${s.id} "${clip(s.title, 60)}" added mid-flight: ${clip(s.addedReason ?? '', 160)}`
    )

  const verificationGaps = input.steps
    .filter((s) => s.required !== false && s.proof !== 'verified')
    .map(
      (s) =>
        `${s.id} "${clip(s.title, 60)}" closed ${s.proof}${s.proof === 'self-verified' ? ' (the builder verified it)' : ''}, not independently verified`
    )

  const surprises = input.log.filter((e) => e.kind === 'surprise').map((e) => clip(e.text, 240))

  const perStep: Outcome['perStep'] = input.steps.map((s) => {
    const rows = input.ledger
      .filter((r) => r.stepId === s.id)
      .sort((a, b) => a.at.localeCompare(b.at))
    const merged = rows.find((r) => r.kind === 'pr-merged')
    const verified = rows.filter((r) => r.kind === 'verified').length
    const commits = input.commits?.[s.id]
    return {
      stepId: s.id,
      openedAt: rows[0]?.at ?? s.addedAt ?? input.createdAt,
      ...(merged ? { mergedAt: merged.at } : {}),
      ...(commits !== undefined ? { commits } : {}),
      ...(verified > 1 ? { reverifications: verified - 1 } : {})
    }
  })

  return {
    declaredEnd: input.declaredEnd,
    actualEnd,
    deviations,
    // A cleared blocker leaves no trace in the record today, so none can be reported here; a close
    // is refused while any is open.
    blockers: [],
    verificationGaps,
    surprises,
    perStep
  }
}

/** The body of a `hot.md` without its chrome (title, guidance quote, provenance stamp, placeholder). */
function hotLines(hot: string | undefined): string[] {
  if (!hot) return []
  return hot
    .split(/\r?\n/)
    .filter(
      (l) =>
        l.trim() !== '' &&
        !/^#\s/.test(l) &&
        !l.trim().startsWith('> provenance:') &&
        !l.trim().startsWith('>') &&
        !l.includes('memory just created')
    )
}

function buildHot(input: ConsolidatorInput, outcome: Outcome, date: string): string {
  const head = [
    '## Where we left off',
    `- ${date}: ${input.kind} ${input.id} "${clip(input.title, 80)}" closed. ${clip(outcome.actualEnd, 160)}`
  ]
  const old = hotLines(input.currentHot)
  const fits = (lines: string[]): boolean => {
    const text = [...head, ...lines].join('\n')
    return words(text) <= HOT_MAX_WORDS && text.length <= MEMORY_ENTRY_MAX_CHARS
  }
  let kept = old
  while (kept.length > 0 && !fits(kept)) kept = kept.slice(1) // oldest first
  return [...head, ...kept].join('\n')
}

const SUPERSEDES = /\bsupersedes\s+(e-[0-9a-f]{8})\b/i

/** Run the consolidation. `date` is the `YYYY-MM-DD` the entries are valid from. */
export function consolidate(input: ConsolidatorInput, date: string): Consolidation {
  const outcome = buildOutcome(input)
  const endStep = input.steps.find((s) => s.kind === 'fixed-end')?.id
  const watches = input.scopePaths.length > 0 ? [...input.scopePaths] : undefined
  const drafts: MemoryDraft[] = []
  const add = (d: Omit<MemoryDraft, 'id' | 'mission' | 'validFrom' | 'watches'>): void => {
    drafts.push({
      id: `drf-${drafts.length + 1}`,
      mission: input.id,
      validFrom: date,
      ...(d.page === 'decisions' && watches ? { watches } : {}),
      ...d
    })
  }

  // Decisions: the ones written to the Log as such, and the decision nodes the operator chose.
  for (const e of input.log.filter((x) => x.kind === 'decision')) {
    const cites = citesFor(input, e.stepId)
    if (cites.length === 0) continue
    const sup = SUPERSEDES.exec(e.text)?.[1]
    add({
      kind: 'decision',
      page: 'decisions',
      entry: `## ${clip(e.text, 90)}\n${e.text}\n\n${sourceLine(input, cites)}`,
      cites,
      ...(sup && isEntryId(sup) ? { supersedes: sup } : {})
    })
  }
  for (const s of input.steps) {
    const d = s.decision
    if (!d || d.chosen === undefined || d.options[d.chosen] === undefined) continue
    const cites = citesFor(input, s.id)
    const text = `${d.title}: chose "${d.options[d.chosen]}" (of ${d.options.map((o) => `"${o}"`).join(', ')}).`
    add({
      kind: 'decision',
      page: 'decisions',
      entry: `## ${clip(text, 90)}\n${text}\n\n${sourceLine(input, cites)}`,
      cites
    })
  }

  // Lessons: a surprise that happened on a step, and a step that closed without independent proof.
  for (const e of input.log.filter((x) => x.kind === 'surprise')) {
    const cites = citesFor(input, e.stepId)
    if (cites.length === 0) continue
    add({
      kind: 'lesson',
      page: 'decisions',
      entry: `## Lesson: ${clip(e.text, 80)}\n${e.text}\n\n${sourceLine(input, cites)}`,
      cites
    })
  }

  const nothingNotable =
    drafts.length === 0 &&
    outcome.deviations.length === 0 &&
    outcome.surprises.length === 0 &&
    outcome.verificationGaps.length === 0
  if (nothingNotable) {
    return { outcome: { ...outcome, nothingNotable: true }, drafts: [], nothingNotable: true }
  }

  const hotCites: Citation[] = endStep ? [{ kind: 'step', ref: endStep }] : []
  add({
    kind: 'hot',
    page: 'hot',
    entry: buildHot(input, outcome, date),
    cites: hotCites
  })
  return { outcome, drafts, nothingNotable: false }
}
