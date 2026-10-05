/**
 * Legacy goal-file migration (T358 S7) — design
 * `docs/specs/2026-09-26-mission-progress/design.md` §9 "Migration".
 *
 * `importLegacyGoalFile` reads one `.harnu/goals/*.md` file (the free-markdown
 * goal state the `mission` skill wrote before Missions existed) and extracts the
 * fields it recognizes into Mission-shaped pieces. It is pure and total: it
 * never throws, never touches disk, and always hands the raw text back as
 * `legacyRaw` — the no-loss guarantee. The `mission_import_legacy` verb
 * (`mcp/tool-handlers.ts`) owns the I/O around it.
 *
 * The corpus is heterogeneous (T360 smoke test, Q7: 55 files, only ~31 in the
 * skill's standard section set), so extraction is best-effort by design:
 *  - `North star` / `Objective` → `declaredEnd.target`;
 *    `Done criteria` → `declaredEnd.evidence`; the kind is inferred from their
 *    words. Anything not found is a placeholder, and `declaredEnd` is then
 *    flagged `needs-review` (decision 5 requires a complete declared end);
 *  - `Executors` / `Units` (and the Portuguese `Executores`) table rows or
 *    bullets → one custom step each, with `session`/`card`/`pr` links;
 *  - `Pending gates` → mission-level blockers; `Open questions` → openQuestions;
 *  - `Log` → the new mission's Log, verbatim.
 * Every other section (`Topology`, `Ticks`, `Tick checklist`, …) has no Mission
 * field and survives in `legacyRaw` only.
 */

import type { Blocker, DeclaredEnd, MissionStep, StepLink } from './mission-core'

/** What {@link importLegacyGoalFile} extracted — the caller mints ids and writes. */
export interface LegacyGoalImport {
  /** From the first `# ` heading (a leading `Goal —` dropped), else the filename. */
  title: string
  /** The legacy frontmatter `session:` — only when it is a full session UUID. */
  session?: string
  /** Always complete (decision 5); placeholders fill what the file did not state. */
  declaredEnd: DeclaredEnd
  /** `['declaredEnd']` when any of its three fields was not read from the file. */
  needsReview: 'declaredEnd'[]
  /**
   * Custom steps, one per executor/unit, with ids `stp-3…` (stp-1/stp-2 are the
   * fixed frame) and ordinals `2…` — the caller places them between the frame.
   */
  steps: MissionStep[]
  /** Mission-level blockers, from `Pending gates`. */
  blockers: Blocker[]
  openQuestions: string[]
  /** The legacy `## Log` section's content, verbatim; `''` when there is none. */
  log: string
  /** Which Mission fields were read from the file (not placeholders). */
  extractedFields: string[]
  /** The input, unchanged — the no-loss guarantee (design §9 step 2). */
  legacyRaw: string
}

// ---- recognized vocabulary (the corpus shapes T360 measured) ----------------

type SectionRole = 'target' | 'evidence' | 'units' | 'gates' | 'questions' | 'log'

/**
 * Normalized `## ` heading → what it feeds. `executores` is the Portuguese
 * heading the corpus actually carries — a parse token, not prose.
 */
const SECTION_ROLES: Record<string, SectionRole> = {
  'north star': 'target',
  objective: 'target',
  goal: 'target',
  'done criteria': 'evidence',
  'definition of done': 'evidence',
  'done when': 'evidence',
  executors: 'units',
  executores: 'units',
  units: 'units',
  'pending gates': 'gates',
  blockers: 'gates',
  'open questions': 'questions',
  log: 'log'
}

