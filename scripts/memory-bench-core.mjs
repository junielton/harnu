// Pure core of the memory efficiency benchmark (T620, spec
// docs/specs/2026-11-04-memory-benchmark/spec.md, S-1). No I/O: the shell in
// memory-bench.mjs reads the files and feeds them here, so every metric is unit-testable on
// plain strings and numbers. The metric names are the contract later chapters cite.
//
// Two functions here MIRROR product code and must change with it (the AC-4 parity test in
// tests/memory-bench-core.test.ts fails otherwise):
//   - memoryReadDefaultBytes / listPageIds  ← memoryReadHandler + readMemoryOverview
//     (src/main/mcp/tool-handlers.ts, src/main/mcp/memory-store.ts)
//   - grepMemory / recall                     ← queryMemory + grepMemory
//     (src/main/mcp/memory-store.ts, src/main/mcp/memory-core.ts)

/** Every metric the scorecard prints, in output order. All are finite numbers. */
export const METRIC_NAMES = [
  'capture_coverage',
  'capture_coverage_git',
  'capture_coverage_nongit',
  'capture_sessions',
  'captured_sessions',
  'sessions_total',
  'decision_yield',
  'decision_yield_agent',
  'decision_yield_human',
  'decision_yield_worker',
  'decision_entries',
  'session_days',
  'decision_blocks',
  'decision_blocks_human',
  'recall_hit_at_5',
  'recall_hit_at_5_strict',
  'recall_hit_at_5_verbatim',
  'recall_questions',
  'boot_handoff_chars',
  'boot_handoff_tokens',
  'boot_handoff_measured',
  'memory_read_default_bytes',
  'hot_freshness_hours',
  'hot_freshness_minutes',
  'index_bytes',
  'digest_count',
  'digests_per_day',
  'orphan_loss',
  'orphan_loss_bytes',
  'orphan_transcripts'
]

/** The memory_query cap on returned matches (MEMORY_QUERY_MAX_MATCHES). */
export const QUERY_MAX_MATCHES = 50
/** Sessions the hot-freshness median looks at (PRD M6). */
export const HOT_WINDOW_SESSIONS = 30
/** A counted session has at least this many operator turns (PRD §4 terms). */
export const MIN_OPERATOR_TURNS = 3
/** The memory subfolders memory_read lists, in its order. */
export const PAGE_DIRS = ['roadmap', 'sessions', 'archive', 'learning']

const DAY_MS = 86_400_000
const DIGEST_NAME = /^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9]+)\.md$/
const ENTRY_ID = /^e-[0-9a-f]{8}$/

// ---- concurrency (CLAUDE.md CPU budget) -------------------------------------------------------

/** How many transcripts may be read at once on a machine with `cpus` CPUs: never above half. */
export function concurrencyLimit(cpus) {
  const n = Number.isFinite(cpus) ? Math.floor(cpus) : 1
  return Math.min(8, Math.max(1, Math.floor(n / 2)))
}

/** Map `items` through async `fn` with at most `limit` calls in flight; results keep input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker)
  await Promise.all(workers)
  return out
}

// ---- paths ------------------------------------------------------------------------------------

/** Claude Code's project slug for a folder: every non-alphanumeric character becomes `-`. */
export function slugOfPath(p) {
  return p.replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9]/g, '-')
}

/** True when `child` is `parent` or lies under it. */
export function isUnder(child, parent) {
  const c = child.replace(/[\\/]+$/, '')
  const p = parent.replace(/[\\/]+$/, '')
  return c === p || c.startsWith(`${p}/`)
}

/** Parse `--path-map from=to` values into ordered pairs. Throws on a malformed value. */
export function parsePathMaps(values) {
  return values.map((v) => {
    const eq = v.indexOf('=')
    if (eq <= 0 || eq === v.length - 1)
      throw new Error(`--path-map expects <from>=<to>, got "${v}"`)
    return { from: v.slice(0, eq).replace(/\/+$/, ''), to: v.slice(eq + 1).replace(/\/+$/, '') }
  })
}

