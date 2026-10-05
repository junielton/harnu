/**
 * T164 U2 — Review pane: the pure core.
 *
 * Everything the review takeover needs to turn "an agent said it's done" into
 * evidence a human can defend, expressed as pure string→struct functions. No
 * fs, no child_process, no Electron: the shell that actually runs `git`/`gh`
 * lives in `review-ipc.ts`, exactly like `pr-stack-core.ts` ↔ `pr-stack.ts`.
 *
 * Four concerns live here, in order:
 *
 *  1. {@link parseUnifiedDiff} — `git diff` stdout → files → hunks → rows. Joins
 *     the existing parser family (`parseNumstat`, `parseGitLog`, `parsePrList`,
 *     `parseForEachRef`, `parseLsRemoteHeads`).
 *  2. {@link annotateWordDiffs} — word-level intra-line spans on modified line
 *     pairs, so a one-character change is findable (PRD §4.3).
 *  3. {@link matchBlastRadius} / {@link contractFlags} — the two mechanical
 *     "should a human look harder here?" layers. Deterministic, never an LLM.
 *  4. {@link assembleEvidence} — raw git/gh stdout → the evidence header's
 *     receipts plus STRUCTURED discrepancies.
 *
 * Hard rule carried from PRD §3.2 R1/R2: this core never emits a rendered
 * sentence and never emits a verdict. A {@link Discrepancy} is a kind plus its
 * data; turning `{ kind: 'no-commits', data: { branch } }` into "No commits on
 * `feat/x`" is the renderer's job, in `en.json`/`pt-BR.json`, in U3.
 *
 * Visual contract: `docs/specs/2026-08-25-t164-review-pane/spec.html`
 * (`evidence-header`, `evidence-header--git-only`, `evidence-header--no-commits`).
 */

import { parseNumstat } from './mcp/digest-core'
import { parsePrList, worstCi, type CiState, type PrLifecycle } from './pr-stack-core'
import type { HeadInfo } from './review-head'

// ═══════════════════════════════════════════════════════════════════════════
// 1. Unified-diff parsing
// ═══════════════════════════════════════════════════════════════════════════

/** What one rendered diff row is. */
export type DiffRowKind = 'context' | 'add' | 'del'

/** A half-open character range inside a row's `text`. */
export interface DiffSpan {
  start: number
  end: number
}

export interface DiffRow {
  kind: DiffRowKind
  /** 1-based line number in the OLD file; `null` on an added row. */
  oldLine: number | null
  /** 1-based line number in the NEW file; `null` on a deleted row. */
  newLine: number | null
  /** Row content WITHOUT the leading `+`/`-`/space marker. */
  text: string
  /** A `\ No newline at end of file` marker followed this row. */
  noNewline: boolean
  /**
   * Changed character spans, set by {@link annotateWordDiffs}. Absent means
   * "not computed" and is NOT the same as "nothing changed" (an empty array).
   */
  spans?: DiffSpan[]
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The text after the closing `@@` — usually the enclosing function. */
  heading: string
  rows: DiffRow[]
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied'

export interface DiffFile {
  /** Path in the NEW tree (the old path for a deletion). */
  path: string
  /** Set only when the file moved — `renamed`/`copied`. */
  oldPath: string | null
  status: DiffFileStatus
  /** No text to render; the pane lists the path and stops (PRD §6). */
  binary: boolean
  hunks: DiffHunk[]
  added: number
  deleted: number
  /**
   * The POST-image blob SHA, off the diff's own `index <old>..<new> <mode>`
   * line — abbreviated exactly as git printed it (T243).
   *
   * It is the identity a local "I have read this file" mark is keyed on, and it
   * is free: git already emits the line on every file and this parser used to
   * throw it away. Keying on the blob rather than on the head SHA invalidates
   * exactly the files that changed — one commit anywhere would otherwise cost
   * the operator every mark in the review — which is `DISMISSED`'s semantics
   * reproduced locally.
   *
   * `null` when git emitted no `index` line at all: a pure rename with no
   * content change (`similarity index 100%`) is the normal case. Nothing about
   * such a file's content moved, so a mark on it has nothing to invalidate.
   */
  blobSha: string | null
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

/**
 * `index 72e4c0d..09c0600 100644` — the pre/post blob SHAs git prints for every
 * file with content. Anchored and hex-only so `similarity index 100%` (which
 * also begins with the word `index` after its own prefix) can never match.
 */
const INDEX_RE = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?:\s|$)/

/** Strip a leading `a/` or `b/` diff prefix, if present. */
function stripAbPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p
}

/**
 * Read a C-quoted path (`"src/caf\303\251.ts"`) starting at `s[from] === '"'`.
 * git quotes any path with non-ASCII bytes when `core.quotepath` is on — its
 * DEFAULT — so this is the normal shape of a unicode path, not an exotic one.
 * Octal escapes are collected as raw bytes and decoded as UTF-8 at the end,
 * which is what makes multi-byte characters round-trip.
 */
