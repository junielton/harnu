// The parser and the checks behind `harnu:spec check` (T601 S-1, S-2).
//
// `parseSpec(content)` reads the wave-A template shape (docs/specs/TEMPLATE.md plus the
// conventions the spec adds: `gated-by:`, `NG-n` bullets, `existing:` tokens, `card` rows)
// into plain data. `acHash(statement, proof)` is the Wave A content hash of an AC line.
// `checkSpecFile` runs the gate's rules as if the draft were approved, then the capability-order
// and atom-coverage checks, and returns every finding. `parseCard` and `checkCards` are the
// `--cards` drift lint: card AC lines compared with the spec rows, never graded. `parseCritics`
// and `checkCritics` lint the Goldfish review record (`critics.md`) beside the spec (S-9).
//
// Dependency-free ES module (Node built-ins only), vendored in the skill directory so the
// staging copies it into any session that has the skill. No I/O: the CLI in spec-check.mjs
// reads the file and prints the findings.

import { createHash } from 'node:crypto'
import {
  checkSpec,
  isSeparatorRow,
  parseHeader,
  sectionKey,
  splitRow,
  splitSections
} from './spec-gate-core.mjs'

const EMPTY_RE = /^(?:[-–—]+|none)?$/i
const ATOM_RE = /\bR-\d+\b/g

/** A cell or list item that means "nothing": empty, a dash, or `none`. */
const isEmpty = (text) => EMPTY_RE.test(text.replace(/[`*]/g, '').trim())

/** `a, b` → `['a', 'b']`, backticks and bold dropped, empties and dashes removed. */
function splitList(text) {
  return text
    .split(',')
    .map((t) => t.replace(/[`*]/g, '').trim())
    .filter((t) => t && !isEmpty(t))
}

/** The backticked spans of a value; falls back to a comma list when there are none. */
function backtickedList(text) {
  const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean)
  return spans.length > 0 ? spans : splitList(text)
}

const cellText = (text) => (isEmpty(text) ? '' : text.trim())

/**
 * The Wave A content hash of one AC line: `#` and the first four hex characters of the sha256 of
 * `<statement> | <proof>` with every run of whitespace collapsed after the join, backticks kept.
 * @param {string} statement
 * @param {string} proof
 * @returns {string}  e.g. `#8abc`
 */
export function acHash(statement, proof) {
  const text = `${statement} | ${proof}`.replace(/\s+/g, ' ').trim()
  return `#${createHash('sha256').update(text).digest('hex').slice(0, 4)}`
}

/** Rows of the first table in a section, keyed by the header's column names (lowercase). */
function tableRows(sectionLines) {
  const rows = []
  let columns = null
  for (const { line, no } of sectionLines) {
    if (!line.trim().startsWith('|')) {
      if (columns && rows.length > 0 && line.trim() === '') break
      continue
    }
    const cells = splitRow(line)
    if (isSeparatorRow(cells)) continue
    if (!columns) {
      columns = cells.map((c) => c.toLowerCase())
      continue
    }
    const get = (name) => {
      const idx = columns.findIndex((c) => c === name || c.startsWith(name))
      return idx === -1 ? '' : (cells[idx] ?? '')
    }
    rows.push({ line: no, get })
  }
  return rows
}

/** Every table row of a section, across several tables (the Amendments section may have more than one). */
function allTableRows(sectionLines) {
  const rows = []
  let block = []
  const flush = () => {
    if (block.length > 0) rows.push(...tableRows(block))
    block = []
  }
  for (const entry of sectionLines) {
    if (entry.line.trim().startsWith('|')) block.push(entry)
    else flush()
  }
  flush()
  return rows
}

/** `- R-n …` bullets (with their indented continuation lines) → `{ id, line, text }`. */
function bullets(sectionLines, idPattern) {
  const out = []
  let current = null
  const startRe = new RegExp(`^\\s*[-*]\\s+\\**(${idPattern})\\b`)
  for (const { line, no } of sectionLines) {
    const m = startRe.exec(line)
    if (m) {
      current = { id: m[1], line: no, text: line }
      out.push(current)
      continue
    }
    if (current && /^\s+\S/.test(line) && !/^\s*[-*]\s/.test(line)) {
      current.text += `\n${line}`
      continue
    }
    current = null
  }
  return out
}

