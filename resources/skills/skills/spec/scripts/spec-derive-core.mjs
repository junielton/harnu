// The derive planner behind `orchestrate-delivery` Phase 2 (T601 S-6).
//
// `planDerive(specContent, specPath, board)` reads a spec and the board and returns the plan
// `{ create, update, skip, refuse }`; it writes nothing. A card is matched to a slice by its
// `spec-slice: S-n` marker, else by an Amendments `card` row (the marker wins when they
// disagree). `backlog` and `ready` cards are updatable; every other status is `skip` with the
// status as the reason; a marked card whose slice no longer exists is `skip` as `orphan`. An
// update rewrites only the span between `<!-- spec:begin S-n -->` and `<!-- spec:end S-n -->`.
// An up-to-date card produces no entry, so a second plan over the board the first produced is
// empty. `renderBlock` builds a slice's block and `applyBlock` splices one into a card body.
//
// Dependency-free ES module (Node built-ins only), vendored in the skill directory beside the
// parser it builds on. No I/O: the CLI in spec-derive.mjs reads the files and prints the plan.

import { acHash, parseCard, parseSpec } from './spec-check-core.mjs'

const UPDATABLE = new Set(['backlog', 'ready'])
const AC_BOX_RE = /^\s*[-*]\s+\[([ xX])\]\s+\**([A-Za-z]+-[A-Za-z0-9]+)\**(?=\s|$)/
const LINKS_SPEC_RE = /^\s*links:\s*spec\s+`?([^\s,`]+)`?/

const beginMarker = (slice) => `<!-- spec:begin ${slice} -->`
const endMarker = (slice) => `<!-- spec:end ${slice} -->`
const markerRe = (kind, slice) =>
  new RegExp(`^\\s*<!--\\s*spec:${kind}\\s+${slice.replace(/[-]/g, '\\-')}\\s*-->\\s*$`)

/** A repo-relative path as a card or a CLI writes it: backticks, quotes and a leading `./` dropped. */
const normalizePath = (p) =>
  String(p)
    .replace(/[`'"]/g, '')
    .trim()
    .replace(/^(?:\.\/)+/, '')

/** The lines of a body with their character offsets, fenced code (markers included) flagged. */
function bodyLines(body) {
  const out = []
  let offset = 0
  let inFence = false
  for (const text of body.split('\n')) {
    const fence = /^\s*(```|~~~)/.test(text)
    if (fence) inFence = !inFence
    out.push({ text, start: offset, end: offset + text.length, code: fence || inFence })
    offset += text.length + 1
  }
  return out
}

/**
 * Where a card body's block for `slice` sits.
 * @returns {{ ok: true, start: number, end: number } | { ok: false, reason: string }}
 *   `start` is the offset of the `spec:begin` line, `end` the offset just past the `spec:end`
 *   line (its newline excluded). Each marker must appear exactly once, outside fenced code,
 *   begin before end.
 */
export function findBlock(body, slice) {
  const lines = bodyLines(body).filter((l) => !l.code)
  const begins = lines.filter((l) => markerRe('begin', slice).test(l.text))
  const ends = lines.filter((l) => markerRe('end', slice).test(l.text))
  if (begins.length !== 1 || ends.length !== 1) {
    return {
      ok: false,
      reason: `${begins.length} \`spec:begin ${slice}\` and ${ends.length} \`spec:end ${slice}\` marker(s), where each must appear exactly once`
    }
  }
  if (ends[0].start < begins[0].start) {
    return { ok: false, reason: `\`spec:end ${slice}\` comes before \`spec:begin ${slice}\`` }
  }
  return { ok: true, start: begins[0].start, end: ends[0].end }
}

/**
 * Replace the block of `slice` in a card body with `block`; every byte outside the span between
 * the two markers (inclusive) is kept. Throws when the body's markers are not one balanced pair.
 * @param {string} body
 * @param {string} slice  e.g. `S-1`
 * @param {string} block  the new span, markers included (as `renderBlock` returns it)
 * @returns {string}
 */
export function applyBlock(body, slice, block) {
  const at = findBlock(body, slice)
  if (!at.ok) throw new Error(`cannot apply the ${slice} block: ${at.reason}`)
  return body.slice(0, at.start) + block + body.slice(at.end)
}

/** The AC ids whose box is ticked inside a block span. */
function tickedIds(span) {
  const ticked = new Set()
  for (const line of span.split('\n')) {
    const m = AC_BOX_RE.exec(line)
    if (m && m[1] !== ' ') ticked.add(m[2])
  }
  return ticked
}

