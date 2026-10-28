/**
 * The report card's parser (T583 U2). Pure and `$`-free (MOD-1): it reads the text of one assistant
 * block and finds the reports the bundled `status` and `report-back` skills print, so the
 * `AssistantMessage` hook can draw them as a card. Display only: it never edits the message.
 *
 * It keys on SHAPE, never on label words, because the labels are written in the operator's
 * language ("you" / "você", "open" / "aberto"): the `▰▱` bar, the `├─` / `└─` rail with its
 * `✓ ✗ ! -` glyphs, the 2-wide gutter (blank, `⚑`, `?`, `!`) and the 9-wide label column.
 *
 * Fail safe is the whole contract: a block that looks like a report but does not parse strictly
 * makes the WHOLE message `null` (the caller draws the engine's own markdown), and nothing here
 * throws. A code block that is not a report (a `tree` output) stays plain text.
 */

export type Glyph = '✓' | '✗' | '!' | '-'
/** `owed` = `⚑` (the operator owes something), `open` = `?`, `warn` = `!`, `none` = blank. */
export type Gutter = 'none' | 'owed' | 'open' | 'warn'

export interface Header {
  /** The glyph in the header's gutter (`✓ ! ✗ -`), or null when blank. */
  mark: Glyph | null
  title: string
  /** The first `▰▱` run: how many cells are filled of how many. */
  bar: { filled: number; total: number } | null
  /** What follows the bar (`Step 4 of 5 · 2 verified`, `70%`), a lead word before it kept first. */
  detail: string
}
export interface RailRow {
  glyph: Glyph
  text: string
}
export interface LedgerRow {
  gutter: Gutter
  label: string
  /** The value, then its continuation lines. */
  lines: string[]
}
export interface LinkRow {
  label: string
  target: string
}
export interface Report {
  header: Header | null
  rail: RailRow[]
  ledger: LedgerRow[]
  links: LinkRow[]
}
export type Segment = { kind: 'text'; text: string } | { kind: 'report'; report: Report }

/** A row longer than this is not a report row (the skills cap theirs near 100). */
export const MAX_ROW_CHARS = 600
/** A block with more lines than this is not a report. */
export const MAX_BLOCK_LINES = 80
/** A message longer than this is not parsed at all. */
export const MAX_TEXT_CHARS = 100_000

const BAR_RE = /[▰▱]{2,}/
// Built from strings: the API-surface scan reads a `$` in code as the engine's `$` (MOD-1).
const RAIL_OPEN_RE = new RegExp('^│$')
const RAIL_ROW_RE = new RegExp('^[├└]─ ([✓✗!-]) (\\S.*)$')
const MARK_RE = /^([✓✗!-]) (?=\S)/
const GUTTERS: Record<string, Gutter> = { ' ': 'none', '⚑': 'owed', '?': 'open', '!': 'warn' }
const OPEN_FENCE_RE = new RegExp('^ {0,3}(`{3,}|~{3,})\\s*([\\w-]*)\\s*$')
const TRAILING_SPACE_RE = new RegExp('\\s+$')
const PR_REF_RE = new RegExp('^#(\\d+)$')
const LINK_ROW_RE = new RegExp('^(\\S.*?) → (\\S.*)$')
const URL_TAIL_RE = new RegExp('[.,;:!?)\\]]+$')
const PLAIN_INFO = new Set(['', 'text', 'txt', 'plain'])