const SLICE_KEYS = {
  'depends-on': 'dependsOn',
  substrate: 'substrate',
  'files-may-touch': 'files',
  produces: 'produces',
  consumes: 'consumes',
  'gated-by': 'gatedBy',
  acs: 'acs'
}

function parseSlices(sectionLines) {
  const slices = []
  let current = null
  for (const { line, no } of sectionLines) {
    const h = /^###\s+(.+?)\s*$/.exec(line)
    if (h) {
      const idMatch = /^(S-[A-Za-z0-9]+)/.exec(h[1])
      current = {
        id: idMatch ? idMatch[1] : h[1],
        line: no,
        title: h[1],
        dependsOn: [],
        substrate: '',
        files: [],
        produces: [],
        consumes: [],
        gatedBy: [],
        acs: [],
        consumesLine: undefined
      }
      slices.push(current)
      continue
    }
    if (!current) continue
    const b = /^\s*[-*]\s+([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!b) continue
    const key = SLICE_KEYS[b[1].toLowerCase()]
    if (!key) continue
    const value = b[2].trim()
    if (key === 'substrate') current.substrate = cellText(value.replace(/[`*]/g, ''))
    else if (key === 'files') current.files = isEmpty(value) ? [] : backtickedList(value)
    else current[key] = splitList(value)
    if (key === 'consumes') current.consumesLine = no
  }
  return slices
}

function parseAcs(sectionLines) {
  return tableRows(sectionLines)
    .map((row) => ({
      id: row.get('id').replace(/[`*]/g, '').trim(),
      line: row.line,
      statement: row.get('statement').trim(),
      proof: row.get('proof').trim(),
      refines: cellText(row.get('refines')),
      covers: splitList(row.get('covers'))
    }))
    .filter((ac) => ac.id)
}