const SESSION_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
/** Harnu board ids (`T123`, `BUG-42`), optionally with their slug tail. */
const CARD_RE = /\b(?:T\d+|BUG-\d+)(?:-[a-z0-9]+)*\b/g
const GITHUB_PR_URL_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g
const REPO_PR_RE = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/g
const BARE_PR_RE = /(^|[\s(])#(\d+)\b/g

const IMPORTED_STEP_REASON = 'Imported from the legacy goal file (one step per executor/unit).'
const IMPORTED_GATE_UNBLOCKS =
  'Imported from the legacy goal file — confirm it still applies, then clear it.'
const MISSING_EVIDENCE =
  'Not stated in the legacy goal file — review and re-scope before approving.'

// ---- parsing ------------------------------------------------------------------

interface Section {
  heading: string
  /** Everything after the heading line up to the next `## ` heading, verbatim. */
  body: string
}

/** A heading's comparable form: no emoji/punctuation edges, lowercase, one space. */
function normalizeHeading(text: string): string {
  return text
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

/** The leading `---` frontmatter block's inner text and where the body starts. */
function splitFrontmatter(raw: string): { inner: string; bodyStart: number } {
  const open = /^---[ \t]*\r?\n/.exec(raw)
  if (!open) return { inner: '', bodyStart: 0 }
  const rest = raw.slice(open[0].length)
  const close = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/.exec(rest)
  if (!close) return { inner: '', bodyStart: 0 }
  return {
    inner: rest.slice(0, close.index),
    bodyStart: open[0].length + close.index + close[0].length
  }
}

/**
 * The body's `# ` title and its `## ` sections, skipping fenced code blocks so a
 * heading inside a ``` fence is never read as structure.
 */
function splitSections(body: string): { title?: string; sections: Section[] } {
  const lines = body.split(/(?<=\n)/) // keep each line's own terminator
  const sections: Section[] = []
  let title: string | undefined
  let current: Section | null = null
  let fence: string | null = null
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, '')
    const fenceMark = /^\s{0,3}(`{3,}|~{3,})/.exec(bare)?.[1]
    if (fenceMark) {
      if (fence === null) fence = fenceMark[0]
      else if (fenceMark[0] === fence) fence = null
    }
    if (fence === null && !fenceMark) {
      const h2 = /^##[ \t]+(.+?)[ \t#]*$/.exec(bare)
      if (h2) {
        current = { heading: h2[1], body: '' }
        sections.push(current)
        continue
      }
      const h1 = /^#[ \t]+(.+?)[ \t#]*$/.exec(bare)
      if (h1 && title === undefined) title = h1[1].trim()
    }
    if (current) current.body += line
  }
  return { title, sections }
}

/** A section's meaningful lines: no HTML comments, template placeholders or blanks. */
function contentLines(body: string): string[] {
  return body
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^<[^>]*>$/.test(l))
}

const BULLET_RE = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/

/** Prose for a declared-end field: bullets joined with `; `, paragraphs with a space. */
function sectionText(body: string): string {
  const lines = contentLines(body).filter((l) => !l.startsWith('|'))
  if (lines.some((l) => BULLET_RE.test(l))) {
    return lines
      .map((l) => BULLET_RE.exec(l)?.[1] ?? l)
      .map((l) => l.trim())
      .filter(Boolean)
      .join('; ')
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim()
}

/** Top-level bullet items (checkbox dropped), or every line when there are none. */
function listItems(body: string): string[] {
  const lines = contentLines(body).filter((l) => !l.startsWith('|'))
  const bullets = lines.flatMap((l) => {
    const m = BULLET_RE.exec(l)
    return m ? [m[1].trim()] : []
  })
  const items = bullets.length > 0 ? bullets : lines
  return items.filter((i) => i.length > 0 && !/^(?:none|n\/a|—|-|tbd)\.?$/i.test(i))
}

interface TableRow {
  headers: string[]
  cells: string[]
}

/** Markdown table rows (header + separator skipped; empty/placeholder rows dropped). */
function tableRows(body: string): TableRow[] {
  const rows: TableRow[] = []
  let headers: string[] | null = null
  const cellsOf = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) {
      headers = null // a table ends at its first non-row line
      continue
    }
    const cells = cellsOf(line)
    if (headers === null) {
      headers = cells
      continue
    }
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue
    if (cells.every((c) => c === '' || /^<[^>]*>$/.test(c))) continue
    rows.push({ headers, cells })
  }
  return rows
}

/** Every session / card / pr reference in a piece of text, in that order, de-duplicated. */
function linksIn(text: string): StepLink[] {
  const links: StepLink[] = []
  const add = (kind: StepLink['kind'], ref: string): void => {
    if (!links.some((l) => l.kind === kind && l.ref === ref)) links.push({ kind, ref })
  }
  for (const m of text.matchAll(SESSION_UUID_RE)) add('session', m[0].toLowerCase())
  // UUIDs out first: their hex groups must not read as anything else.
  const rest = text.replace(SESSION_UUID_RE, ' ')
  for (const m of rest.matchAll(CARD_RE)) add('card', m[0])
  const prs: StepLink[] = []
  let unscanned = rest.replace(GITHUB_PR_URL_RE, (_, owner, repo, n) => {
    prs.push({ kind: 'pr', ref: `${owner}/${repo}#${n}` })
    return ' '
  })
  unscanned = unscanned.replace(REPO_PR_RE, (_, repo, n) => {
    prs.push({ kind: 'pr', ref: `${repo}#${n}` })
    return ' '
  })
  for (const m of unscanned.matchAll(BARE_PR_RE)) prs.push({ kind: 'pr', ref: `#${m[2]}` })
  for (const p of prs) add(p.kind, p.ref)
  return links
}