/** Apply the first matching `--path-map` prefix rewrite. */
export function mapPath(p, maps) {
  for (const { from, to } of maps) if (isUnder(p, from)) return to + p.slice(from.length)
  return p
}

/** The inverse rewrite (a real path back to the path transcripts recorded). */
export function unmapPath(p, maps) {
  for (const { from, to } of maps) if (isUnder(p, to)) return from + p.slice(to.length)
  return p
}

/** True when a project slug may hold transcripts of `root` or of a folder under it. */
export function slugMayHold(slug, root) {
  const own = slugOfPath(root)
  return slug === own || slug.startsWith(`${own}-`)
}

/** The scope root a folder belongs to (the longest one), or null. */
export function scopeRootOf(folder, roots) {
  let best = null
  for (const r of roots) if (isUnder(folder, r) && (!best || r.length > best.length)) best = r
  return best
}

// ---- transcripts ------------------------------------------------------------------------------

const WRAPPERS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
  /<cross-session-message[\s\S]*?<\/cross-session-message>/g
]

/** The text of a user message with Claude Code's injected wrappers removed. */
function operatorText(raw) {
  let text = raw
  for (const re of WRAPPERS) text = text.replace(re, ' ')
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * True when a parsed transcript line is an operator turn (spec S-1 "Operator turn"): a
 * main-thread `user` line that is not meta, not a compaction summary, not a tool result, and
 * whose text is real once the injected wrappers are removed (a slash command counts). An
 * image-only line has no text, so it is not a turn.
 */
export function isOperatorTurn(obj) {
  if (!obj || typeof obj !== 'object' || obj.type !== 'user') return false
  if (obj.isSidechain === true || obj.isMeta === true || obj.isCompactSummary === true) return false
  const content = obj.message?.content
  let raw = ''
  if (typeof content === 'string') raw = content
  else if (Array.isArray(content)) {
    if (content.some((b) => b && b.type === 'tool_result')) return false
    raw = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
  } else return false
  if (raw.trimStart().startsWith('[Request interrupted')) return false
  if (/<command-name>\s*\S[\s\S]*?<\/command-name>/.test(raw)) return true
  return operatorText(raw).length > 0
}

/** A fresh accumulator for {@link foldTranscriptLine}. */
export function createTranscriptFold() {
  return { cwd: null, startMs: null, endMs: null, operatorTurns: 0 }
}

const TIMESTAMP = /"timestamp":"([^"]+)"/

/**
 * Fold one raw transcript line into the accumulator. Only lines that can be user turns, or that
 * carry the first `cwd`, are JSON-parsed; the end time is read with a regex so a 100 MB
 * transcript does not cost a parse per line. Malformed lines are skipped.
 */
export function foldTranscriptLine(fold, line) {
  if (!line) return fold
  const ts = TIMESTAMP.exec(line)
  if (ts) {
    const ms = Date.parse(ts[1])
    if (Number.isFinite(ms)) {
      if (fold.startMs === null) fold.startMs = ms
      fold.endMs = ms
    }
  }
  const needsCwd = fold.cwd === null && line.includes('"cwd"')
  const maybeUser = line.includes('"type":"user"')
  if (!needsCwd && !maybeUser) return fold
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    return fold
  }
  if (needsCwd && typeof obj.cwd === 'string' && obj.cwd) fold.cwd = obj.cwd
  if (maybeUser && isOperatorTurn(obj)) fold.operatorTurns++
  return fold
}

/** Summarize a whole transcript given as lines (tests; the shell streams). */
export function summarizeTranscript(lines) {
  const fold = createTranscriptFold()
  for (const line of lines) foldTranscriptLine(fold, line)
  return fold
}

// ---- digests and decisions --------------------------------------------------------------------

/** `{ date, short }` from a digest file name, or null when it does not follow the convention. */
export function parseDigestName(name) {
  const m = DIGEST_NAME.exec(name)
  return m ? { date: m[1], short: m[2].toLowerCase() } : null
}

