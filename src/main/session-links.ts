import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { ipcMain } from 'electron'
import { scanFolders } from './claude-reader'
import type { FolderEntry } from './folder-model'

/**
 * Links shelf (T617) — the links of a session, read straight from its transcript.
 *
 * What counts as a link: an `http(s)` URL in the **user text** or **assistant text** blocks of a
 * transcript, never in `tool_use` input, `tool_result` content, thinking blocks, sidechain (subagent)
 * lines, meta lines or the harness wrappers (`<system-reminder>` …). Those are the places the operator
 * and the agent actually *said* a link to each other; everything else is tool noise (fetched pages,
 * logs, `npm` output) the shelf must not clutter itself with.
 *
 * Nothing is persisted and nothing touches the network: the label of a link is derived from the URL
 * alone (`classifyUrl`), and the transcript stays the only source.
 *
 * Pure-core / thin-shell (ADR-0001):
 *   - PURE CORE (no fs, no electron): `extractUrls`, `classifyUrl`, the line fold, the folder grouping
 *     and the known-session lookups. Fully unit-tested in `tests/session-links.test.ts`.
 *   - SHELL: an incremental transcript reader (cached per path, only the appended bytes are re-read
 *     while a session grows), the service that wires it to the fleet model, and the IPC registrar.
 *
 * Security (lesson security/001): the renderer only ever hands over a session uuid or a folder path as a
 * *lookup key* into the sessions the fleet model already knows. The transcript path comes from that
 * model, never from the caller — a forged path or an unknown id resolves to nothing.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type LinkKind = 'pr' | 'issue' | 'task' | 'figma' | 'doc' | 'web'

export interface SessionLink {
  /** The URL as written (boundaries cleaned, never normalised — Copy returns what the operator saw). */
  url: string
  kind: LinkKind
  /** Readable name derived from the URL alone, e.g. `acme/web #183`, `Task 86b7x2k1q`. */
  label: string
  /** Second line of the row: `GitHub PR`, `ClickUp`, `node 812-4410`, `Google Docs`… (may be empty). */
  detail: string
  /** `user` for a link in a user text block, `agent` for one in an assistant text block. */
  source: 'user' | 'agent'
  /** ISO time of the latest occurrence. */
  at: string
  /** The surrounding sentence of that occurrence, trimmed to ~120 characters. */
  excerpt: string
}

export interface FolderLinkGroup {
  sessionId: string
  title: string
  count: number
  /** Time of the session's newest link. */
  latestAt: string
  /** Newest first. */
  links: SessionLink[]
}

// ── Pure core: URL extraction ────────────────────────────────────────────────

/**
 * An http(s) URL ends at whitespace, `<` `>` `"` or a backtick, or where a markdown link's `](http`
 * begins (lazy, so `[https://a](https://a)` yields two matches, not one run-on).
 */
