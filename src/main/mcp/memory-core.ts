/**
 * Pure core for Project Memory (T79 S1): the deterministic string/decision math
 * behind the `memory_read` / `memory_append` / `memory_query` MCP verbs and the
 * `.harnu/memory/` on-disk layout.
 *
 * Framework-free + side-effect-free per ADR-0001 (pure-core / thin-shell): NO
 * `fs`, `child_process`, `electron`, or clock — the shell (`memory-store.ts`)
 * probes git + reads/writes files and feeds the bytes + an injected `now` in
 * here, so every accept/reject/format decision is deterministic and lands in the
 * coverage surface (`tests/mcp-memory-core.test.ts`).
 *
 * WHAT LIVES HERE — the parts the security + schema contract depends on:
 *  1. Storage keying (§3.1) — `resolveMemoryCheckout` collapses any worktree to
 *     its main checkout via the git common-dir, so every worktree of a repo
 *     shares ONE memory. No git ⇒ folder-local (graceful degradation).
 *  2. Page safety — `parseMemoryPage` is the traversal gate: an agent-supplied
 *     `page` can only ever name a `.md` file inside the fixed layout, never
 *     escape it (`..`, absolute, foreign dir all fail closed).
 *  3. Append discipline (§3.3) — `buildMemoryWrite` appends to the BODY only and
 *     NEVER rewrites YAML frontmatter/`status` (that is T80's job); `hot.md` is
 *     the single replace exception. Provenance is stamped here from a
 *     caller-derived author, never from the entry content.
 *  4. Anti-secret lint (§7) — `lintSecrets` refuses obvious credential shapes
 *     before anything is disclosed or written; it reports a KIND, never the
 *     secret.
 *  5. `buildMemoryIndex` — the deterministic catalog the shell regenerates on
 *     every write (the user's files stay sovereign; the index is derived).
 *  6. `grepMemory` — the v1 `memory_query` retrieval (plain substring; BM25/
 *     embeddings is S5, only if grep proves insufficient).
 *  7. The tiered read (U2 S-1) — `buildMemoryReadAnswer` (the bounded default),
 *     `buildListAnswer` + the cursor codec (the paginated `cards` / `sessions`
 *     views), all under {@link MEMORY_READ_MAX_BYTES}.
 */

import * as path from 'node:path'
import { dataDirAt } from '../data-dir'
import { renderEntryMeta, type EntryMeta } from './memory-entries'

// ---- Constants --------------------------------------------------------------

/** Hard cap on a single appended entry (chars) — bounds the write surface (§7). */
export const MEMORY_ENTRY_MAX_CHARS = 8_000

/** `hot.md` is a bounded retrieval cue, not a growing log (§3.2 — cap duro). */
export const HOT_MAX_WORDS = 500

/** Cap on `memory_query` matches returned (keeps the read payload bounded). */
export const MEMORY_QUERY_MAX_MATCHES = 50

/** Max length of one grep result line before it is elided. */
const QUERY_LINE_MAX_CHARS = 200

/** Max length of a `page` identifier (defensive — real pages are short). */
const PAGE_MAX_CHARS = 128

/** Byte cap of a `memory_read` answer, default or list view (U2 D-1; PRD M5). */
export const MEMORY_READ_MAX_BYTES = 16_384

/** Byte cap of the regenerated `index.md` (U2 F-3). */
export const INDEX_MAX_BYTES = 8_192

/** The default read cuts `hot` at this many bytes, on a line boundary (U2 F-1). */
export const READ_HOT_MAX_BYTES = 8_192

/** The default read lists at most this many in-progress and this many ready cards. */
export const READ_CARD_ROWS_MAX = 40

/** `limit` of a list view: default and maximum (U2 F-2). */
export const LIST_LIMIT_DEFAULT = 50
export const LIST_LIMIT_MAX = 200

/** Titles in a read answer are cut to this many characters. */
export const READ_TITLE_MAX_CHARS = 120

// ---- Storage keying (§3.1) --------------------------------------------------

/** Drop a single trailing path separator unless the path is the root itself. */
function stripTrailingSep(p: string): string {
  if (p.length > 1 && p.endsWith(path.sep)) return p.slice(0, -1)
  return p
}

/**
 * Resolve the checkout that OWNS a folder's project memory (§3.1). `repoId` is
 * the git common-dir the caller probed (realpath'd, e.g. `<main>/.git`) — the
 * main checkout owns it, so `dirname(repoId)` collapses EVERY worktree of a repo
 * (canonical `.claude/worktrees/*` or otherwise) onto the same anchor. With no
 * `repoId` (a folder outside any git repo) the memory is folder-local — the same
 * layout, no worktree fan-out to collapse.
 *
 * Pure string math: no fs, no probe. The env shell supplies `repoId` from
 * `probeGitMeta(folder)`.
 *
 * @param folder - absolute path of the folder the verb targets.
 * @param repoId - the realpath'd git common-dir, or undefined when not in a repo.
 * @returns the absolute checkout path whose `.harnu/memory/` serves this folder.
 */
export function resolveMemoryCheckout(folder: string, repoId?: string): string {
  if (repoId) {
    const parent = stripTrailingSep(path.dirname(stripTrailingSep(path.normalize(repoId))))
    // A degenerate common-dir (e.g. a bare repo where dirname collapses to root
    // or `.`) falls back to the folder rather than pointing memory at `/`.
    if (parent && parent !== '.' && parent !== path.sep) return parent
  }
  return stripTrailingSep(path.normalize(folder))
}

/** Absolute path of a checkout's `.harnu/memory/` directory. */
export function memoryDirFor(checkout: string): string {
  return path.join(dataDirAt(checkout), 'memory')
}

// ---- Configurable storage location (T89) ------------------------------------

