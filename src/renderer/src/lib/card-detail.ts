/**
 * Card-detail body parsing (card-detail PRD §2-S1) — the PURE logic behind
 * `CardDetailModal.vue`. A roadmap card's `.md` body is free markdown that
 * follows two layered conventions:
 *
 *  1. **Appends**: every agent/human append lands as `entry\n\n> provenance: …`
 *     (the exact `buildMemoryWrite` format in `src/main/mcp/memory-core.ts`).
 *     The stamp line TERMINATES the entry it stamps.
 *  2. **Sections**: the main body may carry `## Goal`, `## Acceptance criteria`
 *     and `## Open questions` headings; everything else (preamble + unknown
 *     sections) is Context. A body with no headings is ALL Context — the modal
 *     is never blank.
 *
 * Judgment call (recorded in the PR): the ORIGINAL body and the FIRST append
 * are not mechanically separable (the original ends with no marker; the first
 * stamp closes `original + first-append` as one chunk). We therefore treat the
 * first chunk — stamped or not — as the MAIN body (parsed into sections), and
 * every later stamped chunk as a trail append. Nothing is lost: fused content
 * renders in Context instead of the trail.
 *
 * Renderer-local by convention: this module MIRRORS the wire formats
 * (`renderProvenance`/`parseProvenanceLine` in main) rather than cross-importing
 * a main-process module (see `stores/roadmap.ts` for the same pattern).
 */

/** Provenance parsed from a visible `> provenance:` stamp line. */
export interface AppendProvenance {
  author?: 'human' | 'agent'
  at?: string
  branch?: string
  sessionId?: string
}

/** One trail entry: the appended markdown + its stamp (null = unstamped tail). */
export interface CardAppend {
  text: string
  provenance: AppendProvenance | null
}

/** One acceptance-criteria checklist item, read-only in S1. */
export interface CardAcItem {
  text: string
  checked: boolean
}

/** The main body split by the `##` section convention. */
export interface CardSections {
  /** `## Goal` content (markdown, heading stripped). */
  goal: string
  /** Checkbox items under `## Acceptance criteria`. */
  acceptance: CardAcItem[]
  /** Non-checkbox residue of the AC section (rendered as prose under the list). */
  acceptanceExtra: string
  /** `## Open questions` content (markdown; prose-only in S1 — the interview is S4). */
  openQuestions: string
  /** Preamble + every unrecognized section (headings kept). Never silently empty
   *  for a non-empty unstructured body. */
  context: string
}

/** Full parse of a card body — what the modal consumes. */
export interface ParsedCardBody {
  sections: CardSections
  appends: CardAppend[]
  /** Unique `[[slug]]` references across the WHOLE body, in order. */
  wikilinks: string[]
  /** The first `dispatched-with: …` audit line (T97), or null. */
  dispatchedWith: string | null
  /** `## Open questions`, split into per-question answered/open state (E7). */
  questions: OpenQuestion[]
}

const STAMP_RE = /^>\s*provenance:/

/**
 * Parse one `> provenance: author=… · at=… · branch=… · session=…` line.
 * Mirror of `parseProvenanceLine` (memory-core): tolerant of spacing/order,
 * unknown keys ignored.
 */
function parseStampLine(line: string): AppendProvenance {
  const out: AppendProvenance = {}
  const rest = line.trim().replace(STAMP_RE, '')
  for (const part of rest.split('·')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!value) continue
    if (key === 'author') out.author = value === 'human' ? 'human' : 'agent'
    else if (key === 'at') out.at = value
    else if (key === 'branch') out.branch = value
    else if (key === 'session') out.sessionId = value
  }
  return out
}

/**
 * Split a card body on its `> provenance:` stamp lines. The chunk before the
 * first stamp is the MAIN body; each later chunk becomes an append carrying the
 * stamp that terminates it (or `provenance: null` for a dangling unstamped
 * tail). Empty chunks (double stamps) are dropped.
 */
