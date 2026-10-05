/**
 * Pure prompt-building + parsing for the "chat over usage data" layer (issue
 * #19, layer 3; extended in T47 P5 with the real cost engine's aggregates).
 * The chat runs ON DEMAND only and is fed PRE-COMPUTED rollups (a few KB),
 * never the raw JSONL — trivial token cost, grounded answers. The model only
 * narrates; all the math is deterministic (`usage-history-core.ts` +
 * `usage-cost-core.ts`). Zero electron/fs deps → `node` vitest env. The spawn
 * shell lives in `usage-history.ts`.
 */

import type { DailyRollup, PlanFitResult } from './usage-history-core'
import type {
  DailyCostRollup,
  ModelCostRollup,
  ProjectCostRollup,
  SessionCostRollup
} from './usage-cost-core'

/** System prompt: pin the model to the supplied data, plain prose, no fluff. */
export const USAGE_CHAT_SYSTEM =
  'You are a usage analyst for a Claude Code session manager. Answer ONLY from ' +
  'the JSON data block provided (daily usage rollups + a deterministic plan-fit ' +
  'projection, plus a REAL cost breakdown by day/model/project/session when the ' +
  '"realCost" field is present — computed from the actual API transcripts, not ' +
  'an estimate). The 5h/7d percentages are account-wide rate-limit usage; the ' +
  'legacy "cost" field on dailyRollups is a LOCAL, NOTIONAL figure (accumulated ' +
  'session cost, overcounts) — prefer "realCost" for spend questions when it is ' +
  'present, and say so if a model in realCost is marked "estimated" (its pricing ' +
  "isn't confirmed). Never invent numbers not in the data. If the data is " +
  'insufficient to answer, say so plainly. Reply in at most 4 short sentences, ' +
  'no markdown headers, no bullet lists unless essential.'

/** Compact real-cost aggregates (T47 P5) — capped so the block stays a few KB. */
export interface CostChatData {
  dailyCost: readonly DailyCostRollup[]
  topModels: readonly ModelCostRollup[]
  topProjects: readonly ProjectCostRollup[]
  topSessions: readonly SessionCostRollup[]
  hasEstimated: boolean
}

export interface ChatContext {
  rollups: readonly DailyRollup[]
  planFit: PlanFitResult | null
  /** Tier id the user is currently on (account-wide %s are relative to it). */
  currentTier: string
  /** As-of date string for the published plan quotas (disclaimer). */
  quotaAsOf: string
  /**
   * Real cost engine aggregates (T47 P5). Pass the FULL rollups from
   * `usageCost:summary` — this function caps/slices them itself so the prompt
   * always stays small. `undefined`/`null` when the engine has no data yet;
   * the chat still works fine on the notional rollups alone.
   */
  costData?: CostChatData | null
}

/** Cap how much of each real-cost dimension rides in the prompt (few-KB budget). */
const DAILY_COST_CAP_DAYS = 60
const TOP_MODELS_CAP = 5
const TOP_PROJECTS_CAP = 5
const TOP_SESSIONS_CAP = 5

/** Round to cents — the chat doesn't need (and shouldn't burn tokens on) sub-cent noise. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function shapeCostData(costData: CostChatData): object {
  return {
    hasEstimated: costData.hasEstimated,
    dailyCost: costData.dailyCost.slice(-DAILY_COST_CAP_DAYS).map((d) => ({
      day: d.day,
      costUsd: round2(d.costUsd),
      sessionsWorked: d.sessionsWorked,
      estimated: d.estimated
    })),
    topModels: costData.topModels.slice(0, TOP_MODELS_CAP).map((m) => ({
      model: m.model,
      costUsd: round2(m.costUsd),
      requestCount: m.requestCount,
      estimated: m.estimated
    })),
    topProjects: costData.topProjects.slice(0, TOP_PROJECTS_CAP).map((p) => ({
      projectPath: p.projectPath,
      costUsd: round2(p.costUsd),
      sessionCount: p.sessionCount
    })),
    topSessions: costData.topSessions.slice(0, TOP_SESSIONS_CAP).map((s) => ({
      sessionId: s.sessionId,
      projectPath: s.projectPath,
      costUsd: round2(s.costUsd)
    }))
  }
}

/**
 * Build the user prompt: a compact JSON data block + the question. The rollups
 * are already aggregated, so even months of history stay within a few KB; the
 * real-cost dimensions (when present) are additionally capped by
 * {@link shapeCostData} so a large `~/.claude/projects/` tree never balloons
 * the prompt.
 */
export function buildUsageChatPrompt(question: string, ctx: ChatContext): string {
  const q = question.trim()
  if (!q) return ''
  const data = {
    currentTier: ctx.currentTier,
    quotaAsOf: ctx.quotaAsOf,
    dailyRollups: ctx.rollups,
    planFit: ctx.planFit,
    realCost: ctx.costData ? shapeCostData(ctx.costData) : null
  }
  return (
    'DATA (JSON):\n' +
    JSON.stringify(data) +
    '\n\nQUESTION:\n' +
    q +
    '\n\nAnswer from the DATA only.'
  )
}

/** Clean the model stdout into a single trimmed answer. Never throws. */
export function parseUsageChatAnswer(stdout: string): string {
  return stdout.replace(/\r/g, '').trim()
}