/** Basename of the human-readable backlink written into a central memory folder. */
export const WHERE_FILE = 'where.md'

/** Where a repo's project memory is physically stored. */
export type MemoryStorageMode = 'in-project' | 'central'

/**
 * The effective memory-location config for a repo (T89): the per-project override
 * if set, else the global default. `in-project` (default, unchanged) keeps memory
 * at `<main-checkout>/.harnu/memory/`; `central` redirects it to a collision-proof
 * sub-folder under a user-picked `root` (Google Drive, an Obsidian vault, an
 * external disk) so the client repo stays 100% clean.
 */
export type MemoryLocationConfig = { mode: 'in-project' } | { mode: 'central'; root: string }

/** The default when nothing is configured: the unchanged in-project behavior. */
export const DEFAULT_MEMORY_CONFIG: MemoryLocationConfig = { mode: 'in-project' }

/**
 * The per-project override wins over the global default (T89). Pure precedence
 * resolution so both layers are pinned by unit tests; the shell reads the two
 * sources (projects.json + the global config file) and feeds them here.
 */
export function effectiveMemoryConfig(
  override: MemoryLocationConfig | undefined | null,
  globalDefault: MemoryLocationConfig
): MemoryLocationConfig {
  return override ?? globalDefault
}

/**
 * Deterministic 8-hex-char hash of a string (FNV-1a, 32-bit). Pure + dependency-
 * free (no `node:crypto`) so the central-storage key stays in the pure core and
 * unit-tests without a mock. It is only a COLLISION TIEBREAKER between repos that
 * share a basename (the T88 "two repos named www" lesson) — not a security
 * primitive — so 32 bits is ample for the handful of same-named repos a user has.
 */
export function hash8(input: string): string {
  let h = 0x811c9dc5 // FNV offset basis (32-bit)
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) // FNV prime, wrapped to 32 bits by imul
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * The collision-proof folder name for a repo's memory under a central root
 * (T89): `<repo-name>--<hash8(main-checkout-path)>`. The `repo-name` (basename)
 * makes the folder human-recognizable when browsing the root; the hash of the
 * FULL main-checkout path disambiguates two repos that share a basename.
 */
export function centralMemoryFolderName(checkout: string): string {
  const name = path.basename(checkout) || 'repo'
  return `${name}--${hash8(checkout)}`
}

/**
 * Resolve the ACTUAL memory dir for a folder given the effective config (T89) —
 * the single seam every consumer already funnels through. `in-project` (default)
 * is the unchanged `<main-checkout>/.harnu/memory/`; `central` redirects to
 * `<root>/<repo-name>--<hash8(checkout)>/` (the SAME inner layout — hot.md,
 * decisions.md, roadmap/, sessions/, archive/ — just outside the repo).
 *
 * Pure string math: the shell probes git for `repoId` and loads the config, then
 * feeds both here. Path-containment (`resolvePageFile`) is asserted against
 * WHATEVER dir this returns, so writes never escape the resolved memory dir
 * regardless of where it lives. A `central` config with a blank `root` falls back
 * to in-project rather than writing to a relative path.
 */
export function resolveMemoryDir(
  folder: string,
  repoId: string | undefined,
  config: MemoryLocationConfig = DEFAULT_MEMORY_CONFIG
): string {
  const checkout = resolveMemoryCheckout(folder, repoId)
  if (config.mode === 'central' && config.root.trim()) {
    const root = stripTrailingSep(path.normalize(config.root))
    return path.join(root, centralMemoryFolderName(checkout))
  }
  return memoryDirFor(checkout)
}

/**
 * Build the `where.md` backlink written into a central memory folder (T89): a
 * human- and Harnu-readable note stating which project this memory belongs to, so
 * someone browsing the central root knows the owner and Harnu can detect a
 * moved/stale project. Pure — the shell writes it (once, non-destructive).
 */
export function buildWhereBacklink(input: { sourcePath: string; generatedAt: string }): string {
  return (
    '# Harnu — central memory\n' +
    '> This folder holds Harnu project memory for the repository below (T89). ' +
    'Do not edit by hand — Harnu uses this file to relocate the source project. ' +
    `· generated ${input.generatedAt}\n\n` +
    `- **Project:** \`${input.sourcePath}\`\n`
  )
}

// ---- Page model (traversal gate) --------------------------------------------

/** Write mode a page accepts when targeted by `memory_append`. */
export type MemoryWriteMode = 'append' | 'replace'

/** A validated, in-layout memory page (never escapes `.harnu/memory/`). */
export interface ParsedMemoryPage {
  /** Normalized page id as addressed (e.g. `hot`, `roadmap/T74-markdown-pane`). */
  page: string
  /** Relative file path within the memory dir (e.g. `hot.md`, `roadmap/T74.md`). */
  file: string
  /** How `memory_append` writes it: `replace` ONLY for `hot`, else `append`. */
  mode: MemoryWriteMode
  /** Whether the file must ALREADY exist to be appended (card bodies — never created here). */
  requireExists: boolean
  /** Whether `memory_append` may target this page at all (`index`/`archive` are read-only). */
  appendable: boolean
}

/** Parse outcome for a page identifier. */
export type PageResult = { ok: true; value: ParsedMemoryPage } | { ok: false; detail: string }

/** Sub-directories a `dir/slug` page may live in, with their append policy. */
const PAGE_SUBDIRS: Record<string, { requireExists: boolean; appendable: boolean }> = {
  // Cards: body-append only, and NEVER created here (card creation = T80).
  roadmap: { requireExists: true, appendable: true },
  // Session digests: plain body files (no frontmatter/status), create-on-append OK.
  sessions: { requireExists: false, appendable: true },
  // Frozen historical snapshots: readable, never written by the verb.
  archive: { requireExists: false, appendable: false },
  // Harnu Learn (T123): mission.md / path.md / resources.md / record-NNNN-<name>.md
  // all live flat under this ONE directory (the gate allows only one segment past
  // the dir, so a learning record is `learning/record-0001-intro`, never
  // `learning/records/0001-intro`). Plain body files, create-on-append OK — same
  // policy as `sessions`.
  learning: { requireExists: false, appendable: true }
}