/** A table row's step title: its deliverable, else its card/unit, else its first cell. */
function rowTitle(row: TableRow): string {
  const pick = (re: RegExp): string | undefined => {
    const i = row.headers.findIndex((h) => re.test(h))
    const cell = i >= 0 ? row.cells[i] : undefined
    return cell && !/^<[^>]*>$/.test(cell) ? cell : undefined
  }
  return (
    pick(/deliverable|title|task/i) ??
    pick(/^(?:card|cards|card\(s\)|unit|units)$/i) ??
    row.cells.find((c) => c.length > 0) ??
    ''
  )
}

/** A board id's stable prefix (`T402-importer-writer` → `T402`), for merging. */
function cardKey(ref: string): string {
  return /^(?:T\d+|BUG-\d+)/.exec(ref)?.[0] ?? ref
}

/** A title fit for a step: one line, bounded. */
function clampTitle(text: string, fallback: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length === 0) return fallback
  return one.length > 200 ? `${one.slice(0, 199)}…` : one
}

/**
 * Units from `Executors`/`Units` sections: table rows first, bullets when a
 * section has no table. A unit naming a card an earlier unit already names is
 * the same unit seen twice (a Units table plus an Executores list) — its links
 * merge into the earlier step instead of adding a duplicate.
 */
function importSteps(sections: Section[]): MissionStep[] {
  const units: Array<{ title: string; links: StepLink[] }> = []
  for (const s of sections) {
    const rows = tableRows(s.body)
    const found =
      rows.length > 0
        ? rows.map((r) => ({ title: rowTitle(r), links: linksIn(r.cells.join(' | ')) }))
        : listItems(s.body).map((item) => ({ title: item, links: linksIn(item) }))
    for (const unit of found) {
      const keys = unit.links.filter((l) => l.kind === 'card').map((l) => cardKey(l.ref))
      const same = units.find((u) =>
        u.links.some((l) => l.kind === 'card' && keys.includes(cardKey(l.ref)))
      )
      if (same) {
        for (const l of unit.links) {
          const dup = same.links.some(
            (x) =>
              x.kind === l.kind &&
              (x.ref === l.ref || (l.kind === 'card' && cardKey(x.ref) === cardKey(l.ref)))
          )
          if (!dup) same.links.push(l)
        }
      } else {
        units.push(unit)
      }
    }
  }
  return units.map((u, i) => ({
    id: `stp-${i + 3}`,
    ordinal: i + 2,
    kind: 'custom',
    title: clampTitle(u.title, `Imported unit ${i + 1}`),
    verification: 'verifier',
    proof: 'unproven',
    links: u.links,
    blockers: [],
    addedReason: IMPORTED_STEP_REASON
  }))
}

