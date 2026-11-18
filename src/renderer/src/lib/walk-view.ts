/**
 * Guided walks: the view-model of the walk pane (design.md §6 "Guided test walk", spec S-3, AC-12 to AC-17,
 * AC-46 and AC-49).
 *
 * Pure and DOM-free. The rules of a walk live in the shared machine (`src/shared/walk-machine.ts`); this module
 * turns a walk, its run and the pane's own ephemeral state into exactly what the pane draws, so the component
 * recounts and decides nothing. It never reads a clock (`data.now` is an argument) and never calls main.
 *
 *  - ONE check at a time: a check's view carries that check and nothing of the next (AC-12).
 *  - The same FIVE outcomes whenever a check asks for an answer; the awaiting and disagrees states show only
 *    what the skill's own rules call for; none is a dialog (AC-13).
 *  - Explain more is a toggle that reveals what the script prepared without moving the cursor (AC-17).
 *  - Nothing here settles a criterion: the close-out only reads one and links to the operator's own door (D-2).
 *
 * Words come from `testWalk.*` through the injected `t`, so a locale is a JSON file and this stays testable.
 */
import {
  canEscalate,
  counts,
  ordinalOf,
  totalChecks,
  view as machineView,
  type CheckState,
  type LastTime,
  type Run,
  type RunCheck
} from '../../../shared/walk-machine'
import { walkLinkKey } from '../../../shared/walk-schema'
import type { DoItem, WalkCheck, WalkLink, WalkScript } from '../../../shared/walk-schema'
import type { WalkSource } from '../../../shared/walk-source'
import type { KeyContext, PaneMode } from './walk-keys'
import { shortDate } from './walk-library'

export type T = (key: string, params?: Record<string, string | number>) => string

// ---- What main sends -----------------------------------------------------------------------------

export interface DeepeningData {
  checkId: string
  more?: string
  extra?: (DoItem & { id: string })[]
  addedInRun: number
  at: number
}
export interface SimplerData {
  checkId: string
  text: string
  do: DoItem[]
  addedInRun: number
  at: number
}
export interface CriterionFact {
  id: string
  text: string
  /** Read live from the mission record: `unavailable` when the mission was closed or removed. */
  state: 'open' | 'settled' | 'unavailable'
}

/** The pane's saved, per-run bits that are not the machine's: which checks revealed their extras and which rows are ticked. */
export interface TickData {
  revealed: string[]
  ticked: Record<string, string[]>
}

/** Everything a pane needs to draw a run, as `walk:load` returns it. */
export interface WalkData {
  folder: string
  walkDir: string
  walkId: string
  runId: string
  rev: number
  script: WalkScript
  deepenings: DeepeningData[]
  simpler: SimplerData[]
  added: { checkId: string; addedInRun: number }[]
  run: Run
  closeOut: string | null
  ownerSessionId: string | null
  tick: TickData
  /** A turn is due and no session could take it (the run's outbox is holding). */
  held: boolean
  /** A turn has waited a while and is not held yet: a parked session may be waking (S-3's carried outbox fix). */
  waking?: boolean
  /** Every run of the walk that started, oldest first (the history's run selector). */
  runs?: { runId: string; n: number; state: Run['state']; startedAt?: number; endedAt?: number }[]
  /** What each check said the last time it was walked (a re-run's quiet hint). */
  lastTime?: Record<string, LastTime>
  /** Links whose target no longer exists (`walkLinkKey`s): the pane does not draw them (AC-25). */
  goneLinks?: string[]
  /** The wait of D-7 before Continue without the check (30 s; a dev variable shortens it). */
  waitMs: number
  now: number
  /** Another walk of the same source, already walked once, that a re-run could use (AC-49). */
  saved: { walkId: string; lastRun: { verified: number; total: number } } | null
  /** A mission source's criteria, read live; empty for every other source. */
  criteria: CriterionFact[]
  /** A mission source's names, for the source line. */
  mission: { title: string; stepTitle?: string; milestoneTitle?: string } | null
}

/** The pane's own, ephemeral state (never persisted). */
export interface WalkUi {
  explainOpen: boolean
  formOpen: boolean
  roadmapOpen: boolean
  lightbox: boolean
  /** The pane was opened on a past run (from the library): an ended run is then shown read-only (S-4). */
  past: boolean
  /** Checks whose `explain` / `simpler` turn the session has not answered yet. */
  asking: { explain: string[]; simpler: string[] }
}

export const freshUi = (): WalkUi => ({
  explainOpen: false,
  formOpen: false,
  roadmapOpen: false,
  lightbox: false,
  past: false,
  asking: { explain: [], simpler: [] }
})

/** What the close-out's Saved in Walks card offers: Open Walks (the library) and Export markdown (S-4). */
export const WALK_CAPS = { library: true, export: true } as const

// ---- Small shared pieces ------------------------------------------------------------------------

export type Glyph = '✓' | '✗' | '!' | '-' | '⚑' | '?'

const GLYPH_OF: Record<CheckState, Glyph> = {
  todo: '-',
  awaiting: '-',
  skipped: '-',
  verified: '✓',
  caveat: '!',
  disagrees: '!',
  failed: '✗'
}

export interface Segment {
  kind: 'text' | 'chip'
  text: string
}