/** Single-segment root pages, with their write policy. */
const PAGE_ROOTS: Record<string, { mode: MemoryWriteMode; appendable: boolean }> = {
  hot: { mode: 'replace', appendable: true },
  decisions: { mode: 'append', appendable: true },
  // Harnu-managed derived catalog: readable, regenerated on write, never appended.
  index: { mode: 'append', appendable: false }
}

/** A page-name segment: filesystem-safe, no traversal, no separators. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

/** Ensure a slug carries the `.md` extension exactly once. */
function withMd(slug: string): string {
  return slug.endsWith('.md') ? slug : `${slug}.md`
}

/**
 * Validate an agent-supplied `page` into an in-layout {@link ParsedMemoryPage}.
 * This is the TRAVERSAL GATE: only the fixed layout is reachable, so a malicious
 * `../../etc/passwd`, an absolute path, a `.md`-less foreign dir, or a `..`
 * segment all fail closed with a `BAD_ARGS`-shaped detail.
 *
 * Accepted shapes:
 *  - a root page: `hot` | `decisions` | `index`;
 *  - a sub-page: `roadmap/<slug>` | `sessions/<slug>` | `archive/<slug>` |
 *    `learning/<slug>`, where `<slug>` is a single filesystem-safe segment
 *    (`.md` optional). Harnu Learn (T123) flattens mission/path/resources/records
 *    into `learning/<slug>` for this reason — the gate never allows a third
 *    segment (see the `learning/records/NNNN` rejection this shape replaces).
 *
 * @param page - the raw, untrusted page identifier.
 * @returns the parsed page, or a `{ ok:false, detail }` reason.
 */
export function parseMemoryPage(page: unknown): PageResult {
  if (typeof page !== 'string') return { ok: false, detail: 'page must be a string' }
  const raw = page.trim()
  if (!raw) return { ok: false, detail: 'page must be a non-empty string' }
  if (raw.length > PAGE_MAX_CHARS) return { ok: false, detail: 'page is too long' }
  if (raw.includes('\\')) return { ok: false, detail: 'page must use "/" separators' }
  if (path.isAbsolute(raw)) return { ok: false, detail: 'page must be relative' }

  const segments = raw.split('/')
  if (segments.some((s) => s === '..' || s === '.' || s.length === 0)) {
    return { ok: false, detail: 'page must not contain empty or ".." segments' }
  }

  if (segments.length === 1) {
    const root = PAGE_ROOTS[stripMd(segments[0])]
    if (!SAFE_SEGMENT.test(segments[0]) || !root) {
      return { ok: false, detail: `unknown page "${raw}" (expected hot | decisions | index)` }
    }
    const name = stripMd(segments[0])
    return {
      ok: true,
      value: {
        page: name,
        file: withMd(name),
        mode: root.mode,
        requireExists: false,
        appendable: root.appendable
      }
    }
  }

  if (segments.length === 2) {
    const [dir, slugRaw] = segments
    const policy = PAGE_SUBDIRS[dir]
    if (!policy) {
      return {
        ok: false,
        detail: `unknown page directory "${dir}" (expected roadmap | sessions | archive | learning)`
      }
    }
    if (!SAFE_SEGMENT.test(slugRaw)) {
      return { ok: false, detail: `invalid page name "${slugRaw}"` }
    }
    const slug = stripMd(slugRaw)
    return {
      ok: true,
      value: {
        page: `${dir}/${slug}`,
        file: `${dir}/${withMd(slug)}`,
        mode: 'append',
        requireExists: policy.requireExists,
        appendable: policy.appendable
      }
    }
  }

  return { ok: false, detail: 'page has too many path segments' }
}

/** Strip a trailing `.md` (for canonicalizing the page id). */
function stripMd(slug: string): string {
  return slug.endsWith('.md') ? slug.slice(0, -3) : slug
}

/**
 * Resolve a validated page to its absolute file path and assert it stays inside
 * the memory dir (belt-and-suspenders: {@link parseMemoryPage} already refuses
 * traversal, this re-checks the joined result). Returns `null` if containment
 * somehow fails — the shell then denies rather than touching the path.
 */
export function resolvePageFile(memoryDir: string, parsed: ParsedMemoryPage): string | null {
  const abs = path.resolve(memoryDir, parsed.file)
  const rel = path.relative(memoryDir, abs)
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    return null
  }
  return abs
}

// ---- Entry validation (caps + secrets) --------------------------------------

/** Uniform validation outcome for an entry (mirrors the gate's BAD_ARGS shape). */
export type EntryCheck = { ok: true } | { ok: false; detail: string }

/** Obvious credential shapes refused before disclosure/write. Kind, never the value. */
const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'private-key-block', re: /-----BEGIN(?:[ A-Z]+)? PRIVATE KEY-----/ },
  { kind: 'aws-access-key-id', re: /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/ },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    kind: 'credential-assignment',
    re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9/+_=.-]{12,}/i
  }
]

/**
 * Refuse an entry that carries an OBVIOUS secret (§7 — "simple lint for obvious
 * patterns before writing"). Reports the matched pattern KIND so the steer names
 * the class without echoing the credential; fail-closed (a match blocks).
 */
export function lintSecrets(text: string): { ok: true } | { ok: false; kind: string } {
  for (const { kind, re } of SECRET_PATTERNS) {
    if (re.test(text)) return { ok: false, kind }
  }
  return { ok: true }
}

