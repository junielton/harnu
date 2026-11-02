/**
 * Campaign ch.6 (T598, spec §3.6) — the memory entry schema, pure.
 *
 * A memory entry written with metadata carries ONE extra visible line between its text and its
 * `> provenance:` stamp:
 *
 *     > entry: e-1a2b3c4d · valid_from=2026-11-02 · watches=src/main/foo.ts,gates · supersedes=e-0f0f0f0f
 *
 * - `id` — content-addressed ({@link mintEntryId}); what `supersedes` / `superseded_by` point at.
 * - `valid_from` — when the decision started to hold.
 * - `watches` — repo paths (a file, or a directory with a trailing `/`) and topics (single words)
 *   the entry is about. Recall (AC-6.3) matches these against a new mission's scope.
 * - `supersedes` — the id of the entry this one replaces; the old entry then gains
 *   `superseded_by=<new id>` ({@link markSuperseded}), the ONLY edit ever made to an existing entry.
 *
 * Entries without a meta line (all memory written before this chapter) are simply not part of the
 * chain and never recalled. Everything here works on strings: the shell reads and writes the files.
 */

import { createHash } from 'node:crypto'
import type { MemoryFile, MemoryMatch } from './memory-core'

/** The structured part of a `> entry:` line. */
export interface EntryMeta {
  id: string
  validFrom?: string
  watches?: string[]
  supersedes?: string
  supersededBy?: string
}

/** One parsed entry: where it sits on its page and what its meta line says. */
export interface ParsedEntry {
  meta: EntryMeta
  /** First non-blank line of the entry text, with any leading `#`s removed. */
  title: string
  /** 1-indexed line of that first non-blank line. */
  startLine: number
  /** 1-indexed line of the entry's `> provenance:` stamp (the block's last line). */
  endLine: number
}

const ENTRY_PREFIX = '> entry:'
const PROVENANCE_PREFIX = '> provenance:'
const ID_RE = /^e-[0-9a-f]{8}$/

/** `e-<8 hex>` derived from the entry text and its date — the same input always names the same entry. */
export function mintEntryId(entry: string, at: string): string {
  return `e-${createHash('sha256').update(`${at}\n${entry.trim()}`).digest('hex').slice(0, 8)}`
}

/** True for a well-formed entry id. */
export function isEntryId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value)
}

/** A watch token is stored comma-separated on one line: no whitespace, no commas. */
export function normalizeWatch(raw: string): string {
  return raw.trim().replace(/[\s,·]+/g, '-')
}

/** Render the `> entry:` line. */
export function renderEntryMeta(meta: EntryMeta): string {
  const out = [meta.id]
  if (meta.validFrom) out.push(`valid_from=${meta.validFrom}`)
  const watches = (meta.watches ?? []).map(normalizeWatch).filter(Boolean)
  if (watches.length > 0) out.push(`watches=${watches.join(',')}`)
  if (meta.supersedes) out.push(`supersedes=${meta.supersedes}`)
  if (meta.supersededBy) out.push(`superseded_by=${meta.supersededBy}`)
  return `${ENTRY_PREFIX} ${out.join(' · ')}`
}

function parseMetaLine(line: string): EntryMeta | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith(ENTRY_PREFIX)) return null
  const [idPart, ...rest] = trimmed.slice(ENTRY_PREFIX.length).split('·')
  const id = idPart.trim()
  if (!ID_RE.test(id)) return null
  const meta: EntryMeta = { id }
  for (const part of rest) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!value) continue
    if (key === 'valid_from') meta.validFrom = value
    else if (key === 'watches') meta.watches = value.split(',').filter(Boolean)
    else if (key === 'supersedes') meta.supersedes = value
    else if (key === 'superseded_by') meta.supersededBy = value
  }
  return meta
}

/**
 * Every entry on a page that carries a meta line. A block is the text between one `> provenance:`
 * stamp and the next; a block with no meta line (older memory, a hand edit) is skipped.
 */
