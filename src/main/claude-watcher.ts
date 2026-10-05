/**
 * Claude transcript watcher (main process).
 *
 * Single recursive chokidar watcher rooted at `~/.claude/projects/`. Emits typed
 * events to the renderer for every disk-level change that affects the sidebar:
 * project add/remove, session add/remove, JSONL appends (tail-read by byte
 * offset), and `sessions-index.json` rewrites.
 *
 * Scope discipline: this module does NOT register IPC handlers and does NOT
 * touch BrowserWindow lifecycle directly. T-1.5 wires that. The only contact
 * with Electron is `getWindow()?.webContents.send(channel, payload)`.
 *
 * Channels emitted:
 *   - claude:seed                  { projects: Project[] }
 *   - claude:project:added         { slug }
 *   - claude:project:removed       { slug }
 *   - claude:session:added         { slug, sessionId }
 *   - claude:session:removed       { slug, sessionId }
 *   - claude:session:updated       SessionUpdatePayload (derived fields, no raw lines)
 *   - claude:index:updated         { slug }
 *   - claude:watcher:degraded      { code, message }
 *   - claude:subagent:updated      SubagentUpdatePayload { slug, parentSessionId, agentId, meta? }
 *   - claude:subagent:removed      { slug, parentSessionId, agentId }
 *
 * Subagent transcripts (`<slug>/<uuid>/subagents/agent-*.jsonl`) are surfaced
 * on their OWN `claude:subagent:updated` channel (issue #9), keyed by the parent
 * session's `sessionId` (the `<uuid>` directory name) PLUS the `agentId` (from
 * the `agent-<id>.jsonl` filename). The renderer nests them under the parent
 * session row and flips their running/done status from these appends. The
 * subdir name = parent uuid is a HARD link — no heuristic.
 */

import type { BrowserWindow } from 'electron'
import { createReadStream, promises as fs, type Stats } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import * as path from 'node:path'
import * as os from 'node:os'
import chokidar, { type FSWatcher } from 'chokidar'
import {
  deriveTurnState,
  computeCtxPct,
  extractAwaySummary,
  type TranscriptEntry,
  type TranscriptState,
  type StagnationVerdict
} from './transcript-truth'
import { deriveStagnation } from './stall-detect'
import { firstRealPrompt } from './claude-reader-derive'
import type { SlugChangeClass } from './fleet-model'

const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'projects')

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface WatcherOptions {
  /** Override `~/.claude/projects/` for testing. */
  rootDir?: string
  /** If true, do not emit `claude:seed`; assume the consumer already has it. */
  skipSeed?: boolean
  /**
   * Fired for every disk-level change that could alter a slug's sessions
   * (session add/update/remove, index update, subagent add/update/remove,
   * project removed). The central fleet model (`fleet-model.ts`, T123 spec
   * §5.1 W1) wires this to `notifySlugChanged` to schedule a debounced,
   * slug-scoped incremental rescan (AC3) — WITHOUT changing what gets sent
   * to the renderer over the existing `claude:*` IPC channels. Optional so
   * every existing caller/test is unaffected.
   */
  onSlugChanged?: (slug: string, cls?: SlugChangeClass) => void
  /**
   * Fired when the watcher itself errors — ENOSPC/EMFILE/EACCES (which also
   * flip {@link WatcherHandle.healthy} to `false`) AND unclassified `OTHER`
   * errors alike: any watcher error means deltas may have been missed, so the
   * fleet model must not keep trusting the incremental stream. The model
   * falls back to a full rescan (spec §5.1 "full-rescan fallback if the
   * watcher degrades") and keeps poll-rescanning while unhealthy.
   */
  onDegraded?: () => void
  /**
   * Fired once chokidar's initial registration completes (`ready`). Events
   * that hit disk between a consumer's own initial scan and this point were
   * never watched — the fleet model triggers one full rescan here to close
   * that gap (a created-then-quiet or removed-in-the-gap session would
   * otherwise be missed forever).
   */
  onReady?: () => void
}

export interface WatcherHandle {
  /** Stops the watcher and frees the chokidar instance. */
  close: () => Promise<void>
  /** Health flag — set to false if we hit ENOSPC/EMFILE. */
  healthy: boolean
}

/**
 * Minimal `Project` snapshot mirrored from `sessions-index.json` (finding 01
 * §4). Shape kept compatible with `src/renderer/src/stores/sessions.ts` — the
 * renderer is responsible for joining worktrees into this once T-1.6 lands.
 */
export interface SeedProject {
  slug: string
  /** From `sessions-index.json#originalPath`. Empty string if unknown. */
  originalPath: string
  /** Pre-parsed entries from the index, if the file was readable. */
  entries: SeedSessionEntry[]
}

export interface SeedSessionEntry {
  sessionId: string
  fullPath: string
  fileMtime: number
  firstPrompt: string
  summary: string
  messageCount: number
  created: string
  modified: string
  gitBranch: string
  projectPath: string
  isSidechain: boolean
}

export type DegradedCode = 'ENOSPC' | 'EMFILE' | 'EACCES' | 'OTHER'

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface TailState {
  /** Byte offset into the file we've consumed up to. */
  offset: number
  /** UTF-8 decoder that buffers incomplete multibyte sequences. */
  decoder: StringDecoder
  /** Carry-over for the partial line (no trailing `\n` yet). */
  partial: string
  /** Inode of the file at the last read — detects an atomic-replace rewrite
   *  (`/compact`) whose new size is >= the old offset (T16). Undefined until
   *  the first real read adopts it. */
  ino?: number
  /** When set, the FIRST read of this file reads at most this many bytes from
   *  EOF instead of the whole file (sidebar-liveness C5). Cleared by that read. */
  firstReadCap?: number
  /** Discard text up to and including the first `\n` — the read started inside
   *  a line (set by a capped first read). */
  dropFirstPartial?: boolean
}

interface PathRoles {
  rootDir: string
}

/**
 * Classify a path under the watched root.
 *
 * Path patterns we care about (depth from root):
 *   1. `<slug>/`                                   -> project dir
 *   2. `<slug>/<uuid>.jsonl`                       -> top-level session
 *   3. `<slug>/sessions-index.json`                -> project meta
 *   4. `<slug>/<uuid>/subagents/agent-*.jsonl`     -> subagent (depth 4)
 *
 * Anything else (notably `<slug>/<uuid>/tool-results/*.txt`) is ignored.
 */
