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
 */

import * as path from 'node:path'
import { dataDirAt } from '../data-dir'

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
}): string {
  const { existing, entry, provenance, mode } = input
  const { frontmatter, body } = splitFrontmatter(existing)
  const block = `${entry.trim()}\n\n${renderProvenance(provenance)}\n`

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
  }
  return meta
}

/**
 * Build the deterministic `index.md` catalog (§3.4 — regenerated on every write,
 * cheap + deterministic; the user's other files stay sovereign). Cards are
 * grouped by `status` (canonical order first, unknown statuses last, sorted by
 * page within a group). Pure.
 */
export function buildMemoryIndex(input: IndexInput): string {
  const lines: string[] = []
  lines.push('# Harnu — memory index (auto-generated)')
  lines.push(
    `> Deterministic catalog regenerated by Harnu on every write (T79). Tiered model: **hot → index → page**. Read \`hot.md\` first. · updated ${input.generatedAt}`
  )
  lines.push('')
  lines.push('## Layers')
  if (input.hasHot) lines.push('- **hot.md** — where we left off (1s resume). Read first.')
  if (input.hasDecisions) lines.push('- **decisions.md** — dated decisions + why (append-only).')
  lines.push(
    `- **roadmap/** — cards (1 file = 1 item, \`status\` frontmatter). ${input.cards.length} cards.`
  )
  lines.push(`- **sessions/** — session digests. ${input.sessions.length} files.`)
  lines.push(`- **archive/** — frozen, read-only history. ${input.archive.length} files.`)
  const learningCount = input.learning?.length ?? 0
  if (learningCount > 0) {
    lines.push(
      `- **learning/** — Harnu Learn mission, path, resources, and learning records (T123). ${learningCount} files.`
    )
  }

  if (input.cards.length > 0) {
    lines.push('')
    lines.push('## Cards by status')
    const byStatus = new Map<string, IndexCard[]>()
    for (const card of input.cards) {
      const key = (card.status ?? 'no-status').trim() || 'no-status'
      const bucket = byStatus.get(key)
      if (bucket) bucket.push(card)
      else byStatus.set(key, [card])
    }
    const rank = (s: string): number => {
      const i = (STATUS_ORDER as readonly string[]).indexOf(s)
      return i === -1 ? STATUS_ORDER.length : i
    }
    const statuses = [...byStatus.keys()].sort(
      (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0)
    )
    for (const status of statuses) {
      const cards = (byStatus.get(status) ?? [])
        .slice()
        .sort((a, b) => (a.page < b.page ? -1 : a.page > b.page ? 1 : 0))
      const rendered = cards
        .map((c) => {
          const label = c.title ? `${c.id ?? c.page}: ${c.title}` : (c.id ?? c.page)
          return `[[${c.page}|${label}]]`
        })
        .join(' · ')
      lines.push(`- **${status}**: ${rendered}`)
    }
  }

  return lines.join('\n') + '\n'
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