function parseDecisions(sectionLines) {
  return tableRows(sectionLines)
    .map((row) => ({
      id: row.get('id').replace(/[`*]/g, '').trim(),
      line: row.line,
      status: row.get('status').trim(),
      question: row.get('question').trim()
    }))
    .filter((d) => /^D-\d+$/.test(d.id))
}

/** `card` rows of the Amendments table (`S-n → slug`, ASCII `->` accepted); the last row per slice wins. */
function parseCards(sectionLines) {
  const bySlice = new Map()
  for (const row of allTableRows(sectionLines)) {
    if (row.get('kind').replace(/[`*]/g, '').trim().toLowerCase() !== 'card') continue
    const m = /(S-[A-Za-z0-9]+)\s*(?:→|->)\s*`?([^\s|`]+)`?/.exec(row.get('what'))
    if (!m) continue
    bySlice.set(m[1], { slice: m[1], card: m[2], line: row.line })
  }
  return [...bySlice.values()]
}

/** Drop fenced code (markers included): an example inside a fence is not part of the spec. */
function outsideFences(sectionLines) {
  let inFence = false
  return sectionLines.filter(({ line }) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      return false
    }
    return !inFence
  })
}

/**
 * @param {string} content  the spec file text
 * @returns {{
 *   header: Record<string, string> | null,
 *   atoms: { id: string, line: number }[],
 *   nonGoals: { id: string, line: number, cites: string[] }[],
 *   slices: { id: string, line: number, title: string, dependsOn: string[], substrate: string,
 *     files: string[], produces: string[], consumes: string[], gatedBy: string[], acs: string[],
 *     consumesLine?: number }[],
 *   acs: { id: string, line: number, statement: string, proof: string, refines: string, covers: string[] }[],
 *   decisions: { id: string, line: number, status: string, question: string }[],
 *   cards: { slice: string, card: string, line: number }[]
 * }}  Line numbers are 1-based in the whole file. A missing section yields an empty list.
 */
export function parseSpec(content) {
  const { header, bodyStart } = parseHeader(content)
  const { sections } = splitSections(content.split('\n'), bodyStart)
  const section = (key) => outsideFences(sections.get(key) ?? [])

  return {
    header,
    atoms: bullets(section('problem'), 'R-\\d+').map(({ id, line }) => ({ id, line })),
    nonGoals: bullets(section('goals'), 'NG-\\d+').map(({ id, line, text }) => ({
      id,
      line,
      cites: [...new Set(text.match(ATOM_RE) ?? [])]
    })),
    slices: parseSlices(section('slices')),
    acs: parseAcs(section('acceptance criteria')),
    decisions: parseDecisions(section('open decisions')),
    cards: parseCards(section('amendments'))
  }
}

/** The slices that precede `slice`: its transitive `depends-on` closure (never itself, cycle-safe). */
function precedingSlices(slice, byId) {
  const seen = new Set()
  const stack = [...slice.dependsOn]
  while (stack.length > 0) {
    const id = stack.pop()
    if (seen.has(id)) continue
    seen.add(id)
    const dep = byId.get(id)
    if (dep) stack.push(...dep.dependsOn)
  }
  seen.delete(slice.id)
  return seen
}

/**
 * Capability order: every capability a slice consumes is produced by a slice in its depends-on
 * closure. `existing:<name>` tokens are exempt; tokens match exactly, case-sensitive.
 * @param {ReturnType<typeof parseSpec>} parsed
 * @returns {{ line: number, rule: 'missing-producer' | 'producer-not-before', message: string }[]}
 */
export function checkCapabilityOrder(parsed) {
  const byId = new Map(parsed.slices.map((s) => [s.id, s]))
  const producers = new Map() // token -> slice ids
  for (const s of parsed.slices) {
    for (const token of s.produces) {
      if (!producers.has(token)) producers.set(token, [])
      producers.get(token).push(s.id)
    }
  }

  const findings = []
  for (const slice of parsed.slices) {
    const before = precedingSlices(slice, byId)
    const line = slice.consumesLine ?? slice.line
    for (const token of slice.consumes) {
      if (token.startsWith('existing:')) continue
      const makers = producers.get(token) ?? []
      if (makers.length === 0) {
        findings.push({
          line,
          rule: 'missing-producer',
          message: `${slice.id} consumes \`${token}\`, which no slice produces — add the slice that produces it, or write \`existing:${token}\` if it is already in the repo`
        })
      } else if (!makers.some((m) => m !== slice.id && before.has(m))) {
        const list = makers.join(', ')
        const why = makers.every((m) => m === slice.id)
          ? `only ${slice.id} itself produces it`
          : `it is produced only by ${list}, which ${makers.length === 1 ? 'is' : 'are'} not in ${slice.id}'s depends-on closure`
        findings.push({
          line,
          rule: 'producer-not-before',
          message: `${slice.id} consumes \`${token}\`, but ${why} — a slice must come after the slice that produces what it consumes`
        })
      }
    }
  }
  return findings
}

/**
 * Atom coverage: every request atom is cited by an AC `covers` cell, an `NG-` bullet or an
 * Open-decisions question cell; a spec with no atoms at all is itself a finding.
 * @param {ReturnType<typeof parseSpec>} parsed
 * @param {{ noAtomsLine?: number }} [options]  where to report `no-atoms` (the Problem heading)
 * @returns {{ line: number, rule: 'no-atoms' | 'uncovered-atom', message: string }[]}
 */
export function checkAtomCoverage(parsed, options = {}) {
  if (parsed.atoms.length === 0) {
    return [
      {
        line: options.noAtomsLine ?? 1,
        rule: 'no-atoms',
        message:
          'the Problem section has no request atoms — write one `- R-n …` bullet per sentence the requester said, so every AC can say which atom it covers'
      }
    ]
  }
  const cited = new Set()
  for (const ac of parsed.acs) for (const id of ac.covers) cited.add(id)
  for (const ng of parsed.nonGoals) for (const id of ng.cites) cited.add(id)
  for (const d of parsed.decisions) for (const id of d.question.match(ATOM_RE) ?? []) cited.add(id)

  return parsed.atoms
    .filter((atom) => !cited.has(atom.id))
    .map((atom) => ({
      line: atom.line,
      rule: 'uncovered-atom',
      message: `request atom ${atom.id} is cited by no AC \`covers\` cell, no NG- bullet and no Open-decisions question — cover it, record a non-goal, or ask the decision`
    }))
}

