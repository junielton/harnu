/**
 * Pure session-anatomy + window-enrichment core for the Usage BI dashboard
 * (T47 P6 S1). Sits ON TOP of the P5 cost engine (`usage-cost-core.ts`) —
 * every token/cost number here is derived by re-using that engine's dedupe +
 * pricing (`priceFileLines`), never by re-summing raw usage. Zero fs/electron
 * deps — unit-tested in the `node` vitest env (`tests/usage-bi-core.test.ts`).
 *
 * Layers:
 *  1. Per-file anatomy signals ({@link buildFileAnatomySignals}) — one call per
 *     transcript file (main OR `subagents/agent-*.jsonl`), mirroring the P5
 *     engine's per-file cache unit so the shell can cache this alongside the
 *     existing `CostBucket[]`.
 *  2. Per-session anatomy ({@link buildSessionAnatomy}) — folds a session's
 *     file signals (1 main + N subagents) into the full anatomy shape the BI
 *     snapshot serves.
 *  3. Window enrichment ({@link enrichWindows}) — joins hourly cost buckets
 *     against `usage-history-core.ts`'s closed `WindowRecord`s to answer
 *     "which sessions burned this 5h window".
 *  4. Daily model breakdown ({@link buildDailyModelBreakdown}) — per-day
 *     cost-by-model + dominant model, folded from the same merged
 *     `CostBucket[]` the P5 engine already produces.
 */

import {
  priceFileLines,
  emptyTokenBreakdown,
  type TokenBreakdown,
  type CostBucket
} from './usage-cost-core'
import { firstRealPrompt } from './claude-reader-derive'
import { WINDOW_DURATION_MS, type WindowRecord } from './usage-history-core'

// ---- Context-window sizing (utils/context.ts parity) ------------------------

export const CONTEXT_WINDOW_DEFAULT = 200_000
export const CONTEXT_WINDOW_1M = 1_000_000

/**
 * 200k tokens by default; 1M when the model id carries the `[1m]` marker
 * (Anthropic's long-context beta suffix). Matches the CLI's own
 * `utils/context.ts` sizing (semantics pinned in the P5 recipe memory).
 */
export function contextWindowFor(modelId: string): number {
  return modelId.includes('[1m]') ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW_DEFAULT
}

function addTokens(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens
  }
}

// ---- Turn / title line parsing ----------------------------------------------

/**
 * Real-user-turn extraction (semantics pinned, part A "turns"): a `type:
 * 'user'` record counts as a turn when its `message.content` is either (a) a
 * non-empty string, or (b) a content-block array containing at least one
 * NON-`tool_result` block (text/image/etc). An array whose blocks are ALL
 * `tool_result` is the synthetic user record Claude Code writes to carry a
 * tool's result back to the model — not something the human typed — so it is
 * EXCLUDED from the turn count (matches the objective's "exclude tool_result-
 * only user records" instruction). Returns `null` when the record is not a
 * real turn; otherwise the representative text (may be `''` for an
 * image-only turn — still a real turn, just nothing to quote).
 */
function extractRealUserText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.trim() ? content : null
  }
  if (Array.isArray(content)) {
    if (content.length === 0) return null
    const hasNonToolResult = content.some(
      (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type !== 'tool_result'
    )
    if (!hasNonToolResult) return null
    const textBlock = content.find(
      (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text'
    ) as Record<string, unknown> | undefined
    return textBlock && typeof textBlock.text === 'string' ? (textBlock.text as string) : ''
  }
  return null
}

interface AnatomyLineInfo {
  timestampMs: number | null
  isUserTurn: boolean
  userText: string
  customTitle: string | null
  aiTitle: string | null
}

/**
 * Parse ONE raw JSONL line for the anatomy signals that span every record
 * type (unlike `parseAssistantLine`, which only looks at priced assistant
 * records): timestamps, real user turns, and the title markers Harnu's
 * sidebar already understands (`custom-title` from `/rename`, `ai-title` from
 * Claude's auto-namer). Never throws; unparseable/irrelevant lines yield
 * `null`.
 */
function parseAnatomyLine(line: string): AnatomyLineInfo | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>

  const timestamp = rec.timestamp
  const timestampMs = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN

  let customTitle: string | null = null
  let aiTitle: string | null = null
  if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') {
    customTitle = rec.customTitle
  }
  if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
    aiTitle = rec.aiTitle
  }

  let isUserTurn = false
  let userText = ''
  if (rec.type === 'user' && rec.isMeta !== true && rec.isSidechain !== true) {
    const message = rec.message
    if (message && typeof message === 'object') {
      const text = extractRealUserText((message as Record<string, unknown>).content)
      if (text !== null) {
        isUserTurn = true
        userText = text
      }
    }
  }

  return {
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : null,
    isUserTurn,
    userText,
    customTitle,
    aiTitle
  }
}