const cleanTitle = (s: string): string => s.replace(/\*\*/g, '').replace(/`/g, '').trim()

type Line =
  | { k: 'blank' }
  | { k: 'opener' }
  | { k: 'rail'; row: RailRow }
  | { k: 'header'; header: Header }
  | { k: 'ledger'; row: LedgerRow }
  | { k: 'cont'; text: string }
  | { k: 'link'; row: LinkRow }
  | { k: 'unknown' }

function parseHeader(line: string): Header | null {
  const bar = BAR_RE.exec(line)
  if (!bar) return null
  let rest = line
  let mark: Glyph | null = null
  const m = MARK_RE.exec(rest)
  if (m) {
    mark = m[1] as Glyph
    rest = rest.slice(2)
  }
  const at = rest.indexOf(bar[0])
  const pre = rest.slice(0, at).trim()
  const after = rest.slice(at + bar[0].length).trim()
  const split = /\s{2,}/.exec(pre)
  const title = cleanTitle(split ? pre.slice(0, split.index) : pre)
  const lead = split ? pre.slice(split.index).trim() : ''
  const filled = [...bar[0]].filter((c) => c === '▰').length
  return {
    mark,
    title,
    bar: { filled, total: bar[0].length },
    detail: [lead, after].filter(Boolean).join(' ')
  }
}

function parseLedger(line: string): LedgerRow | null {
  const cp = [...line.padEnd(11)]
  const gutter = GUTTERS[cp[0]]
  if (gutter === undefined || cp[1] !== ' ') return null
  const label = cp.slice(2, 11).join('')
  // The label column is 9 wide and ends on a space: the value starts at the 12th column.
  if (cp[10] !== ' ' || label.trim() === '' || label[0] === ' ' || /\s{2,}/.test(label.trim())) {
    return null
  }
  return { gutter, label: label.trim(), lines: [cp.slice(11).join('').trim()] }
}

function classify(line: string, next: string | undefined, first: boolean): Line {
  if (line === '') return { k: 'blank' }
  if (RAIL_OPEN_RE.test(line)) return { k: 'opener' }
  const rail = RAIL_ROW_RE.exec(line)
  if (rail) return { k: 'rail', row: { glyph: rail[1] as Glyph, text: rail[2].trim() } }
  const header = parseHeader(line)
  if (header) return { k: 'header', header }
  // `report-back` without a bar: just the front name, directly above the rail's opener.
  if (first && next === '│' && /^\S/.test(line) && !line.includes(' → ')) {
    return { k: 'header', header: { mark: null, title: cleanTitle(line), bar: null, detail: '' } }
  }
  const ledger = parseLedger(line)
  if (ledger) return { k: 'ledger', row: ledger }
  if (/^ {11,}\S/.test(line)) return { k: 'cont', text: line.trim() }
  const link = LINK_ROW_RE.exec(line)
  if (link) {
    return { k: 'link', row: { label: link[1].replace(/`/g, '').trim(), target: link[2].trim() } }
  }
  return { k: 'unknown' }
}

/** Does this block look like a report at all? Only then is a strict parse failure a fallback. */
function looksLikeReport(lines: string[]): boolean {
  return lines.some((l) => RAIL_ROW_RE.test(l) || BAR_RE.test(l) || /^[⚑?] +\S/.test(l))
}

type Parsed = Report[] | 'invalid'

function parseBlock(raw: string[]): Parsed {
  if (raw.length > MAX_BLOCK_LINES) return 'invalid'
  const lines = raw.map((l) => l.replace(TRAILING_SPACE_RE, '').normalize('NFC'))
  if (lines.some((l) => [...l].length > MAX_ROW_CHARS)) return 'invalid'
  const reports: Report[] = []
  let cur: Report | null = null
  let prev: Line['k'] = 'blank'
  let seen = false // the first non-blank line of the block
  const start = (header: Header | null): Report => {
    const r: Report = { header, rail: [], ledger: [], links: [] }
    reports.push(r)
    return r
  }
  for (let i = 0; i < lines.length; i++) {
    const c = classify(lines[i], lines[i + 1], !seen)
    if (c.k === 'blank') {
      prev = 'blank'
      continue
    }
    seen = true
    if (c.k === 'unknown') return 'invalid'
    if (c.k === 'header') {
      cur = start(c.header)
    } else {
      cur ??= start(null)
      if (c.k === 'rail') cur.rail.push(c.row)
      else if (c.k === 'ledger') cur.ledger.push(c.row)
      else if (c.k === 'link') cur.links.push(c.row)
      else if (c.k === 'cont') {
        if (prev !== 'ledger' && prev !== 'cont') return 'invalid'
        cur.ledger[cur.ledger.length - 1].lines.push(c.text)
      }
    }
    prev = c.k
  }
  for (const r of reports) {
    const framed = (r.header?.bar ?? null) !== null || r.rail.length > 0
    if (!framed || r.ledger.length === 0) return 'invalid'
  }
  return reports.length > 0 ? reports : 'invalid'
}