const CARD_AC_RE =
  /^\s*[-*]\s+\[[ xX]\]\s+\**([A-Za-z]+-[A-Za-z0-9]+)\**(?:\s+#([0-9a-fA-F]{4}))?(?=\s|$)/
const SLICE_MARKER_RE = /^\s*spec-slice:\s*`?(S-[A-Za-z0-9]+)`?\s*$/

/** A repo-relative path as a card or a CLI writes it: backticks, quotes and a leading `./` dropped. */
const normalizePath = (p) =>
  p
    .replace(/[`'"]/g, '')
    .trim()
    .replace(/^(?:\.\/)+/, '')

/**
 * One board card, as `spec check --cards` reads it.
 * @param {string} content  the card file text
 * @returns {{ spec: string | null, specLine: number | null, slice: string | null,
 *   sliceLine: number | null, acs: { id: string, hash: string | null, line: number }[] }}
 *   `spec` is the frontmatter `spec:` value, `slice` the body's `spec-slice: S-n` marker, `acs`
 *   every `- [ ] <id> [#xxxx] …` line outside fenced code (`hash` null on an unhashed line).
 *   Line numbers are 1-based.
 */
export function parseCard(content) {
  const lines = content.split('\n')
  let spec = null
  let specLine = null
  let bodyStart = 0
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    if (end !== -1) {
      for (let i = 1; i < end; i++) {
        const m = /^spec:\s*(.*)$/.exec(lines[i])
        if (m && normalizePath(m[1])) {
          spec = normalizePath(m[1])
          specLine = i + 1
        }
      }
      bodyStart = end + 1
    }
  }

  let slice = null
  let sliceLine = null
  const acs = []
  let inFence = false
  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const marker = SLICE_MARKER_RE.exec(line)
    if (marker && slice === null) {
      slice = marker[1]
      sliceLine = i + 1
      continue
    }
    const ac = CARD_AC_RE.exec(line)
    if (ac) acs.push({ id: ac[1], hash: ac[2] ? `#${ac[2].toLowerCase()}` : null, line: i + 1 })
  }
  return { spec, specLine, slice, sliceLine, acs }
}

/**
 * Card-versus-spec drift (`spec check --cards`). Reads the cards whose `spec:` names the spec and
 * reports, per AC line: `hash-diverged` (the card's `#xxxx` differs from the hash of the spec
 * row), `unknown-ac` (a hashed id the spec does not have) and `missing-ac` (an AC the slice lists
 * that its card does not carry). A card's slice is its `spec-slice` marker, else the Amendments
 * `card` row naming its slug (the marker wins when they disagree). An unhashed line is a card-only
 * AC: listed as information, never compared. It lints and never grades.
 * @param {ReturnType<typeof parseSpec>} parsed
 * @param {string} specPath  the spec's repo-relative path, as cards write it in `spec:`
 * @param {{ path: string, slug: string, content: string }[]} cards  the board's cards
 * @returns {{ matched: string[],
 *   findings: { path: string, line: number, rule: 'hash-diverged' | 'unknown-ac' | 'missing-ac', message: string }[],
 *   info: { path: string, line: number, message: string }[] }}  `matched` lists the paths read
 */
export function checkCards(parsed, specPath, cards) {
  const target = normalizePath(specPath)
  const acById = new Map(parsed.acs.map((ac) => [ac.id, ac]))
  const sliceById = new Map(parsed.slices.map((s) => [s.id, s]))
  const sliceBySlug = new Map(parsed.cards.map((c) => [c.card, c.slice]))
  const matched = []
  const findings = []
  const info = []

  for (const { path, slug, content } of cards) {
    const card = parseCard(content)
    if (card.spec !== target) continue
    matched.push(path)

    for (const line of card.acs) {
      if (line.hash === null) {
        info.push({
          path,
          line: line.line,
          message: `${line.id} has no hash: a card-only AC, listed for information and not compared with the spec`
        })
        continue
      }
      const row = acById.get(line.id)
      if (!row) {
        findings.push({
          path,
          line: line.line,
          rule: 'unknown-ac',
          message: `${line.id} ${line.hash} is not in the spec's Acceptance criteria table — an id the spec does not have cannot be traced to it; add the AC to the spec through an Amendments row, or drop the hash if it is a card-only AC`
        })
        continue
      }
      const expected = acHash(row.statement, row.proof)
      if (line.hash !== expected) {
        findings.push({
          path,
          line: line.line,
          rule: 'hash-diverged',
          message: `${line.id} carries ${line.hash}, but the spec row (line ${row.line}) hashes to ${expected} — the card no longer says what the spec says; copy the statement and proof from the spec row again, or amend the spec`
        })
      }
    }

    const sliceId = card.slice ?? sliceBySlug.get(slug) ?? null
    if (sliceId === null) continue
    const slice = sliceById.get(sliceId)
    if (!slice) {
      info.push({
        path,
        line: card.sliceLine ?? card.specLine ?? 1,
        message: `the card names slice ${sliceId}, which the spec does not have; its slice ACs are not compared`
      })
      continue
    }
    const onCard = new Set(card.acs.map((a) => a.id))
    const line = (card.slice !== null ? card.sliceLine : card.specLine) ?? 1
    for (const id of slice.acs) {
      if (onCard.has(id)) continue
      findings.push({
        path,
        line,
        rule: 'missing-ac',
        message: `${slice.id} lists ${id}, but its card has no ${id} line — copy the AC line from the spec row onto the card`
      })
    }
  }

  const byLine = (a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1)
  return { matched, findings: findings.sort(byLine), info: info.sort(byLine) }
}

/** The `## <heading>` sections of a markdown text, by lowercase heading, as `{ line, no }` lists. */
function markdownSections(content) {
  const out = new Map()
  let current = null
  let inFence = false
  content.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const h = !inFence && /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      current = []
      out.set(h[1].toLowerCase(), current)
      return
    }
    if (current && !inFence) current.push({ line, no: i + 1 })
  })
  return out
}