/** Fields of the first `> provenance:` stamp in `text` (author kept raw: agent/human/worker). */
function parseProvenance(line) {
  const out = {}
  for (const part of line.trim().slice('> provenance:'.length).split('·')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (value && (key === 'author' || key === 'at')) out[key] = value
  }
  return out
}

/** Parse a `> entry:` meta line into `{ id, validFrom }`, or null. */
function parseEntryLine(line) {
  const t = line.trim()
  if (!t.startsWith('> entry:')) return null
  const [idPart, ...rest] = t.slice('> entry:'.length).split('·')
  const id = idPart.trim()
  if (!ENTRY_ID.test(id)) return null
  const meta = { id }
  for (const part of rest) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === 'valid_from')
      meta.validFrom = part.slice(eq + 1).trim()
  }
  return meta
}

/**
 * Every provenance-stamped block of a memory page, with its addressable entry meta when it has
 * one. Block boundaries and the entry's first line follow `parseEntries`
 * (src/main/mcp/memory-entries.ts): a block runs from the line after the previous stamp to its
 * own stamp; the first block of a page skips the scaffold's H1 and `>` guidance.
 * Lines are 1-indexed.
 */
export function parseBlocks(content) {
  const lines = content.split(/\r?\n/)
  const out = []
  let blockStart = 0
  let entry = null
  for (let i = 0; i < lines.length; i++) {
    const m = parseEntryLine(lines[i])
    if (m) entry = m
    if (!lines[i].trim().startsWith('> provenance:')) continue
    const prov = parseProvenance(lines[i])
    let first = blockStart
    const chrome = blockStart === 0 ? /^(?:#\s|>)/ : null
    while (first < i && (lines[first].trim() === '' || chrome?.test(lines[first]))) first++
    out.push({
      entryId: entry ? entry.id : null,
      validFrom: entry?.validFrom ?? null,
      author: prov.author ?? null,
      at: prov.at ?? null,
      startLine: first + 1,
      endLine: i + 1
    })
    entry = null
    blockStart = i + 1
  }
  return out
}

// ---- the memory_read and memory_query mirrors -------------------------------------------------

/**
 * The page ids memory_read lists, in its order: root pages, then each of PAGE_DIRS, every list
 * sorted by file name (`listMd` sorts). Input: `.md` file names per location.
 */
export function listPageIds(names) {
  const strip = (n) => n.replace(/\.md$/, '')
  const md = (list) => (list ?? []).filter((n) => n.endsWith('.md')).sort()
  const ids = md(names.root).map(strip)
  for (const dir of PAGE_DIRS) for (const n of md(names[dir])) ids.push(`${dir}/${strip(n)}`)
  return ids
}

/** The text memory_read({ folder }) returns with no page; its UTF-8 byte length is M5. */
export function memoryReadDefaultPayload({ hot, index, pages }) {
  if (hot === null && index === null && pages.length === 0) {
    return JSON.stringify({
      ok: true,
      memory: null,
      message:
        'No project memory yet for this repo. The first memory_append (e.g. page:decisions or page:hot) scaffolds `.harnu/memory/`.'
    })
  }
  return JSON.stringify({ ok: true, memory: { hot: hot ?? '', index: index ?? '', pages } })
}

/** M5: byte length of {@link memoryReadDefaultPayload}. */
export function memoryReadDefaultBytes(overview) {
  return Buffer.byteLength(memoryReadDefaultPayload(overview), 'utf8')
}

/**
 * The memory_query matcher: a case-insensitive substring over every line of every page, pages
 * in memory_read order, capped at QUERY_MAX_MATCHES. `files` = `[{ page, content }]` in that
 * order. Returns `[{ page, line }]`.
 */
export function grepMemory(files, query, max = QUERY_MAX_MATCHES) {
  const needle = query.trim().toLowerCase()
  const matches = []
  if (!needle) return matches
  for (const file of files) {
    const lines = file.content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue
      if (matches.length >= max) return matches
      matches.push({ page: file.page, line: i + 1 })
    }
  }
  return matches
}