/** The declared-end kind its words point at; `null` when nothing does. */
function inferKind(text: string): DeclaredEnd['kind'] | null {
  if (/\b(?:PRs?|pull requests?|merged?|commits?|branch(?:es)?|CI)\b/.test(text)) return 'code'
  if (/\b(?:UI|screens?|mockups?|layouts?|visual)\b/i.test(text)) return 'ui'
  if (/\b(?:research|study|report|investigat\w*|analysis|memo)\b/i.test(text)) return 'research'
  if (/\b(?:decide|decision|ADR)\b/i.test(text)) return 'decision'
  return null
}

/** A title from a goal filename: `<session8>-` prefix and `.md` dropped, dashes spaced. */
function titleFromFileName(fileName: string | undefined): string {
  const base = (fileName ?? '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.md$/i, '')
    .replace(/^[0-9a-f]{8}-/i, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  return base.length > 0 ? base : 'Imported goal'
}

// ---- the importer ---------------------------------------------------------------

/**
 * Extract what a legacy goal file states into Mission-shaped pieces. Pure and
 * total — never throws, whatever the input: a file with no recognized heading
 * still yields a complete declared end (placeholders, flagged `needs-review`),
 * no steps, and `legacyRaw` equal to the input (Review Focus #3).
 */
export function importLegacyGoalFile(
  raw: string,
  opts: { now: string; fileName?: string }
): LegacyGoalImport {
  const text = typeof raw === 'string' ? raw : ''
  const extracted: string[] = []
  const { inner, bodyStart } = splitFrontmatter(text)
  const { title: h1, sections } = splitSections(text.slice(bodyStart))
  const byRole = (role: SectionRole): Section[] =>
    sections.filter((s) => SECTION_ROLES[normalizeHeading(s.heading)] === role)

  const headingTitle = h1?.replace(/^goal\s*[—–:-]\s*/i, '').trim()
  const title = clampTitle(headingTitle ?? '', titleFromFileName(opts.fileName))
  if (headingTitle) extracted.push('title')

  const session = /^session:[ \t]*["']?([0-9a-f-]{36})["']?[ \t]*$/im.exec(inner)?.[1]
  const validSession =
    session && new RegExp(`^${SESSION_UUID_RE.source}$`, 'i').test(session)
      ? session.toLowerCase()
      : undefined
  if (validSession) extracted.push('session')

  const target = byRole('target')
    .map((s) => sectionText(s.body))
    .find((t) => t.length > 0)
  const evidence = byRole('evidence')
    .map((s) => sectionText(s.body))
    .find((t) => t.length > 0)
  if (target) extracted.push('declaredEnd.target')
  if (evidence) extracted.push('declaredEnd.evidence')
  const kind = inferKind(`${target ?? ''} ${evidence ?? ''}`)
  if (kind) extracted.push('declaredEnd.kind')
  const declaredEnd: DeclaredEnd = {
    kind: kind ?? 'other',
    target:
      target ??
      `Not stated in the legacy goal file "${title}" — review and re-scope before approving.`,
    evidence: evidence ?? MISSING_EVIDENCE
  }
  const needsReview: 'declaredEnd'[] = target && evidence && kind ? [] : ['declaredEnd']

  const steps = importSteps(byRole('units'))
  if (steps.length > 0) extracted.push('steps')

  const blockers: Blocker[] = byRole('gates')
    .flatMap((s) => listItems(s.body))
    .map((reason) => ({
      reason,
      unblocks: IMPORTED_GATE_UNBLOCKS,
      owner: 'agent' as const,
      raisedAt: opts.now
    }))
  if (blockers.length > 0) extracted.push('blockers')

  const openQuestions = byRole('questions').flatMap((s) => listItems(s.body))
  if (openQuestions.length > 0) extracted.push('openQuestions')

  const logSection = byRole('log')[0]
  const log = logSection?.body ?? ''
  if (contentLines(log).length > 0) extracted.push('log')

  return {
    title,
    ...(validSession ? { session: validSession } : {}),
    declaredEnd,
    needsReview,
    steps,
    blockers,
    openQuestions,
    log,
    extractedFields: extracted,
    legacyRaw: text
  }
}