// ---- Per-file anatomy signals (the cache unit) -------------------------------

/** One hourly (hour-start, model) cost point — the window-enrichment join key. */
export interface HourlyCostPoint {
  /** Epoch ms floored to the containing hour. */
  hourStartMs: number
  model: string
  costUsd: number
}

export interface FileAnatomyMeta {
  sessionId: string
  isSubagent: boolean
}

/**
 * Everything one transcript file (main or subagent) contributes to its
 * session's anatomy. Folded across a session's files by
 * {@link buildSessionAnatomy}. Turn/title/peak-context signals are only
 * collected from the MAIN file (`isSubagent: false`) — a subagent's own user
 * turns aren't the human's turns, and its context usage is a separate
 * sub-conversation the parent HUD doesn't expose (semantic decision, pinned
 * in tests). Token/cost/hourly signals are collected from EVERY file, main
 * and subagent alike (they all count toward the session's total spend).
 */
export interface FileAnatomySignals {
  sessionId: string
  isSubagent: boolean
  minTs: number | null
  maxTs: number | null
  /** Real user turns (main file only; always 0 for a subagent file). */
  turns: number
  /** Latest `/rename` custom title seen (main file only). */
  customTitle: string
  /** Latest Claude-generated auto-title seen (main file only). */
  aiTitle: string
  /** First real user message's raw text (main file only), for the title fallback. */
  firstUserText: string
  /** Max (input + cache-write + cache-read) / contextWindow over deduped assistant
   *  records, as a fraction 0..1 (NOT yet rounded to a percent). Main file only. */
  peakContextRatio: number
  requestCount: number
  tokens: TokenBreakdown
  costByModel: Record<string, number>
  estimated: boolean
  /** Per (hour, model) cost points, capped by the shell's cutoff — see usage-cost.ts. */
  hourly: HourlyCostPoint[]
}

/**
 * Fold one file's lines into {@link FileAnatomySignals}. Calls
 * `priceFileLines` (the P5 dedupe+pricing engine) once for the token/cost/
 * context signals, and a separate lightweight line-scan for turns/titles/
 * timestamps (record types `priceFileLines` doesn't look at, e.g. `user`,
 * `custom-title`). `hourlyCutoffMs` (epoch ms) drops any priced request older
 * than the cutoff from the returned `hourly` array — the shell uses this to
 * cap stored per-session hourly detail to the last 90 days (cache-size
 * sanity; semantics pinned in tests). Never throws.
 */
export function buildFileAnatomySignals(
  lines: readonly string[],
  meta: FileAnatomyMeta,
  hourlyCutoffMs = -Infinity
): FileAnatomySignals {
  let minTs: number | null = null
  let maxTs: number | null = null
  let turns = 0
  let customTitle = ''
  let aiTitle = ''
  let firstUserText = ''
  let firstUserFound = false

  for (const line of lines) {
    const info = parseAnatomyLine(line)
    if (!info) continue
    if (info.timestampMs !== null) {
      minTs = minTs === null ? info.timestampMs : Math.min(minTs, info.timestampMs)
      maxTs = maxTs === null ? info.timestampMs : Math.max(maxTs, info.timestampMs)
    }
    if (meta.isSubagent) continue // turns/titles/context are main-file-only (see doc comment)
    if (info.customTitle) customTitle = info.customTitle
    if (info.aiTitle) aiTitle = info.aiTitle
    if (info.isUserTurn) {
      turns++
      if (!firstUserFound && info.userText) {
        firstUserText = info.userText
        firstUserFound = true
      }
    }
  }

  const priced = priceFileLines(lines)
  let peakContextRatio = 0
  let tokens = emptyTokenBreakdown()
  let requestCount = 0
  let estimated = false
  const costByModel: Record<string, number> = {}
  const hourlyMap = new Map<string, HourlyCostPoint>()

  for (const p of priced) {
    requestCount++
    tokens = addTokens(tokens, p.tokens)
    costByModel[p.model] = (costByModel[p.model] ?? 0) + p.costUsd
    if (p.estimated) estimated = true

    if (!meta.isSubagent) {
      const window = contextWindowFor(p.model)
      const used = p.tokens.inputTokens + p.tokens.cacheWriteTokens + p.tokens.cacheReadTokens
      const ratio = used / window
      if (ratio > peakContextRatio) peakContextRatio = ratio
    }

    if (p.timestampMs >= hourlyCutoffMs) {
      const hourStartMs = Math.floor(p.timestampMs / 3_600_000) * 3_600_000
      const key = `${hourStartMs}|${p.model}`
      const existing = hourlyMap.get(key)
      if (existing) existing.costUsd += p.costUsd
      else hourlyMap.set(key, { hourStartMs, model: p.model, costUsd: p.costUsd })
    }
  }

  return {
    sessionId: meta.sessionId,
    isSubagent: meta.isSubagent,
    minTs,
    maxTs,
    turns,
    customTitle,
    aiTitle,
    firstUserText,
    peakContextRatio,
    requestCount,
    tokens,
    costByModel,
    estimated,
    hourly: [...hourlyMap.values()]
  }
}