function readQuoted(s: string, from: number): { value: string; end: number } | null {
  if (s[from] !== '"') return null
  const bytes: number[] = []
  let i = from + 1
  while (i < s.length) {
    const ch = s[i]
    if (ch === '"') {
      return { value: Buffer.from(bytes).toString('utf8'), end: i + 1 }
    }
    if (ch === '\\') {
      const next = s[i + 1]
      if (next === undefined) return null
      const simple: Record<string, number> = {
        n: 0x0a,
        t: 0x09,
        r: 0x0d,
        f: 0x0c,
        b: 0x08,
        v: 0x0b,
        a: 0x07,
        '\\': 0x5c,
        '"': 0x22
      }
      if (next in simple) {
        bytes.push(simple[next])
        i += 2
        continue
      }
      const octal = /^[0-7]{1,3}/.exec(s.slice(i + 1))
      if (octal) {
        bytes.push(Number.parseInt(octal[0], 8) & 0xff)
        i += 1 + octal[0].length
        continue
      }
      // Unknown escape — keep the escaped character verbatim.
      bytes.push(...Buffer.from(next, 'utf8'))
      i += 2
      continue
    }
    bytes.push(...Buffer.from(ch, 'utf8'))
    i += 1
  }
  return null
}

/** Unquote + de-prefix one path as it appears on a `--- `/`+++ `/`rename` line. */
function readPath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('"')) {
    const q = readQuoted(trimmed, 0)
    if (q) return stripAbPrefix(q.value)
  }
  return stripAbPrefix(trimmed)
}

/**
 * Split the `a/… b/…` tail of a `diff --git` line.
 *
 * Ambiguous by construction when a path contains a space, so the order matters:
 * quoted forms first (unambiguous), then the "both sides are the same path"
 * shortcut that covers everything except an actual rename, then a best-effort
 * ` b/` split.
 */
function parseDiffGitPaths(rest: string): { oldPath: string; newPath: string } {
  if (rest.startsWith('"')) {
    const a = readQuoted(rest, 0)
    if (a) {
      const remainder = rest.slice(a.end).replace(/^ +/, '')
      const b = remainder.startsWith('"') ? readQuoted(remainder, 0) : null
      return {
        oldPath: stripAbPrefix(a.value),
        newPath: b ? stripAbPrefix(b.value) : stripAbPrefix(remainder)
      }
    }
  }
  const same = /^a\/(.+) b\/\1$/.exec(rest)
  if (same) return { oldPath: same[1], newPath: same[1] }
  const idx = rest.indexOf(' b/')
  if (idx > 0) {
    return { oldPath: readPath(rest.slice(0, idx)), newPath: readPath(rest.slice(idx + 1)) }
  }
  const single = readPath(rest)
  return { oldPath: single, newPath: single }
}

/**
 * A fresh file record. `oldPath` stays `null` until a `rename from`/`copy from`
 * line proves a real move — the `diff --git` left-hand side is only a parsing
 * fallback for the path and is not, on its own, evidence of a rename.
 */
function emptyFile(path: string): DiffFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    binary: false,
    hunks: [],
    added: 0,
    deleted: 0,
    blobSha: null
  }
}

/**
 * Parse `git diff` / `git diff <base>...<head>` stdout into files → hunks →
 * rows.
 *
 * Tolerant by design, same posture as `parsePrList`: unrecognized preamble is
 * skipped, a truncated hunk yields the rows it did get, and an empty string
 * yields `[]` — a review pane that renders nothing is recoverable, a main
 * process that throws on someone else's diff is not.
 *
 * Row bookkeeping is driven by the hunk header's declared counts rather than by
 * the line prefixes alone, so trailing junk after a hunk (a `--` signature line
 * from `format-patch`, a `\` marker, a stray blank) can never be mistaken for a
 * context row.
 */