/** The first five distinct page ids of a match list. */
export function topPages(matches, k = 5) {
  const out = []
  for (const m of matches) {
    if (!out.includes(m.page)) out.push(m.page)
    if (out.length === k) break
  }
  return out
}

/**
 * The `## ` section of a page whose heading contains `text` (case-insensitive): lines from the
 * heading to the line before the next `## ` heading. First match wins; null when none.
 */
export function findSection(content, text) {
  const lines = content.split(/\r?\n/)
  const needle = text.toLowerCase()
  const start = lines.findIndex((l) => l.startsWith('## ') && l.toLowerCase().includes(needle))
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i
      break
    }
  }
  return { startLine: start + 1, endLine: end }
}

/**
 * Where one gold id lives: `{ page, startLine?, endLine? }`, or null when it resolves nowhere.
 * Gold ids are a page id (`hot`, `roadmap/<stem>`), a decision entry id (`e-1a2b3c4d`), or a
 * section anchor (`<page>#<heading text>`).
 */
export function resolveGold(gold, files, blocksByPage) {
  if (ENTRY_ID.test(gold)) {
    for (const [page, blocks] of blocksByPage) {
      const b = blocks.find((x) => x.entryId === gold)
      if (b) return { page, startLine: b.startLine, endLine: b.endLine }
    }
    return null
  }
  const hash = gold.indexOf('#')
  if (hash > 0) {
    const page = gold.slice(0, hash)
    const file = files.find((f) => f.page === page)
    const section = file ? findSection(file.content, gold.slice(hash + 1)) : null
    return section ? { page, ...section } : null
  }
  return files.some((f) => f.page === gold) ? { page: gold } : null
}

/**
 * Score one question (spec S-1 "The two mirrors"). `page`: some gold's page is among the first
 * five distinct pages memory_query returns — the PRD M3 definition. `strict`: as `page` for a
 * plain page id, but an entry id or section anchor only hits when one of the returned matches
 * on a top-five page lies inside it, so a 400 KB page that matches everything does not count.
 */
export function recallHit(files, blocksByPage, searchText, expect) {
  const matches = grepMemory(files, searchText)
  const top = topPages(matches)
  let page = false
  let strict = false
  for (const gold of expect) {
    const at = resolveGold(gold, files, blocksByPage)
    if (!at || !top.includes(at.page)) continue
    page = true
    if (at.startLine === undefined) strict = true
    else if (
      matches.some((m) => m.page === at.page && m.line >= at.startLine && m.line <= at.endLine)
    ) {
      strict = true
    }
  }
  return { page, strict }
}

/** Validate a parsed question set; throws with a message naming the bad entry. */
export function validateQuestions(raw) {
  if (!Array.isArray(raw)) throw new Error('the question set must be a JSON array')
  return raw.map((q, i) => {
    const ok =
      q &&
      typeof q.question === 'string' &&
      q.question.trim() &&
      typeof q.query === 'string' &&
      q.query.trim() &&
      Array.isArray(q.expect) &&
      q.expect.length > 0 &&
      q.expect.every((e) => typeof e === 'string' && e)
    if (!ok) throw new Error(`question ${i + 1} needs a non-empty question, query and expect[]`)
    // The query must be words the asker already used, never words lifted from the gold page:
    // otherwise the set measures how well it was tuned to grep, not the memory.
    if (!q.question.toLowerCase().includes(q.query.trim().toLowerCase())) {
      throw new Error(`question ${i + 1}: query "${q.query}" is not a span of the question text`)
    }
    return { question: q.question, query: q.query, expect: q.expect }
  })
}

// ---- metrics ----------------------------------------------------------------------------------

const round = (x, d) => {
  const f = 10 ** d
  return Math.round(x * f) / f
}
const ratio = (n, d) => (d > 0 ? round(n / d, 4) : 0)
const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10)
const dayMs = (date) => Date.parse(`${date}T00:00:00Z`)

/** True when a date-string or epoch-ms falls in `[since, until)`. */
function inWindow(value, window) {
  const ms = typeof value === 'number' ? value : dayMs(value)
  if (!Number.isFinite(ms)) return window.since === null && window.until === null
  if (window.since !== null && ms < dayMs(window.since)) return false
  if (window.until !== null && ms >= dayMs(window.until)) return false
  return true
}

