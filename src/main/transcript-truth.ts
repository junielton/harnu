/**
 * Pure transcript-truth derivations (T91 — adopt Claude Code JSONL ground truth).
 *
 * Given the parsed entries of a Claude Code `.jsonl` transcript (or just its
 * tail window / a live append delta), these functions compute the signals Harnu
 * used to only APPROXIMATE from mtime + hook heuristics:
 *
 *  1. {@link deriveTurnState}  — a deterministic turn-over state machine
 *     (working / idle / needs-input) read from the CLI's own markers.
 *  2. {@link isChainParticipant} — the tail filter that drops the metadata the
 *     CLI re-appends at EOF on every pause/switch/resume.
 *  3. {@link deriveTitles} / {@link pickTitle} / {@link pickWhatsHappening} —
 *     titles from the dedicated `custom-title`/`ai-title`/`task-summary`/
 *     `last-prompt` entries instead of first-prompt guesses.
 *  4. {@link extractAwaySummary} — the CLI's NL "Goal:… Next:…" recap.
 *  5. {@link computeCtxPct} — context-window % straight from the last assistant
 *     usage, reset across `/compact`.
 *  6. {@link deriveStagnation} (T175, `stall-detect.ts`) — a second flavour of
 *     `stuck`: a session emitting tool calls whose targets it has already
 *     visited, with no mutation among them.
 *
 * NO fs / electron deps — it operates on already-parsed objects, so it unit-tests
 * in isolation with real-shaped fixtures (like `claude-reader-derive.ts`). Every
 * function is pure and tolerant: an unknown/corrupt entry is skipped, never thrown
 * on.
 */

import { deriveStagnation, type StagnationVerdict } from './stall-detect'

export type { StagnationVerdict } from './stall-detect'

/** One parsed JSONL entry. We only ever read a handful of fields, all optional. */
export type TranscriptEntry = Record<string, unknown>

/**
 * The deterministic turn-over state a transcript reports about itself (T91 §1).
 * DISTINCT from the hook `TaskState`: this is disk ground truth, consulted by the
 * canonical fleet classifier only when no live hook/screen signal is present.
 *
 *  - `working`     — the last assistant turn ended on a `tool_use` (a tool is
 *                    running) or the model is mid-generation / mid-prompt.
 *  - `idle`        — the last turn concluded (`end_turn` → `stop_hook_summary` →
 *                    `turn_duration`, or an `away_summary` was written).
 *  - `needs-input` — the last assistant paused on a human-gating tool
 *                    (`AskUserQuestion` / `ExitPlanMode`) with no result yet.
 *  - `unknown`     — no recognizable marker in the window; caller falls back to
 *                    the quiet-timer heuristic.
 */
export type TranscriptState = 'working' | 'idle' | 'needs-input' | 'unknown'

/** The on-disk entry `type`s that ARE part of the conversation chain (T91 §2). */
const CHAIN_TYPES = new Set(['user', 'assistant', 'system'])

/**
 * Tools whose `tool_use` blocks a turn on YOU: the model emitted the call and
 * cannot proceed until you answer. When one of these is the last assistant's
 * unresolved `tool_use`, the turn is `needs-input`, not `working` (T91 §1). A
 * generic permission prompt is NOT here — that surfaces via the hook FSM
 * (`PermissionRequest` → taskState `needs-input`), which the classifier already
 * layers on top; the transcript alone can't distinguish a pending-permission
 * `tool_use` from a merely-running one.
 */
export const HUMAN_GATING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

/**
 * Entry `type`s that are internal noise: skip them without parsing their (often
 * huge) payloads (T91 §6). `content-replacement` and the `marble-origami-*`
 * internal-build entries can carry large uuid arrays; they never inform any
 * derivation here, so callers may drop them before/after parse.
 */
export const TOLERATED_NOISE_TYPES = new Set([
  'content-replacement',
  'marble-origami-commit',
  'marble-origami-snapshot'
])