export function parseEntries(content: string): ParsedEntry[] {
  const lines = content.split(/\r?\n/)
  const out: ParsedEntry[] = []
  let blockStart = 0
  let meta: EntryMeta | null = null
  for (let i = 0; i < lines.length; i++) {
    const m = parseMetaLine(lines[i])
    if (m) meta = m
    if (!lines[i].trim().startsWith(PROVENANCE_PREFIX)) continue
    if (meta) {
      let first = blockStart
      // The first block of a fresh page also holds the scaffold header (an H1 and a `>` guidance
      // quote); the entry starts after it.
      const chrome = blockStart === 0 ? /^(?:#\s|>)/ : null
      while (first < i && (lines[first].trim() === '' || chrome?.test(lines[first]))) first++
      const title = lines[first].replace(/^\s*#+\s*/, '').trim()
      out.push({ meta, title, startLine: first + 1, endLine: i + 1 })
    }
    meta = null
    blockStart = i + 1
  }
  return out
}

/**
 * Mark `oldId` as replaced by `newId`: its meta line gains ` · superseded_by=<newId>`. Returns the
 * new content, or `null` when the page has no such entry or it already has a successor — a chain
 * stays a chain, never a fork. Nothing else on the page changes.
 */
export function markSuperseded(content: string, oldId: string, newId: string): string | null {
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = parseMetaLine(lines[i])
    if (!m || m.id !== oldId) continue
    if (m.supersededBy) return null
    lines[i] = `${lines[i].replace(/\s+$/, '')} · superseded_by=${newId}`
    return lines.join('\n')
  }
  return null
}

/** A `memory_query` match, plus the entry that replaced the one it sits in. */
export interface AnnotatedMatch extends MemoryMatch {
  supersededBy?: { id: string; page: string; line: number; text: string }
}

/**
 * Attach the successor to every match that lies inside a superseded entry, so the reader sees
 * "this was replaced by …" next to the stale line instead of acting on it.
 */
export function annotateSuperseded(
  files: readonly MemoryFile[],
  matches: readonly MemoryMatch[]
): AnnotatedMatch[] {
  const byPage = new Map<string, ParsedEntry[]>()
  const byId = new Map<string, { page: string; entry: ParsedEntry }>()
  for (const f of files) {
    const entries = parseEntries(f.content)
    byPage.set(f.page, entries)
    for (const entry of entries) byId.set(entry.meta.id, { page: f.page, entry })
  }
  return matches.map((match) => {
    const inside = byPage
      .get(match.page)
      ?.find((e) => match.line >= e.startLine && match.line <= e.endLine)
    const successorId = inside?.meta.supersededBy
    if (!successorId) return { ...match }
    const succ = byId.get(successorId)
    if (!succ) return { ...match }
    return {
      ...match,
      supersededBy: {
        id: successorId,
        page: succ.page,
        line: succ.entry.startLine,
        text: succ.entry.title
      }
    }
  })
}

// ---- Recall (AC-6.3) ---------------------------------------------------------

/** What a new mission or campaign is about: the repo paths it scopes and the titles it will carry. */
export interface RecallQuery {
  /** Repo-relative paths (a file or a directory). */
  paths: readonly string[]
  /** Free text — chapter titles, the mission title — matched against single-word topic watches. */
  topics: readonly string[]
}

/** One recalled memory entry, in the `{ page, line, text }` shape the ACK and the Brief carry. */
export interface RecallHit {
  page: string
  line: number
  text: string
}

/** Most entries a recall returns: it rides in an ACK and a size-capped Brief. */
export const RECALL_MAX = 5

const trimSlash = (p: string): string => p.replace(/^\.\//, '').replace(/\/+$/, '')

/** True when two repo paths name the same file or one is a directory holding the other. */
function pathsOverlap(a: string, b: string): boolean {
  const x = trimSlash(a)
  const y = trimSlash(b)
  if (!x || !y) return false
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)
}

function looksLikePath(watch: string): boolean {
  return watch.includes('/') || /\.[A-Za-z0-9]+$/.test(watch)
}

function entryMatches(watches: readonly string[], q: RecallQuery): boolean {
  const haystack = q.topics.join('\n').toLowerCase()
  for (const w of watches) {
    if (looksLikePath(w)) {
      if (q.paths.some((p) => pathsOverlap(w, p))) return true
    } else if (haystack.includes(w.toLowerCase())) {
      return true
    }
  }
  return false
}

/**
 * The live entries whose `watches` overlap the query, newest page order preserved. A superseded
 * entry is never recalled (its successor is, if it watches the same things), and an empty query
 * recalls nothing.
 */
export function recallEntries(
  files: readonly MemoryFile[],
  query: RecallQuery,
  max: number = RECALL_MAX
): RecallHit[] {
  if (query.paths.length === 0 && query.topics.length === 0) return []
  const hits: RecallHit[] = []
  for (const f of files) {
    for (const e of parseEntries(f.content)) {
      if (e.meta.supersededBy) continue
      if (!e.meta.watches?.length || !entryMatches(e.meta.watches, query)) continue
      hits.push({ page: f.page, line: e.startLine, text: e.title })
      if (hits.length >= max) return hits
    }
  }
  return hits
}