/** Count whitespace-delimited words (for the `hot.md` cap). */
function wordCount(text: string): number {
  const t = text.trim()
  return t.length === 0 ? 0 : t.split(/\s+/).length
}

/**
 * Validate an entry against a resolved page: appendability, the per-entry char
 * cap, the `hot.md` word cap (replace pages), and the anti-secret lint. Pure —
 * the gate validator and the shell both call this so the same bytes are refused
 * everywhere, before any disclosure or write.
 */
export function validateEntry(parsed: ParsedMemoryPage, entry: string): EntryCheck {
  if (!parsed.appendable) {
    return {
      ok: false,
      detail: `page "${parsed.page}" is Harnu-managed and cannot be written via memory_append`
    }
  }
  if (entry.trim().length === 0) return { ok: false, detail: 'entry must be non-empty' }
  if (entry.length > MEMORY_ENTRY_MAX_CHARS) {
    return { ok: false, detail: `entry exceeds the ${MEMORY_ENTRY_MAX_CHARS}-char cap` }
  }
  if (parsed.mode === 'replace' && wordCount(entry) > HOT_MAX_WORDS) {
    return {
      ok: false,
      detail: `hot.md is capped at ${HOT_MAX_WORDS} words — trim the snapshot (it is a 1s retrieval cue, not a log)`
    }
  }
  const secret = lintSecrets(entry)
  if (!secret.ok) {
    return {
      ok: false,
      detail: `entry looks like it contains a secret (${secret.kind}); memory is not a secret store`
    }
  }
  return { ok: true }
}

// ---- Provenance (stamped server-side, never from args) ----------------------

/** Who wrote a memory entry. Derived from the authenticated caller, NEVER from content. */
export type MemoryAuthor = 'human' | 'agent'

/** The canonical provenance stamped on every entry (§3.2). Values are EN. */
export interface Provenance {
  author: MemoryAuthor
  /** `YYYY-MM-DD` (server clock). */
  at: string
  /** Originating Harnu session id, when known (empty via the shared-token MCP transport). */
  sessionId?: string
  /** Originating branch/worktree, derived server-side from the folder's git meta. */
  branch?: string
  /** Campaign ch.6: the mission this entry was recorded for (`mission:<id>`), stamped server-side. */
  mission?: string
}

/** Format an injected epoch-ms clock as the `YYYY-MM-DD` provenance date. */
export function formatMemoryDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

/**
 * Render provenance as a VISIBLE, greppable one-line blockquote (§7 — visible
 * provenance per entry is the cross-session prompt-injection mitigation). Stable
 * prefix `> provenance:` so a reader sees who wrote it and a tool can parse it.
 */
export function renderProvenance(p: Provenance): string {
  const parts = [`author=${p.author}`, `at=${p.at}`]
  if (p.branch) parts.push(`branch=${p.branch}`)
  if (p.sessionId) parts.push(`session=${p.sessionId}`)
  if (p.mission) parts.push(`mission=${p.mission}`)
  return `> provenance: ${parts.join(' · ')}`
}

// ---- Content assembly (body-append / hot-replace, frontmatter-safe) ---------

/** Split a document into its leading YAML frontmatter block (if any) and body. */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const m = /^---\r?\n/.exec(content)
  if (!m) return { frontmatter: '', body: content }
  const afterOpen = content.slice(m[0].length)
  const close = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(afterOpen)
  if (!close) return { frontmatter: '', body: content } // malformed → treat as body (never corrupt)
  const end = m[0].length + close.index + close[0].length
  return { frontmatter: content.slice(0, end), body: content.slice(end) }
}

/**
 * Build the new file content for a `memory_append`. APPEND preserves any YAML
 * frontmatter + the existing body and adds the entry + a provenance stamp to the
 * BODY (never touches frontmatter/`status` — §3.3). REPLACE (`hot.md` only)
 * preserves frontmatter and swaps the whole body for the entry + stamp.
 *
 * Pure: the shell reads `existing` from disk (or `''` for a fresh file) and
 * writes the returned string back.
 */
export function buildMemoryWrite(input: {
  existing: string
  entry: string
  provenance: Provenance
  mode: MemoryWriteMode
  /** Campaign ch.6: the `> entry:` line (id, valid_from, watches, supersedes) — see `memory-entries.ts`. */
  meta?: EntryMeta
}): string {
  const { existing, entry, provenance, mode, meta } = input
  const { frontmatter, body } = splitFrontmatter(existing)
  const metaLine = meta ? `${renderEntryMeta(meta)}\n` : ''
  const block = `${entry.trim()}\n\n${metaLine}${renderProvenance(provenance)}\n`

  if (mode === 'replace') {
    const fmPart = frontmatter ? `${frontmatter.replace(/\s*$/, '')}\n\n` : ''
    return `${fmPart}${block}`
  }

  const trimmedBody = body.replace(/\s+$/, '')
  const spacer = trimmedBody.length > 0 ? '\n\n' : ''
  return `${frontmatter}${trimmedBody}${spacer}${block}`
}

// ---- Index (deterministic, Harnu-regenerated on write) -----------------------

/** Minimal card metadata parsed from a roadmap card's frontmatter. */
export interface CardMeta {
  id?: string
  title?: string
  status?: string
  /** The branch a dispatch stamped on the card (`executedIn`); present on in-progress cards. */
  executedIn?: string
}

/** One roadmap card for the index (its metadata + the page id linking to it). */
export interface IndexCard extends CardMeta {
  /** Page id (e.g. `roadmap/T74-markdown-pane`) — the `[[...]]` link target. */
  page: string
}