/** True for an entry Harnu should skip entirely (internal noise, T91 §6). */
export function isNoiseEntry(entry: TranscriptEntry | null | undefined): boolean {
  if (!entry || typeof entry !== 'object') return true
  const t = entry.type
  if (typeof t !== 'string') return true
  return TOLERATED_NOISE_TYPES.has(t) || t.startsWith('marble-origami-')
}

/**
 * A chain participant is a real conversation entry — it has a `uuid` envelope and
 * a `type` of `user` / `assistant` / `system` (T91 §2, CLI's `isTranscriptMessage`).
 * This is the filter that removes the metadata the CLI re-appends at EOF on every
 * pause/switch/resume (`last-prompt`, `custom-title`, `mode`, `permission-mode`,
 * `bridge-session`, `ai-title`, …) — none of which carry a `uuid`, so a single
 * `uuid + type` test drops them all. Derive last-message / preview / turn-state
 * ONLY from entries that pass this.
 */
export function isChainParticipant(entry: TranscriptEntry | null | undefined): boolean {
  if (!entry || typeof entry !== 'object') return false
  if (typeof entry.uuid !== 'string' || entry.uuid.length === 0) return false
  return typeof entry.type === 'string' && CHAIN_TYPES.has(entry.type)
}

/** The last entry in file order that passes {@link isChainParticipant}, or null. */
export function lastChainParticipant(entries: readonly TranscriptEntry[]): TranscriptEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isChainParticipant(entries[i])) return entries[i]
  }
  return null
}

/** The `message` object of an entry, or null. */
function messageOf(entry: TranscriptEntry): Record<string, unknown> | null {
  const msg = entry.message
  return msg && typeof msg === 'object' ? (msg as Record<string, unknown>) : null
}

/** Names of every `tool_use` block in an assistant entry's content (may be []). */
export function toolUseNames(entry: TranscriptEntry): string[] {
  const msg = messageOf(entry)
  if (!msg) return []
  const content = msg.content
  if (!Array.isArray(content)) return []
  const names: string[] = []
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as Record<string, unknown>).type === 'tool_use'
    ) {
      const name = (block as Record<string, unknown>).name
      if (typeof name === 'string') names.push(name)
    }
  }
  return names
}

/**
 * Deterministic turn-over state machine (T91 §1). Reads the LAST chain
 * participant (metadata tail already filtered out) and decides:
 *
 *  - `system` `turn_duration` / `stop_hook_summary` / `away_summary` → `idle`
 *    (the turn's end checkpoint, or the away recap — nothing is running).
 *  - `assistant` with `stop_reason` `end_turn` / `stop_sequence` / `max_tokens`
 *    → `idle` (the model concluded its turn).
 *  - `assistant` with `stop_reason` `tool_use` → `needs-input` iff it holds an
 *    unresolved human-gating tool call ({@link HUMAN_GATING_TOOLS}); else
 *    `working` (a normal tool is running). "Unresolved" is implicit: a resolved
 *    tool would make a LATER entry the last chain participant.
 *  - `assistant` still streaming (`stop_reason` null) → `working`.
 *  - `user` (a fresh prompt or a tool_result) → `working` (the model will/does act).
 *  - anything else / empty window → `unknown` (caller uses the quiet-timer).
 */
export function deriveTurnState(entries: readonly TranscriptEntry[]): TranscriptState {
  const last = lastChainParticipant(entries)
  if (!last) return 'unknown'

  const type = last.type

  if (type === 'system') {
    const subtype = typeof last.subtype === 'string' ? last.subtype : ''
    if (subtype === 'turn_duration' || subtype === 'stop_hook_summary') return 'idle'
    if (subtype === 'away_summary') return 'idle'
    // Other subtypes (compact_boundary mid-file, local_command, …) aren't a
    // reliable turn boundary — defer to the quiet-timer.
    return 'unknown'
  }

  if (type === 'assistant') {
    const msg = messageOf(last)
    const stopReason = msg && typeof msg.stop_reason === 'string' ? msg.stop_reason : null
    if (
      stopReason === 'end_turn' ||
      stopReason === 'stop_sequence' ||
      stopReason === 'max_tokens'
    ) {
      return 'idle'
    }
    if (stopReason === 'tool_use') {
      const names = toolUseNames(last)
      if (names.some((n) => HUMAN_GATING_TOOLS.has(n))) return 'needs-input'
      return 'working'
    }
    // stop_reason null/unknown → mid-stream generation.
    return 'working'
  }

  if (type === 'user') {
    // A new user prompt or a tool_result — the model is (about to be) working.
    return 'working'
  }

  return 'unknown'
}