/**
 * The Goldfish review record beside a spec (`critics.md`), in the shape the skill documents: a
 * `## Reviewers` table (`reviewer | round | model | status`) and a `## Findings` table
 * (`id | reviewer | severity | finding | disposition | evidence`).
 * @param {string} content  the critics.md text
 * @returns {{ structured: boolean,
 *   reviewers: { reviewer: string, round: number, model: string, status: string, line: number }[],
 *   findings: { id: string, reviewer: string, severity: string, finding: string,
 *     disposition: string, evidence: string, line: number }[] }}
 *   `structured` is false when the file has neither table (a free-form record, not linted).
 */
export function parseCritics(content) {
  const secs = markdownSections(content)
  const plain = (text) => text.replace(/[`*]/g, '').trim()
  const reviewers = tableRows(secs.get('reviewers') ?? [])
    .map((row) => ({
      reviewer: plain(row.get('reviewer')),
      round: Number.parseInt(plain(row.get('round')), 10) || 1,
      model: plain(row.get('model')),
      status: plain(row.get('status')),
      line: row.line
    }))
    .filter((r) => r.reviewer)
  const findings = tableRows(secs.get('findings') ?? [])
    .map((row) => ({
      id: plain(row.get('id')),
      reviewer: plain(row.get('reviewer')),
      severity: plain(row.get('severity')),
      finding: row.get('finding').trim(),
      disposition: cellText(plain(row.get('disposition'))),
      evidence: cellText(row.get('evidence')),
      line: row.line
    }))
    .filter((f) => f.id)
  return { structured: secs.has('reviewers') || secs.has('findings'), reviewers, findings }
}

/** Evidence that says only "it is meant to be": not checkable. */
const WEAK_EVIDENCE_RE =
  /^(?:(?:this|it) is |it's )?(?:intentional(?:ly so)?|intended|deliberate|on purpose|by design|as designed|working as intended)$/

/**
 * The `critics.md` lint (`spec check`, T601 S-9): every finding has one disposition (`fix`,
 * `contest`, `escalate D-n` naming a D-n of the spec, `decline NG-n` naming an NG-n of the spec),
 * a contest carries checkable evidence and never contests a comprehension gap, and no reviewer's
 * latest round is `not run` or `failed`.
 * @param {ReturnType<typeof parseCritics>} critics
 * @param {ReturnType<typeof parseSpec>} parsed  the spec the review is of
 * @returns {{ line: number, rule: 'undisposed-finding' | 'weak-contest' | 'reviewer-not-run', message: string }[]}
 */
export function checkCritics(critics, parsed) {
  const decisions = new Set(parsed.decisions.map((d) => d.id))
  const nonGoals = new Set(parsed.nonGoals.map((n) => n.id))
  const findings = []

  for (const f of critics.findings) {
    const verb = /^([a-z]+)\b/i.exec(f.disposition)?.[1]?.toLowerCase() ?? ''
    const named = (re) => re.exec(f.disposition)?.[0] ?? null
    let undisposed = null
    if (!f.disposition) undisposed = 'has no disposition'
    else if (verb === 'escalate') {
      const id = named(/\bD-\d+\b/)
      if (!id) undisposed = 'is escalated to no D-n'
      else if (!decisions.has(id))
        undisposed = `is escalated to ${id}, which the spec does not have`
    } else if (verb === 'decline') {
      const id = named(/\bNG-\d+\b/)
      if (!id) undisposed = 'is declined to no NG-n'
      else if (!nonGoals.has(id)) undisposed = `is declined to ${id}, which the spec does not have`
    } else if (verb !== 'fix' && verb !== 'contest')
      undisposed = `has the disposition "${f.disposition}"`
    if (undisposed) {
      findings.push({
        line: f.line,
        rule: 'undisposed-finding',
        message: `${f.id} ${undisposed} — give it one: fix, contest (with checkable evidence), escalate D-n (an Open decisions row) or decline NG-n (a non-goal)`
      })
      continue
    }
    if (verb !== 'contest') continue
    if (/^comprehension$/i.test(f.reviewer)) {
      findings.push({
        line: f.line,
        rule: 'weak-contest',
        message: `${f.id} contests a comprehension gap — a reader who got the spec wrong is evidence the spec is unclear; fix the spec instead`
      })
      continue
    }
    const evidence = f.evidence
      .replace(/[`*_.!]/g, '')
      .trim()
      .toLowerCase()
    // "Intentional, by design." is two weak claims, not evidence: weak when every part is.
    const parts = evidence
      .split(/\s*(?:[,;]|\band\b)\s*/)
      .map((p) => p.trim())
      .filter(Boolean)
    if (parts.length === 0 || parts.every((p) => WEAK_EVIDENCE_RE.test(p))) {
      findings.push({
        line: f.line,
        rule: 'weak-contest',
        message: `${f.id} is contested with ${evidence ? `"${f.evidence}"` : 'no evidence'} — a contest cites something checkable (a spec line, an AC proof, a file), not intent`
      })
    }
  }

  const latest = new Map()
  for (const r of critics.reviewers) {
    const prev = latest.get(r.reviewer)
    if (!prev || r.round >= prev.round) latest.set(r.reviewer, r)
  }
  for (const r of latest.values()) {
    if (!/^(?:not run|failed)\b/i.test(r.status)) continue
    findings.push({
      line: r.line,
      rule: 'reviewer-not-run',
      message: `reviewer ${r.reviewer} did not run (round ${r.round}: ${r.status}) — a failed reviewer is not "no findings"; run it again and add a row for the new round`
    })
  }
  return findings.sort((a, b) => a.line - b.line)
}