export function parseUnifiedDiff(stdout: string): DiffFile[] {
  const files: DiffFile[] = []
  if (!stdout) return files

  const lines = stdout.split('\n')
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let lastRow: DiffRow | null = null
  let oldLine = 0
  let newLine = 0
  let remainingOld = 0
  let remainingNew = 0

  const closeHunk = (): void => {
    hunk = null
    lastRow = null
  }

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

    if (line.startsWith('diff --git ')) {
      if (file) files.push(file)
      closeHunk()
      const paths = parseDiffGitPaths(line.slice('diff --git '.length))
      file = emptyFile(paths.newPath)
      continue
    }
    if (!file) continue

    // A `\ No newline at end of file` marker annotates the row BEFORE it, and
    // git emits it after the last row of a hunk — i.e. once the hunk's declared
    // budget is already spent. It is therefore matched before the budget check,
    // not inside it.
    if (hunk && lastRow && line.startsWith('\\')) {
      lastRow.noNewline = true
      continue
    }

    // ── inside a hunk body ────────────────────────────────────────────────
    if (hunk && (remainingOld > 0 || remainingNew > 0)) {
      const marker = line[0]
      if (marker === '+') {
        const row: DiffRow = {
          kind: 'add',
          oldLine: null,
          newLine: newLine++,
          text: line.slice(1),
          noNewline: false
        }
        hunk.rows.push(row)
        lastRow = row
        file.added += 1
        remainingNew -= 1
        continue
      }
      if (marker === '-') {
        const row: DiffRow = {
          kind: 'del',
          oldLine: oldLine++,
          newLine: null,
          text: line.slice(1),
          noNewline: false
        }
        hunk.rows.push(row)
        lastRow = row
        file.deleted += 1
        remainingOld -= 1
        continue
      }
      if (marker === ' ' || line === '') {
        // A context row. Some producers strip the trailing space on an
        // otherwise-empty context line, so `''` counts while the hunk still
        // has budget — which is exactly what the counters are for.
        const row: DiffRow = {
          kind: 'context',
          oldLine: oldLine++,
          newLine: newLine++,
          text: line === '' ? '' : line.slice(1),
          noNewline: false
        }
        hunk.rows.push(row)
        lastRow = row
        remainingOld -= 1
        remainingNew -= 1
        continue
      }
      // Anything else ends the hunk and falls through to the header rules.
      closeHunk()
    } else if (hunk) {
      closeHunk()
    }

    // ── file header region ────────────────────────────────────────────────
    const hunkMatch = HUNK_RE.exec(line)
    if (hunkMatch) {
      oldLine = Number.parseInt(hunkMatch[1], 10)
      remainingOld = hunkMatch[2] === undefined ? 1 : Number.parseInt(hunkMatch[2], 10)
      newLine = Number.parseInt(hunkMatch[3], 10)
      remainingNew = hunkMatch[4] === undefined ? 1 : Number.parseInt(hunkMatch[4], 10)
      hunk = {
        oldStart: oldLine,
        oldLines: remainingOld,
        newStart: newLine,
        newLines: remainingNew,
        heading: hunkMatch[5] ?? '',
        rows: []
      }
      lastRow = null
      file.hunks.push(hunk)
      continue
    }
    // The blob SHAs, captured rather than skipped (T243). The POST-image is the
    // one that identifies what the operator is about to read.
    const indexMatch = INDEX_RE.exec(line)
    if (indexMatch) {
      file.blobSha = indexMatch[2]
      continue
    }
    if (line.startsWith('new file mode')) {
      file.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'deleted'
      continue
    }
    if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = readPath(line.slice('rename from '.length))
      continue
    }
    if (line.startsWith('rename to ')) {
      file.status = 'renamed'
      file.path = readPath(line.slice('rename to '.length))
      continue
    }
    if (line.startsWith('copy from ')) {
      file.status = 'copied'
      file.oldPath = readPath(line.slice('copy from '.length))
      continue
    }
    if (line.startsWith('copy to ')) {
      file.status = 'copied'
      file.path = readPath(line.slice('copy to '.length))
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true
      continue
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim()
      if (p === '/dev/null') file.status = 'added'
      continue
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim()
      if (p === '/dev/null') file.status = 'deleted'
      else if (file.status !== 'renamed' && file.status !== 'copied') file.path = readPath(p)
      continue
    }
  }
  if (file) files.push(file)
  return files
}

/** Total rendered rows across every hunk of every file — the renderer's budget. */
export function countDiffRows(files: readonly DiffFile[]): number {
  let n = 0
  for (const f of files) for (const h of f.hunks) n += h.rows.length
  return n
}

/**
 * Cap a parsed diff at `maxRows` rendered rows, dropping whole files past the
 * budget. Returns which files were dropped so the pane can say so out loud —
 * silently showing a partial diff would be the worst possible failure in a
 * surface whose entire job is "you can defend this decision" (PRD §6).
 */
export function truncateDiff(
  files: readonly DiffFile[],
  maxRows: number
): { files: DiffFile[]; truncated: boolean; omittedFiles: string[] } {
  if (maxRows <= 0) {
    return { files: [], truncated: files.length > 0, omittedFiles: files.map((f) => f.path) }
  }
  const kept: DiffFile[] = []
  const omittedFiles: string[] = []
  let budget = maxRows
  for (const f of files) {
    const rows = f.hunks.reduce((n, h) => n + h.rows.length, 0)
    if (kept.length > 0 && rows > budget) {
      omittedFiles.push(f.path)
      continue
    }
    kept.push(f)
    budget -= rows
  }
  return { files: kept, truncated: omittedFiles.length > 0, omittedFiles }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Word-level intra-line diff
// ═══════════════════════════════════════════════════════════════════════════

interface Token {
  text: string
  start: number
  end: number
}

const TOKEN_RE = /[A-Za-z0-9_$]+|\s+|[\s\S]/y

/** Split a line into identifier / whitespace / single-punctuation tokens. */
export function tokenizeLine(text: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < text.length) {
    TOKEN_RE.lastIndex = i
    const m = TOKEN_RE.exec(text)
    if (!m) break
    out.push({ text: m[0], start: i, end: i + m[0].length })
    i += m[0].length
  }
  return out
}

/**
 * Above this many tokens on either side of the trimmed middle, the LCS is
 * skipped and the whole middle is marked as one span. A quadratic DP on a
 * minified 20k-character line would stall the main process, and a coarse span
 * is a readability regression, not a correctness one.
 */
const LCS_TOKEN_LIMIT = 400

/** Longest-common-subsequence mask over two token runs (`true` = matched). */
function lcsMask(a: readonly Token[], b: readonly Token[]): { a: boolean[]; b: boolean[] } {
  const n = a.length
  const m = b.length
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        a[i].text === b[j].text
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const maskA = new Array<boolean>(n).fill(false)
  const maskB = new Array<boolean>(m).fill(false)
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      maskA[i] = true
      maskB[j] = true
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) i++
    else j++
  }
  return { a: maskA, b: maskB }
}