/** The dedicated title/summary entries, latest-wins (T91 §3). Empty when absent. */
export interface TranscriptTitles {
  /** `/rename` — the user's explicit title. Highest precedence, never clobbered. */
  customTitle: string
  /** Claude's auto-generated 3–7 word title. */
  aiTitle: string
  /** A `task-summary` entry's text — "what is this session about". */
  taskSummary: string
  /** The latest `last-prompt` entry — the freshest user instruction. */
  lastPrompt: string
}

/** Read a string field from an entry by any of several candidate keys. */
function firstString(entry: TranscriptEntry, keys: string[]): string {
  for (const k of keys) {
    const v = entry[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return ''
}

/**
 * Scan for the dedicated title entries, latest-wins (T91 §3). `custom-title` and
 * `ai-title` can appear anywhere (the CLI re-appends the freshest at EOF); the
 * latest occurrence of each wins.
 */
export function deriveTitles(entries: readonly TranscriptEntry[]): TranscriptTitles {
  const out: TranscriptTitles = { customTitle: '', aiTitle: '', taskSummary: '', lastPrompt: '' }
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    switch (e.type) {
      case 'custom-title': {
        const v = firstString(e, ['customTitle', 'title'])
        if (v) out.customTitle = v
        break
      }
      case 'ai-title': {
        const v = firstString(e, ['aiTitle', 'title'])
        if (v) out.aiTitle = v
        break
      }
      case 'task-summary': {
        const v = firstString(e, ['taskSummary', 'summary', 'content', 'text'])
        if (v) out.taskSummary = v
        break
      }
      case 'last-prompt': {
        const v = firstString(e, ['lastPrompt', 'prompt'])
        if (v) out.lastPrompt = v
        break
      }
    }
  }
  return out
}

/**
 * The session label (T91 §3): the user's `custom-title` wins, else Claude's
 * `ai-title`, else ''. NEVER lets an `ai-title` clobber a `custom-title`.
 */
export function pickTitle(titles: Pick<TranscriptTitles, 'customTitle' | 'aiTitle'>): string {
  return titles.customTitle || titles.aiTitle || ''
}

/**
 * "What's happening now" (T91 §3): `task-summary` → `last-prompt` → the first
 * user message. A live subtitle, distinct from the persistent {@link pickTitle}.
 */
export function pickWhatsHappening(
  titles: Pick<TranscriptTitles, 'taskSummary' | 'lastPrompt'>,
  firstPrompt: string
): string {
  return titles.taskSummary || titles.lastPrompt || firstPrompt || ''
}

/**
 * The latest `system`/`away_summary` content (T91 §4) — the CLI's own NL recap of
 * "what happened while you were away" ("Goal:… Next:…"). Empty when none present.
 * Surface it VERBATIM in previews / the triage queue.
 */
export function extractAwaySummary(entries: readonly TranscriptEntry[]): string {
  let out = ''
  for (const e of entries) {
    if (
      e &&
      typeof e === 'object' &&
      e.type === 'system' &&
      e.subtype === 'away_summary' &&
      typeof e.content === 'string' &&
      e.content.length > 0
    ) {
      out = e.content
    }
  }
  return out
}

/** Default model context window (tokens). */
export const DEFAULT_CONTEXT_WINDOW = 200_000
/** Context window for a `[1m]`-suffixed model (tokens). */
export const LARGE_CONTEXT_WINDOW = 1_000_000

/** Context window for a model id: 1M for a `[1m]` suffix, else 200k (T91 §5). */
export function contextWindowForModel(model: string | null | undefined): number {
  if (typeof model === 'string' && /\[1m\]/i.test(model)) return LARGE_CONTEXT_WINDOW
  return DEFAULT_CONTEXT_WINDOW
}

/** Sum the three context-occupying token counts of an assistant `usage` block. */
function usedTokensFromUsage(usage: Record<string, unknown>): number | null {
  const input = usage.input_tokens
  const cacheCreate = usage.cache_creation_input_tokens
  const cacheRead = usage.cache_read_input_tokens
  // input_tokens is always present on a real usage block; the cache fields may be
  // absent on the very first turn. Treat missing cache fields as 0, but require
  // at least input_tokens to be a number (else this isn't a usable usage block).
  if (typeof input !== 'number') return null
  const c = typeof cacheCreate === 'number' ? cacheCreate : 0
  const r = typeof cacheRead === 'number' ? cacheRead : 0
  return input + c + r
}

/** The `postTokens` recorded on a `compact_boundary` (nested or top-level), or null. */
function postTokensOf(entry: TranscriptEntry): number | null {
  const meta = entry.compactMetadata
  if (meta && typeof meta === 'object') {
    const p = (meta as Record<string, unknown>).postTokens
    if (typeof p === 'number') return p
  }
  const top = entry.postTokens
  return typeof top === 'number' ? top : null
}

/** Context-window usage computed from a transcript (T91 §5). */
export interface CtxUsage {
  /** 0–100, rounded. */
  pct: number
  /** Raw occupied tokens the pct is based on. */
  usedTokens: number
  /** The model's context window (200k / 1M). */
  contextWindow: number
}

/**
 * Context-window % straight from the JSONL (T91 §5): the LAST assistant `usage`'s
 * input + cache_creation + cache_read over the model's context window. A
 * `compact_boundary` resets the baseline — its `postTokens` is used when no
 * assistant turn follows the compaction (else the post-compaction assistant's own
 * usage, which already reflects the shrunk context, wins by latest-order). Returns
 * null when the window holds no usable usage (fall back to statusline data).
 */
export function computeCtxPct(entries: readonly TranscriptEntry[]): CtxUsage | null {
  let used: number | null = null
  let model: string | null = null
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue
    if (e.type === 'assistant') {
      const msg = messageOf(e)
      if (!msg) continue
      if (typeof msg.model === 'string') model = msg.model
      const usage = msg.usage
      if (usage && typeof usage === 'object') {
        const u = usedTokensFromUsage(usage as Record<string, unknown>)
        if (u !== null) used = u
      }
    } else if (e.type === 'system' && e.subtype === 'compact_boundary') {
      const post = postTokensOf(e)
      if (post !== null) used = post
    }
  }
  if (used === null) return null
  const contextWindow = contextWindowForModel(model)
  const pct = Math.max(0, Math.min(100, Math.round((used / contextWindow) * 100)))
  return { pct, usedTokens: used, contextWindow }
}

/** Everything the reader/watcher surfaces from a transcript's tail (T91). */
export interface TranscriptTruth {
  transcriptState: TranscriptState
  titles: TranscriptTitles
  awaySummary: string
  ctx: CtxUsage | null
  stagnation: StagnationVerdict
}

/**
 * Run every derivation over a window of parsed entries in one pass' worth of
 * scans. The window should be the transcript TAIL (plus, ideally, any re-appended
 * metadata at EOF) — the last turn's markers, the last assistant usage, the latest
 * titles and away_summary all live there. Pure; safe on an empty array.
 */
export function deriveTranscriptTruth(entries: readonly TranscriptEntry[]): TranscriptTruth {
  return {
    transcriptState: deriveTurnState(entries),
    titles: deriveTitles(entries),
    awaySummary: extractAwaySummary(entries),
    ctx: computeCtxPct(entries),
    stagnation: deriveStagnation(entries)
  }
}