export function splitStampedAppends(body: string): { main: string; appends: CardAppend[] } {
  const lines = body.split(/\r?\n/)
  const chunks: { text: string; stamp: AppendProvenance | null }[] = []
  let buf: string[] = []
  for (const line of lines) {
    if (STAMP_RE.test(line.trim())) {
      chunks.push({ text: buf.join('\n'), stamp: parseStampLine(line) })
      buf = []
    } else {
      buf.push(line)
    }
  }
  const tail = buf.join('\n')
  if (tail.trim().length > 0) chunks.push({ text: tail, stamp: null })

  if (chunks.length === 0) return { main: '', appends: [] }

  const [first, ...rest] = chunks
  const appends: CardAppend[] = rest
    .filter((c) => c.text.trim().length > 0)
    .map((c) => ({ text: c.text.trim(), provenance: c.stamp }))
  return { main: first.text, appends }
}

/** Recognized `##` headings → section keys (case-insensitive, exact title).
 *  `## Context` is recognized too so its literal heading never renders inside
 *  the Context prose (the section label is the modal's own eyebrow). */
const SECTION_KEYS: Record<string, 'goal' | 'acceptance' | 'openQuestions' | 'context'> = {
  goal: 'goal',
  'acceptance criteria': 'acceptance',
  'open questions': 'openQuestions',
  context: 'context'
}

const HEADING_RE = /^##\s+(.+?)\s*$/
const CHECKBOX_RE = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/

/**
 * Split the MAIN body into the dossier sections by the `##` heading convention.
 * Preamble (before any heading) and unrecognized sections (heading line kept)
 * fold into `context` — so an unstructured body renders whole as Context and
 * the modal is never blank (PRD §2-S1 AC).
 */
export function parseCardSections(main: string): CardSections {
  const out: CardSections = {
    goal: '',
    acceptance: [],
    acceptanceExtra: '',
    openQuestions: '',
    context: ''
  }
  const buckets: { goal: string[]; acceptance: string[]; openQuestions: string[] } = {
    goal: [],
    acceptance: [],
    openQuestions: []
  }
  const contextParts: string[] = []
  let contextBuf: string[] = []
  let current: 'goal' | 'acceptance' | 'openQuestions' | 'context' = 'context'

  const flushContext = (): void => {
    if (contextBuf.join('\n').trim().length > 0) contextParts.push(contextBuf.join('\n').trim())
    contextBuf = []
  }

  for (const line of main.split(/\r?\n/)) {
    const h = HEADING_RE.exec(line)
    if (h) {
      const key = SECTION_KEYS[h[1].trim().toLowerCase()]
      if (key) {
        if (current === 'context') flushContext()
        current = key
        continue
      }
      // Unrecognized heading → a Context chunk that KEEPS its heading line.
      if (current === 'context') {
        contextBuf.push(line)
      } else {
        current = 'context'
        contextBuf = [line]
      }
      continue
    }
    if (current === 'context') contextBuf.push(line)
    else buckets[current].push(line)
  }
  flushContext()

  out.goal = buckets.goal.join('\n').trim()
  out.openQuestions = buckets.openQuestions.join('\n').trim()
  out.context = contextParts.join('\n\n')

  const extra: string[] = []
  for (const line of buckets.acceptance) {
    const m = CHECKBOX_RE.exec(line)
    if (m) out.acceptance.push({ text: m[2].trim(), checked: m[1].toLowerCase() === 'x' })
    else extra.push(line)
  }
  out.acceptanceExtra = extra.join('\n').trim()
  return out
}

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g

/** Unique `[[slug]]` (or `[[slug|label]]`) references, in order of appearance. */
export function extractWikilinks(body: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of body.matchAll(WIKILINK_RE)) {
    const ref = m[1].split('|')[0].trim()
    if (!ref || seen.has(ref)) continue
    seen.add(ref)
    out.push(ref)
  }
  return out
}

const DISPATCHED_WITH_RE = /^dispatched-with:\s*\S.*$/m

/** The first `dispatched-with: model·effort` audit line (T97), verbatim, or null. */
export function extractDispatchedWith(body: string): string | null {
  const m = DISPATCHED_WITH_RE.exec(body)
  return m ? m[0].trim() : null
}