function median(values) {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Compute the whole scorecard. Pure and deterministic. Input:
 *   repo:   { name, kind: 'git' | 'non-git' }
 *   roots:  scope roots (absolute paths, already path-mapped)
 *   window: { since, until } (YYYY-MM-DD or null)
 *   memory: null when absent, else { hot, hotMtimeMs, index, decisions, names, files }
 *           names = { root, roadmap, sessions, archive, learning } (.md file names)
 *           files = [{ page, content }] in memory_read order (only needed with questions)
 *   sessions: [{ sessionId, cwd, startMs, endMs, operatorTurns, bytes, cwdExists }]
 *   questions: validated question set or null
 *   boot: { startup?, resume?, compact? } texts, or null
 */
export function computeScorecard(input) {
  const { repo, roots, window, memory, questions, boot } = input
  const sessions = [...input.sessions]
    .filter((s) => s.startMs !== null && inWindow(s.startMs, window))
    .sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0))

  const digestNames = (memory?.names.sessions ?? []).filter((n) => n.endsWith('.md')).sort()
  const digests = digestNames.map((n) => parseDigestName(n)).filter(Boolean)
  const digestShorts = new Set(digests.map((d) => d.short))
  const hasDigest = (s) => digestShorts.has(s.sessionId.slice(0, 8).toLowerCase())

  // M1 capture coverage.
  const counted = sessions.filter((s) => s.operatorTurns >= MIN_OPERATOR_TURNS)
  const captured = counted.filter(hasDigest)
  const captureCoverage = ratio(captured.length, counted.length)
  const byFolder = new Map()
  for (const s of counted) {
    const root = scopeRootOf(s.cwd, roots)
    const rel = root ? s.cwd.slice(root.length).replace(/^\//, '') || '.' : s.cwd
    const label = s.cwdExists ? rel : `${rel} (gone)`
    const row = byFolder.get(label) ?? { folder: label, sessions: 0, captured: 0 }
    row.sessions++
    if (hasDigest(s)) row.captured++
    byFolder.set(label, row)
  }
  const captureByFolder = [...byFolder.values()].sort((a, b) =>
    a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0
  )

  // M2 decision yield.
  const sessionDays = new Set(counted.map((s) => `${s.cwd}\u0000${utcDate(s.startMs)}`)).size
  const blocks = memory?.decisions ? parseBlocks(memory.decisions) : []
  const entries = blocks.filter((b) => b.entryId && inWindow(b.validFrom ?? b.at ?? '', window))
  const byAuthor = (list, a) => list.filter((b) => b.author === a).length
  const stamped = blocks.filter((b) => inWindow(b.at ?? '', window))

  // M3 recall.
  let hits = 0
  let strictHits = 0
  let verbatimHits = 0
  const misses = []
  const unresolved = []
  if (questions && memory) {
    const blocksByPage = new Map(memory.files.map((f) => [f.page, parseBlocks(f.content)]))
    for (const q of questions) {
      const hit = recallHit(memory.files, blocksByPage, q.query, q.expect)
      if (hit.page) hits++
      if (hit.strict) strictHits++
      else misses.push(q.question)
      if (recallHit(memory.files, blocksByPage, q.question, q.expect).page) verbatimHits++
      for (const gold of q.expect) {
        if (!resolveGold(gold, memory.files, blocksByPage)) unresolved.push(gold)
      }
    }
  } else if (questions) misses.push(...questions.map((q) => q.question))
  const q = questions ? questions.length : 0

  // M4 boot handoff.
  const bootChars = {}
  for (const src of ['startup', 'resume', 'compact']) {
    const text = boot?.[src]
    bootChars[src] = typeof text === 'string' ? [...text].length : 0
  }
  const bootMax = Math.max(bootChars.startup, bootChars.resume, bootChars.compact)

  // M5 memory_read default payload.
  const overview = memory
    ? { hot: memory.hot, index: memory.index, pages: listPageIds(memory.names) }
    : { hot: null, index: null, pages: [] }

  // M6 hot freshness.
  const ended = sessions
    .filter((s) => s.endMs !== null)
    .sort((a, b) => b.endMs - a.endMs || (a.sessionId < b.sessionId ? -1 : 1))
    .slice(0, HOT_WINDOW_SESSIONS)
  let freshMinutes = 0
  if (ended.length > 0) {
    if (memory?.hot == null || memory.hotMtimeMs == null) freshMinutes = -60
    else freshMinutes = median(ended.map((s) => Math.max(0, s.endMs - memory.hotMtimeMs) / 60_000))
  }

  // Digests in the window.
  const windowDigests = digests.filter((d) => inWindow(d.date, window))
  let digestDays = 0
  if (windowDigests.length > 0) {
    const dates = windowDigests.map((d) => d.date).sort()
    const from = window.since ?? dates[0]
    const to = window.until ? utcDate(dayMs(window.until) - DAY_MS) : dates[dates.length - 1]
    digestDays = Math.max(1, Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1)
  }

  // M7 orphan loss.
  const orphans = sessions.filter((s) => !s.cwdExists)
  const lost = orphans.filter((s) => !hasDigest(s))
  const bytes = (list) => list.reduce((a, s) => a + (s.bytes ?? 0), 0)

  const metrics = {
    capture_coverage: captureCoverage,
    capture_coverage_git: repo.kind === 'git' ? captureCoverage : 0,
    capture_coverage_nongit: repo.kind === 'non-git' ? captureCoverage : 0,
    capture_sessions: counted.length,
    captured_sessions: captured.length,
    sessions_total: sessions.length,
    decision_yield: ratio(entries.length, sessionDays),
    decision_yield_agent: ratio(byAuthor(entries, 'agent'), sessionDays),
    decision_yield_human: ratio(byAuthor(entries, 'human'), sessionDays),
    decision_yield_worker: ratio(byAuthor(entries, 'worker'), sessionDays),
    decision_entries: entries.length,
    session_days: sessionDays,
    decision_blocks: stamped.length,
    decision_blocks_human: byAuthor(stamped, 'human'),
    recall_hit_at_5: ratio(hits, q),
    recall_hit_at_5_strict: ratio(strictHits, q),
    recall_hit_at_5_verbatim: ratio(verbatimHits, q),
    recall_questions: q,
    boot_handoff_chars: bootMax,
    boot_handoff_tokens: Math.ceil(bootMax / 4),
    boot_handoff_measured: boot ? 1 : 0,
    memory_read_default_bytes: memoryReadDefaultBytes(overview),
    hot_freshness_hours: round(freshMinutes / 60, 3),
    hot_freshness_minutes: round(freshMinutes, 1),
    index_bytes: memory?.index != null ? Buffer.byteLength(memory.index, 'utf8') : 0,
    digest_count: windowDigests.length,
    digests_per_day: ratio(windowDigests.length, digestDays),
    orphan_loss: ratio(lost.length, orphans.length),
    orphan_loss_bytes: ratio(bytes(lost), bytes(orphans)),
    orphan_transcripts: orphans.length
  }

  return {
    schema: 1,
    repo: { name: repo.name, kind: repo.kind, memory: memory ? 'present' : 'absent' },
    window: { since: window.since, until: window.until },
    inputs: { questions: input.questionsName ?? null, boot: Boolean(boot) },
    metrics: Object.fromEntries(METRIC_NAMES.map((n) => [n, metrics[n]])),
    detail: {
      capture_by_folder: captureByFolder,
      recall_misses: misses,
      recall_unresolved_gold: [...new Set(unresolved)].sort(),
      boot: bootChars
    }
  }
}