const trimEdges = (lines: string[]): string => {
  let a = 0
  let b = lines.length
  while (a < b && lines[a].trim() === '') a++
  while (b > a && lines[b - 1].trim() === '') b--
  return lines.slice(a, b).join('\n')
}

/**
 * The message as text and report segments, or null when it holds no report (the hook then returns
 * `next(e)`). Null as well for anything partial: an unterminated fence, a report-looking block that
 * does not parse strictly, an oversized message.
 */
export function splitReports(text: string): Segment[] | null {
  try {
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_CHARS) return null
    const all = text.split(/\r?\n/)
    const segments: Segment[] = []
    let pending: string[] = []
    let found = false
    const flush = (): void => {
      const t = trimEdges(pending)
      if (t !== '') segments.push({ kind: 'text', text: t })
      pending = []
    }
    for (let i = 0; i < all.length; i++) {
      const open = OPEN_FENCE_RE.exec(all[i])
      if (!open) {
        pending.push(all[i])
        continue
      }
      const fenceChar = open[1][0]
      const close = new RegExp(
        '^ {0,3}' + (fenceChar === '`' ? '`' : '~') + '{' + open[1].length + ',}\\s*$'
      )
      let end = -1
      for (let j = i + 1; j < all.length; j++) {
        if (close.test(all[j])) {
          end = j
          break
        }
      }
      if (end === -1) return null // an unterminated fence: a block still streaming, or a broken one
      const inner = all.slice(i + 1, end)
      const whole = all.slice(i, end + 1)
      if (!PLAIN_INFO.has(open[2].toLowerCase()) || !looksLikeReport(inner)) {
        pending.push(...whole)
      } else {
        const parsed = parseBlock(inner)
        if (parsed === 'invalid') return null
        flush()
        for (const report of parsed) segments.push({ kind: 'report', report })
        found = true
      }
      i = end
    }
    flush()
    return found ? segments : null
  } catch {
    return null
  }
}

/** The card's border: green when every marker is `✓`, red when any is `✗`, else the accent. */
export function cardTone(report: Report): 'ok' | 'fail' | 'accent' {
  const marks: Glyph[] = report.rail.map((r) => r.glyph)
  if (report.header?.mark) marks.push(report.header.mark)
  if (marks.includes('✗')) return 'fail'
  if (marks.length > 0 && marks.every((m) => m === '✓')) return 'ok'
  return 'accent'
}

export type Inline =
  | { t: 'text'; s: string }
  | { t: 'code'; s: string }
  | { t: 'bold'; s: string }
  | { t: 'link'; s: string; href: string }

const INLINE_RE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|(https?:\/\/[^\s<>`]+)|(PR #\d+|#\d+)/g

/** `#142` -> its URL, from the links rows whose label names the number and whose target is a URL. */
export function linkIndex(links: readonly LinkRow[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const l of links) {
    if (!/^https?:\/\//.test(l.target)) continue
    for (const m of l.label.matchAll(/#(\d+)/g)) if (!out.has(m[1])) out.set(m[1], l.target)
  }
  return out
}

/** One row's value as inline pieces: code spans, bold, bare URLs and `PR #n` references as links. */
export function inlineOf(text: string, index: ReadonlyMap<string, string>): Inline[] {
  const out: Inline[] = []
  let at = 0
  const push = (s: string): void => {
    if (s !== '') out.push({ t: 'text', s })
  }
  for (const m of text.matchAll(INLINE_RE)) {
    push(text.slice(at, m.index))
    at = m.index + m[0].length
    if (m[1] !== undefined) {
      const ref = PR_REF_RE.exec(m[1])
      const href = ref ? index.get(ref[1]) : undefined
      out.push(href ? { t: 'link', s: m[1], href } : { t: 'code', s: m[1] })
    } else if (m[2] !== undefined) {
      out.push({ t: 'bold', s: m[2] })
    } else if (m[3] !== undefined) {
      const url = m[3].replace(URL_TAIL_RE, '')
      out.push({ t: 'link', s: url, href: url })
      push(m[3].slice(url.length))
    } else {
      const href = index.get(m[4].replace(/\D/g, ''))
      if (href) out.push({ t: 'link', s: m[4], href })
      else push(m[4])
    }
  }
  push(text.slice(at))
  return out
}