/**
 * Lint one spec the way `spec check` does: the gate's rules as if the spec were approved, then
 * capability order, then atom coverage. Every finding is collected; nothing short-circuits.
 * @param {string} content  the spec file text
 * @param {string} path     the spec path (for the gate's messages only)
 * @param {string[]} [trackedFiles]  every tracked file in the repo, for the header path rules
 * @returns {{ line: number, rule: string, message: string }[]}  empty when the spec is clean
 */
export function checkSpecFile(content, path, trackedFiles = []) {
  const findings = []
  const { header, bodyStart } = parseHeader(content)
  if (!header) {
    findings.push({
      line: 1,
      rule: 'bad-header',
      message:
        'the spec has no `---` header block — start the file with `status:` and `tier:` as docs/specs/TEMPLATE.md shows'
    })
  } else {
    for (const f of checkSpec(content, path, trackedFiles, { asApproved: true })) {
      findings.push({ line: f.line ?? 1, rule: f.rule, message: f.message })
    }
  }

  const parsed = parseSpec(content)
  findings.push(...checkCapabilityOrder(parsed))

  const { seenSections } = splitSections(content.split('\n'), bodyStart)
  const problem = seenSections.find((s) => s.key === sectionKey('Problem'))
  findings.push(...checkAtomCoverage(parsed, { noAtomsLine: problem?.no }))
  return findings
}