/**
 * Merge a card's declared `deps`, `parent` and its body `[[slug]]` references
 * into one deduplicated linked-refs list — the card's own id/slug excluded.
 */
export function linkedRefsOf(
  card: { id: string; slug: string; deps: readonly string[]; parent?: string },
  wikilinks: readonly string[]
): string[] {
  const self = new Set([card.id, card.slug])
  const seen = new Set<string>()
  const out: string[] = []
  for (const ref of [...card.deps, ...(card.parent ? [card.parent] : []), ...wikilinks]) {
    const r = ref.trim()
    if (!r || self.has(r) || seen.has(r)) continue
    seen.add(r)
    out.push(r)
  }
  return out
}

/** Resolve a (usually repo-relative) `spec:` path against the board's folder. */
export function resolveDocPath(folder: string, doc: string): string {
  if (doc.startsWith('/')) return doc
  return `${folder.replace(/\/+$/, '')}/${doc}`
}

// ---- Linked-chip relation labels (T130 S3, M9) ------------------------------

/** The structural subset a linked card needs to resolve a relation direction. */
export interface RelatableCard {
  id: string
  slug: string
  column: string
  deps: readonly string[]
}

/** A linked chip's relation to the OPEN card, or `null` when direction doesn't apply
 *  (a `parent`/`[[wikilink]]` ref that isn't also a declared dependency either way). */
export type LinkRelation = 'blocked-by' | 'blocks' | 'done'

/**
 * The relation label for one linked chip (M9): a ref that's in the OPEN card's
 * own `deps` is `blocked-by` it (or `done`, once the target lands — softer than
 * "blocked" for a dependency that's already resolved); a ref that ISN'T one of
 * the open card's deps, but whose OWN `deps` list the open card back, `blocks`
 * the other way. A ref resolved only via `parent`/`[[wikilink]]` (present in
 * neither direction) carries no relation (`null`) — direction is a `deps`-only
 * concept.
 */
export function relationOf(
  ref: string,
  target: RelatableCard | null,
  ownDeps: readonly string[],
  ownRefs: readonly string[]
): LinkRelation | null {
  if (!target) return null
  if (ownDeps.includes(ref)) {
    return target.column === 'done' ? 'done' : 'blocked-by'
  }
  if (target.deps.some((d) => ownRefs.includes(d))) return 'blocks'
  return null
}

const AC_HEADING_RE = /^##\s+(.+?)\s*$/
const AC_CHECKBOX_LINE_RE = /^(\s*[-*]\s*\[)([ xX])(\]\s*.*)$/

/**
 * Flip the `index`-th (0-based) Acceptance-criteria checkbox — `- [ ]`↔`- [x]`,
 * `*`/`-` bullets, upper/lowercase `X` all preserved — touching ONLY that one
 * line of the raw body (S2, live AC toggle). `index` matches the ORDER
 * `parseCardSections(body).acceptance` yields, so the caller can wire a click
 * handler straight off the `v-for` index without re-deriving anything.
 *
 * Operates on the WHOLE raw body (not just `splitStampedAppends`'s main chunk)
 * so appends/trail content downstream of the section are carried through byte
 * -for-byte — this is what feeds `replaceBody`, the same full-replace door the
 * edit-mode textarea uses (design.md "Edit mode"). Scoped strictly to the `##
 * Acceptance criteria` section: a checkbox-shaped line anywhere else (e.g. in
 * Context prose or a later append) is never touched. An out-of-range `index`
 * returns `body` unchanged.
 */
export function toggleAcceptanceCriterion(body: string, index: number): string {
  if (index < 0) return body
  const lines = body.split(/\r?\n/)
  let inAcceptance = false
  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    const heading = AC_HEADING_RE.exec(lines[i])
    if (heading) {
      inAcceptance = heading[1].trim().toLowerCase() === 'acceptance criteria'
      continue
    }
    if (!inAcceptance) continue
    const m = AC_CHECKBOX_LINE_RE.exec(lines[i])
    if (!m) continue
    if (seen === index) {
      const flipped = m[2].trim() ? ' ' : 'x'
      lines[i] = `${m[1]}${flipped}${m[3]}`
      return lines.join('\n')
    }
    seen++
  }
  return body
}