/** Merge the unmatched tokens of one side into contiguous character spans. */
function spansFrom(tokens: readonly Token[], matched: readonly boolean[]): DiffSpan[] {
  const spans: DiffSpan[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (matched[i]) continue
    const start = tokens[i].start
    let end = tokens[i].end
    while (i + 1 < tokens.length && !matched[i + 1]) {
      i++
      end = tokens[i].end
    }
    spans.push({ start, end })
  }
  return spans
}

/**
 * Changed character spans for one modified line PAIR — the deleted row's spans
 * and the added row's spans, each indexed into that row's own text.
 *
 * Identical lines yield two empty arrays (not `undefined`): "computed, and
 * nothing differs" is a real answer, distinct from "not computed".
 */
export function wordSpans(oldText: string, newText: string): { del: DiffSpan[]; add: DiffSpan[] } {
  if (oldText === newText) return { del: [], add: [] }
  const a = tokenizeLine(oldText)
  const b = tokenizeLine(newText)

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix].text === b[prefix].text) prefix++
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix].text === b[b.length - 1 - suffix].text
  )
    suffix++

  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  if (midA.length === 0 && midB.length === 0) return { del: [], add: [] }
  if (midA.length === 0) return { del: [], add: [{ start: midB[0].start, end: midB.at(-1)!.end }] }
  if (midB.length === 0) return { del: [{ start: midA[0].start, end: midA.at(-1)!.end }], add: [] }
  if (midA.length > LCS_TOKEN_LIMIT || midB.length > LCS_TOKEN_LIMIT) {
    return {
      del: [{ start: midA[0].start, end: midA.at(-1)!.end }],
      add: [{ start: midB[0].start, end: midB.at(-1)!.end }]
    }
  }
  const mask = lcsMask(midA, midB)
  return { del: spansFrom(midA, mask.a), add: spansFrom(midB, mask.b) }
}

/**
 * How much of the two lines is shared, as a 0..1 ratio of unchanged characters.
 * Below {@link MIN_PAIR_SIMILARITY} the two rows are a replacement rather than
 * an edit, and marking every character as "changed" would be noise.
 */
function similarity(
  oldText: string,
  newText: string,
  spans: { del: DiffSpan[]; add: DiffSpan[] }
): number {
  const total = oldText.length + newText.length
  if (total === 0) return 1
  const changed =
    spans.del.reduce((n, s) => n + (s.end - s.start), 0) +
    spans.add.reduce((n, s) => n + (s.end - s.start), 0)
  return 1 - changed / total
}

const MIN_PAIR_SIMILARITY = 0.25

/**
 * Pair the modified rows of a hunk: every maximal run of deleted rows that is
 * immediately followed by a run of added rows pairs positionally. Returns
 * indices into `rows`, so the caller decides what to do with each pair.
 */
export function pairModifiedRows(
  rows: readonly DiffRow[]
): Array<{ delIndex: number; addIndex: number }> {
  const pairs: Array<{ delIndex: number; addIndex: number }> = []
  let i = 0
  while (i < rows.length) {
    if (rows[i].kind !== 'del') {
      i++
      continue
    }
    const delStart = i
    while (i < rows.length && rows[i].kind === 'del') i++
    const addStart = i
    while (i < rows.length && rows[i].kind === 'add') i++
    const dels = addStart - delStart
    const adds = i - addStart
    const n = Math.min(dels, adds)
    for (let k = 0; k < n; k++) pairs.push({ delIndex: delStart + k, addIndex: addStart + k })
  }
  return pairs
}

/**
 * Annotate every modified line pair with its word-level spans, returning a NEW
 * structure (the input is never mutated — a pure function that edited its
 * argument would make the parser's output unsafe to cache).
 *
 * `maxRows` bounds the work: a diff bigger than the budget is returned
 * un-annotated rather than blocking on quadratic work the operator can't see.
 */
export function annotateWordDiffs(
  files: readonly DiffFile[],
  opts: { maxRows?: number } = {}
): DiffFile[] {
  const maxRows = opts.maxRows ?? 20_000
  if (countDiffRows(files) > maxRows) return files.map((f) => ({ ...f, hunks: [...f.hunks] }))

  return files.map((file) => ({
    ...file,
    hunks: file.hunks.map((hunk) => {
      const rows = hunk.rows.map((r) => ({ ...r }))
      for (const { delIndex, addIndex } of pairModifiedRows(rows)) {
        const del = rows[delIndex]
        const add = rows[addIndex]
        const spans = wordSpans(del.text, add.text)
        if (similarity(del.text, add.text, spans) < MIN_PAIR_SIMILARITY) continue
        del.spans = spans.del
        add.spans = spans.add
      }
      return { ...hunk, rows }
    })
  }))
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Mechanical flags — blast radius + repo contracts
// ═══════════════════════════════════════════════════════════════════════════

/** One `git diff --name-status` row. */
export interface NameStatusEntry {
  status: DiffFileStatus
  path: string
  oldPath: string | null
}

const NAME_STATUS_LETTER: Record<string, DiffFileStatus> = {
  A: 'added',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  C: 'copied',
  T: 'modified'
}

/**
 * Parse `git diff --name-status` (`A\tpath`, `R096\told\tnew`). This is what
 * makes the ADDED-vs-CHANGED distinction available, which the user-docs gate
 * (T124) depends on — it fires on files a PR *adds*, not on files it edits.
 */
export function parseNameStatus(stdout: string): NameStatusEntry[] {
  const out: NameStatusEntry[] = []
  if (!stdout) return out
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const parts = raw.split('\t')
    const letter = parts[0]?.[0]?.toUpperCase() ?? ''
    const status = NAME_STATUS_LETTER[letter]
    if (!status || parts.length < 2) continue
    if ((status === 'renamed' || status === 'copied') && parts.length >= 3) {
      out.push({ status, oldPath: readPath(parts[1]), path: readPath(parts[2]) })
      continue
    }
    out.push({ status, oldPath: null, path: readPath(parts[1]) })
  }
  return out
}