type Classification =
  | { kind: 'project'; slug: string }
  | { kind: 'session'; slug: string; sessionId: string }
  | { kind: 'subagent'; slug: string; sessionId: string; agent: string }
  | { kind: 'index'; slug: string }
  | { kind: 'unknown' }

function classify(p: string, roles: PathRoles): Classification {
  const rel = path.relative(roles.rootDir, p)
  if (!rel || rel.startsWith('..')) return { kind: 'unknown' }
  const parts = rel.split(path.sep)

  if (parts.length === 1) {
    // `<slug>` directory itself.
    return { kind: 'project', slug: parts[0] }
  }

  if (parts.length === 2) {
    const [slug, leaf] = parts
    if (leaf === 'sessions-index.json') return { kind: 'index', slug }
    if (leaf.endsWith('.jsonl')) {
      return {
        kind: 'session',
        slug,
        sessionId: leaf.slice(0, -'.jsonl'.length)
      }
    }
    return { kind: 'unknown' }
  }

  if (parts.length === 4 && parts[2] === 'subagents' && parts[3].endsWith('.jsonl')) {
    return {
      kind: 'subagent',
      slug: parts[0],
      sessionId: parts[1],
      agent: parts[3].slice(0, -'.jsonl'.length)
    }
  }

  return { kind: 'unknown' }
}

/**
 * Classification leaf for a subagent is the filename without `.jsonl`
 * (`agent-<id>`). Strip the `agent-` prefix to recover the bare `agentId` that
 * matches the JSONL's `agentId` field and the reader's `SubagentEntry.agentId`.
 */
function agentIdFromAgentLeaf(agentLeaf: string): string {
  return agentLeaf.replace(/^agent-/, '')
}

/** Are we looking at `<slug>/sessions-index.json` by path inspection alone? */
function isIndexJson(p: string): boolean {
  return path.basename(p) === 'sessions-index.json'
}

/** Are we looking at a JSONL file by extension? */
function isJsonl(p: string): boolean {
  return p.toLowerCase().endsWith('.jsonl')
}

// ---------------------------------------------------------------------------
// Session→slug correlation (BUG-55 cross-slug moves)
// ---------------------------------------------------------------------------

/**
 * Cheap top-level listing of every slug dir's own `<uuid>.jsonl` files,
 * independent of `skipSeed` (unlike {@link readSeedProjects}, which is gated
 * on it and also opens/parses each `sessions-index.json`). A session that
 * `EnterWorktree` re-homes needs its ORIGINAL slug known from the moment the
 * watcher boots, so the cross-slug correlation in the `add`/`unlink`
 * handlers below works even when the consumer skips the heavier seed (the
 * production path: `main/index.ts` already has a scan from `folders:load`).
 */
async function seedSessionSlugs(rootDir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let slugs: string[] = []
  try {
    slugs = await fs.readdir(rootDir)
  } catch {
    return out
  }
  await Promise.all(
    slugs.map(async (slug) => {
      if (slug.startsWith('.')) return
      const projectDir = path.join(rootDir, slug)
      let children: string[] = []
      try {
        children = await fs.readdir(projectDir)
      } catch {
        return
      }
      for (const leaf of children) {
        if (!leaf.endsWith('.jsonl')) continue
        out.set(leaf.slice(0, -'.jsonl'.length), slug)
      }
    })
  )
  return out
}

// ---------------------------------------------------------------------------
// Seed scan (cheap synchronous-shape pass; no JSONLs opened)
// ---------------------------------------------------------------------------

async function readSeedProjects(rootDir: string): Promise<SeedProject[]> {
  const out: SeedProject[] = []
  let entries: string[] = []
  try {
    entries = await fs.readdir(rootDir)
  } catch {
    // Root may not exist on a fresh machine — that's fine, return [].
    return out
  }

  await Promise.all(
    entries.map(async (slug) => {
      // Skip dotfiles at the project level (`.DS_Store`, `.last-cleanup`, …).
      if (slug.startsWith('.')) return
      const projectDir = path.join(rootDir, slug)
      const st = await fs.stat(projectDir).catch(() => null)
      if (!st?.isDirectory()) return

      const project: SeedProject = {
        slug,
        originalPath: '',
        entries: []
      }

      const indexPath = path.join(projectDir, 'sessions-index.json')
      try {
        const raw = await fs.readFile(indexPath, 'utf8')
        const parsed = JSON.parse(raw) as {
          version?: number
          originalPath?: string
          entries?: SeedSessionEntry[]
        }
        if (typeof parsed.originalPath === 'string') {
          project.originalPath = parsed.originalPath
        }
        if (Array.isArray(parsed.entries)) {
          project.entries = parsed.entries.filter(
            (e): e is SeedSessionEntry =>
              !!e && typeof e === 'object' && typeof e.sessionId === 'string'
          )
        }
      } catch {
        // No index, or corrupt — leave entries empty. Watcher will pick up new
        // sessions as they're written.
      }

      out.push(project)
    })
  )

  // Stable ordering by slug, so seed snapshots are diff-friendly.
  out.sort((a, b) => a.slug.localeCompare(b.slug))
  return out
}

// ---------------------------------------------------------------------------
// Tail-read implementation (per finding 02 §8)
// ---------------------------------------------------------------------------

/** First append to a transcript the watcher never read: tail at most this much (C5). */
const FIRST_APPEND_TAIL_CAP_BYTES = 256 * 1024
/** Head window read to classify a transcript first seen via `change` (C5). */
const CLASSIFY_HEAD_BYTES = 8 * 1024

// Bytes the last `tailFile` read per path — test-only observability (AC-22).
// Bounded: it is cleared whenever it grows past a small size.
const lastTailBytes = new Map<string, number>()
function recordTailBytes(absPath: string, n: number): void {
  if (lastTailBytes.size >= 256) lastTailBytes.clear()
  lastTailBytes.set(absPath, n)
}

/**
 * Parse the complete JSONL lines within the first `maxBytes` of a file. The
 * trailing fragment cut by the window is dropped. Returns [] on any read error.
 */
async function readHeadLines(absPath: string, maxBytes: number): Promise<unknown[]> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    fh = await fs.open(absPath, 'r')
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0)
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const segments = text.split('\n')
    if (bytesRead === maxBytes) segments.pop() // possibly cut mid-line
    const out: unknown[] = []
    for (const raw of segments) {
      if (!raw) continue
      try {
        out.push(JSON.parse(raw))
      } catch {
        /* corrupt line — skip, like tailFile */
      }
    }
    return out
  } catch {
    return []
  } finally {
    await fh?.close().catch(() => {})
  }
}

