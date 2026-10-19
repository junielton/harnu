/**
 * Pure core of the footer's transcript fallback (BUG-196 AC-1): when a session has no statusLine
 * record at all, the model and context % can still be read from its own transcript. Reuses the
 * T91 derivations (`transcript-truth.ts`); the file read lives in `statusline-fallback.ts`.
 */
import { computeCtxPct, type TranscriptEntry } from './transcript-truth'

export interface TranscriptFallbackReading {
  modelId: string
  /** Context-window used %, or null when no assistant turn carried usage. */
  contextPercent: number | null
  /** Epoch ms of the last assistant turn, or null when it carried no timestamp. */
  atMs: number | null
}

/** The CLI writes this as the model of turns it produced locally (no API call). */
const SYNTHETIC_MODEL = '<synthetic>'

/** Model, context % and time of the transcript's last assistant turn; null with no assistant turn. */
export function deriveTranscriptFallback(
  entries: readonly TranscriptEntry[]
): TranscriptFallbackReading | null {
  let modelId = ''
  let atMs: number | null = null
  let sawAssistant = false
  for (const e of entries) {
    if (!e || typeof e !== 'object' || e.type !== 'assistant') continue
    const msg = e.message
    const model =
      msg && typeof msg === 'object' ? (msg as Record<string, unknown>).model : undefined
    if (typeof model !== 'string' || model === SYNTHETIC_MODEL) continue
    sawAssistant = true
    modelId = model
    const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN
    atMs = Number.isFinite(ts) ? ts : null
  }
  if (!sawAssistant) return null
  const ctx = computeCtxPct(entries)
  return { modelId, contextPercent: ctx ? ctx.pct : null, atMs }
}

/**
 * Parse the text of a transcript's tail. When the read started mid-file the first line is
 * partial and is dropped. Unparseable lines are skipped.
 */
export function parseJsonlTail(text: string, startedMidFile: boolean): TranscriptEntry[] {
  const lines = text.split('\n')
  if (startedMidFile) lines.shift()
  const out: TranscriptEntry[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (parsed && typeof parsed === 'object') out.push(parsed as TranscriptEntry)
    } catch {
      /* partial or corrupt line */
    }
  }
  return out
}