const URL_RE = /https?:\/\/[^\s<>"`]+?(?=\]\(https?:\/\/|[\s<>"`]|$)/gi

/** Characters that are sentence/markdown punctuation when they trail a URL. */
const TRAILING = new Set(['.', ',', ';', ':', "'", '"', ']', '>', '!', '?'])

function count(s: string, ch: string): number {
  let n = 0
  for (const c of s) if (c === ch) n += 1
  return n
}

/**
 * Strip trailing punctuation off a raw match. A closing `)` is stripped only when the URL has no `(`
 * to close (`…/Foo_(bar)` keeps its paren; `(see https://x.com/a)` loses it).
 */
function cleanUrl(raw: string): string {
  let url = raw
  for (;;) {
    const last = url.charAt(url.length - 1)
    if (TRAILING.has(last)) url = url.slice(0, -1)
    else if (last === ')' && count(url, ')') > count(url, '(')) url = url.slice(0, -1)
    else break
  }
  return url
}

function parseHttp(url: string): URL | null {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname ? u : null
  } catch {
    return null
  }
}

interface UrlHit {
  url: string
  /** Index of the first character of the (cleaned) URL in the scanned text. */
  index: number
  /** Index just past its last character. */
  end: number
}

/** Every valid http(s) URL of `text`, in order, with clean boundaries and its position. */
function scanUrls(text: string): UrlHit[] {
  const hits: UrlHit[] = []
  for (const m of text.matchAll(URL_RE)) {
    const url = cleanUrl(m[0])
    if (!url || !parseHttp(url)) continue
    hits.push({ url, index: m.index, end: m.index + url.length })
  }
  return hits
}

/** Every http(s) URL in `text`, in order, with clean boundaries (AC-3). */
export function extractUrls(text: string): string[] {
  return scanUrls(text).map((h) => h.url)
}

// ── Pure core: classification from the URL alone (AC-2) ──────────────────────

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** `host` + path, without query, hash or a trailing slash. */
function hostAndPath(u: URL): string {
  const path = u.pathname.replace(/\/+$/, '')
  return `${u.hostname}${path}`
}

export function classifyUrl(url: string): { kind: LinkKind; label: string; detail: string } {
  const u = parseHttp(url)
  if (!u) return { kind: 'web', label: url, detail: '' }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const segs = u.pathname.split('/').filter(Boolean)

  if (host === 'github.com' && segs.length >= 4) {
    const [owner, repo, what, n] = segs
    if (/^\d+$/.test(n)) {
      if (what === 'pull')
        return { kind: 'pr', label: `${owner}/${repo} #${n}`, detail: 'GitHub PR' }
      if (what === 'issues') {
        return { kind: 'issue', label: `${owner}/${repo} #${n}`, detail: 'GitHub issue' }
      }
    }
  }

  if (host === 'app.clickup.com' && segs[0] === 't' && segs.length >= 2) {
    // `/t/<id>` or the team-scoped `/t/<team>/<id>` — the id is the last segment.
    return { kind: 'task', label: `Task ${decode(segs[segs.length - 1])}`, detail: 'ClickUp' }
  }

  if (host === 'figma.com' && (segs[0] === 'design' || segs[0] === 'file') && segs.length >= 2) {
    const name = segs[2] ? decode(segs[2]) : segs[1]
    const node = u.searchParams.get('node-id')
    return { kind: 'figma', label: name, detail: node ? `node ${node}` : '' }
  }

  if (host === 'docs.google.com') {
    return { kind: 'doc', label: hostAndPath(u), detail: 'Google Docs' }
  }
  if (host === 'notion.so') {
    return { kind: 'doc', label: hostAndPath(u), detail: 'Notion' }
  }

  return { kind: 'web', label: hostAndPath(u), detail: '' }
}

// ── Pure core: excerpt ───────────────────────────────────────────────────────

const EXCERPT_MAX = 120

/** The harness wrappers that sit inside a user turn but were never typed by the operator. */
const WRAPPER_RES = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
  /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g,
  // An unclosed reminder (truncated line).
  /<system-reminder>[\s\S]*$/g
]

/** Drop the wrappers but keep the line structure (the excerpt works per line). */
function stripWrappers(text: string): string {
  let out = text
  for (const re of WRAPPER_RES) out = out.replace(re, ' ')
  return out
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function stripBullet(s: string): string {
  return s.replace(/^\s*(?:[-*•>]|\d+[.)])\s+/, '')
}

function clipHead(s: string): string {
  return s.length <= EXCERPT_MAX ? s : s.slice(0, EXCERPT_MAX - 1).trimEnd() + '…'
}

function clipTail(s: string): string {
  return s.length <= EXCERPT_MAX ? s : '…' + s.slice(s.length - (EXCERPT_MAX - 1)).trimStart()
}

/** Keep the window of `s` around `[from, to)` — the URL stays visible in a long sentence. */
function clipAround(s: string, from: number, to: number): string {
  if (s.length <= EXCERPT_MAX) return s
  const urlLen = to - from
  if (urlLen >= EXCERPT_MAX - 2) return s.slice(from, from + EXCERPT_MAX - 1) + '…'
  const budget = EXCERPT_MAX - 2 - urlLen
  const left = Math.floor(budget / 2)
  const start = Math.max(0, from - left)
  const end = Math.min(s.length, to + (budget - (from - start)))
  const body = s.slice(start, end)
  const clipped = (start > 0 ? '…' : '') + body + (end < s.length ? '…' : '')
  return clipped.length <= EXCERPT_MAX ? clipped : clipHead(clipped)
}

/** Replace every URL of `line` by same-length filler so a `.` inside one is never a sentence end. */
function maskUrls(line: string): string {
  return line.replace(URL_RE, (m) => 'x'.repeat(m.length))
}

const MD_LINK_RE = /\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)/g

/**
 * Collapse the markdown links `[text](url)` of `line` to their text and remap the target `[u0, u1)`.
 * `md` is true when the target was the destination of a link that has text — that text is then what
 * the excerpt shows for it, and it is content (never dropped like a trailing bare URL).
 */