// ---- Per-session anatomy -----------------------------------------------------

export interface SessionAnatomy {
  sessionId: string
  projectPath: string
  /** `/rename` title → Claude auto-title → first user line (truncated) → uuid prefix. */
  title: string
  startedAtMs: number | null
  endedAtMs: number | null
  durationMs: number | null
  turns: number
  requestCount: number
  subagentCount: number
  tokens: TokenBreakdown
  costByModel: Record<string, number>
  costUsd: number
  /** Rounded integer percent (0-100+, uncapped — a session CAN exceed 100% pre-compact). */
  peakContextPct: number
  estimated: boolean
}

const TITLE_MAX_LEN = 64

function truncateTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  return cleaned.length > TITLE_MAX_LEN ? cleaned.slice(0, TITLE_MAX_LEN) + '…' : cleaned
}

/**
 * Fold a session's per-file anatomy signals (1 main + N subagents, in any
 * order) into the full {@link SessionAnatomy}. Title cascade mirrors Harnu's
 * sidebar (`claude-reader.ts`'s `summary || firstPrompt || …`): explicit
 * `/rename` wins, then Claude's auto-title, then the first user message's
 * first line (de-wrappered via the SAME `firstRealPrompt` helper the sidebar
 * uses — reused, not duplicated — then re-truncated to {@link TITLE_MAX_LEN}
 * for the BI table), then the uuid prefix as the last resort.
 */
export function buildSessionAnatomy(
  fileSignals: readonly FileAnatomySignals[],
  opts: { sessionId: string; projectPath: string; subagentCount: number }
): SessionAnatomy {
  let minTs: number | null = null
  let maxTs: number | null = null
  let turns = 0
  let customTitle = ''
  let aiTitle = ''
  let firstUserText = ''
  let peakContextRatio = 0
  let requestCount = 0
  let tokens = emptyTokenBreakdown()
  const costByModel: Record<string, number> = {}
  let estimated = false

  for (const f of fileSignals) {
    if (f.minTs !== null) minTs = minTs === null ? f.minTs : Math.min(minTs, f.minTs)
    if (f.maxTs !== null) maxTs = maxTs === null ? f.maxTs : Math.max(maxTs, f.maxTs)
    if (!f.isSubagent) {
      turns += f.turns
      if (f.customTitle) customTitle = f.customTitle
      if (f.aiTitle) aiTitle = f.aiTitle
      if (!firstUserText && f.firstUserText) firstUserText = f.firstUserText
      peakContextRatio = Math.max(peakContextRatio, f.peakContextRatio)
    }
    requestCount += f.requestCount
    tokens = addTokens(tokens, f.tokens)
    for (const [model, cost] of Object.entries(f.costByModel)) {
      costByModel[model] = (costByModel[model] ?? 0) + cost
    }
    if (f.estimated) estimated = true
  }

  const costUsd = Object.values(costByModel).reduce((a, b) => a + b, 0)
  const fallbackFirstLine = firstUserText ? firstRealPrompt([firstUserText]) : ''
  const title =
    customTitle ||
    aiTitle ||
    (fallbackFirstLine ? truncateTitle(fallbackFirstLine) : '') ||
    opts.sessionId.slice(0, 8)

  return {
    sessionId: opts.sessionId,
    projectPath: opts.projectPath,
    title,
    startedAtMs: minTs,
    endedAtMs: maxTs,
    durationMs: minTs !== null && maxTs !== null ? maxTs - minTs : null,
    turns,
    requestCount,
    subagentCount: opts.subagentCount,
    tokens,
    costByModel,
    costUsd,
    peakContextPct: Math.round(peakContextRatio * 100),
    estimated
  }
}

// ---- Daily model breakdown ---------------------------------------------------

export interface DayModelBreakdown {
  day: string
  costByModel: Record<string, number>
  dominantModel: string | null
}