/** Count non-empty `git status --porcelain` lines (each = one changed path). */
export function countPorcelain(stdout: string): number {
  return stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length
}

/**
 * Compile one blast-radius glob.
 *
 * Deliberately small and documented rather than gitignore-complete, because the
 * operator writes these by hand and a rule they can't predict is worse than a
 * rule that covers less:
 *
 *  - `**` matches any characters INCLUDING a slash, and a `**` followed by a
 *    slash also matches zero segments
 *  - `*` matches any characters EXCEPT `/`; `?` matches one non-`/`
 *  - `[abc]` / `[!abc]` are character classes
 *  - a pattern ending in `/` means "this directory and everything under it"
 *  - a pattern containing NO `/` matches the file's BASENAME (so `*.pem` works)
 */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.endsWith('/') ? `${glob}**` : glob
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close > i + 1) {
        const body = pattern.slice(i + 1, close)
        out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`
        i = close + 1
        continue
      }
      out += '\\['
      i += 1
      continue
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    i += 1
  }
  return new RegExp(`^${out}$`)
}

/** Does `filePath` match `glob` under the rules documented on {@link globToRegExp}? */
export function matchesGlob(glob: string, filePath: string): boolean {
  const trimmed = glob.trim()
  if (!trimmed) return false
  const re = globToRegExp(trimmed)
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (re.test(normalized)) return true
  if (!trimmed.includes('/')) {
    const base = normalized.slice(normalized.lastIndexOf('/') + 1)
    return re.test(base)
  }
  return false
}

/**
 * Which of `files` sit on the repo's sensitive-path list. Order follows `files`
 * so the pane's markers appear in diff order, and duplicates are impossible.
 */
export function matchBlastRadius(globs: readonly string[], files: readonly string[]): string[] {
  if (globs.length === 0) return []
  return files.filter((f) => globs.some((g) => matchesGlob(g, f)))
}

// ── Repo contract flags (derived from scripts/ci/*-core.mjs) ────────────────

/**
 * These constants MIRROR the CI gate cores by hand
 * (`scripts/ci/{changelog,awareness,user-docs,i18n-parity}-gate-core.mjs`). They
 * are duplicated rather than imported because those are plain `.mjs` scripts
 * outside `tsconfig.node.json`'s program, and pulling them into the main-process
 * bundle to read four string constants would be the wrong trade. The duplication
 * is pinned by `tests/review-core.test.ts`, which imports the real `.mjs` cores
 * and asserts this module agrees with them file-for-file.
 */
export const CONTRACT_SRC_PREFIX = 'src/'
export const CONTRACT_CHANGELOG_FILE = 'CHANGELOG.md'
export const CONTRACT_AWARENESS_TRIGGERS = [
  'src/main/mcp/tool-catalog.ts',
  'src/main/harnu-features.ts'
] as const
export const CONTRACT_AWARENESS_DOC = 'docs/harnu-features.md'
export const CONTRACT_COMPONENT_DIR = 'src/renderer/src/components/'
export const CONTRACT_MAIN_DIR = 'src/main/'
export const CONTRACT_TOOL_CATALOG_FILE = 'src/main/mcp/tool-catalog.ts'
export const CONTRACT_USER_DOCS_DIR = 'docs/user/'
export const CONTRACT_I18N_FILES = [
  'src/renderer/src/i18n/en.json',
  'src/renderer/src/i18n/pt-BR.json'
] as const

export type ContractId = 'changelog' | 'awareness' | 'userDocs' | 'i18n'

export interface ContractFlag {
  id: ContractId
  /** Did the contract's trigger fire — is it in play for this diff at all? */
  required: boolean
  /** Did the diff also do the thing the contract demands? */
  satisfied: boolean
  /** The files that made it `required`, for the "why" the pane shows. */
  triggers: string[]
}

function normalizePath(f: string): string {
  return f.replace(/^\.\//, '').replace(/\\/g, '/')
}

/** True when `path` sits DIRECTLY inside `dir` — one segment, no deeper. */
function isTopLevelUnder(dir: string, path: string): boolean {
  if (!path.startsWith(dir)) return false
  const rest = path.slice(dir.length)
  return rest.length > 0 && !rest.includes('/')
}

/**
 * The repo-contract flags for a diff: CHANGELOG, self-awareness doc, user docs
 * and the i18n locale pair. Deterministic and mechanical — this is the layer
 * PRD §3.1 item 4 requires to be "never LLM".
 *
 * `required: false` is NOT a pass mark, it means the contract does not apply to
 * this diff, which is the "i18n not applicable" phrasing the approved spec's
 * evidence header renders (R2 — no state may read as a completion badge).
 */
export function contractFlags(entries: readonly NameStatusEntry[]): ContractFlag[] {
  const changed = entries.map((e) => normalizePath(e.path))
  const added = entries.filter((e) => e.status === 'added').map((e) => normalizePath(e.path))
  const has = (f: string): boolean => changed.includes(f)

  const srcTriggers = changed.filter((f) => f.startsWith(CONTRACT_SRC_PREFIX))
  const awarenessTriggers = changed.filter((f) =>
    (CONTRACT_AWARENESS_TRIGGERS as readonly string[]).includes(f)
  )
  const userDocsTriggers = [
    ...added.filter((f) => isTopLevelUnder(CONTRACT_COMPONENT_DIR, f)),
    ...added.filter((f) => isTopLevelUnder(CONTRACT_MAIN_DIR, f)),
    ...(has(CONTRACT_TOOL_CATALOG_FILE) ? [CONTRACT_TOOL_CATALOG_FILE] : [])
  ]
  const i18nTriggers = changed.filter((f) => (CONTRACT_I18N_FILES as readonly string[]).includes(f))

  return [
    {
      id: 'changelog',
      required: srcTriggers.length > 0,
      satisfied: has(CONTRACT_CHANGELOG_FILE),
      triggers: srcTriggers
    },
    {
      id: 'awareness',
      required: awarenessTriggers.length > 0,
      satisfied: has(CONTRACT_AWARENESS_DOC),
      triggers: awarenessTriggers
    },
    {
      id: 'userDocs',
      required: userDocsTriggers.length > 0,
      satisfied: changed.some((f) => f.startsWith(CONTRACT_USER_DOCS_DIR)),
      triggers: [...new Set(userDocsTriggers)]
    },
    {
      // The diff-level half of the parity gate: touching ONE locale without the
      // other is the failure `vue-tsc` catches later. Key-for-key parity needs
      // file contents and stays with `scripts/ci/i18n-parity.mjs`.
      id: 'i18n',
      required: i18nTriggers.length > 0,
      satisfied: CONTRACT_I18N_FILES.every((f) => has(f)),
      triggers: i18nTriggers
    }
  ]
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Evidence assembly
// ═══════════════════════════════════════════════════════════════════════════

/** The bound session's end state (t125's vocabulary; `null` when unbound). */
export type SessionEndState = 'done' | 'killed' | 'stand-down' | 'hibernated' | 'running'

/** The PR half of the header, or the reason it does not apply (PRD AC4). */
export type PrEvidence =
  | { applicable: false; reason: 'no-remote' | 'gh-unavailable' }
  | { applicable: true; pr: ReviewPr | null }

export interface ReviewPr {
  number: number
  title: string
  url: string
  state: PrLifecycle
  isDraft: boolean
  /** GitHub's own word (`APPROVED`, `CHANGES_REQUESTED`, …) or `null`. */
  reviewDecision: string | null
  ci: CiState
}

export interface ReviewFileEntry {
  path: string
  oldPath: string | null
  status: DiffFileStatus
  added: number
  deleted: number
  binary: boolean
  /** On the repo's operator-owned sensitive-path list (PRD §3.2 R3). */
  sensitive: boolean
}

/**
 * A named gap between what the branch claims and what it shows. STRUCTURED on
 * purpose: the renderer owns the sentence, this core owns the fact.
 */
export type DiscrepancyKind =
  | 'no-commits'
  | 'dirty-tree'
  | 'behind-base'
  | 'sensitive-paths'
  | 'contract-unmet'
  | 'ci-failing'
  | 'ci-pending'
  | 'pr-draft'
  | 'pr-merged'
  | 'no-pr'
  | 'no-remote'
  | 'gh-unavailable'
  // T246 — the head is a PR this machine never checked out. Each of these
  // REPLACES `no-commits` rather than joining it: an unreadable head produces
  // the same `commitsAhead: 0` as a branch with nothing on it, and letting the
  // two share a sentence is how an operator reads "no commits" and Closes.
  | 'head-not-fetched'
  | 'head-fetch-failed'
  | 'base-unresolved'
  | 'head-moved'
  | 'head-local-differs'
  | 'refresh-failed'

export type DiscrepancySeverity = 'bad' | 'warn' | 'info'

export interface DiscrepancyData {
  branch?: string
  base?: string
  count?: number
  paths?: string[]
  pr?: number
  contract?: ContractId
}

export interface Discrepancy {
  kind: DiscrepancyKind
  severity: DiscrepancySeverity
  data: DiscrepancyData
}

export interface ReviewEvidence {
  branch: string
  base: string
  commitsAhead: number
  /** Commits the base has that the branch lacks; `null` when unknown. */
  behindBase: number | null
  files: ReviewFileEntry[]
  filesChanged: number
  added: number
  deleted: number
  dirtyCount: number
  sensitivePaths: string[]
  contracts: ContractFlag[]
  session: SessionEndState | null
  pr: PrEvidence
  /**
   * Where the reviewed head came from and whether it is readable at all (T246).
   * `kind: 'local'` + `state: 'ready'` is the pre-T246 shape — the folder's own
   * branch — and every field below it is the additive foreign-PR story.
   */
  head: HeadInfo
  discrepancies: Discrepancy[]
}

/**
 * Raw stdout in, evidence out. Every field is nullable because
 * `runGit`/`gh` degrade to `null` on ANY failure, and every one of those
 * degradations is a legitimate state here rather than an error to surface
 * (PRD AC4 — git-only is first-class).
 */
export interface EvidenceInput {
  branch: string
  base: string
  /** `git rev-list --count <base>..<head>`. */
  revListCount: string | null
  /** `git rev-list --count <head>..<base>`. */
  behindCount: string | null
  /** `git diff --numstat <base>...<head>`. */
  numstat: string | null
  /** `git diff --name-status <base>...<head>`. */
  nameStatus: string | null
  /** `git status --porcelain`. */
  porcelain: string | null
  /** `git remote`; an empty string means "repo with no remote". */
  remotes: string | null
  /** `gh pr list --json …`; `null` when gh is absent or unauthenticated. */
  prListJson: string | null
  session?: SessionEndState | null
  blastRadiusGlobs?: readonly string[]
  /** T246. Omitted = the folder's own branch, read locally, as before. */
  head?: HeadInfo
}

function parseCount(stdout: string | null): number | null {
  if (stdout === null) return null
  const n = Number.parseInt(stdout.trim(), 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Normalize a numstat path: a rename is reported as `old => new` (or the
 * compact ` {a => b}/rest` form), and the pane keys everything by the NEW path,
 * which is what `--name-status` already gave us.
 */
function numstatPath(raw: string): string {
  const compact = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw)
  if (compact) return readPath(`${compact[1]}${compact[3]}${compact[4]}`)
  const arrow = raw.lastIndexOf(' => ')
  if (arrow >= 0) return readPath(raw.slice(arrow + 4))
  return readPath(raw)
}

/**
 * numstat rows keyed by path, reusing `parseNumstat` (`mcp/digest-core.ts`) —
 * the same parser the session digest counts churn with, so the review pane and
 * the digest can never disagree about how many lines a branch moved.
 */
function numstatIndex(stdout: string | null): Map<string, { added: number; deleted: number }> {
  const map = new Map<string, { added: number; deleted: number }>()
  if (!stdout) return map
  for (const stat of parseNumstat(stdout)) {
    map.set(numstatPath(stat.file), { added: stat.added, deleted: stat.deleted })
  }
  return map
}

/**
 * Paths git reported as binary — a `-\t-\tpath` numstat row. `parseNumstat`
 * folds those to `0/0` (correct for churn arithmetic, lossy for us), so the
 * marker is recovered from the raw rows here rather than by changing it.
 */
function binaryPaths(stdout: string | null): Set<string> {
  const out = new Set<string>()
  if (!stdout) return out
  for (const raw of stdout.split(/\r?\n/)) {
    const parts = raw.split('\t')
    if (parts.length >= 3 && parts[0] === '-' && parts[1] === '-') {
      out.add(numstatPath(parts.slice(2).join('\t').trim()))
    }
  }
  return out
}

const SEVERITY_ORDER: Record<DiscrepancySeverity, number> = { bad: 0, warn: 1, info: 2 }

/**
 * The named gaps for one assembled evidence set. Split out from
 * {@link assembleEvidence} so the discrepancy rules are testable against a
 * hand-built evidence object without going near git.
 */
export function computeDiscrepancies(
  evidence: Omit<ReviewEvidence, 'discrepancies'>
): Discrepancy[] {
  const out: Discrepancy[] = []
  const head = evidence.head
  const readable = head.state === 'ready'

  // T246 — an unreadable head short-circuits every count-derived line.
  //
  // `runGit` degrades to `null`, and `parseCount(null)` is `0`, so a diff
  // against a ref that is not on disk produces EXACTLY the numbers a branch
  // with nothing on it produces. Emitting `no-commits` here would tell an
  // operator that someone else's PR is empty when the truth is that Harnu has
  // never fetched it — the R2 failure this pane exists to prevent, arrived at
  // from a new direction. So the state names itself and the counts stay quiet.
  if (!readable) {
    const kind: DiscrepancyKind =
      head.state === 'fetch-failed'
        ? 'head-fetch-failed'
        : head.state === 'base-unresolved'
          ? 'base-unresolved'
          : 'head-not-fetched'
    out.push({
      kind,
      severity: head.state === 'not-fetched' ? 'warn' : 'bad',
      data: {
        branch: evidence.branch,
        base: evidence.base,
        ...(head.prNumber !== null ? { pr: head.prNumber } : {})
      }
    })
  }

  if (readable && evidence.commitsAhead === 0) {
    out.push({ kind: 'no-commits', severity: 'bad', data: { branch: evidence.branch } })
  }
  // A foreign PR head is reviewed from the repo's MAIN worktree, whose
  // uncommitted files are the operator's own work and say nothing about the PR.
  // Reporting them as a gap in someone else's branch would be a fabricated
  // discrepancy, so the whole pair is silent on that path.
  if (head.kind === 'local' && evidence.dirtyCount > 0) {
    out.push({ kind: 'dirty-tree', severity: 'warn', data: { count: evidence.dirtyCount } })
  }
  if (readable && evidence.behindBase !== null && evidence.behindBase > 0) {
    out.push({
      kind: 'behind-base',
      severity: 'warn',
      data: { count: evidence.behindBase, base: evidence.base }
    })
  }

  // Staleness is a BOOLEAN, not an age (T246). "The head commit is 3 days old"
  // describes the code, not the operator's copy, and a three-day-old head can
  // be perfectly current. There is deliberately no line for `current`: an
  // "up to date" row is the all-clear badge R2 forbids, and the receipts strip
  // already states it as one word among the other facts.
  if (head.freshness === 'moved') {
    out.push({
      kind: head.kind === 'pr' ? 'head-moved' : 'head-local-differs',
      severity: 'warn',
      data: { branch: evidence.branch, ...(head.prNumber !== null ? { pr: head.prNumber } : {}) }
    })
  }
  // A refresh that failed while an older copy still renders. Distinct from
  // `head-fetch-failed`, which is the case with nothing to fall back on: here
  // there IS a diff below, and the point is that it may not be the current one.
  if (head.fetchFailed && readable) {
    out.push({ kind: 'refresh-failed', severity: 'warn', data: {} })
  }
  if (evidence.sensitivePaths.length > 0) {
    out.push({
      kind: 'sensitive-paths',
      severity: 'warn',
      data: { paths: [...evidence.sensitivePaths], count: evidence.sensitivePaths.length }
    })
  }
  for (const c of evidence.contracts) {
    if (c.required && !c.satisfied) {
      out.push({ kind: 'contract-unmet', severity: 'warn', data: { contract: c.id } })
    }
  }

  if (!evidence.pr.applicable) {
    out.push({ kind: evidence.pr.reason, severity: 'info', data: {} })
  } else if (evidence.pr.pr === null) {
    if (evidence.commitsAhead > 0) out.push({ kind: 'no-pr', severity: 'info', data: {} })
  } else {
    const pr = evidence.pr.pr
    if (pr.state === 'MERGED')
      out.push({ kind: 'pr-merged', severity: 'info', data: { pr: pr.number } })
    if (pr.ci === 'failing')
      out.push({ kind: 'ci-failing', severity: 'bad', data: { pr: pr.number } })
    else if (pr.ci === 'pending')
      out.push({ kind: 'ci-pending', severity: 'warn', data: { pr: pr.number } })
    if (pr.isDraft && pr.state === 'OPEN')
      out.push({ kind: 'pr-draft', severity: 'warn', data: { pr: pr.number } })
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
}

/**
 * Assemble everything the evidence header shows for one branch.
 *
 * Never throws and never reports an error: a repo with no remote, a machine
 * with no `gh`, an unauthenticated `gh` and a branch with nothing on it are all
 * ordinary states that render as themselves (PRD AC2/AC4).
 */
export function assembleEvidence(input: EvidenceInput): ReviewEvidence {
  const entries = parseNameStatus(input.nameStatus ?? '')
  const stats = numstatIndex(input.numstat)
  const binaries = binaryPaths(input.numstat)
  const globs = input.blastRadiusGlobs ?? []

  const sensitivePaths = matchBlastRadius(
    globs,
    entries.map((e) => e.path)
  )
  const sensitiveSet = new Set(sensitivePaths)

  let added = 0
  let deleted = 0
  const files: ReviewFileEntry[] = entries.map((e) => {
    const s = stats.get(e.path) ?? { added: 0, deleted: 0 }
    added += s.added
    deleted += s.deleted
    return {
      path: e.path,
      oldPath: e.oldPath,
      status: e.status,
      added: s.added,
      deleted: s.deleted,
      binary: binaries.has(e.path),
      sensitive: sensitiveSet.has(e.path)
    }
  })

  const head: HeadInfo = input.head ?? {
    kind: 'local',
    state: 'ready',
    ref: input.branch,
    // Nothing on this fallback path resolved a commit — the caller that HAS one
    // passes a real `head`. `null` is the honest answer, and every consumer of
    // `sha` treats it as "cannot be named" rather than guessing from `ref`.
    sha: null,
    prNumber: null,
    freshness: 'unknown',
    fetchedAt: null,
    fetchFailed: false
  }

  const prs = input.prListJson === null ? null : parsePrList(input.prListJson)
  // Match by NUMBER when the caller resolved a PR (T246), by the bare branch
  // name otherwise. The number is the stronger key: two forks can legitimately
  // propose the same `headRefName`, and the branch-name match would then bind
  // the review to whichever of them `gh` happened to list first. The fallback
  // is what keeps the existing your-own-branch path — where nothing knows a
  // number — matching exactly as it did.
  const match =
    (head.prNumber !== null
      ? prs?.find((p) => p.number === head.prNumber)
      : prs?.find((p) => p.branch === input.branch)) ?? null
  const hasRemote = (input.remotes ?? '').trim().length > 0
  const pr: PrEvidence = !hasRemote
    ? { applicable: false, reason: 'no-remote' }
    : prs === null
      ? { applicable: false, reason: 'gh-unavailable' }
      : {
          applicable: true,
          pr: match
            ? {
                number: match.number,
                title: match.title,
                url: match.url,
                state: match.state,
                isDraft: match.isDraft,
                reviewDecision: match.reviewDecision,
                ci: worstCi(match.checks)
              }
            : null
        }

  const base: Omit<ReviewEvidence, 'discrepancies'> = {
    branch: input.branch,
    base: input.base,
    commitsAhead: parseCount(input.revListCount) ?? 0,
    behindBase: parseCount(input.behindCount),
    files,
    filesChanged: files.length,
    added,
    deleted,
    dirtyCount: input.porcelain === null ? 0 : countPorcelain(input.porcelain),
    sensitivePaths,
    contracts: contractFlags(entries),
    session: input.session ?? null,
    pr,
    head
  }

  return { ...base, discrepancies: computeDiscrepancies(base) }
}