/** The listing the shell feeds {@link buildMemoryIndex} after scanning the dir. */
export interface IndexInput {
  hasHot: boolean
  hasDecisions: boolean
  cards: IndexCard[]
  sessions: string[]
  archive: string[]
  /**
   * Harnu Learn (T123) filenames under `learning/` — mission/path/resources/
   * records, all flat in one dir (§ PAGE_SUBDIRS). Optional so pre-T123 callers
   * (and existing fixtures) don't need updating; treated as `[]` when absent.
   */
  learning?: string[]
  /** `YYYY-MM-DD` generation date (injected clock). */
  generatedAt: string
}

/** The status order the index groups cards under (unknown/other trails). */
const STATUS_ORDER = ['ready', 'in-progress', 'review', 'backlog', 'done', 'dropped'] as const

/**
 * Parse the minimal `id` / `title` / `status` from a card's YAML frontmatter.
 * A shallow top-level line scan (NOT a full YAML parse) — deterministic and
 * dependency-free; nested keys (e.g. `provenance.author`) are ignored because
 * they are indented. Returns whatever it finds; every field is optional.
 */
export function parseCardMeta(content: string): CardMeta {
  const { frontmatter } = splitFrontmatter(content)
  if (!frontmatter) return {}
  const meta: CardMeta = {}
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    // Top-level only: no leading whitespace (skips nested provenance/etc.).
    const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(rawLine)
    if (!m) continue
    const key = m[1]
    const value = m[2].trim().replace(/^["']|["']$/g, '')
    if (key === 'id' && value) meta.id = value
    else if (key === 'title' && value) meta.title = value
    else if (key === 'status' && value) meta.status = value
    else if (key === 'executedIn' && value && value !== 'null') meta.executedIn = value
  }
  return meta
}

/** The label a card is listed under: `id: title`, else the id, else its page id. */
function cardLabel(c: IndexCard): string {
  const title = c.title ? clipChars(c.title, READ_TITLE_MAX_CHARS) : ''
  return title ? `${c.id ?? c.page}: ${title}` : (c.id ?? c.page)
}

/** Cut a string to `max` characters (code points), ending with `…` when cut. */
function clipChars(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…'
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

/** A card's status as the read surfaces name it (`no-status` when absent or blank). */
function statusOf(c: CardMeta): string {
  return (c.status ?? 'no-status').trim() || 'no-status'
}

function statusRank(status: string): number {
  const i = (STATUS_ORDER as readonly string[]).indexOf(status)
  return i === -1 ? STATUS_ORDER.length : i
}

/** Cards in the surfaces' order: status order (unknown last, alphabetical), then page id. */
export function sortCards(cards: readonly IndexCard[]): IndexCard[] {
  return cards.slice().sort((a, b) => {
    const sa = statusOf(a)
    const sb = statusOf(b)
    return (
      statusRank(sa) - statusRank(sb) ||
      (sa < sb ? -1 : sa > sb ? 1 : 0) ||
      (a.page < b.page ? -1 : a.page > b.page ? 1 : 0)
    )
  })
}

function byPage(cards: readonly IndexCard[], status: string): IndexCard[] {
  return cards
    .filter((c) => statusOf(c) === status)
    .sort((a, b) => (a.page < b.page ? -1 : a.page > b.page ? 1 : 0))
}

/**
 * Build the deterministic `index.md` (§3.4 — regenerated on every write; the user's other files
 * stay sovereign). U2 F-3: capped at {@link INDEX_MAX_BYTES}. It lists the layers with their
 * counts, the in-progress and then the ready cards as links, and one line naming the paginated
 * `memory_read` views for the rest; when the active cards would pass the cap the tail of `ready`
 * (then of `in-progress`) is left out and a line says how many. Pure.
 */
export function buildMemoryIndex(input: IndexInput): string {
  const head: string[] = []
  head.push('# Harnu — memory index (auto-generated)')
  head.push(
    `> Deterministic catalog regenerated by Harnu on every write (T79). Tiered model: **hot → index → page**. Read \`hot.md\` first. · updated ${input.generatedAt}`
  )
  head.push('')
  head.push('## Layers')
  if (input.hasHot) head.push('- **hot.md** — where we left off (1s resume). Read first.')
  if (input.hasDecisions) head.push('- **decisions.md** — dated decisions + why (append-only).')
  head.push(
    `- **roadmap/** — cards (1 file = 1 item, \`status\` frontmatter). ${input.cards.length} cards.`
  )
  head.push(`- **sessions/** — session digests. ${input.sessions.length} files.`)
  head.push(`- **archive/** — frozen, read-only history. ${input.archive.length} files.`)
  const learningCount = input.learning?.length ?? 0
  if (learningCount > 0) {
    head.push(
      `- **learning/** — Harnu Learn mission, path, resources, and learning records (T123). ${learningCount} files.`
    )
  }

  const tail = [
    '',
    "Every other card, with its status: `memory_read({ folder, page: 'cards' })`. The session digests: `memory_read({ folder, page: 'sessions' })`."
  ]
  const link = (c: IndexCard): string => `- [[${c.page}|${cardLabel(c)}]]`
  const inProgress = byPage(input.cards, 'in-progress')
  const ready = byPage(input.cards, 'ready')

  const render = (ip: IndexCard[], rd: IndexCard[], omitted: number): string => {
    const lines = [...head]
    if (ip.length > 0) lines.push('', '## In progress', ...ip.map(link))
    if (rd.length > 0) lines.push('', '## Ready', ...rd.map(link))
    if (omitted > 0) lines.push('', `_${omitted} more active cards are not listed here._`)
    lines.push(...tail)
    return lines.join('\n') + '\n'
  }

  let ip = inProgress
  let rd = ready
  let out = render(ip, rd, 0)
  while (utf8Bytes(out) > INDEX_MAX_BYTES && (ip.length > 0 || rd.length > 0)) {
    if (rd.length > 0) rd = rd.slice(0, -1)
    else ip = ip.slice(0, -1)
    out = render(ip, rd, inProgress.length - ip.length + (ready.length - rd.length))
  }
  return out
}

// ---- The tiered read (U2 S-1: F-1 default answer, F-2 list views) ------------

/** `hot.md` as the read serves it: no frontmatter, no `> provenance:` stamp, trimmed. */
export function hotForRead(hot: string): string {
  const { body } = splitFrontmatter(hot)
  return body
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith('> provenance:'))
    .join('\n')
    .trim()
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes on a line boundary. One line longer than the
 * budget is cut on a character boundary rather than dropped. Reports whether anything was cut.
 */
export function cutToBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (utf8Bytes(text) <= maxBytes) return { text, cut: false }
  const kept: string[] = []
  let used = 0
  for (const line of text.split('\n')) {
    const next = used + utf8Bytes(line) + (kept.length > 0 ? 1 : 0)
    if (next > maxBytes) break
    kept.push(line)
    used = next
  }
  if (kept.length === 0) {
    let out = ''
    for (const ch of text) {
      if (utf8Bytes(out + ch) > maxBytes) break
      out += ch
    }
    return { text: out, cut: true }
  }
  return { text: kept.join('\n'), cut: true }
}

/** What the shell feeds {@link buildMemoryReadAnswer} after scanning the directory. */
export interface MemoryReadInput {
  /** `hot.md` as stored, or `null` when absent. */
  hot: string | null
  cards: readonly IndexCard[]
  /** Digest files under `sessions/`. */
  sessions: number
  /** Addressable `> entry:` blocks in `decisions.md`. */
  decisions: number
  archive: number
  learning: number
}

interface CardRow {
  id: string
  title: string
  page: string
  executedIn?: string
}

/** The `more` block of the default read: how to reach everything it leaves out. */
const READ_MORE = {
  cards: "memory_read({ folder, page: 'cards', status?, limit?, cursor? })",
  sessions: "memory_read({ folder, page: 'sessions', limit?, cursor? })",
  page: "memory_read({ folder, page: '<page id>' })"
} as const

function cardRow(c: IndexCard, withBranch: boolean): CardRow {
  const id = c.id ?? c.page.replace(/^roadmap\//, '')
  const row: CardRow = { id, title: clipChars(c.title ?? id, READ_TITLE_MAX_CHARS), page: c.page }
  if (withBranch && c.executedIn) row.executedIn = c.executedIn
  return row
}

/**
 * The page-less `memory_read` answer (U2 F-1): the handoff (`hot`), the in-progress and ready
 * cards, the counts and where to read more, under {@link MEMORY_READ_MAX_BYTES}. Rows leave from
 * the end of `ready` first, then of `inProgress`; `counts` and `more` never do. `bytes` is the
 * UTF-8 length of the serialized answer, itself included. Pure.
 */
export function buildMemoryReadAnswer(input: MemoryReadInput): {
  ok: true
  memory: Record<string, unknown>
} {
  const hotCut = cutToBytes(hotForRead(input.hot ?? ''), READ_HOT_MAX_BYTES)
  const inProgressAll = byPage(input.cards, 'in-progress')
  const readyAll = byPage(input.cards, 'ready')
  let inProgress = inProgressAll.slice(0, READ_CARD_ROWS_MAX).map((c) => cardRow(c, true))
  let ready = readyAll.slice(0, READ_CARD_ROWS_MAX).map((c) => cardRow(c, false))

  const cardCounts = new Map<string, number>()
  for (const c of input.cards) cardCounts.set(statusOf(c), (cardCounts.get(statusOf(c)) ?? 0) + 1)
  const counts = {
    cards: Object.fromEntries(
      [...cardCounts.entries()].sort(
        (a, b) => statusRank(a[0]) - statusRank(b[0]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
      )
    ),
    sessions: input.sessions,
    decisions: input.decisions,
    archive: input.archive,
    learning: input.learning
  }

  const assemble = (bytes: number): { ok: true; memory: Record<string, unknown> } => {
    const omitted = inProgressAll.length - inProgress.length + (readyAll.length - ready.length)
    const memory: Record<string, unknown> = {
      hot: hotCut.text,
      cards: { inProgress, ready },
      counts,
      more: READ_MORE,
      truncated: hotCut.cut || omitted > 0
    }
    if (omitted > 0) memory.cardsOmitted = omitted
    memory.bytes = bytes
    return { ok: true, memory }
  }

  // Size with the widest `bytes` the cap allows, then drop rows until it fits.
  const measure = (): number => utf8Bytes(JSON.stringify(assemble(MEMORY_READ_MAX_BYTES)))
  while (measure() > MEMORY_READ_MAX_BYTES && (ready.length > 0 || inProgress.length > 0)) {
    if (ready.length > 0) ready = ready.slice(0, -1)
    else inProgress = inProgress.slice(0, -1)
  }

  // `bytes` counts itself: iterate to the fixed point (it settles within a few digits).
  let bytes = 0
  for (let i = 0; i < 6; i++) {
    const next = utf8Bytes(JSON.stringify(assemble(bytes)))
    if (next === bytes) break
    bytes = next
  }
  return assemble(bytes)
}

/** The views `memory_read` can page. */
export type ListView = 'cards' | 'sessions'

/** A cursor encodes the view, the filter and an offset; opaque to the caller (base64url). */
export function encodeCursor(view: ListView, offset: number, status?: string): string {
  const raw = `${view}:${offset}${status ? `:${status}` : ''}`
  return Buffer.from(raw, 'utf8').toString('base64url')
}

/** Decode a cursor for `view` and `status`; refuses one made for another view or filter. */
export function decodeCursor(
  cursor: string,
  view: ListView,
  status?: string
): { ok: true; offset: number } | { ok: false; detail: string } {
  const bad = { ok: false as const, detail: 'the cursor does not belong to this view and filter' }
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return bad
  const raw = Buffer.from(cursor, 'base64url').toString('utf8')
  const m = /^(cards|sessions):(\d+)(?::(.+))?$/.exec(raw)
  if (!m || m[1] !== view || (m[3] ?? undefined) !== (status || undefined)) return bad
  return { ok: true, offset: Number(m[2]) }
}

/** One item of a list view (cards: id/title/status/page; sessions: page/date/title/branch?/sessionId?). */
export type ListItem = Record<string, string>

/**
 * A list view answer (U2 F-2). `items` is the window the shell loaded starting at `offset` (at
 * most `limit` rows); the answer ends early, with `truncated: true` and a `nextCursor` resuming
 * after the last row it kept, when the window would pass {@link MEMORY_READ_MAX_BYTES}. Pure.
 */
export function buildListAnswer(input: {
  view: ListView
  items: readonly ListItem[]
  total: number
  offset: number
  status?: string
}): {
  ok: true
  page: ListView
  items: ListItem[]
  total: number
  nextCursor: string | null
  truncated: boolean
} {
  const make = (
    n: number
  ): {
    ok: true
    page: ListView
    items: ListItem[]
    total: number
    nextCursor: string | null
    truncated: boolean
  } => ({
    ok: true,
    page: input.view,
    items: input.items.slice(0, n) as ListItem[],
    total: input.total,
    nextCursor:
      input.offset + n < input.total
        ? encodeCursor(input.view, input.offset + n, input.status)
        : null,
    truncated: n < input.items.length
  })
  let n = input.items.length
  while (n > 1 && utf8Bytes(JSON.stringify(make(n))) > MEMORY_READ_MAX_BYTES) n--
  return make(n)
}

/** The list-view row of a card. */
export function cardListItem(c: IndexCard): ListItem {
  const row = cardRow(c, false)
  return { id: row.id, title: row.title, status: statusOf(c), page: row.page }
}

/** The list-view row of a digest (`branch` and `sessionId` only when its stamp carries them). */
export function digestListItem(d: DigestMeta): ListItem {
  const item: ListItem = {
    page: d.page,
    date: d.date,
    title: clipChars(d.title, READ_TITLE_MAX_CHARS)
  }
  if (d.branch) item.branch = d.branch
  if (d.sessionId) item.sessionId = d.sessionId
  return item
}

/** Digest file names, newest first by the date in the name, then by name (the timeline's order). */
export function sortDigestNames(names: readonly string[]): string[] {
  const dateOf = (n: string): string => DIGEST_NAME.exec(n)?.[1] ?? ''
  return names.slice().sort((a, b) => {
    const da = dateOf(a)
    const db = dateOf(b)
    if (da !== db) return da < db ? 1 : -1
    return a < b ? 1 : a > b ? -1 : 0
  })
}

// ---- Query (v1 grep) --------------------------------------------------------

/** One `memory_query` match: the page it came from, 1-indexed line, and text. */
export interface MemoryMatch {
  page: string
  line: number
  text: string
}

/** A memory file fed to {@link grepMemory}: its page id and full content. */
export interface MemoryFile {
  page: string
  content: string
}

/**
 * The v1 `memory_query` retrieval (§3.3): a plain case-insensitive substring
 * grep across the memory files, bounded to {@link MEMORY_QUERY_MAX_MATCHES}.
 * Pure — the shell reads the files and feeds them. (BM25/embeddings is S5, only
 * if grep proves insufficient.)
 */
export function grepMemory(
  files: readonly MemoryFile[],
  query: string,
  max: number = MEMORY_QUERY_MAX_MATCHES
): { matches: MemoryMatch[]; truncated: boolean } {
  const needle = query.trim().toLowerCase()
  const matches: MemoryMatch[] = []
  if (!needle) return { matches, truncated: false }

  for (const file of files) {
    const lines = file.content.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue
      if (matches.length >= max) return { matches, truncated: true }
      matches.push({ page: file.page, line: i + 1, text: elide(lines[i].trim()) })
    }
  }
  return { matches, truncated: false }
}

/** Truncate an over-long grep line so the query payload stays bounded. */
function elide(text: string): string {
  return text.length <= QUERY_LINE_MAX_CHARS ? text : text.slice(0, QUERY_LINE_MAX_CHARS - 1) + '…'
}

// ---- Hot preview (the 1s hover cue — §4.2) ----------------------------------

/** Default number of content lines the folder-hover preview of `hot.md` shows. */
export const HOT_PREVIEW_MAX_LINES = 6

/**
 * Extract the top of `hot.md` for the folder-hover card (§4.2 — "where we left
 * off" in 1s). Pure string math: strips the YAML frontmatter, the leading `# ` title
 * and any leading blockquote chrome (the scaffold's `> ≤500 words…` guidance),
 * and the machine `> provenance:` stamp, then returns the first `maxLines`
 * non-blank content lines as a markdown STRING (list markers / bold preserved so
 * `MarkdownRenderer` renders them).
 *
 * For a real hot (post-`memory_append(page:hot)` replace → `<snapshot>` + a
 * trailing provenance stamp) this yields the snapshot; for a freshly-scaffolded
 * hot it yields just the `_(memory just created…)_` placeholder — honest, never
 * the chrome. Returns `''` when there is nothing but chrome.
 */
export function extractHotPreview(hot: string, maxLines: number = HOT_PREVIEW_MAX_LINES): string {
  const { body } = splitFrontmatter(hot)
  const lines = body.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''))

  // Skip leading chrome: blank lines, the H1 title, and guidance blockquotes.
  let start = 0
  while (start < lines.length) {
    const l = lines[start].trim()
    if (l === '' || l.startsWith('# ') || l.startsWith('>')) start++
    else break
  }

  const out: string[] = []
  for (let i = start; i < lines.length && out.length < maxLines; i++) {
    const trimmed = lines[i].trim()
    // Drop the machine provenance stamp wherever it sits (it is meta, not cue).
    if (trimmed.startsWith('> provenance:')) continue
    // Keep blank lines only when they separate collected content (never leading).
    if (trimmed === '' && out.length === 0) continue
    out.push(lines[i])
  }
  // Trim trailing blanks the loop may have collected between paragraphs.
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out.join('\n')
}