function flattenMarkdown(
  line: string,
  u0: number,
  u1: number
): { flat: string; t0: number; t1: number; md: boolean } {
  let flat = ''
  let last = 0
  let t0 = u0
  let t1 = u1
  let md = false
  let placed = false
  for (const m of line.matchAll(MD_LINK_RE)) {
    const mEnd = m.index + m[0].length
    if (!placed && u0 >= last && u1 <= m.index) {
      t0 = flat.length + (u0 - last)
      t1 = t0 + (u1 - u0)
      placed = true
    }
    flat += line.slice(last, m.index)
    const text = m[1].trim() || m[2]
    if (!placed && u0 >= m.index && u1 <= mEnd) {
      t0 = flat.length
      t1 = t0 + text.length
      md = m[1].trim() !== ''
      placed = true
    }
    flat += text
    last = mEnd
  }
  if (!placed) {
    t0 = flat.length + (u0 - last)
    t1 = t0 + (u1 - u0)
  }
  flat += line.slice(last)
  return { flat, t0, t1, md }
}

/**
 * The sentence around the URL at `[index, end)` of `text`, trimmed to ~120 characters (AC-1).
 *  - mid-sentence → the whole sentence, URL included, so it still reads;
 *  - trailing or leading → the URL is dropped (the row already shows it);
 *  - a markdown link `[text](url)` → shown as its text, in place;
 *  - alone on its line → the previous non-empty line (`and the Figma frame:` / URL).
 */
function excerptRaw(text: string, index: number, end: number): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1
  let lineEnd = text.indexOf('\n', end)
  if (lineEnd === -1) lineEnd = text.length
  const {
    flat: line,
    t0: u0,
    t1: u1,
    md
  } = flattenMarkdown(text.slice(lineStart, lineEnd), index - lineStart, end - lineStart)
  const masked = maskUrls(line)

  let sStart = 0
  for (const m of masked.slice(0, u0).matchAll(/[.!?]\s/g)) sStart = m.index + 2
  let sEnd = line.length
  const tail = /[.!?](?:\s|$)/.exec(masked.slice(u1))
  if (tail) sEnd = u1 + tail.index + 1

  const seg = line.slice(sStart, sEnd)
  const s0 = u0 - sStart
  const s1 = u1 - sStart
  const before = collapse(stripBullet(seg.slice(0, s0)))
  const after = collapse(seg.slice(s1))
  const afterIsPunct = /^[\s.,;:!?)\]>'"—–-]*$/.test(after)

  let out = ''
  if (!md && before && afterIsPunct) out = clipTail(before)
  else if (!md && !before && after && !afterIsPunct) out = clipHead(after)
  else if (md || (before && after)) {
    const flat = collapse(stripBullet(seg))
    const url = line.slice(u0, u1)
    const at = Math.max(0, flat.indexOf(url))
    out = clipAround(flat, at, at + url.length)
  }
  if (out) return out

  // The URL is alone on its line: borrow the previous non-empty line.
  const prior = text.slice(0, lineStart).split('\n')
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    const cleaned = collapse(stripBullet(prior[i].replace(URL_RE, ' ')))
    if (cleaned) return clipHead(cleaned)
  }
  return ''
}

/** The excerpt as shown: emphasis markers and backticks are markup, not words. */
function excerptFor(text: string, index: number, end: number): string {
  return excerptRaw(text, index, end)
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── Pure core: the transcript fold ───────────────────────────────────────────

interface FoldEntry extends SessionLink {
  /** Line order, the tie-break between two occurrences with the same timestamp. */
  order: number
}

export interface LinkFold {
  byUrl: Map<string, FoldEntry>
  order: number
  /** Timestamp of the last parsed line — a line without one inherits it. */
  lastAt: string
}

export function createLinkFold(): LinkFold {
  return { byUrl: new Map(), order: 0, lastAt: '' }
}

/** The text blocks of a `message.content` (a plain string, or only the `text` blocks of an array). */
function textBlocks(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const b of content) {
    if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text') {
      const t = (b as Record<string, unknown>).text
      if (typeof t === 'string') out.push(t)
    }
  }
  return out
}

/**
 * Fold one raw JSONL line into `fold`. Cheap lines (no `http` at all) are skipped without a parse;
 * corrupt lines are ignored. Never throws.
 */