/**
 * Read from `state.offset` to end-of-file, returning every complete
 * JSON-parsed line that arrives. Updates `state.offset` and `state.partial`.
 * Returns an empty array if nothing new is available.
 *
 * Truncation is handled by detecting `stat.size < state.offset` and resetting.
 */
async function tailFile(absPath: string, state: TailState): Promise<unknown[]> {
  let st: Stats | null = null
  try {
    st = await fs.stat(absPath)
  } catch {
    return []
  }
  if (!st || !st.isFile()) return []

  // Compaction detection (T16): a `/compact` rewrites the transcript — either
  // in place (size shrinks below our offset) or via write-temp+rename (new
  // inode, size may be >= our offset). Either way the bytes after our old offset
  // are NOT genuinely-new appends, so re-baseline to the new EOF and emit
  // NOTHING — otherwise every downstream fold (awaySummary, stagnation,
  // auto-name) would misread the whole file as one giant fresh delta. Only
  // trigger once we've consumed something (`offset > 0`) so a brand-new file at
  // offset 0 still emits its initial lines. Assumes append-only JSONL (true for
  // Claude transcripts except `/compact`); the index-reload path backfills
  // metadata.
  const inoKnown = state.ino !== undefined && st.ino > 0
  const rewritten =
    state.offset > 0 && (st.size < state.offset || (inoKnown && st.ino !== state.ino))
  if (rewritten) {
    state.offset = st.size
    state.partial = ''
    state.decoder = new StringDecoder('utf8')
    state.ino = st.ino
    return []
  }
  if (state.firstReadCap !== undefined) {
    // Bounded first read (C5): only the last `firstReadCap` bytes. The window's
    // first byte only marks a boundary — dropping through the first `\n` keeps
    // exactly the lines that start after it, so no fragment is ever parsed.
    if (state.offset === 0 && st.size > state.firstReadCap) {
      state.offset = st.size - state.firstReadCap
      state.dropFirstPartial = true
    }
    state.firstReadCap = undefined
  }
  if (st.size === state.offset) return []

  const endOffset = st.size
  const startOffset = state.offset
  recordTailBytes(absPath, endOffset - startOffset)
  const readIno = st.ino // captured for the `end` closure (st is a re-widened `let`)

  const parsed: unknown[] = []

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absPath, {
      start: startOffset,
      // end is inclusive in node streams. endOffset is exclusive (== size).
      end: endOffset - 1
    })

    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf8')
      let text = state.decoder.write(buf)
      if (state.dropFirstPartial) {
        const nl = text.indexOf('\n')
        if (nl === -1) return // still inside the cut line
        text = text.slice(nl + 1)
        state.dropFirstPartial = false
      }
      const combined = state.partial + text
      const segments = combined.split('\n')
      // Last segment is the new partial (might be empty if chunk ended on \n).
      state.partial = segments.pop() ?? ''
      for (const raw of segments) {
        if (!raw) continue // skip blank lines harmlessly
        try {
          parsed.push(JSON.parse(raw))
        } catch {
          // Corrupt line (e.g. unclean shutdown mid-write). Log and skip — do
          // not break the stream. Finding 01 §11 confirms this is expected.
          // Keeping a `parsed: null` sentinel would force the renderer to
          // pattern-match on it; omitting is cleaner.
        }
      }
    })

    stream.on('end', () => {
      const flushed = state.decoder.end()
      if (flushed) state.partial += flushed
      state.offset = endOffset
      state.ino = readIno // adopt the inode so a later atomic-replace is detected (T16)
      resolve()
    })

    stream.on('error', reject)
  })

  return parsed
}

/**
 * Live transcript-truth derived from a `session:updated` delta (T91). Rides on
 * the event so the renderer refreshes a session's turn-state / ctx% / away recap
 * WITHOUT a full re-scan — the same pure derivations the reader runs on the cold
 * tail, applied to the freshly-appended lines (which carry the latest turn's
 * markers, last assistant usage, and any away recap). Only fields the delta could
 * actually determine are set; a metadata-only append (pause/switch re-append)
 * yields `unknown` state / null ctx, so those keys are OMITTED and the renderer
 * keeps its prior value — never a downgrade to `unknown`.
 *
 * `stagnation` (T175/T176) is folded the same way: only over THIS delta (no
 * ring/accumulator is kept per path — D3), so it's included only when the
 * delta itself contains at least one tool call (`calls > 0`), else omitted so
 * the renderer keeps its prior verdict. This under-reports for a session
 * watched continuously since before a stall began (each tiny per-turn delta
 * rarely reaches the call floor on its own) but is exactly right for the
 * common case this whole feature targets — the operator was away and Harnu's
 * watcher catches up on a large batch of accumulated appends in one delta.
 */
export function deltaTruth(newLines: unknown[]): {
  transcriptState?: TranscriptState
  ctxPct?: number
  awaySummary?: string
  stagnation?: StagnationVerdict
} {
  const entries = newLines as TranscriptEntry[]
  const out: {
    transcriptState?: TranscriptState
    ctxPct?: number
    awaySummary?: string
    stagnation?: StagnationVerdict
  } = {}
  const ts = deriveTurnState(entries)
  if (ts !== 'unknown') out.transcriptState = ts
  const ctx = computeCtxPct(entries)
  if (ctx) out.ctxPct = ctx.pct
  const away = extractAwaySummary(entries)
  if (away) out.awaySummary = away
  const stagnation = deriveStagnation(entries)
  if (stagnation.calls > 0) out.stagnation = stagnation
  return out
}

// ---------------------------------------------------------------------------
// Event payloads (sidebar-liveness C3, AC-20)
// ---------------------------------------------------------------------------

/**
 * `claude:session:updated` wire shape. Every field is DERIVED in main from the
 * appended lines — the raw lines themselves never cross IPC (a first append to a
 * long transcript used to ship it whole: two measured events carried 27.7 MB).
 * Optional fields are omitted when the delta did not determine them, so the
 * renderer keeps its prior value.
 */
export interface SessionUpdatePayload {
  slug: string
  sessionId: string
  /** Latest `/rename` title in the delta (`custom-title` line). */
  renameTitle?: string
  /** Latest `ai-title` in the delta (Claude's auto-generated title). */
  aiTitle?: string
  /** First real user prompt in the delta (`firstRealPrompt`), for a row that has none yet. */
  firstPromptCandidate?: string
  transcriptState?: TranscriptState
  ctxPct?: number
  awaySummary?: string
  stagnation?: StagnationVerdict
}