// ---- Session digest timeline (§4.2) -----------------------------------------

/** Filename shape of an auto-digest: `YYYY-MM-DD-<sessionId8>.md` (§3.2). */
const DIGEST_NAME = /^(\d{4}-\d{2}-\d{2})-([A-Za-z0-9]+)\.md$/

/**
 * One parsed session digest for the memory-pane timeline (§4.2). The `date` +
 * `sessionShort` come from the filename; `title` from the first `# ` heading;
 * `author` / `branch` / `sessionId` from the visible `> provenance:` stamp.
 */
export interface DigestMeta {
  /** Page id linking to the digest (e.g. `sessions/2026-07-06-a1b2c3d4`). */
  page: string
  /** Relative file path within the memory dir (`sessions/<slug>.md`). */
  file: string
  /** `YYYY-MM-DD` parsed from the filename (`''` when it doesn't match). */
  date: string
  /** The 8-ish char session-id prefix from the filename (`''` when none). */
  sessionShort: string
  /** First `# ` heading, else the filename stem — always non-empty. */
  title: string
  /** Provenance author, when the stamp is present. */
  author?: MemoryAuthor
  /** Provenance branch, when stamped. */
  branch?: string
  /** FULL session id from the provenance stamp, when present (may exceed the 8-char stem). */
  sessionId?: string
  /**
   * What the digest was written from, read off its header line (`· evidence: <kind>_`): commits,
   * no commits, a folder outside git, or a removed folder. Absent for a digest without the token.
   */
  evidence?: DigestEvidence
}