/**
 * The marked block of one slice: its AC lines (`- [ ] <id> #<hash> — <statement> — proof:
 * <proof>`), its `scope:` line and its `links:` line, between the `spec:begin` and `spec:end`
 * markers (included). AC ids the slice cites but the table lacks are left out (the plan refuses
 * such a slice).
 * @param {ReturnType<typeof parseSpec>} parsed
 * @param {ReturnType<typeof parseSpec>['slices'][number]} slice
 * @param {string} specPath  the spec's repo-relative path
 * @param {Set<string>} [ticked]  AC ids whose box an existing card has ticked; kept as `[x]`
 * @returns {string}  no trailing newline
 */
export function renderBlock(parsed, slice, specPath, ticked = new Set()) {
  const acById = new Map(parsed.acs.map((ac) => [ac.id, ac]))
  const acLines = slice.acs
    .map((id) => acById.get(id))
    .filter(Boolean)
    .map(
      (ac) =>
        `- [${ticked.has(ac.id) ? 'x' : ' '}] ${ac.id} ${acHash(ac.statement, ac.proof)} — ${ac.statement} — proof: ${ac.proof}`
    )
  const links = [`spec ${normalizePath(specPath)}`]
  for (const field of ['prd', 'adr']) {
    const value = parsed.header?.[field]
    if (value && normalizePath(value)) links.push(`${field} ${normalizePath(value)}`)
  }
  return [
    beginMarker(slice.id),
    '',
    ...acLines,
    ...(acLines.length > 0 ? [''] : []),
    `scope: ${slice.files.map((f) => `\`${f}\``).join(', ')}`,
    `links: ${links.join(', ')}`,
    '',
    endMarker(slice.id)
  ].join('\n')
}

/** The spec a card names, if any: the board entry's `spec`, its frontmatter `spec:`, or its `links: spec` line. */
function cardSpec(entry, parsedCard) {
  if (typeof entry.spec === 'string' && normalizePath(entry.spec)) return normalizePath(entry.spec)
  if (parsedCard.spec) return parsedCard.spec
  for (const line of bodyLines(entry.body)) {
    if (line.code) continue
    const m = LINKS_SPEC_RE.exec(line.text)
    if (m) return normalizePath(m[1])
  }
  return null
}

/** The literal prefix of a glob: everything before its first wildcard (`*`, `?`, `[`, `{`). */
function globPrefix(glob) {
  const g = normalizePath(glob)
  const idx = g.search(/[*?[{]/)
  return idx === -1 ? { exact: true, prefix: g } : { exact: false, prefix: g.slice(0, idx) }
}

/** Prefix containment of two globs (`**` is a subtree): an exact path overlaps only itself or a glob over it. */
function globsOverlap(a, b) {
  const pa = globPrefix(a)
  const pb = globPrefix(b)
  if (pa.exact && pb.exact) return pa.prefix === pb.prefix
  if (pa.exact) return pa.prefix.startsWith(pb.prefix)
  if (pb.exact) return pb.prefix.startsWith(pa.prefix)
  return pa.prefix.startsWith(pb.prefix) || pb.prefix.startsWith(pa.prefix)
}

/** The transitive `depends-on` closure of a slice (never itself, cycle-safe). */
function closure(slice, byId) {
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

/** Spec-level reasons per slice: no scope, an unordered overlap, a cited AC missing from the table. */
function specRefusals(parsed) {
  const byId = new Map(parsed.slices.map((s) => [s.id, s]))
  const before = new Map(parsed.slices.map((s) => [s.id, closure(s, byId)]))
  const acIds = new Set(parsed.acs.map((ac) => ac.id))
  const reasons = new Map(parsed.slices.map((s) => [s.id, []]))

  for (const slice of parsed.slices) {
    if (slice.files.length === 0) {
      reasons
        .get(slice.id)
        .push(
          `${slice.id} has no files-may-touch — name the paths the slice may change, or the executor's scope is invented`
        )
    }
    const missing = slice.acs.filter((id) => !acIds.has(id))
    if (missing.length > 0) {
      reasons
        .get(slice.id)
        .push(
          `${slice.id} cites ${missing.join(', ')}, which the Acceptance criteria table does not have — add the row or drop the id`
        )
    }
  }

  for (let i = 0; i < parsed.slices.length; i++) {
    for (let j = i + 1; j < parsed.slices.length; j++) {
      const a = parsed.slices[i]
      const b = parsed.slices[j]
      if (before.get(a.id).has(b.id) || before.get(b.id).has(a.id)) continue
      const pairs = []
      for (const fa of a.files)
        for (const fb of b.files) if (globsOverlap(fa, fb)) pairs.push([fa, fb])
      if (pairs.length === 0) continue
      const shared = pairs.map(([fa, fb]) => (fa === fb ? `\`${fa}\`` : `\`${fa}\` / \`${fb}\``))
      const why = (self, other) =>
        `${self.id} and ${other.id} overlap on ${shared.join(', ')} with no depends-on path between them — order them with depends-on or split the files`
      reasons.get(a.id).push(why(a, b))
      reasons.get(b.id).push(why(b, a))
    }
  }
  return reasons
}