/** Subagent metadata read from its transcript lines — first defined value per field. */
export interface AgentMeta {
  agentType?: string
  skill?: string
  plugin?: string
  model?: string
  task?: string
}

/** `claude:subagent:updated` wire shape (issue #9) — `meta` replaces the raw lines. */
export interface SubagentUpdatePayload {
  slug: string
  parentSessionId: string
  agentId: string
  meta?: AgentMeta
}

// Per-field serialized-size budgets. Together with the bounded fields (ids,
// numbers, a 120-char prompt) they keep any single event under 16 KB (AC-20)
// no matter what a transcript line holds.
const TITLE_MAX_BYTES = 2048
const AWAY_SUMMARY_MAX_BYTES = 8192
const STAGNATION_TARGET_MAX_BYTES = 512
const AGENT_META_FIELD_MAX_BYTES = 512

/** `s` shortened until its JSON encoding fits `maxBytes` (UTF-8, quotes and escapes included). */
function capJsonBytes(s: string, maxBytes: number): string {
  // A char is at least one encoded byte, so this first cut is always safe and
  // keeps the measure below off multi-megabyte strings.
  let out = s.length > maxBytes ? s.slice(0, maxBytes) : s
  let size = Buffer.byteLength(JSON.stringify(out))
  while (size > maxBytes && out.length > 0) {
    out = out.slice(0, Math.min(out.length - 1, Math.floor((out.length * maxBytes) / size)))
    size = Buffer.byteLength(JSON.stringify(out))
  }
  return out
}

/** Flatten a Claude `message.content` (string or text-block array) to plain text. */
function messageText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return ''
  const content = (msg as Record<string, unknown>).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text'
          ? String((b as Record<string, unknown>).text ?? '')
          : ''
      )
      .join('')
  }
  return ''
}

/** Build the `claude:session:updated` payload for one delta (AC-20). */
export function buildSessionUpdate(
  slug: string,
  sessionId: string,
  newLines: unknown[]
): SessionUpdatePayload {
  let renameTitle = ''
  let aiTitle = ''
  const userTexts: string[] = []
  for (const raw of newLines) {
    if (!raw || typeof raw !== 'object') continue
    const line = raw as Record<string, unknown>
    if (line.type === 'custom-title') {
      const title =
        typeof line.customTitle === 'string'
          ? line.customTitle
          : typeof line.title === 'string'
            ? line.title
            : ''
      if (title) renameTitle = title
    } else if (line.type === 'ai-title') {
      if (typeof line.aiTitle === 'string' && line.aiTitle) aiTitle = line.aiTitle
    } else if (line.type === 'user' && line.isSidechain !== true) {
      const text = messageText(line.message)
      if (text) userTexts.push(text)
    }
  }
  const out: SessionUpdatePayload = { slug, sessionId }
  if (renameTitle) out.renameTitle = capJsonBytes(renameTitle, TITLE_MAX_BYTES)
  if (aiTitle) out.aiTitle = capJsonBytes(aiTitle, TITLE_MAX_BYTES)
  const firstPrompt = firstRealPrompt(userTexts)
  if (firstPrompt) out.firstPromptCandidate = firstPrompt
  const truth = deltaTruth(newLines)
  if (truth.transcriptState) out.transcriptState = truth.transcriptState
  if (typeof truth.ctxPct === 'number') out.ctxPct = truth.ctxPct
  if (truth.awaySummary) out.awaySummary = capJsonBytes(truth.awaySummary, AWAY_SUMMARY_MAX_BYTES)
  if (truth.stagnation) {
    out.stagnation = {
      ...truth.stagnation,
      topTarget: capJsonBytes(truth.stagnation.topTarget, STAGNATION_TARGET_MAX_BYTES)
    }
  }
  return out
}

/**
 * Whatever agent metadata a batch of subagent JSONL lines carries:
 * `attributionAgent`/`attributionSkill`/`attributionPlugin`, the model (first
 * assistant line) and the task (first user message). Returns only the fields it
 * found, each the FIRST defined value in the batch.
 */
export function readAgentMeta(newLines: unknown[]): AgentMeta {
  const meta: AgentMeta = {}
  for (const raw of newLines) {
    if (!raw || typeof raw !== 'object') continue
    const line = raw as Record<string, unknown>
    if (meta.agentType === undefined && typeof line.attributionAgent === 'string') {
      meta.agentType = line.attributionAgent
    }
    if (meta.skill === undefined && typeof line.attributionSkill === 'string') {
      meta.skill = line.attributionSkill
    }
    if (meta.plugin === undefined && typeof line.attributionPlugin === 'string') {
      meta.plugin = line.attributionPlugin
    }
    if (meta.model === undefined && line.type === 'assistant') {
      const msg = line.message
      if (
        msg &&
        typeof msg === 'object' &&
        typeof (msg as Record<string, unknown>).model === 'string'
      ) {
        meta.model = (msg as Record<string, unknown>).model as string
      }
    }
    if (meta.task === undefined && line.type === 'user') {
      const text = messageText(line.message)
      if (text) meta.task = text.slice(0, 200)
    }
  }
  for (const key of Object.keys(meta) as (keyof AgentMeta)[]) {
    meta[key] = capJsonBytes(meta[key] as string, AGENT_META_FIELD_MAX_BYTES)
  }
  return meta
}

/** Build the `claude:subagent:updated` payload for one delta (AC-20). */
export function buildSubagentUpdate(
  slug: string,
  parentSessionId: string,
  agentId: string,
  newLines: unknown[]
): SubagentUpdatePayload {
  const out: SubagentUpdatePayload = { slug, parentSessionId, agentId }
  const meta = readAgentMeta(newLines)
  if (Object.keys(meta).length > 0) out.meta = meta
  return out
}

// ---------------------------------------------------------------------------
// Event coalescing (sidebar-liveness C3, AC-21)
// ---------------------------------------------------------------------------

const COALESCE_TRAILING_MS = 150
const COALESCE_MAX_WAIT_MS = 500

/** Fields where the latest defined value wins when two updates merge. */
const LATEST_WINS_KEYS = [
  'renameTitle',
  'aiTitle',
  'transcriptState',
  'ctxPct',
  'awaySummary',
  'stagnation'
] as const