// ---- Open questions (T130 S4, E7 — question/answer convention) -------------
//
// Within `## Open questions`, each question is a blank-line-separated paragraph
// OR one line of a bullet list (`- `/`* `) — a block that mixes bullet and
// non-bullet lines falls back to being ONE question (the whole block, joined).
// An answer is an ORDINARY provenance-stamped body append (the exact same
// append door the Trail already renders) whose FIRST line anchors it to the
// question it answers:
//
//   > answers: <question text, whitespace-normalized>
//   <answer prose>
//
// This mirrors the `> provenance:` stamp's blockquote style without colliding
// with it (`isAnswerAppend` only matches "answers:", never "provenance:"). The
// modal's Send button composes this anchor automatically; a human editing the
// `.md` by hand can write the identical line. When more than one append
// answers the same question, the LAST one (body order) wins — earlier answers
// stay in the raw file as history, simply superseded in the rendered block.
// Answer-anchored appends are excluded from the generic Trail render (design.md
// §6 item 9): they already have a dedicated, better-fitting home in the Open
// Questions block, so nothing is deleted from the file — only not shown twice.

/** One `## Open questions` entry — its answered/open state and, when answered,
 *  the provenance + prose (E7, PRD §2-S4). */
export interface OpenQuestion {
  text: string
  answered: boolean
  answerText: string | null
  provenance: AppendProvenance | null
}

const ANSWER_ANCHOR_RE = /^>\s*answers:\s*(.+)$/i
const QUESTION_LIST_ITEM_RE = /^[-*]\s+(.*)$/

/** Collapse internal whitespace/newlines to single spaces, trim — the anchor's
 *  matching key (so line-wrap differences never break the answered/open link). */
function normalizeQuestionText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Split raw `## Open questions` content into individual question TEXTS, in
 * order (E7 deliverable 1: "each question is a paragraph or list item"). A
 * paragraph block whose every line is a `-`/`* ` bullet yields one question per
 * line; any other block (single or multi-line prose) yields ONE question, its
 * lines joined with a space.
 */
export function splitQuestions(section: string): string[] {
  const blocks = section
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
  const out: string[] = []
  for (const block of blocks) {
    const lines = block
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    const isList = lines.length > 0 && lines.every((l) => QUESTION_LIST_ITEM_RE.test(l))
    if (isList) {
      for (const line of lines) {
        const m = QUESTION_LIST_ITEM_RE.exec(line)
        if (m) out.push(m[1].trim())
      }
    } else {
      out.push(normalizeQuestionText(lines.join(' ')))
    }
  }
  return out
}

/** Build the append entry a Send composes (E7): the anchor line + the answer
 *  prose. The caller stamps this through the normal provenance append door. */
export function buildAnswerAppend(questionText: string, answerText: string): string {
  return `> answers: ${normalizeQuestionText(questionText)}\n${answerText.trim()}`
}

/** Whether an append is an answer to an open question (its first line anchors
 *  to one) — used to keep the generic Trail free of duplicate rendering. */
export function isAnswerAppend(ap: CardAppend): boolean {
  const first = ap.text.split(/\r?\n/)[0]?.trim() ?? ''
  return ANSWER_ANCHOR_RE.test(first)
}

/**
 * Every `> answers: …` anchored span in the RAW body, as `CardAppend`-shaped
 * matches (`text` starts with the anchor line, exactly the shape
 * `isAnswerAppend`/`parseOpenQuestions` expect). Judgment call (recorded on the
 * PR): a card's FIRST-EVER stamped write fuses with the unstamped original
 * body into one chunk (`splitStampedAppends`'s documented S1 rule — the two
 * aren't mechanically separable) — which would hide an answer that happens to
 * be that first write from `splitStampedAppends(body).appends`. This scan
 * works independently, straight off the raw body's `> answers:`/`> provenance:`
 * markers, so a question answered as the card's very first append still
 * resolves correctly regardless of which "chunk" it landed in.
 */