/** The evidence kinds a digest header can carry (memory U1, "Evidence token"). */
export type DigestEvidence = 'commits' | 'no-commits' | 'no-git' | 'orphan'

/** The header line `renderDigest` writes: an italic line ending `· evidence: <kind>_`. */
const EVIDENCE_TOKEN = /^_.*·\s*evidence:\s*(commits|no-commits|no-git|orphan)_\s*$/

/**
 * The evidence kind of the latest digest header in the body, or undefined without one. A session
 * page is appended to by each later digest of the session that day, so the last header is the
 * session's current state (first no commits, later commits reads "commits").
 */
function digestEvidence(content: string): DigestEvidence | undefined {
  const { body } = splitFrontmatter(content)
  let kind: DigestEvidence | undefined
  for (const rawLine of body.split(/\r?\n/)) {
    const m = EVIDENCE_TOKEN.exec(rawLine.trim())
    if (m) kind = m[1] as DigestEvidence
  }
  return kind
}

/** A raw digest file fed to {@link buildTimeline}: its filename and full content. */
export interface DigestFile {
  /** Basename only, e.g. `2026-07-06-a1b2c3d4.md`. */
  name: string
  content: string
}

/**
 * Parse the visible `> provenance:` blockquote (as rendered by
 * {@link renderProvenance}) back into its fields. Tolerant of spacing and field
 * order; unknown keys are ignored. Returns `{}` when no stamp line is present.
 */