/** Merge `next` into `prev` per C3: latest defined wins, except `firstPromptCandidate` (first wins). */
function mergeSessionUpdate(
  prev: SessionUpdatePayload | undefined,
  next: SessionUpdatePayload
): SessionUpdatePayload {
  const out: SessionUpdatePayload = { slug: next.slug, sessionId: next.sessionId }
  const fp = prev?.firstPromptCandidate ?? next.firstPromptCandidate
  if (fp !== undefined) out.firstPromptCandidate = fp
  for (const key of LATEST_WINS_KEYS) {
    const value = next[key] !== undefined ? next[key] : prev?.[key]
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value
  }
  return out
}

/** Merge subagent updates: `meta` keeps the FIRST defined value per field, like `readAgentMeta`. */
function mergeSubagentUpdate(
  prev: SubagentUpdatePayload | undefined,
  next: SubagentUpdatePayload
): SubagentUpdatePayload {
  const out: SubagentUpdatePayload = {
    slug: next.slug,
    parentSessionId: next.parentSessionId,
    agentId: next.agentId
  }
  const meta: AgentMeta = {}
  for (const source of [next.meta, prev?.meta]) {
    for (const [key, value] of Object.entries(source ?? {}) as [keyof AgentMeta, unknown][]) {
      if (typeof value === 'string') meta[key] = value // prev applied last: first-seen wins
    }
  }
  if (Object.keys(meta).length > 0) out.meta = meta
  return out
}

interface PendingEvent {
  channel: 'claude:session:updated' | 'claude:subagent:updated'
  payload: SessionUpdatePayload | SubagentUpdatePayload
  firstAt: number
  timer: NodeJS.Timeout
}

export interface EventCoalescer {
  session: (p: SessionUpdatePayload) => void
  subagent: (p: SubagentUpdatePayload) => void
  /** Sends `claude:session:added` NOW; a pending update for the id still goes out after it. */
  added: (slug: string, sessionId: string) => void
  /** Cancels a pending update for a removed id, so it can never follow the removal. */
  dropSession: (sessionId: string) => void
  dropSubagent: (parentSessionId: string, agentId: string) => void
  flushAll: () => void
  /** Drops every pending event and clears its timer (watcher teardown). */
  close: () => void
}

/**
 * Per-id coalescer for the watcher's update events. A busy session appends many
 * times a second; each append used to be its own IPC event and its own renderer
 * mutation. Updates for one key (`session:<id>` / `subagent:<parent>:<agent>`)
 * merge into one pending event, sent on a 150 ms trailing edge that never waits
 * past 500 ms from the first queued update.
 */
function createEventCoalescer(
  send: (channel: string, payload: unknown) => void,
  opts?: { trailingMs?: number; maxWaitMs?: number }
): EventCoalescer {
  const trailingMs = opts?.trailingMs ?? COALESCE_TRAILING_MS
  const maxWaitMs = opts?.maxWaitMs ?? COALESCE_MAX_WAIT_MS
  const pending = new Map<string, PendingEvent>()

  const flush = (key: string): void => {
    const ev = pending.get(key)
    if (!ev) return
    clearTimeout(ev.timer)
    pending.delete(key)
    send(ev.channel, ev.payload)
  }

  const drop = (key: string): void => {
    const ev = pending.get(key)
    if (!ev) return
    clearTimeout(ev.timer)
    pending.delete(key)
  }

  const queue = (
    key: string,
    channel: PendingEvent['channel'],
    payload: PendingEvent['payload']
  ): void => {
    const now = Date.now()
    const prev = pending.get(key)
    if (prev) clearTimeout(prev.timer)
    const firstAt = prev?.firstAt ?? now
    const delay = Math.max(0, Math.min(trailingMs, firstAt + maxWaitMs - now))
    pending.set(key, { channel, payload, firstAt, timer: setTimeout(() => flush(key), delay) })
  }

  return {
    session: (p) => {
      const key = `session:${p.sessionId}`
      const prev = pending.get(key)?.payload as SessionUpdatePayload | undefined
      queue(key, 'claude:session:updated', mergeSessionUpdate(prev, p))
    },
    subagent: (p) => {
      const key = `subagent:${p.parentSessionId}:${p.agentId}`
      const prev = pending.get(key)?.payload as SubagentUpdatePayload | undefined
      queue(key, 'claude:subagent:updated', mergeSubagentUpdate(prev, p))
    },
    // Never delayed: the renderer must learn about an id before any update for
    // it. A pending update for this id is still on its timer, so it follows.
    added: (slug, sessionId) => {
      send('claude:session:added', { slug, sessionId })
    },
    dropSession: (sessionId) => drop(`session:${sessionId}`),
    dropSubagent: (parentSessionId, agentId) => drop(`subagent:${parentSessionId}:${agentId}`),
    flushAll: () => {
      for (const key of [...pending.keys()]) flush(key)
    },
    close: () => {
      for (const ev of pending.values()) clearTimeout(ev.timer)
      pending.clear()
    }
  }
}

/** A fresh tail state for a file we start reading from `offset` (default EOF-of-nothing = 0). */
function makeTailState(offset = 0): TailState {
  return { offset, decoder: new StringDecoder('utf8'), partial: '' }
}

/** How a transcript came to exist, per its `entrypoint` stamp. */
type TranscriptOrigin = 'interactive' | 'programmatic'

/**
 * Classify a transcript from its lines (BUG-77).
 *
 * Claude Code stamps every transcript with the `entrypoint` that produced it:
 * `cli` for an interactive session, `sdk-cli` / `sdk-py` / … for a programmatic
 * `claude -p` run. Harnu makes such runs ITSELF — the `/usage` poller, the Haiku
 * auto-namer, usage-history chat — and they all spawn with `cwd: homedir()`, so
 * their transcripts land inside a slug dir this watcher is watching. Announcing
 * one as a session is not merely cosmetic: the renderer's synth→real collapse
 * picks the newest synthetic in the folder by RECENCY, so a probe landing next
 * to a "+ New session" re-keys that synthetic — stealing the operator's live
 * terminal onto a row labelled with the probe's transcript.
 *
 * `claude-reader` already applies this rule on the scan path (rule #6); this is
 * the same rule for the live watcher path, so both agree on what a session is.
 *
 * Returns `null` while no line has carried an `entrypoint` yet. Callers MUST
 * treat that as "not yet known" and fall back to today's behaviour — a
 * transcript predating the stamp, or a partial first read, must never be
 * silently dropped.
 */
export function classifyTranscriptLines(lines: unknown[]): TranscriptOrigin | null {
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue
    const ep = (line as { entrypoint?: unknown }).entrypoint
    if (typeof ep !== 'string' || ep === '') continue
    return ep === 'cli' ? 'interactive' : 'programmatic'
  }
  return null
}

