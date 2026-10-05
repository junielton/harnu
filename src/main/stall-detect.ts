/**
 * Stagnation detector (T175) — a pure, LLM-free fold over transcript tool-call
 * entries that flags a session repeating the same tool targets with no
 * mutation between them: the "noisy stall" the filesystem-silence-only
 * `stuck` rule cannot see (`fleet-state.ts`'s `workingOrStuck`).
 *
 * Zero process spawns, zero LLM/API calls, zero network requests, no timer,
 * no persisted per-session state — the window is anchored on the LAST
 * entry's own `timestamp` field (transcript time), never `Date.now()`.
 * Novelty is judged only against tool calls already present in the same
 * input array (the reader's existing tail) — no accumulator, no cross-call
 * state.
 *
 * Design rationale: docs/specs/T175-session-stagnation-detector.md
 */

/** One parsed JSONL entry. We only ever read a handful of fields, all optional. */
export type TranscriptEntry = Record<string, unknown>

/** Rolling window, measured in transcript time (the last entry's own timestamp). */
export const STAGNATION_WINDOW_MS = 5 * 60_000

/** Busy-ness floor: fewer tool calls in the window than this is never stagnant. */
export const STAGNATION_MIN_CALLS = 8

/** Tool names whose call mutates state — one inside the window rules out stagnation. */
export const MUTATION_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

/** Tools whose salient input is a file path. */
const FILE_PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit'])

/** The first string-valued key of an input object, or ''. */
function firstStringValue(input: Record<string, unknown>): string {
  for (const key of Object.keys(input)) {
    const v = input[key]
    if (typeof v === 'string') return v
  }
  return ''
}

/** The salient input for a tool call — what the call actually acted on. */
function salientInput(name: string, input: Record<string, unknown>): string {
  if (FILE_PATH_TOOLS.has(name)) {
    return typeof input.file_path === 'string' ? input.file_path : firstStringValue(input)
  }
  if (name === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    return command.replace(/\s+/g, ' ').trim().slice(0, 200)
  }
  if (name === 'Grep') {
    const pattern = typeof input.pattern === 'string' ? input.pattern : ''
    const path = typeof input.path === 'string' ? input.path : ''
    return `${pattern} ${path}`
  }
  if (name === 'Glob') {
    return typeof input.pattern === 'string' ? input.pattern : firstStringValue(input)
  }
  if (name === 'Task' || name === 'Agent') {
    return typeof input.description === 'string' ? input.description : firstStringValue(input)
  }
  return firstStringValue(input)
}

/** A tool call inside the tail, reduced to what stagnation detection needs. */
interface ToolCall {
  /** Comparison key: `name` + NUL + salient input. NUL can't occur in either part. */
  fingerprint: string
  /** Display label: `name: salient`. Never used for comparison. */
  label: string
  /** Transcript-time timestamp (ms) of the entry this call came from. */
  ts: number
  isMutation: boolean
}

/** Every `tool_use` block across the tail's `assistant` entries, in file order. */
function extractToolCalls(entries: readonly TranscriptEntry[]): ToolCall[] {
  const calls: ToolCall[] = []
  for (const e of entries) {
    if (!e || typeof e !== 'object' || e.type !== 'assistant') continue
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN
    if (Number.isNaN(ts)) continue
    const msg = e.message
    if (!msg || typeof msg !== 'object') continue
    const content = (msg as Record<string, unknown>).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue
      const rawInput = b.input
      const input =
        rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {}
      const salient = salientInput(b.name, input)
      calls.push({
        fingerprint: `${b.name}\u0000${salient}`,
        label: `${b.name}: ${salient}`,
        ts,
        isMutation: MUTATION_TOOLS.has(b.name)
      })
    }
  }
  return calls
}

/** The tally + verdict a stagnation check produces over a transcript tail. */
export interface StagnationVerdict {
  stagnant: boolean
  /** Tool calls inside the window. */
  calls: number
  /** Distinct fingerprints inside the window (the tally's second number). */
  distinct: number
  /** Display label of the most-repeated fingerprint, e.g. `Bash: npm test`. */
  topTarget: string
  /** Repeat count of `topTarget` inside the window. */
  topCount: number
}

const ZERO_VERDICT: StagnationVerdict = {
  stagnant: false,
  calls: 0,
  distinct: 0,
  topTarget: '',
  topCount: 0
}

/**
 * Fold the tail's tool calls into a stagnation verdict. The window is
 * `(last - STAGNATION_WINDOW_MS, last]`, anchored on the last entry's own
 * `timestamp` — never `Date.now()`. A session is `stagnant` iff, within the
 * window: it made at least {@link STAGNATION_MIN_CALLS} tool calls, every
 * fingerprint was already present earlier in the tail (`novel === 0`), and no
 * {@link MUTATION_TOOLS} call occurred (`mutations === 0`). Pure and tolerant:
 * an empty or malformed tail returns a non-stagnant zero verdict, never throws.
 */
export function deriveStagnation(entries: readonly TranscriptEntry[]): StagnationVerdict {
  if (entries.length === 0) return ZERO_VERDICT

  const lastEntry = entries[entries.length - 1]
  const lastTs =
    lastEntry && typeof lastEntry === 'object' && typeof lastEntry.timestamp === 'string'
      ? Date.parse(lastEntry.timestamp)
      : NaN
  if (Number.isNaN(lastTs)) return ZERO_VERDICT

  const allCalls = extractToolCalls(entries)
  const windowStart = lastTs - STAGNATION_WINDOW_MS
  const windowCalls = allCalls.filter((c) => c.ts > windowStart && c.ts <= lastTs)
  if (windowCalls.length === 0) return ZERO_VERDICT

  const priorFingerprints = new Set(
    allCalls.filter((c) => c.ts <= windowStart).map((c) => c.fingerprint)
  )

  const tally = new Map<string, { count: number; label: string }>()
  for (const c of windowCalls) {
    const existing = tally.get(c.fingerprint)
    if (existing) existing.count++
    else tally.set(c.fingerprint, { count: 1, label: c.label })
  }

  let novel = 0
  for (const fp of tally.keys()) {
    if (!priorFingerprints.has(fp)) novel++
  }

  const mutations = windowCalls.filter((c) => c.isMutation).length

  let topTarget = ''
  let topCount = 0
  for (const { count, label } of tally.values()) {
    if (count > topCount) {
      topCount = count
      topTarget = label
    }
  }

  const stagnant = windowCalls.length >= STAGNATION_MIN_CALLS && novel === 0 && mutations === 0

  return { stagnant, calls: windowCalls.length, distinct: tally.size, topTarget, topCount }
}