/**
 * The derive plan for one spec over the board.
 * @param {string} specContent  the spec file text
 * @param {string} specPath     the spec's repo-relative path, as the block's `links: spec` names it
 * @param {{ slug: string, status: string, title?: string, body: string, spec?: string }[]} board
 * @returns {{
 *   create: { slice: string, title: string, block: string }[],
 *   update: { slug: string, slice: string, block: string }[],
 *   skip: { slug?: string, slice: string, reason: string }[],
 *   refuse: { slice: string, reason: string }[]
 * }}  Each list in spec slice order (orphans after, in board order). `block` is the whole span,
 *   markers included, with no trailing newline.
 */
export function planDerive(specContent, specPath, board) {
  const parsed = parseSpec(specContent)
  const target = normalizePath(specPath)
  const sliceIds = new Set(parsed.slices.map((s) => s.id))
  const rowSlug = new Map(parsed.cards.map((c) => [c.slice, c.card]))

  // The board's cards that may belong to this spec: a card naming another spec is never touched.
  const cards = board
    .filter((entry) => entry && typeof entry.body === 'string' && typeof entry.slug === 'string')
    .map((entry) => {
      const parsedCard = parseCard(entry.body)
      return { entry, marker: parsedCard.slice, spec: cardSpec(entry, parsedCard) }
    })
    .filter((c) => c.spec === null || c.spec === target)

  const plan = { create: [], update: [], skip: [], refuse: [] }
  const refusals = specRefusals(parsed)

  for (const slice of parsed.slices) {
    const reasons = [...refusals.get(slice.id)]
    const marked = cards.filter((c) => c.marker === slice.id)
    let matches = marked
    if (marked.length === 0 && rowSlug.has(slice.id)) {
      // The map row names the card, unless that card's own marker says it is another slice's.
      matches = cards.filter(
        (c) =>
          c.entry.slug === rowSlug.get(slice.id) && (c.marker === null || c.marker === slice.id)
      )
    }

    if (matches.length > 1) {
      reasons.push(
        `${matches.length} cards carry ${slice.id} (${matches.map((c) => c.entry.slug).join(', ')}) — keep one and remove the marker from the others`
      )
      plan.refuse.push({ slice: slice.id, reason: reasons.join('; ') })
      continue
    }

    const card = matches[0]
    if (card && !UPDATABLE.has(card.entry.status)) {
      plan.skip.push({ slug: card.entry.slug, slice: slice.id, reason: String(card.entry.status) })
      if (reasons.length > 0) plan.refuse.push({ slice: slice.id, reason: reasons.join('; ') })
      continue
    }

    let at = null
    if (card) {
      at = findBlock(card.entry.body, slice.id)
      if (!at.ok) reasons.push(`card ${card.entry.slug} has ${at.reason}`)
    }
    if (reasons.length > 0) {
      plan.refuse.push({ slice: slice.id, reason: reasons.join('; ') })
      continue
    }

    if (!card) {
      plan.create.push({
        slice: slice.id,
        title: slice.title,
        block: renderBlock(parsed, slice, target)
      })
      continue
    }
    const current = card.entry.body.slice(at.start, at.end)
    const block = renderBlock(parsed, slice, target, tickedIds(current))
    if (block !== current) plan.update.push({ slug: card.entry.slug, slice: slice.id, block })
  }

  for (const c of cards) {
    if (c.marker !== null && !sliceIds.has(c.marker)) {
      plan.skip.push({ slug: c.entry.slug, slice: c.marker, reason: 'orphan' })
    }
  }
  return plan
}