/**
 * Run `task` after any in-flight task for `key` in `chains` settles, so per-path
 * `tailFile`-plus-emit calls never overlap on the shared `TailState` (T15).
 * chokidar does not await async listeners, and JSONLs run `awaitWriteFinish:false`,
 * so a `change` routinely fires while the `add` tail is mid-stream; without this
 * they share one `offset`/`StringDecoder`/`partial` and duplicate + corrupt lines.
 * FIFO (add before change); the chain self-cleans when idle so the map stays bounded.
 */
function runExclusive<T>(
  chains: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>
): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  const run = prev.then(task, task) // run regardless of the prior result
  const guarded = run.catch(() => {}) // a chain link must never reject
  chains.set(key, guarded)
  void guarded.finally(() => {
    if (chains.get(key) === guarded) chains.delete(key)
  })
  return run
}

/**
 * Test-only hook (AC-27): awaited by the `add` handler between its first read and
 * its classification, so a test can queue a `change` behind a classifying `add`
 * deterministically. Always `null` in production.
 */
let classifyGateForTests: ((absPath: string) => Promise<void>) | null = null

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function startClaudeWatcher(
  getWindow: () => BrowserWindow | null,
  opts?: WatcherOptions
): Promise<WatcherHandle> {
  const rootDir = opts?.rootDir ?? DEFAULT_ROOT
  const skipSeed = opts?.skipSeed ?? false
  const roles: PathRoles = { rootDir }

  const offsets = new Map<string, TailState>()
  // Per-path serialization for tailFile calls (T15) — see `runExclusive`.
  const tailChains = new Map<string, Promise<unknown>>()
  // sessionId -> slug it currently lives under (BUG-55). Seeded unconditionally
  // below, then kept live by the `add`/`unlink` handlers so a cross-slug move
  // (EnterWorktree re-homing a transcript) can be correlated regardless of
  // which side of the add/unlink pair the watcher observes first.
  const sessionSlugs = new Map<string, string>()
  // Grace-period timers for a session `unlink`, keyed by the unlinked path
  // (BUG-55 AC4). A move is an unlink in the old slug plus an add in the new
  // one with NO ordering guarantee — if the unlink fires first and is acted
  // on immediately, the session's identity is lost the moment the matching
  // add lands (the renderer sees a fresh add, not a re-home). Delaying the
  // removal lets a near-simultaneous add update `sessionSlugs` first; the
  // grace check below only removes if the mapping still points here.
  const UNLINK_GRACE_MS = 300
  const pendingUnlinkGrace = new Map<string, NodeJS.Timeout>()
  // Paths proven to be programmatic `claude -p` transcripts (BUG-77). Once a
  // path lands here it is never announced or tailed to the renderer again, so a
  // long-lived probe's appends can't backfill a row label either.
  const programmaticPaths = new Set<string>()

  const handle: WatcherHandle = {
    healthy: true,
    close: async () => {
      /* replaced below once chokidar is constructed */
    }
  }

  const send = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  // Every session/subagent update and session add goes through one coalescer
  // (sidebar-liveness C3): updates merge per id, adds are never delayed.
  const events = createEventCoalescer(send)

  // Fleet-model hook (T123 §5.1 W1) — fires ALONGSIDE `send`, never instead of
  // it, so the renderer wire format is untouched. `onSlugChanged` is best-
  // effort: a callback throwing must never break the watcher's own dispatch.
  const notifySlug = (slug: string, cls: SlugChangeClass = 'membership'): void => {
    try {
      opts?.onSlugChanged?.(slug, cls)
    } catch (err) {
      console.error('[claude-watcher] onSlugChanged callback threw', err)
    }
  }

  // Ensure the root exists so the watcher doesn't immediately error on a
  // brand-new machine. mkdir({recursive}) is a no-op if it already exists.
  try {
    await fs.mkdir(rootDir, { recursive: true })
  } catch {
    // If we can't even create the directory (read-only home, EACCES, …),
    // we'll surface degraded state once chokidar errors. Do not throw here.
  }

  // 0. Seed the sessionId->slug correlation map UNCONDITIONALLY (BUG-55) —
  // this must run even when `skipSeed` is set (the production path), since
  // it's what lets a cross-slug move be recognized on the very first `add`/
  // `unlink` the watcher observes for a session that already existed at boot.
  for (const [sessionId, slug] of await seedSessionSlugs(rootDir)) {
    sessionSlugs.set(sessionId, slug)
  }

  // 1. Seed snapshot. Send before subscribing so renderer paints once.
  let seedProjects: SeedProject[] = []
  if (!skipSeed) {
    seedProjects = await readSeedProjects(rootDir)
    // Prime tail offsets to the current end-of-file so we don't replay the
    // entire history on the first `change` event. Active sessions only get
    // their *new* lines emitted.
    await Promise.all(
      seedProjects.flatMap((proj) =>
        proj.entries.map(async (entry) => {
          const absPath = entry.fullPath
          if (!absPath || !absPath.endsWith('.jsonl')) return
          try {
            const st = await fs.stat(absPath)
            const seeded = makeTailState(st.size)
            // Adopt the inode now so a `/compact` between seed and the first
            // `change` is caught by the ino check, not only the size shrink (T16).
            seeded.ino = st.ino
            offsets.set(absPath, seeded)
          } catch {
            // File listed in index but missing on disk (dead session per
            // finding 01 §7). Don't seed an offset — if it's ever recreated,
            // `add` handler will install one starting at 0.
          }
        })
      )
    )
    send('claude:seed', { projects: seedProjects })
  }

  // 2. Construct chokidar.
  //
  // `ignored`: a predicate that
  //   (a) skips dotfiles,
  //   (b) skips anything under `tool-results/`,
  //   (c) for non-JSONL/non-index files, ignores them entirely.
  //
  // Note: chokidar v5 calls the predicate with (path, stats?). Directories
  // pass `stats.isDirectory() === true`; we MUST NOT reject directories or
  // the recursive walk dies on the way down.
  const ignoredPredicate = (p: string, stats?: Stats): boolean => {
    const base = path.basename(p)
    if (base.startsWith('.')) return true

    // `tool-results` directory — we don't surface those files in the sidebar.
    // The folder shows up as a path segment somewhere within the tree.
    const rel = path.relative(rootDir, p)
    const segs = rel.split(path.sep)
    if (segs.includes('tool-results')) return true

    // If we don't know whether it's a dir or file yet, allow it — chokidar
    // will re-invoke with stats once it has them.
    if (!stats) return false
    if (stats.isDirectory()) return false

    // Files we explicitly care about.
    if (isJsonl(p)) return false
    if (isIndexJson(p)) return false

    // Anything else (e.g. `bridge-pointer.json`, `agent-*.meta.json`,
    // stray files) is out of scope for v1.
    return true
  }

  const watcher: FSWatcher = chokidar.watch(rootDir, {
    ignoreInitial: true,
    persistent: true,
    atomic: true,
    followSymlinks: false,
    depth: 4,
    ignorePermissionErrors: true,
    // `awaitWriteFinish` is applied selectively: stable for the index file
    // (atomic rewrite), disabled for JSONLs (they append constantly). The
    // `ignored` predicate above already filters out non-relevant files, so
    // applying a global awaitWriteFinish=false plus per-handler debounce on
    // the index is the cleanest split.
    awaitWriteFinish: false,
    ignored: ignoredPredicate
  })

  // 3. Per-index-file debouncer (so a single atomic rewrite doesn't double-fire).
  const indexDebounce = new Map<string, NodeJS.Timeout>()
  const INDEX_DEBOUNCE_MS = 150

  function scheduleIndexEmit(absPath: string, slug: string): void {
    const prev = indexDebounce.get(absPath)
    if (prev) clearTimeout(prev)
    indexDebounce.set(
      absPath,
      setTimeout(() => {
        indexDebounce.delete(absPath)
        send('claude:index:updated', { slug })
        notifySlug(slug)
      }, INDEX_DEBOUNCE_MS)
    )
  }

  // 4. Wire chokidar events.
  watcher.on('addDir', (p) => {
    const c = classify(p, roles)
    if (c.kind === 'project') {
      send('claude:project:added', { slug: c.slug })
      // A new slug dir is a membership change the model must see even if its
      // first JSONL's own `add` is missed or classified away (AC-2).
      notifySlug(c.slug)
    }
  })

  watcher.on('unlinkDir', (p) => {
    const c = classify(p, roles)
    if (c.kind === 'project') {
      // Drop any per-file offsets we held for this project.
      const prefix = p + path.sep
      for (const key of [...offsets.keys()]) {
        if (key.startsWith(prefix)) offsets.delete(key)
      }
      send('claude:project:removed', { slug: c.slug })
      notifySlug(c.slug)
    }
  })

  watcher.on('add', async (p) => {
    const c = classify(p, roles)
    if (c.kind === 'session') {
      // New JSONL — offset starts at 0; tail will emit the whole file's
      // initial content (typically the `last-prompt`, `custom-title`,
      // `system:init` lines written at session creation).
      offsets.set(p, makeTailState())
      // Cross-slug move correlation (BUG-55): update the mapping BEFORE
      // sending, so a pending unlink-grace check for the OLD slug (whichever
      // order it fires in) sees the new owner and skips its removal.
      sessionSlugs.set(c.sessionId, c.slug)
      // Tail BEFORE announcing (BUG-77). The initial burst Claude Code writes at
      // session creation carries the `entrypoint` stamp, so this first read is
      // what tells an operator's session apart from one of Harnu's own `claude -p`
      // probes. Announcing first and retracting later is NOT an option: the
      // renderer's `session:removed` splices the row and drops its selection,
      // which would orphan a live terminal if the collapse already ran.
      // A read that can't classify yet (empty/partial file, or a transcript from
      // before the stamp existed) falls through to announcing, exactly as before.
      let announced = false
      try {
        await runExclusive(tailChains, p, async () => {
          const state = offsets.get(p)
          if (!state) return
          const newLines = await tailFile(p, state)
          if (classifyGateForTests) await classifyGateForTests(p)
          if (classifyTranscriptLines(newLines) === 'programmatic') {
            programmaticPaths.add(p)
            sessionSlugs.delete(c.sessionId)
            return
          }
          announced = true
          events.added(c.slug, c.sessionId)
          notifySlug(c.slug)
          if (newLines.length > 0) {
            events.session(buildSessionUpdate(c.slug, c.sessionId, newLines))
          }
        })
      } catch {
        /* fall through to the unclassified-announce below */
      }
      // The tail failed or was pre-empted, so nothing classified this path. Announce
      // anyway — a session we can't read about is still a session, and withholding
      // it would be a regression on a path that used to announce unconditionally.
      if (!announced && !programmaticPaths.has(p)) {
        events.added(c.slug, c.sessionId)
        notifySlug(c.slug)
      }
    } else if (c.kind === 'subagent') {
      // New subagent transcript — surface it on its own channel (issue #9) so
      // the renderer can nest it under the parent session and seed its status.
      offsets.set(p, makeTailState())
      notifySlug(c.slug)
      try {
        await runExclusive(tailChains, p, async () => {
          const state = offsets.get(p)
          if (!state) return
          const newLines = await tailFile(p, state)
          if (newLines.length > 0) {
            events.subagent(
              buildSubagentUpdate(c.slug, c.sessionId, agentIdFromAgentLeaf(c.agent), newLines)
            )
          }
        })
      } catch {
        /* swallow */
      }
    } else if (c.kind === 'index') {
      scheduleIndexEmit(p, c.slug)
    }
  })

  watcher.on('change', async (p) => {
    const c = classify(p, roles)
    // A proven `claude -p` transcript stays invisible for its whole life, not
    // just at `add` — a probe that keeps appending must never reach the renderer
    // and backfill a row (BUG-77).
    if (programmaticPaths.has(p)) return
    if (c.kind === 'session' || c.kind === 'subagent') {
      // Whether the `add` was missed (e.g. seed missed it because the index was
      // stale) — if so this `change` is our FIRST read of the file, so it is the
      // one that has to classify it (BUG-77). An ordinary append is a mid-file
      // delta that carries no `entrypoint`, and re-classifying those every time
      // would just be a chance to get it wrong.
      const missedAdd = !offsets.has(p)
      if (missedAdd) {
        // The watcher runs with `ignoreInitial`, so a missed add is always a file
        // that existed before it was first seen: never replay it whole (C5). Seed
        // synchronously so a second `change` sees the path as known; the tail
        // itself is serialized below (T15).
        const state = makeTailState()
        state.firstReadCap = FIRST_APPEND_TAIL_CAP_BYTES
        offsets.set(p, state)
      }
      try {
        await runExclusive(tailChains, p, async () => {
          // Re-check inside the chain (BUG-77, AC-27): this change may have been
          // queued while the path's `add` was still classifying it.
          if (programmaticPaths.has(p)) return
          const state = offsets.get(p)
          if (!state) return
          // A missed add's first read is a capped tail, which may not reach the
          // `entrypoint` stamp — classify (and read session-level head facts)
          // from a separate head window instead.
          const headLines = missedAdd ? await readHeadLines(p, CLASSIFY_HEAD_BYTES) : []
          if (
            missedAdd &&
            c.kind === 'session' &&
            classifyTranscriptLines(headLines) === 'programmatic'
          ) {
            programmaticPaths.add(p)
            sessionSlugs.delete(c.sessionId)
            return
          }
          const newLines = await tailFile(p, state)
          if (newLines.length === 0) return
          if (
            missedAdd &&
            c.kind === 'session' &&
            classifyTranscriptLines(headLines) === null &&
            classifyTranscriptLines(newLines) === 'programmatic'
          ) {
            programmaticPaths.add(p)
            sessionSlugs.delete(c.sessionId)
            return
          }
          // An ordinary append only moves the transcript's append fields, so it
          // takes the rate-limited path (C4). A missed add is the first time the
          // watcher sees this file — keep it on the membership window.
          notifySlug(c.slug, missedAdd ? 'membership' : 'append')
          if (c.kind === 'subagent') {
            // Agent type and task live in the subagent's first lines.
            events.subagent(
              buildSubagentUpdate(c.slug, c.sessionId, agentIdFromAgentLeaf(c.agent), [
                ...headLines,
                ...newLines
              ])
            )
          } else {
            const update = buildSessionUpdate(c.slug, c.sessionId, newLines)
            const headPrompt = buildSessionUpdate(
              c.slug,
              c.sessionId,
              headLines
            ).firstPromptCandidate
            if (headPrompt) update.firstPromptCandidate = headPrompt
            events.session(update)
          }
        })
      } catch {
        /* swallow; chokidar will fire again on the next write */
      }
    } else if (c.kind === 'index') {
      scheduleIndexEmit(p, c.slug)
    }
  })

  watcher.on('unlink', (p) => {
    const c = classify(p, roles)
    offsets.delete(p)
    // A programmatic transcript was never announced, so there is nothing to
    // remove — just forget it so the set doesn't grow unbounded (BUG-77).
    if (programmaticPaths.delete(p)) return
    if (c.kind === 'session') {
      // Cross-slug move correlation (BUG-55 AC4): don't act immediately — a
      // move is this unlink plus an add under a different slug with no
      // ordering guarantee. Delay the removal so a near-simultaneous add can
      // update `sessionSlugs` first; only remove if, once the grace window
      // elapses, the session is STILL mapped to the slug this unlink was for.
      const prevTimer = pendingUnlinkGrace.get(p)
      if (prevTimer) clearTimeout(prevTimer)
      pendingUnlinkGrace.set(
        p,
        setTimeout(() => {
          pendingUnlinkGrace.delete(p)
          if (sessionSlugs.get(c.sessionId) !== c.slug) return // re-homed elsewhere — no-op
          sessionSlugs.delete(c.sessionId)
          events.dropSession(c.sessionId)
          send('claude:session:removed', {
            slug: c.slug,
            sessionId: c.sessionId
          })
          notifySlug(c.slug)
        }, UNLINK_GRACE_MS)
      )
    } else if (c.kind === 'subagent') {
      // Rare (subagent transcripts aren't normally deleted), but keep the
      // renderer's nested list in sync if one disappears (issue #9). A pending
      // update would re-create the agent row the removal just dropped.
      events.dropSubagent(c.sessionId, agentIdFromAgentLeaf(c.agent))
      send('claude:subagent:removed', {
        slug: c.slug,
        parentSessionId: c.sessionId,
        agentId: agentIdFromAgentLeaf(c.agent)
      })
      notifySlug(c.slug)
    }
  })

  // 4b. Initial registration complete — let the fleet model close the gap
  // between its own boot scan and the watch actually being live (T123 §5.1
  // W1). Anything created/removed in that window emitted no event, so only a
  // rescan can observe it.
  watcher.on('ready', () => {
    try {
      opts?.onReady?.()
    } catch (err) {
      console.error('[claude-watcher] onReady callback threw', err)
    }
  })

  // 5. Error sink. ENOSPC/EMFILE are partial-degraded; EACCES is "can't read";
  // anything else falls through to OTHER.
  watcher.on('error', (err: unknown) => {
    const e = err as NodeJS.ErrnoException
    const raw = e?.code ?? ''
    let code: DegradedCode = 'OTHER'
    if (raw === 'ENOSPC') code = 'ENOSPC'
    else if (raw === 'EMFILE') code = 'EMFILE'
    else if (raw === 'EACCES') code = 'EACCES'

    if (code !== 'OTHER') {
      // Set handle.healthy false so the renderer can surface a status pill.
      handle.healthy = false
    }
    // ANY watcher error (classified or OTHER) means incremental deltas may
    // have been missed — the fleet model must fall back to a full rescan, so
    // this fires unconditionally, unlike the healthy flag above.
    try {
      opts?.onDegraded?.()
    } catch (cbErr) {
      console.error('[claude-watcher] onDegraded callback threw', cbErr)
    }
    send('claude:watcher:degraded', {
      code,
      message: e?.message ?? String(err)
    })
  })

  // 6. Teardown.
  handle.close = async (): Promise<void> => {
    for (const t of indexDebounce.values()) clearTimeout(t)
    indexDebounce.clear()
    for (const t of pendingUnlinkGrace.values()) clearTimeout(t)
    pendingUnlinkGrace.clear()
    events.close()
    sessionSlugs.clear()
    offsets.clear()
    tailChains.clear()
    try {
      await watcher.close()
    } catch {
      /* swallow — best effort */
    }
  }

  return handle
}

/**
 * Test-only seams (ADR-0001): the chokidar shell is e2e-covered, but the pure
 * tail/serialization logic (T15/T16) is unit-tested directly via these exports.
 */
export const __testables = {
  tailFile,
  runExclusive,
  makeTailState,
  classifyTranscriptLines,
  createEventCoalescer,
  lastTailBytesForTests: (absPath: string): number | undefined => lastTailBytes.get(absPath),
  setClassifyGateForTests: (gate: ((absPath: string) => Promise<void>) | null): void => {
    classifyGateForTests = gate
  }
}