// ---- markdown ---------------------------------------------------------------------------------

const ROWS = [
  [
    'capture_coverage',
    'M1',
    '≥ 0.95',
    (m) => `${m.captured_sessions} of ${m.capture_sessions} sessions with ≥ 3 operator turns`
  ],
  [
    'decision_yield',
    'M2',
    '≥ 0.5',
    (m) =>
      `${m.decision_entries} entries over ${m.session_days} session-days (agent ${m.decision_yield_agent}, human ${m.decision_yield_human}, worker ${m.decision_yield_worker}; ${m.decision_blocks} stamped blocks, ${m.decision_blocks_human} human)`
  ],
  [
    'recall_hit_at_5',
    'M3',
    '≥ 0.8',
    (m) => `${m.recall_questions} questions, gold page in the top five`
  ],
  [
    'recall_hit_at_5_strict',
    'M3',
    '≥ 0.8',
    (m) =>
      `a returned match lies inside the gold entry or section; the verbatim question text scores ${m.recall_hit_at_5_verbatim}`
  ],
  [
    'boot_handoff_chars',
    'M4',
    '≤ 8,000 (2,000 tokens)',
    (m) =>
      m.boot_handoff_measured
        ? `${m.boot_handoff_tokens} tokens`
        : 'not captured: nothing injects memory at start today'
  ],
  [
    'memory_read_default_bytes',
    'M5',
    '≤ 16,384',
    () => 'bytes of the page-less memory_read payload'
  ],
  [
    'hot_freshness_hours',
    'M6',
    '≤ 0.167',
    (m) =>
      m.hot_freshness_hours < 0
        ? 'no hot.md'
        : `median over the last ${HOT_WINDOW_SESSIONS} session ends (${m.hot_freshness_minutes} min)`
  ],
  ['index_bytes', '—', '—', () => 'bytes of index.md'],
  ['digest_count', '—', '—', () => 'digests in the window'],
  ['digests_per_day', '—', '—', () => 'digests per calendar day in the window'],
  [
    'orphan_loss',
    'M7',
    '0',
    (m) =>
      `${m.orphan_transcripts} transcripts of missing folders; byte ratio ${m.orphan_loss_bytes}`
  ]
]