export function foldTranscriptLine(fold: LinkFold, raw: string): void {
  if (!raw.includes('http')) return
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return
  }
  if (!obj || typeof obj !== 'object') return
  if (typeof obj.timestamp === 'string' && obj.timestamp) fold.lastAt = obj.timestamp
  const type = obj.type
  if (type !== 'user' && type !== 'assistant') return
  if (obj.isSidechain === true || obj.isMeta === true) return
  const message = obj.message
  if (!message || typeof message !== 'object') return
  const source: 'user' | 'agent' = type === 'user' ? 'user' : 'agent'
  const at = fold.lastAt

  for (const block of textBlocks((message as Record<string, unknown>).content)) {
    const text = stripWrappers(block)
    for (const hit of scanUrls(text)) {
      fold.order += 1
      const prev = fold.byUrl.get(hit.url)
      // Keep the latest occurrence: a later line wins, an out-of-order older one does not.
      if (prev && at < prev.at) continue
      fold.byUrl.set(hit.url, {
        url: hit.url,
        ...classifyUrl(hit.url),
        source,
        at,
        excerpt: excerptFor(text, hit.index, hit.end),
        order: fold.order
      })
    }
  }
}

/** The fold's links, newest first (ties: the later line first). */
export function foldedLinks(fold: LinkFold): SessionLink[] {
  return [...fold.byUrl.values()]
    .sort((a, b) => (a.at === b.at ? b.order - a.order : a.at < b.at ? 1 : -1))
    .map((e) => ({
      url: e.url,
      kind: e.kind,
      label: e.label,
      detail: e.detail,
      source: e.source,
      at: e.at,
      excerpt: e.excerpt
    }))
}

/** Every link of a whole JSONL transcript text (AC-1). */
export function extractLinksFromJsonl(raw: string): SessionLink[] {
  const fold = createLinkFold()
  for (const line of raw.split('\n')) if (line) foldTranscriptLine(fold, line)
  return foldedLinks(fold)
}

// ── Pure core: which sessions exist (AC-4) ───────────────────────────────────

/** The known session entry for `uuid`, or null — `uuid` is a lookup key only, never a path. */
export function findKnownSession(
  folders: readonly FolderEntry[],
  uuid: string
): FolderEntry['sessions'][number] | null {
  if (typeof uuid !== 'string' || !uuid) return null
  for (const folder of folders) {
    for (const session of folder.sessions) if (session.sessionId === uuid) return session
  }
  return null
}

export function findKnownFolder(folders: readonly FolderEntry[], path: string): FolderEntry | null {
  if (typeof path !== 'string' || !path) return null
  return folders.find((f) => f.path === path) ?? null
}

const TITLE_MAX = 80

/** A session's display title as main knows it: summary, else the first prompt, else the short id. */
function sessionTitle(session: FolderEntry['sessions'][number]): string {
  const raw = (session.summary || session.firstPrompt || '').replace(/\s+/g, ' ').trim()
  if (!raw) return session.sessionId.slice(0, 8)
  return raw.length > TITLE_MAX ? raw.slice(0, TITLE_MAX - 1).trimEnd() + '…' : raw
}

// ── Shell: incremental transcript reader ─────────────────────────────────────

/** Past this, only the tail of a transcript is scanned (the CLI's own transcript read ceiling). */
const MAX_SCAN_BYTES = 50 * 1024 * 1024
/**
 * How many transcripts keep a warm fold. The Folder scope reads every session of a folder on each pass,
 * so a cap below the folder's size would evict what the next pass needs and re-parse everything every
 * time (an LRU cycles). A fold holds only the links, so a generous cap is cheap.
 */
const CACHE_MAX = 512
/** Parallel transcript reads for a folder listing. */
const FOLDER_CONCURRENCY = 4

interface CacheEntry {
  size: number
  mtimeMs: number
  ino: number
  /** Byte offset just past the last complete line folded. */
  pos: number
  fold: LinkFold
  links: SessionLink[]
}

/**
 * Fold bytes `[start, end)` of `path` into `fold`; returns the offset just past the last complete line.
 * A trailing partial line (the CLI is mid-write) is left for the next read unless it already parses.
 */