function scanAnswerAppends(body: string): CardAppend[] {
  const out: CardAppend[] = []
  let anchor: string | null = null
  let buf: string[] = []
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim()
    const am = ANSWER_ANCHOR_RE.exec(trimmed)
    if (am) {
      anchor = am[1].trim()
      buf = []
      continue
    }
    if (STAMP_RE.test(trimmed)) {
      if (anchor !== null) {
        out.push({
          text: `> answers: ${anchor}\n${buf.join('\n')}`.trim(),
          provenance: parseStampLine(line)
        })
        anchor = null
      }
      buf = []
      continue
    }
    if (anchor !== null) buf.push(line)
  }
  return out
}

/**
 * Drop any paragraph block from a raw `## Open questions` section whose first
 * line is a `> answers: …` anchor (companion to `scanAnswerAppends`): when an
 * answer fuses into the section text itself (the same first-append edge case),
 * `splitQuestions` must never mistake the leaked anchor+answer text for a
 * FOURTH question.
 */
function stripEmbeddedAnswers(section: string): string {
  return section
    .split(/\n\s*\n/)
    .filter((block) => !ANSWER_ANCHOR_RE.test(block.trim().split(/\r?\n/)[0]?.trim() ?? ''))
    .join('\n\n')
}

/**
 * Parse `## Open questions` into per-question answered/open state (E7): a
 * question is answered when some append's first line is `> answers: <text>`
 * matching its whitespace-normalized text — the LAST such append (body order)
 * wins. Deterministic and pure; feeds the modal's answered/open rendering, the
 * `{n} open` badge, and the compact-card `? {n}` chip (all via the SAME count).
 * `appends` should be `scanAnswerAppends(body)` (or any `CardAppend[]` shaped
 * the same way) — NOT `splitStampedAppends(body).appends`, which can miss a
 * first-ever-write answer (see `scanAnswerAppends`'s doc comment).
 */
export function parseOpenQuestions(
  section: string,
  appends: readonly CardAppend[]
): OpenQuestion[] {
  const clean = stripEmbeddedAnswers(section)
  return splitQuestions(clean).map((text) => {
    const anchor = normalizeQuestionText(text)
    let match: CardAppend | null = null
    for (const ap of appends) {
      const first = ap.text.split(/\r?\n/)[0]?.trim() ?? ''
      const m = ANSWER_ANCHOR_RE.exec(first)
      if (m && normalizeQuestionText(m[1]) === anchor) match = ap
    }
    if (!match) return { text, answered: false, answerText: null, provenance: null }
    const answerText = match.text.split(/\r?\n/).slice(1).join('\n').trim()
    return { text, answered: true, answerText, provenance: match.provenance }
  })
}

/**
 * The unanswered-question count for a card body (B11, PRD OQ1: "questions
 * only", never AC gaps) — the ONE count the modal badge and the compact-card
 * `? {n}` chip both read, so they can never disagree. Lighter than
 * `parseCardBody`: skips wikilink/dispatched-with extraction the board's
 * per-card render loop doesn't need.
 */
export function unansweredQuestionCount(body: string): number {
  const { main } = splitStampedAppends(body)
  const { openQuestions } = parseCardSections(main)
  if (!openQuestions) return 0
  return parseOpenQuestions(openQuestions, scanAnswerAppends(body)).filter((q) => !q.answered)
    .length
}

/** One-call composition: appends split first, sections from the main chunk only,
 *  links + the dispatched-with audit line scanned across the WHOLE body. */
export function parseCardBody(body: string): ParsedCardBody {
  const { main, appends } = splitStampedAppends(body)
  const sections = parseCardSections(main)
  return {
    sections,
    appends: appends.filter((ap) => !isAnswerAppend(ap)),
    wikilinks: extractWikilinks(body),
    dispatchedWith: extractDispatchedWith(body),
    questions: parseOpenQuestions(sections.openQuestions, scanAnswerAppends(body))
  }
}