/**
 * Fold merged `CostBucket[]` (already produced by the P5 engine) into a
 * per-day cost-by-model map + the day's dominant (highest-cost) model. Pure
 * re-aggregation of data the engine already computed — no re-parse.
 */
export function buildDailyModelBreakdown(buckets: readonly CostBucket[]): DayModelBreakdown[] {
  const byDay = new Map<string, Record<string, number>>()
  for (const b of buckets) {
    let m = byDay.get(b.day)
    if (!m) {
      m = {}
      byDay.set(b.day, m)
    }
    m[b.model] = (m[b.model] ?? 0) + b.costUsd
  }
  return [...byDay.entries()]
    .map(([day, costByModel]) => {
      let dominantModel: string | null = null
      let best = -1
      for (const [model, cost] of Object.entries(costByModel)) {
        if (cost > best) {
          dominantModel = model
          best = cost
        }
      }
      return { day, costByModel, dominantModel }
    })
    .sort((a, b) => a.day.localeCompare(b.day))
}

// ---- Window enrichment --------------------------------------------------------

/** One priced hour, attributed to a session (the window-enrichment join input). */
export interface SessionHourlyPoint extends HourlyCostPoint {
  sessionId: string
}

export interface EnrichedWindowSession {
  sessionId: string
  title?: string
  costUsd: number
}

export interface EnrichedWindow extends WindowRecord {
  /** Σ cost of every hourly bucket whose hour-start fell inside this window's span. */
  costDeltaUsd: number
  /** Top 5 sessions by cost within the span. */
  sessionsActive: EnrichedWindowSession[]
  /** Highest-cost model within the span, or `null` when the span has no priced cost. */
  dominantModel: string | null
}

const TOP_SESSIONS_PER_WINDOW = 5

/**
 * Join hourly (session, model) cost points against closed rate-limit windows:
 * "which sessions burned this 5h window". Attribution rule (pinned): an
 * hourly bucket belongs to a window when its hour-START falls in
 * `[window.startedAtMs, window.resetsAtMs)` — a HALF-OPEN interval, so a
 * bucket is never double-counted across two adjacent windows. This means
 * that at either edge, a bucket whose hour spans the boundary attributes
 * its WHOLE hour's cost to whichever window contains its start — up to ~1h
 * of edge imprecision, accepted (matches the `partial`-window imprecision
 * already accepted elsewhere in the usage-history engine).
 */
export function enrichWindows(
  windows: readonly WindowRecord[],
  hourlyPoints: readonly SessionHourlyPoint[],
  titleBySession?: ReadonlyMap<string, string>
): EnrichedWindow[] {
  return windows.map((w) => {
    let costDeltaUsd = 0
    const bySession = new Map<string, number>()
    const byModel = new Map<string, number>()
    for (const p of hourlyPoints) {
      if (p.hourStartMs < w.startedAtMs || p.hourStartMs >= w.resetsAtMs) continue
      costDeltaUsd += p.costUsd
      bySession.set(p.sessionId, (bySession.get(p.sessionId) ?? 0) + p.costUsd)
      byModel.set(p.model, (byModel.get(p.model) ?? 0) + p.costUsd)
    }
    const sessionsActive: EnrichedWindowSession[] = [...bySession.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_SESSIONS_PER_WINDOW)
      .map(([sessionId, costUsd]) => ({
        sessionId,
        title: titleBySession?.get(sessionId),
        costUsd
      }))
    let dominantModel: string | null = null
    let dominantCost = -1
    for (const [model, cost] of byModel) {
      if (cost > dominantCost) {
        dominantModel = model
        dominantCost = cost
      }
    }
    return { ...w, costDeltaUsd, sessionsActive, dominantModel }
  })
}

/**
 * Mirrors the renderer's `usage-history-format.ts#projectWindowPeak` (a
 * process-boundary duplicate, not an import — `src/main/` must not depend on
 * `src/renderer/`, see CLAUDE.md). Linear projection of where a still-open
 * window will land at reset, from its elapsed fraction. `< 10%` elapsed is
 * treated as too noisy to project (mirrors the renderer's guard).
 */
export function projectWindowPeak(
  currentPct: number,
  resetsAtMs: number | null,
  nowMs: number,
  durationMs: number = WINDOW_DURATION_MS.fiveHour
): number | null {
  if (resetsAtMs === null) return null
  const elapsed = nowMs - (resetsAtMs - durationMs)
  if (elapsed <= 0) return currentPct
  const frac = Math.min(1, elapsed / durationMs)
  if (frac < 0.1) return currentPct
  return currentPct / frac
}