async function foldRange(
  path: string,
  start: number,
  end: number,
  fold: LinkFold
): Promise<number> {
  let leftover: Buffer = Buffer.alloc(0)
  let consumed = start
  const stream = createReadStream(path, { start, end: end - 1 })
  for await (const chunk of stream) {
    const buf = leftover.length ? Buffer.concat([leftover, chunk as Buffer]) : (chunk as Buffer)
    const nl = buf.lastIndexOf(10)
    if (nl === -1) {
      leftover = buf
      continue
    }
    const complete = buf.subarray(0, nl + 1)
    leftover = buf.subarray(nl + 1)
    for (const line of complete.toString('utf8').split('\n'))
      if (line) foldTranscriptLine(fold, line)
    consumed += complete.length
  }
  if (leftover.length) {
    const tail = leftover.toString('utf8')
    try {
      JSON.parse(tail)
      foldTranscriptLine(fold, tail)
      consumed += leftover.length
    } catch {
      // Incomplete line — picked up on the next read.
    }
  }
  return consumed
}

/**
 * The links of one transcript file. Cached per path by `(size, mtime)`: an unchanged file costs a `stat`,
 * a file that only grew costs the appended bytes, and a rewrite (`/compact`, a different inode, a
 * shrink) is a full re-read. Never throws — a missing or unreadable file yields `[]`.
 */
function createTranscriptReader(): (path: string) => Promise<SessionLink[]> {
  const cache = new Map<string, CacheEntry>()
  return async (path) => {
    if (!path.endsWith('.jsonl')) return []
    try {
      const st = await stat(path)
      const hit = cache.get(path)
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
        cache.delete(path)
        cache.set(path, hit) // LRU touch
        return hit.links
      }
      const grew = hit && hit.ino === st.ino && st.size > hit.pos && hit.pos > 0
      const fold = grew ? hit.fold : createLinkFold()
      const from = grew ? hit.pos : Math.max(0, st.size - MAX_SCAN_BYTES)
      const pos = await foldRange(path, from, st.size, fold)
      const entry: CacheEntry = {
        size: st.size,
        mtimeMs: st.mtimeMs,
        ino: st.ino,
        pos,
        fold,
        links: foldedLinks(fold)
      }
      cache.delete(path)
      cache.set(path, entry)
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
      return entry.links
    } catch {
      cache.delete(path)
      return []
    }
  }
}

// ── Shell: the service and its IPC registrar ─────────────────────────────────

export interface SessionLinksService {
  forSession(uuid: string): Promise<SessionLink[]>
  forFolder(folderPath: string): Promise<FolderLinkGroup[]>
}

/**
 * The two reads behind the footer pill. `getFolders` is the fleet model (the sessions Harnu already
 * knows); injectable so the tests need no Electron.
 */
export function createSessionLinksService(deps: {
  getFolders: () => Promise<FolderEntry[]>
}): SessionLinksService {
  const read = createTranscriptReader()

  return {
    async forSession(uuid) {
      const session = findKnownSession(await deps.getFolders(), uuid)
      return session ? read(session.fullPath) : []
    },

    async forFolder(folderPath) {
      const folder = findKnownFolder(await deps.getFolders(), folderPath)
      if (!folder) return []
      const sessions = folder.sessions.filter((s) => !s.isSidechain)
      const groups: FolderLinkGroup[] = []
      for (let i = 0; i < sessions.length; i += FOLDER_CONCURRENCY) {
        const batch = sessions.slice(i, i + FOLDER_CONCURRENCY)
        const read$ = await Promise.all(batch.map((s) => read(s.fullPath)))
        batch.forEach((s, j) => {
          const links = read$[j]
          if (links.length === 0) return
          groups.push({
            sessionId: s.sessionId,
            title: sessionTitle(s),
            count: links.length,
            latestAt: links[0].at,
            links
          })
        })
      }
      return groups.sort((a, b) =>
        a.latestAt === b.latestAt ? 0 : a.latestAt < b.latestAt ? 1 : -1
      )
    }
  }
}

/** Register the Links shelf IPC reads (house pattern; called from `index.ts` at boot). Stateless. */
export function registerSessionLinks(): void {
  const service = createSessionLinksService({ getFolders: () => scanFolders() })

  ipcMain.handle('sessionLinks:session', async (_e, uuid: string): Promise<SessionLink[]> => {
    if (typeof uuid !== 'string') return []
    return service.forSession(uuid)
  })

  ipcMain.handle('sessionLinks:folder', async (_e, folder: string): Promise<FolderLinkGroup[]> => {
    if (typeof folder !== 'string') return []
    return service.forFolder(folder)
  })
}