export function parseProvenanceLine(content: string): {
  author?: MemoryAuthor
  at?: string
  branch?: string
  sessionId?: string
} {
  const out: { author?: MemoryAuthor; at?: string; branch?: string; sessionId?: string } = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('> provenance:')) continue
    const rest = line.slice('> provenance:'.length)
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
    return out // first stamp wins
  }
  return out
}

/** First `# ` heading in the body (after frontmatter), or `''` when none. */
function firstHeading(content: string): string {
  const { body } = splitFrontmatter(content)
  for (const rawLine of body.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(rawLine)
    if (m) return m[1].trim()
  }
  return ''
}

/**
 * Parse one session-digest file into its {@link DigestMeta}. Pure — the shell
 * reads the file and feeds `{ name, content }`. Files whose name doesn't match
 * the `YYYY-MM-DD-<id>.md` convention still parse (date/sessionShort empty), so
 * a hand-authored digest never breaks the timeline.
 */
export function parseDigestMeta(name: string, content: string): DigestMeta {
  const stem = name.replace(/\.md$/, '')
  const m = DIGEST_NAME.exec(name)
  const date = m ? m[1] : ''
  const sessionShort = m ? m[2] : ''
  const prov = parseProvenanceLine(content)
  const meta: DigestMeta = {
    page: `sessions/${stem}`,
    file: `sessions/${name}`,
    date,
    sessionShort,
    title: firstHeading(content) || stem
  }
  if (prov.author) meta.author = prov.author
  if (prov.branch) meta.branch = prov.branch
  if (prov.sessionId) meta.sessionId = prov.sessionId
  const evidence = digestEvidence(content)
  if (evidence) meta.evidence = evidence
  return meta
}

/**
 * Build the memory-pane timeline (§4.2 — the default view of the digests): parse
 * every `sessions/` file and sort **newest first** by filename date, then by name
 * descending as a stable tiebreaker (the `sessionId8` suffix disambiguates same-day
 * digests deterministically). Pure — the shell supplies the files.
 */
export function buildTimeline(files: readonly DigestFile[]): DigestMeta[] {
  return files
    .map((f) => parseDigestMeta(f.name, f.content))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1
      return a.file < b.file ? 1 : a.file > b.file ? -1 : 0
    })
}