/** Render a scorecard as a markdown report (deterministic). */
export function renderMarkdown(card) {
  const m = card.metrics
  const lines = []
  lines.push(`## Memory benchmark: ${card.repo.name}`)
  lines.push('')
  lines.push(
    `- Kind: ${card.repo.kind} · memory: ${card.repo.memory} · sessions in window: ${m.sessions_total}`
  )
  lines.push(`- Window: ${card.window.since ?? 'all time'} → ${card.window.until ?? 'now'}`)
  lines.push(
    `- Question set: ${card.inputs.questions ?? 'none'} · boot capture: ${card.inputs.boot ? 'yes' : 'no'}`
  )
  lines.push('')
  lines.push('| Metric | PRD | Value | Basis | Target |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const [name, prd, target, basis] of ROWS) {
    lines.push(`| \`${name}\` | ${prd} | ${m[name]} | ${basis(m)} | ${target} |`)
  }
  lines.push('')
  lines.push(
    `Capture series: git ${m.capture_coverage_git}, non-git ${m.capture_coverage_nongit} (this folder is ${card.repo.kind}).`
  )
  lines.push('')
  lines.push('### Capture by folder')
  lines.push('')
  if (card.detail.capture_by_folder.length === 0) lines.push('No counted sessions in the window.')
  else {
    lines.push('| Folder | Sessions | Captured |')
    lines.push('| --- | --- | --- |')
    for (const r of card.detail.capture_by_folder)
      lines.push(`| \`${r.folder}\` | ${r.sessions} | ${r.captured} |`)
  }
  if (card.detail.recall_misses.length > 0) {
    lines.push('')
    lines.push('### Recall misses (strict)')
    lines.push('')
    for (const q of card.detail.recall_misses) lines.push(`- ${q}`)
  }
  if (card.detail.recall_unresolved_gold.length > 0) {
    lines.push('')
    lines.push('### Gold ids that resolve to nothing in this memory')
    lines.push('')
    for (const g of card.detail.recall_unresolved_gold) lines.push(`- \`${g}\``)
  }
  return lines.join('\n') + '\n'
}