/** A backtick span of a script's text is a copy chip; the rest is plain. */
export function segments(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const at = m.index ?? 0
    if (at > last) out.push({ kind: 'text', text: text.slice(last, at) })
    out.push({ kind: 'chip', text: m[1] })
    last = at + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

const byId = (script: WalkScript, id: string): WalkCheck | undefined =>
  script.checks.find((c) => c.id === id)

// ---- The source line (V-19) ---------------------------------------------------------------------

export interface SourceHeader {
  kind: WalkSource['kind']
  icon: 'target' | 'git-pull-request' | 'git-branch' | 'bookmark' | 'lightbulb'
  text: string
  /** What a click on the text opens: the PR, or the Mission dropdown. Plain text for every other source. */
  link: 'pr' | 'mission' | null
  /** The full value a copy puts on the clipboard (the PR's URL), when there is one. */
  copy: string | null
  /** `Re-run · run N` on a re-run. */
  runChip: string | null
}

export function sourceHeader(
  source: WalkSource,
  t: T,
  opts: {
    runN?: number
    mission?: { title: string; stepTitle?: string; milestoneTitle?: string } | null
  } = {}
): SourceHeader {
  const runChip =
    opts.runN && opts.runN > 1 ? t('testWalk.source.rerunChip', { n: opts.runN }) : null
  switch (source.kind) {
    case 'pr':
      return {
        kind: 'pr',
        icon: 'git-pull-request',
        text: [`PR #${source.number}`, source.title, source.author].filter(Boolean).join(' · '),
        link: 'pr',
        copy: source.url ?? null,
        runChip
      }
    case 'branch':
      return {
        kind: 'branch',
        icon: 'git-branch',
        text: t('testWalk.source.branch', { branch: source.branch, base: source.base }),
        link: null,
        copy: null,
        runChip
      }
    case 'card':
      return {
        kind: 'card',
        icon: 'bookmark',
        text: t('testWalk.source.card', { slug: source.slug }),
        link: null,
        copy: null,
        runChip
      }
    case 'mission': {
      const mission = opts.mission?.title || source.missionId
      const text =
        source.scope === 'step'
          ? t('testWalk.source.missionStep', {
              mission,
              name: opts.mission?.stepTitle || source.id || ''
            })
          : source.scope === 'milestone'
            ? t('testWalk.source.missionMilestone', {
                mission,
                name: opts.mission?.milestoneTitle || source.id || ''
              })
            : t('testWalk.source.missionAll', { mission })
      return { kind: 'mission', icon: 'target', text, link: 'mission', copy: null, runChip }
    }
    default:
      return {
        kind: 'feature',
        icon: 'lightbulb',
        text: t('testWalk.source.feature', { text: source.text }),
        link: null,
        copy: null,
        runChip
      }
  }
}

// ---- Progress (V-7) -----------------------------------------------------------------------------

export interface ProgressView {
  /** The served check's fixed ordinal. */
  n: number
  /** N, the checks to walk. */
  total: number
  /** The only text of the strip: `Check n of N`. */
  label: string
  /** One cell per check to walk. Closed, current or the rest; no text. */
  cells: ('closed' | 'current' | 'rest')[]
}

function progressView(run: Run, current: string | null, t: T): ProgressView | null {
  const walked = run.checks.filter((c) => c.countable)
  if (walked.length === 0) return null
  const n =
    (current ? ordinalOf(run, current) : null) ?? Math.min(counts(run).verified + 1, walked.length)
  return {
    n,
    total: walked.length,
    label: t('testWalk.progress', { n, total: walked.length }),
    cells: walked.map((c) =>
      c.id === current
        ? 'current'
        : c.state === 'verified' || c.state === 'caveat'
          ? 'closed'
          : 'rest'
    )
  }
}

// ---- Outcomes -----------------------------------------------------------------------------------

export type OutcomeId =
  | 'start'
  | 'done'
  | 'try-again'
  | 'failed'
  | 'back'
  | 'skip'
  | 'explain'
  | 'follow-anyway'
  | 'treat-as-failed'
  | 'continue-without'
  | 'send'
  | 'cancel-form'
  | 'pick-skipped'
  | 'close-out'
  | 'rerun'
  | 'export'

export interface Outcome {
  id: OutcomeId
  label: string
  look: 'primary' | 'neutral' | 'ghost'
  glyph: Glyph | '+' | null
  /** The key chip on the primary button (V-2); the other shortcuts live in tooltips. */
  chip: 'Enter' | null
  /** The shortcut named in the tooltip. */
  shortcut: string | null
  /** A toggle that is on (Explain more while its card is open). */
  pressed: boolean
  /** Never a dialog: an outcome is a button that acts at once. */
  dialog: false
}

const camel = (id: string): string => id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

const outcome = (t: T, id: OutcomeId, o: Partial<Outcome> = {}): Outcome => ({
  id,
  label: t(`testWalk.action.${camel(id)}`, { n: 1 }),
  look: 'ghost',
  glyph: null,
  chip: null,
  shortcut: null,
  pressed: false,
  dialog: false,
  ...o
})

/** The five outcomes of a check that asks for the operator's answer; the first slot is Done, or Try again on a retry. */
function fiveOutcomes(t: T, first: 'done' | 'try-again', explainOpen: boolean): Outcome[] {
  return [
    first === 'done'
      ? outcome(t, 'done', { look: 'primary', glyph: '✓', chip: 'Enter' })
      : outcome(t, 'try-again', { look: 'primary', chip: 'Enter' }),
    outcome(t, 'failed', { look: 'neutral', glyph: '✗', shortcut: 'F' }),
    outcome(t, 'back', { shortcut: 'B' }),
    outcome(t, 'skip', { glyph: '-', shortcut: 'S' }),
    outcome(t, 'explain', { glyph: '+', shortcut: 'E', pressed: explainOpen })
  ]
}

// ---- Last time (a re-run) -------------------------------------------------------------------------

export interface LastTimeView {
  result: LastTime['result']
  /** The quiet word on a roadmap row: `last time: passed`. */
  text: string
  /** `warn` for a check that failed last time: it is the one to look at. */
  tone: 'warn' | 'quiet'
}

/** The roadmap row's hint for a check; `null` when the last run never walked it (or this is a first run). */
function lastTimeRow(data: WalkData, id: string, t: T): LastTimeView | null {
  const lt = data.lastTime?.[id]
  if (!lt) return null
  return {
    result: lt.result,
    text: t(`walksLibrary.lastTime.${lt.result}`),
    tone: lt.result === 'failed' ? 'warn' : 'quiet'
  }
}

/** The check card's hint: what it said last time, and what the operator wrote when it failed. */
function lastTimeCard(
  data: WalkData,
  id: string,
  t: T
): { tone: 'warn' | 'quiet'; text: string } | null {
  const lt = data.lastTime?.[id]
  if (!lt) return null
  if (lt.result === 'failed')
    return {
      tone: 'warn',
      text: lt.line
        ? t('walksLibrary.lastTimeHint.failedLine', { line: lt.line })
        : t('walksLibrary.lastTimeHint.failed')
    }
  return { tone: 'quiet', text: t(`walksLibrary.lastTimeHint.${lt.result}`) }
}

// ---- Checks -------------------------------------------------------------------------------------

export interface LinkChip {
  label: string
  kind: WalkLink['kind']
  target: string
  line?: number
  mono: boolean
  /** The full value a copy puts on the clipboard; `null` when the link has no full form worth copying. */
  copy: string | null
  /** A file link's absolute path (the pane opens it in the viewer); `null` for every other kind. */
  abs: string | null
  /** Said once, quietly: the agent's own declaration that it could not open the address. */
  note: 'login' | 'unchecked' | null
}

/** The links whose target still exists: a link the load found gone is not drawn (AC-25). */
function liveLinks(links: WalkLink[], data: WalkData): WalkLink[] {
  const gone = data.goneLinks
  return gone && gone.length > 0 ? links.filter((l) => !gone.includes(walkLinkKey(l))) : links
}

function linkChip(l: WalkLink, folder: string): LinkChip {
  const abs =
    l.kind === 'file' ? `${folder.replace(/\/$/, '')}/${l.target.replace(/^\.?\//, '')}` : null
  return {
    label: l.label,
    kind: l.kind,
    target: l.target,
    ...(l.line !== undefined ? { line: l.line } : {}),
    abs,
    mono: l.kind === 'file' || l.kind === 'pr' || l.kind === 'url',
    copy:
      l.kind === 'file'
        ? `${abs}${l.line !== undefined ? `:${l.line}` : ''}`
        : l.kind === 'pr'
          ? null
          : l.target,
    note:
      l.kind === 'url' && l.checked?.status === 'login'
        ? 'login'
        : l.kind === 'url' && l.checked?.status === 'unchecked'
          ? 'unchecked'
          : null
  }
}

export interface DoView {
  n: number
  text: Segment[]
  see: Segment[]
  block: { text: string; lang: string | null } | null
}

const doView = (items: DoItem[]): DoView[] =>
  items.map((d, i) => ({
    n: i + 1,
    text: segments(d.text),
    see: segments(d.see),
    block: d.block ? { text: d.block.text, lang: d.block.lang ?? null } : null
  }))

export interface TeachView {
  what: string
  where: LinkChip[]
  idea: { text: string; link: LinkChip | null } | null
  why: string | null
}

export interface ExtraRow {
  id: string
  text: Segment[]
  see: Segment[]
  ticked: boolean
}

export interface ExplainView {
  open: boolean
  /** Something was prepared (or already deepened); when not, a press asks the session. */
  prepared: boolean
  asking: boolean
  /** What the card shows, in order: a walk-through teaches first and folds the edge checks under it. */
  order: ('more' | 'teach' | 'edge')[]
  foldEdge: boolean
  more: string[]
  teach: TeachView | null
  extras: ExtraRow[]
}

export interface CheckView {
  checkId: string
  n: number
  total: number
  title: string
  phase: 'todo' | 'awaiting' | 'disagrees' | 'failed'
  blocking: boolean
  /** "Checks 2 to 6 depend on this one": the check numbers the quiet line names. */
  blocksLine: { from: number; to: number; why: string | null } | null
  /** Back leads with the check's `undo` when it has one. */
  undo: string | null
  /** The same line with its backtick spans as copy chips: an undo command is copyable (BUG-293). */
  undoParts: Segment[] | null
  do: DoView[]
  where: { text: string; path: string | null; approximate: boolean; links: LinkChip[] } | null
  see: {
    passes: Segment[]
    /** The muted `✗ Not: …` line (V-6). */
    notLine: Segment[] | null
    images: { src: string; alt: string; caption: string; kind: 'expected' | 'capture' }[]
    table: { item: string; shows: string; source: string }[]
  }
  icheck: { kind: 'check'; precheck: string | null; how: string } | { kind: 'nothing'; why: string }
  /** The latest "Said more simply" card, over the same check. */
  simpler: { text: string } | null
  correction: { text: string } | null
  reported: { line: string | null; shot: string | null; shotPath: string | null } | null
  evidence: { ran: string; expected: Segment[]; found: string } | null
  explain: ExplainView
  /** The quiet "I didn't get this step" link. */
  lost: boolean
  asking: { explain: boolean; simpler: boolean }
  quiet: 'awaiting' | null
  door: { kind: 'mission' | 'pr' | 'feature' } | null
  /** A re-run: what this check said last time. */
  lastTime: { tone: 'warn' | 'quiet'; text: string } | null
}

const prepared = (data: WalkData, c: WalkCheck): boolean =>
  !!c.more ||
  !!c.teach ||
  (c.edge?.length ?? 0) > 0 ||
  data.deepenings.some(
    (d) => d.checkId === c.id && d.addedInRun <= data.run.n && (d.more || d.extra?.length)
  )

function explainView(data: WalkData, c: WalkCheck, ui: WalkUi): ExplainView {
  const learn = data.script.purpose === 'learn'
  const ticked = new Set(data.tick.ticked[c.id] ?? [])
  const deep = data.deepenings.filter((d) => d.checkId === c.id && d.addedInRun <= data.run.n)
  const more = [c.more, ...deep.map((d) => d.more)].filter((m): m is string => !!m)
  const extras: ExtraRow[] = [
    ...(c.edge ?? []).map((e) => ({ id: e.id ?? '', text: e.text, see: e.see })),
    ...deep.flatMap((d) => (d.extra ?? []).map((e) => ({ id: e.id, text: e.text, see: e.see })))
  ].map((e) => ({
    id: e.id,
    text: segments(e.text),
    see: segments(e.see),
    ticked: ticked.has(e.id)
  }))
  const teach: TeachView | null = c.teach
    ? {
        what: c.teach.what,
        where: liveLinks(c.teach.where ?? [], data).map((l) => linkChip(l, data.folder)),
        idea: c.teach.idea
          ? {
              text: c.teach.idea.text,
              link:
                c.teach.idea.link && liveLinks([c.teach.idea.link], data).length > 0
                  ? linkChip(c.teach.idea.link, data.folder)
                  : null
            }
          : null,
        why: c.teach.why ?? null
      }
    : null
  return {
    open: ui.explainOpen,
    prepared: prepared(data, c),
    asking: ui.asking.explain.includes(c.id),
    order: learn ? ['teach', 'more', 'edge'] : ['more', 'edge', 'teach'],
    foldEdge: learn,
    more,
    teach,
    extras
  }
}

/** What a press on Explain more does: show what is prepared, fold it back, or ask the session. */
export function explainAction(
  data: WalkData,
  ui: WalkUi,
  checkId: string
): 'reveal' | 'fold' | 'ask' {
  const c = byId(data.script, checkId)
  if (!c) return 'ask'
  if (ui.explainOpen) return 'fold'
  return prepared(data, c) ? 'reveal' : 'ask'
}

/** The new tick map after the operator ticks (or unticks) one extra check. Never touches Done. */
export function tickExtra(tick: TickData, checkId: string, extraId: string): TickData {
  const now = new Set(tick.ticked[checkId] ?? [])
  if (now.has(extraId)) now.delete(extraId)
  else now.add(extraId)
  return {
    revealed: tick.revealed.includes(checkId) ? tick.revealed : [...tick.revealed, checkId],
    ticked: { ...tick.ticked, [checkId]: [...now] }
  }
}

const doorKind = (source: WalkSource): 'mission' | 'pr' | 'feature' =>
  source.kind === 'mission' ? 'mission' : source.kind === 'pr' ? 'pr' : 'feature'

function blocksLine(
  run: Run,
  c: WalkCheck
): { from: number; to: number; why: string | null } | null {
  const nums = (c.blocks ?? [])
    .map((id) => ordinalOf(run, id))
    .filter((n): n is number => n !== null)
  if (nums.length === 0) return null
  return { from: Math.min(...nums), to: Math.max(...nums), why: c.blocksWhy ?? null }
}

function checkView(data: WalkData, rc: RunCheck, ui: WalkUi, t: T): CheckView {
  const c = byId(data.script, rc.id)!
  const run = data.run
  const phase =
    rc.state === 'awaiting' || rc.state === 'disagrees' || rc.state === 'failed' ? rc.state : 'todo'
  const latestSimpler = [...data.simpler]
    .filter((s) => s.checkId === c.id && s.addedInRun <= run.n)
    .sort((a, b) => b.at - a.at)[0]
  const steps = latestSimpler ? latestSimpler.do : c.do
  const last = rc.failures.at(-1)
  const n = ordinalOf(run, rc.id) ?? 1
  return {
    checkId: c.id,
    n,
    total: totalChecks(run),
    title: c.title,
    phase,
    blocking: rc.blocks.length > 0,
    blocksLine: blocksLine(run, c),
    undo: c.undo ?? null,
    undoParts: c.undo ? segments(c.undo) : null,
    do: doView(steps),
    where: latestSimpler
      ? null
      : {
          text: c.where.text,
          path: c.where.path ?? null,
          approximate: c.where.approximate === true,
          links: liveLinks(c.where.links ?? [], data).map((l) => linkChip(l, data.folder))
        },
    see: {
      passes: segments(c.passes),
      notLine: c.fails ? segments(c.fails) : null,
      images: (c.images ?? []).map((im) => ({
        src: im.src,
        alt: im.alt,
        caption: im.caption ?? t(`testWalk.image.${im.kind}`),
        kind: im.kind
      })),
      table: c.table ?? []
    },
    icheck: c.check
      ? { kind: 'check', precheck: c.precheck ?? null, how: c.check.how }
      : { kind: 'nothing', why: c.nothingFromHere ?? '' },
    simpler: latestSimpler ? { text: latestSimpler.text } : null,
    correction: rc.state === 'failed' ? rc.correction : null,
    reported:
      rc.state === 'failed' && last
        ? {
            line: last.line ?? null,
            shot: last.shot ? (last.shot.split('/').pop() ?? last.shot) : null,
            shotPath: last.shot ?? null
          }
        : null,
    evidence:
      rc.state === 'disagrees' && rc.report
        ? {
            ran: c.check?.how ?? '',
            expected: segments(c.passes),
            found: rc.report.evidence
          }
        : null,
    explain: explainView(data, c, ui),
    lost: phase === 'todo' || phase === 'failed',
    asking: {
      explain: ui.asking.explain.includes(c.id),
      simpler: ui.asking.simpler.includes(c.id)
    },
    quiet: phase === 'awaiting' ? 'awaiting' : null,
    door:
      phase === 'failed' && canEscalate(run, rc.id) ? { kind: doorKind(data.script.source) } : null,
    lastTime: lastTimeCard(data, rc.id, t)
  }
}

// ---- The roadmap ----------------------------------------------------------------------------------

export interface RoadmapRow {
  id: string
  /** The row's number among the checks to walk; `null` for a row verified before the walk. */
  n: number | null
  title: string
  glyph: Glyph
  how:
    | { kind: 'eyes' }
    | { kind: 'check'; value: string }
    | { kind: 'earlier'; evidence: string; caveat: boolean; openPr: string | null }
  /** Added by `walk_extend` in this run. */
  added: boolean
  /** A re-run: what this check said last time. */
  lastTime: LastTimeView | null
}

export interface RoadmapView {
  readOnly: boolean
  title: string
  sub: string
  rows: RoadmapRow[]
  leftOut: { label: string; rows: { text: string; owner: string }[] } | null
  /** One line offering to re-run a saved walk of the same source instead (V-20). */
  rerunOffer: { walkId: string; text: string } | null
  startLabel: string | null
}

function roadmapView(data: WalkData, readOnly: boolean, t: T): RoadmapView {
  const run = data.run
  const added = new Set(data.added.filter((a) => a.addedInRun === run.n).map((a) => a.checkId))
  const rows: RoadmapRow[] = run.checks.map((rc) => {
    const c = byId(data.script, rc.id)!
    const how: RoadmapRow['how'] =
      rc.closedHow === 'pre-closed'
        ? {
            kind: 'earlier',
            evidence: c.evidence ?? '',
            caveat: c.status === 'caveat',
            openPr: c.openPr !== undefined ? String(c.openPr) : null
          }
        : c.check
          ? { kind: 'check', value: c.check.how }
          : { kind: 'eyes' }
    return {
      id: rc.id,
      n: ordinalOf(run, rc.id),
      title: c.title,
      glyph: GLYPH_OF[rc.state],
      how,
      added: added.has(rc.id),
      lastTime: lastTimeRow(data, rc.id, t)
    }
  })
  const preClosed = run.checks.filter((c) => !c.countable).length
  const total = totalChecks(run)
  const out = data.script.leftOut ?? []
  const owners = [...new Set(out.map((o) => o.owner))].map((o) => t(`testWalk.roadmap.owner.${o}`))
  const first = counts(run).todo === total || run.state === 'ready'
  return {
    readOnly,
    title: data.script.title,
    sub:
      run.n > 1
        ? t('walksLibrary.rerunSub', { total, n: run.n })
        : preClosed > 0
          ? t('testWalk.roadmap.subEarlier', { total, earlier: preClosed })
          : t('testWalk.roadmap.sub', { total }),
    rows,
    leftOut: out.length
      ? {
          label: t('testWalk.roadmap.leftOut', { n: out.length, owners: owners.join(' · ') }),
          rows: out
        }
      : null,
    rerunOffer:
      !readOnly && run.state === 'ready' && run.n === 1 && data.saved
        ? {
            walkId: data.saved.walkId,
            text: t('testWalk.roadmap.rerunOffer', {
              verified: data.saved.lastRun.verified,
              total: data.saved.lastRun.total
            })
          }
        : null,
    startLabel: !readOnly && first ? t('testWalk.action.start', { n: 1 }) : null
  }
}

// ---- The close-out -------------------------------------------------------------------------------

export interface CloseoutRow {
  id: string
  n: number | null
  title: string
  glyph: Glyph
  /** How it was verified, in words ("you confirmed · my check agreed"). */
  how: string
  tone: 'normal' | 'warn' | 'bad'
}

export interface CloseoutView {
  title: string
  sub: string
  rows: CloseoutRow[]
  /** The unticked extra checks of the checks whose card was opened (V-4). */
  unticked: { checkId: string; n: number | null; title: string; items: string[] }[]
  /** The `⚑ Still yours` card: drawn only when something is owed. */
  owed: {
    parts: string
    recheck: string[]
    criteria: { id: string; text: string; state: string; open: boolean }[]
    /** A link that opens the Mission, where the operator ticks the criterion. Never a control that settles. */
    link: 'mission' | null
    note: string | null
  } | null
  nothingOwed: boolean
  saved: { actions: ('open-walks' | 'export')[] }
  /** The copyable summary: the same text the session received as the `closed` turn. */
  summary: string
}

const HOW_KEY: Record<string, string> = {
  'done-check': 'agreed',
  'done-nothing': 'eyes',
  continued: 'continued',
  'follow-anyway': 'followed',
  'ended-before-agent': 'ended',
  'pre-closed': 'earlier'
}

function closeoutRow(data: WalkData, rc: RunCheck, t: T): CloseoutRow {
  const c = byId(data.script, rc.id)!
  const base = {
    id: rc.id,
    n: ordinalOf(data.run, rc.id),
    title: c.title,
    glyph: GLYPH_OF[rc.state]
  }
  if (rc.state === 'failed') {
    const line = rc.failures.at(-1)?.line
    return {
      ...base,
      how: line
        ? t('testWalk.closeout.how.failedLine', { line })
        : t('testWalk.closeout.how.failed'),
      tone: 'bad'
    }
  }
  if (rc.state === 'skipped')
    return { ...base, how: t('testWalk.closeout.how.skipped'), tone: 'normal' }
  if (rc.state === 'todo' || rc.state === 'awaiting')
    return { ...base, how: t('testWalk.closeout.how.notReached'), tone: 'normal' }
  if (rc.state === 'disagrees')
    return { ...base, how: t('testWalk.closeout.how.disagreed'), tone: 'warn' }
  const key = HOW_KEY[rc.closedHow ?? ''] ?? 'agreed'
  if (key === 'earlier')
    return {
      ...base,
      how: t(
        c.status === 'caveat'
          ? 'testWalk.closeout.how.earlierCaveat'
          : 'testWalk.closeout.how.earlier',
        {
          evidence: c.evidence ?? ''
        }
      ),
      tone: c.status === 'caveat' ? 'warn' : 'normal'
    }
  if (key === 'followed')
    return {
      ...base,
      how: t('testWalk.closeout.how.followed', { evidence: rc.report?.evidence ?? '' }),
      tone: 'warn'
    }
  return {
    ...base,
    how: t(`testWalk.closeout.how.${key}`),
    tone: rc.state === 'caveat' ? 'warn' : 'normal'
  }
}

function closeoutView(data: WalkData, t: T): CloseoutView {
  const run = data.run
  const c = counts(run)
  const unverified = c.caveat + c.disagrees
  const rows = run.checks.map((rc) => closeoutRow(data, rc, t))

  const unticked = data.tick.revealed.flatMap((id) => {
    const check = byId(data.script, id)
    if (!check) return []
    const done = new Set(data.tick.ticked[id] ?? [])
    const all = [
      ...(check.edge ?? []).map((e) => ({ id: e.id ?? '', text: e.text })),
      ...data.deepenings
        .filter((d) => d.checkId === id && d.addedInRun <= run.n)
        .flatMap((d) => (d.extra ?? []).map((e) => ({ id: e.id, text: e.text })))
    ].filter((e) => !done.has(e.id))
    return all.length
      ? [{ checkId: id, n: ordinalOf(run, id), title: check.title, items: all.map((e) => e.text) }]
      : []
  })

  const plural = (key: string, n: number): string =>
    t(`testWalk.closeout.part.${key}.${n === 1 ? 'one' : 'other'}`, { n })
  const parts: string[] = []
  if (c.skipped) parts.push(plural('skipped', c.skipped))
  if (c.failed) parts.push(plural('failed', c.failed))
  if (unverified) parts.push(plural('unverified', unverified))
  const owedCount = c.skipped + c.failed + unverified
  // "a", "a and b", "a, b and c": the words join in the operator's language
  const joined =
    parts.length > 1
      ? parts.slice(0, -1).join(', ') + t('testWalk.closeout.partAnd') + parts[parts.length - 1]
      : (parts[0] ?? '')
  const recheck = run.checks.flatMap((rc) => {
    const ck = byId(data.script, rc.id)
    if (!ck || ck.status !== 'caveat' || ck.openPr === undefined || rc.closedHow !== 'pre-closed')
      return []
    return [t('testWalk.closeout.recheck', { n: ck.title, pr: String(ck.openPr) })]
  })
  const criteria = data.criteria.map((k) => ({
    id: k.id,
    text: k.text,
    state: t(`testWalk.closeout.criterion.${k.state}`),
    open: k.state === 'open'
  }))
  const openCriteria = criteria.some((k) => k.open)
  const owed = parts.length > 0 || recheck.length > 0 || openCriteria
  return {
    title: t('testWalk.closeout.title'),
    sub: t(c.failed ? 'testWalk.closeout.subFailed' : 'testWalk.closeout.sub', {
      verified: c.verified,
      unverified,
      skipped: c.skipped,
      failed: c.failed
    }),
    rows,
    unticked,
    owed: owed
      ? {
          parts: parts.length
            ? t(`testWalk.closeout.owedMore.${owedCount === 1 ? 'one' : 'other'}`, {
                parts: joined
              })
            : '',
          recheck,
          criteria,
          link: openCriteria ? 'mission' : null,
          note: openCriteria ? t('testWalk.closeout.neverTick') : null
        }
      : null,
    nothingOwed: !owed,
    saved: {
      actions: [
        ...(WALK_CAPS.library ? (['open-walks'] as const) : []),
        ...(WALK_CAPS.export ? (['export'] as const) : [])
      ]
    },
    summary: data.closeOut ?? ''
  }
}

// ---- A past run, read-only (S-4, AC-21) ------------------------------------------------------------

export interface PastRunOption {
  runId: string
  n: number
  label: string
  current: boolean
  live: boolean
}

export interface PastNotes {
  /** What the operator wrote, one line per time it failed. */
  lines: string[]
  /** The screenshots the operator pasted: the file in the run's folder and its name. */
  shots: { path: string; name: string }[]
  /** The agent's one correction after a Failed. */
  correction: string | null
  /** What the agent's check found. */
  evidence: string | null
}

export interface PastRow extends CloseoutRow {
  notes: PastNotes | null
}

export interface PastRunView {
  /** `Walks`: the way back to the library. */
  back: string
  readOnly: string
  title: string
  /** `4 passed · 1 failed · 1 skipped`, plus what was not confirmed or never reached when there is any. */
  sub: string
  run: { label: string; options: PastRunOption[] }
  rows: PastRow[]
}

/** The pane's own lightbox shape for a screenshot of a past run (the same one a check's image uses). */
export function shotLightbox(shot: { path: string; name: string }): {
  src: string
  alt: string
  caption: string
} {
  return { src: shot.path, alt: shot.name, caption: shot.name }
}

const baseName = (path: string): string => path.split('/').pop() ?? path

function pastNotes(rc: RunCheck): PastNotes | null {
  const operator = rc.failures.filter((f) => f.from === 'operator')
  const notes: PastNotes = {
    lines: operator.flatMap((f) => (f.line ? [f.line] : [])),
    shots: operator.flatMap((f) => (f.shot ? [{ path: f.shot, name: baseName(f.shot) }] : [])),
    // the live card is cleared by Try again; the record keeps what the agent said (the latest one)
    correction: rc.correction?.text ?? rc.correctionLog?.at(-1)?.text ?? null,
    evidence: rc.report?.evidence ?? null
  }
  return notes.lines.length || notes.shots.length || notes.correction || notes.evidence
    ? notes
    : null
}

/**
 * An ended run as it was when it ended: the rail (one row per check THE RUN HAD, so a check added to the walk later
 * is hidden), each check's recorded outcome, and under a failed or noted one what the operator wrote, their
 * screenshots, the agent's correction and its evidence. Nothing here can be changed; the action bar holds Re-run and
 * Export markdown.
 */
function pastRunView(data: WalkData, t: T, locale: string): PastRunView {
  const run = data.run
  const c = counts(run)
  const when = (r: { startedAt?: number; endedAt?: number }): string =>
    shortDate(r.endedAt ?? r.startedAt ?? data.now, data.now, locale)
  const label = (r: NonNullable<WalkData['runs']>[number]): string =>
    r.state === 'live'
      ? t('walksLibrary.past.runLive', { n: r.n })
      : t('walksLibrary.past.run', { n: r.n, date: when(r) })
  const listed = data.runs ?? []
  const options: PastRunOption[] = (
    listed.some((r) => r.runId === data.runId)
      ? listed
      : [...listed, { runId: data.runId, n: run.n, state: run.state, endedAt: run.endedAt }]
  ).map((r) => ({
    runId: r.runId,
    n: r.n,
    label: label(r),
    current: r.runId === data.runId,
    live: r.state === 'live'
  }))
  const parts = [
    t('walksLibrary.past.sub', { passed: c.verified, failed: c.failed, skipped: c.skipped })
  ]
  if (c.caveat + c.disagrees > 0)
    parts.push(t('walksLibrary.past.subUnverified', { n: c.caveat + c.disagrees }))
  if (c.todo + c.awaiting > 0)
    parts.push(t('walksLibrary.past.subNotReached', { n: c.todo + c.awaiting }))
  return {
    back: t('walksLibrary.past.back'),
    readOnly: t('walksLibrary.past.readOnly'),
    title: data.script.title,
    sub: parts.join(' · '),
    run: { label: options.find((o) => o.current)?.label ?? '', options },
    rows: run.checks.map((rc) => ({ ...closeoutRow(data, rc, t), notes: pastNotes(rc) }))
  }
}

// ---- The pane -----------------------------------------------------------------------------------

export interface PaneView {
  mode: PaneMode
  /** The pane header's title: `Walk · <title>`. */
  title: string
  source: SourceHeader | null
  progress: ProgressView | null
  roadmap: RoadmapView | null
  check: CheckView | null
  skipped: { ids: string[]; rows: RoadmapRow[]; closeLabel: string } | null
  closeout: CloseoutView | null
  /** The action bar: the five outcomes, or only what the state's own rules call for. */
  outcomes: Outcome[]
  /** What the pane's primary action is (and so what Enter means). */
  primary: KeyContext['primary']
  /** The error state: the outbox is holding a turn no session could take. */
  error: { done: number; total: number } | null
  /** A past run, read-only (`mode: 'past'`). */
  past: PastRunView | null
  /** A turn is waiting for a parked session: one quiet line, the pane stays where it is. */
  waking: string | null
}

const EMPTY: PaneView = {
  mode: 'empty',
  title: '',
  source: null,
  progress: null,
  roadmap: null,
  check: null,
  skipped: null,
  closeout: null,
  outcomes: [],
  primary: null,
  error: null,
  past: null,
  waking: null
}

export function paneView(
  data: WalkData | null,
  ui: WalkUi,
  t: T,
  opts: { locale?: string } = {}
): PaneView {
  if (!data) return { ...EMPTY, mode: 'empty' }
  const run = data.run
  const isPast = ui.past && run.state === 'ended'
  const base = {
    title: data.script.title,
    // a past run names its run in the selector, so the source line carries no `Re-run · run N` chip there
    source: sourceHeader(data.script.source, t, {
      ...(isPast ? {} : { runN: run.n }),
      mission: data.mission
    }),
    waking: data.waking && run.state === 'live' ? t('testWalk.waking') : null
  }
  const mv = machineView(run)

  // a turn is due and no session can take it: the progress is saved, the way out is Resume the session
  if (data.held && run.state === 'live') {
    const cn = counts(run)
    return {
      ...EMPTY,
      ...base,
      mode: 'error',
      error: { done: cn.verified + cn.caveat, total: cn.total }
    }
  }

  if (run.state === 'ready' || (ui.roadmapOpen && run.state === 'live')) {
    const readOnly = run.state === 'live'
    const rm = roadmapView(data, readOnly, t)
    return {
      ...EMPTY,
      ...base,
      mode: 'roadmap',
      roadmap: rm,
      outcomes: readOnly
        ? []
        : [outcome(t, 'start', { look: 'primary', chip: 'Enter', label: rm.startLabel ?? '' })],
      primary: readOnly ? null : 'start'
    }
  }

  if (isPast) {
    return {
      ...EMPTY,
      ...base,
      mode: 'past',
      past: pastRunView(data, t, opts.locale ?? 'en'),
      outcomes: [
        outcome(t, 'rerun', { look: 'primary', chip: 'Enter' }),
        outcome(t, 'export', { look: 'neutral' })
      ],
      primary: 'rerun'
    }
  }

  if (mv.mode === 'closeout' || run.state === 'ended') {
    return { ...EMPTY, ...base, mode: 'closeout', closeout: closeoutView(data, t) }
  }

  if (mv.mode === 'skipped-list') {
    const rm = roadmapView(data, true, t)
    const rows = rm.rows.filter((r) => mv.ids.includes(r.id))
    return {
      ...EMPTY,
      ...base,
      mode: 'skipped',
      skipped: { ids: mv.ids, rows, closeLabel: t('testWalk.skipped.close', { n: mv.ids.length }) },
      outcomes: [
        outcome(t, 'pick-skipped', { look: 'primary', chip: 'Enter' }),
        outcome(t, 'close-out', { label: t('testWalk.skipped.close', { n: mv.ids.length }) })
      ],
      primary: 'pick-skipped'
    }
  }

  // a served check
  if (mv.mode !== 'check') return { ...EMPTY, ...base, mode: 'empty' }
  const rc = run.checks.find((c) => c.id === mv.checkId)!
  const check = checkView(data, rc, ui, t)
  const progress = progressView(run, check.checkId, t)

  if (ui.formOpen && (check.phase === 'todo' || check.phase === 'failed')) {
    return {
      ...EMPTY,
      ...base,
      mode: 'failed-form',
      progress,
      check,
      outcomes: [outcome(t, 'send', { look: 'primary', chip: 'Enter' }), outcome(t, 'cancel-form')],
      primary: 'send'
    }
  }

  let outcomes: Outcome[]
  let primary: KeyContext['primary']
  switch (check.phase) {
    case 'awaiting': {
      const delivered = rc.deliveredAt
      const waited = delivered !== null && data.now - delivered >= data.waitMs
      outcomes = waited ? [outcome(t, 'continue-without', { look: 'neutral', glyph: '!' })] : []
      primary = null
      break
    }
    case 'disagrees':
      outcomes = [
        outcome(t, 'try-again', { look: 'primary', chip: 'Enter' }),
        check.blocking
          ? outcome(t, 'treat-as-failed', { look: 'neutral', glyph: '✗' })
          : outcome(t, 'follow-anyway', { look: 'neutral', glyph: '!' }),
        outcome(t, 'back', { shortcut: 'B' })
      ]
      primary = 'try-again'
      break
    case 'failed':
      outcomes = fiveOutcomes(t, 'try-again', ui.explainOpen)
      primary = 'try-again'
      break
    default:
      outcomes = fiveOutcomes(t, 'done', ui.explainOpen)
      primary = 'done'
  }
  return { ...EMPTY, ...base, mode: 'check', progress, check, outcomes, primary }
}

/** The keyboard context of a view (what `mapWalkKey` needs). */
export function keyContext(view: PaneView, ui: WalkUi): KeyContext {
  return {
    mode: view.mode,
    primary: view.primary,
    available: new Set(view.outcomes.map((o) => o.id)),
    lightbox: ui.lightbox,
    roadmapOpen: ui.roadmapOpen,
    formOpen: ui.formOpen
  }
}

/** Is the failure form's Send allowed? A line or an image is needed (AC-15). */
export function canSendFailure(line: string, shot: string | null): boolean {
  return line.trim().length > 0 || !!shot
}
