import { describe, it, expect } from 'vitest'
import {
  buildUsageChatPrompt,
  parseUsageChatAnswer,
  USAGE_CHAT_SYSTEM,
  type ChatContext,
  type CostChatData
} from '../src/main/usage-history-chat'
import type {
  DailyCostRollup,
  ModelCostRollup,
  ProjectCostRollup,
  SessionCostRollup
} from '../src/main/usage-cost-core'

function baseCtx(over: Partial<ChatContext> = {}): ChatContext {
  return {
    rollups: [],
    planFit: null,
    currentTier: 'max20',
    quotaAsOf: '2026-01-01',
    ...over
  }
}

function dailyCost(over: Partial<DailyCostRollup> = {}): DailyCostRollup {
  return {
    day: '2026-07-01',
    costUsd: 12.3456,
    requestCount: 10,
    tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 },
    webSearchRequests: 0,
    sessionsWorked: 2,
    estimated: false,
    ...over
  }
}

function modelRow(over: Partial<ModelCostRollup> = {}): ModelCostRollup {
  return {
    model: 'claude-sonnet-4-6',
    tierLabel: 'sonnet-3.5-4.6',
    estimated: false,
    costUsd: 5.6789,
    requestCount: 20,
    tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 },
    ...over
  }
}

function projectRow(over: Partial<ProjectCostRollup> = {}): ProjectCostRollup {
  return {
    projectPath: '/home/user/proj',
    costUsd: 3.14159,
    requestCount: 5,
    sessionCount: 2,
    estimated: false,
    ...over
  }
}

function sessionRow(over: Partial<SessionCostRollup> = {}): SessionCostRollup {
  return {
    sessionId: 'sess-abc',
    projectPath: '/home/user/proj',
    costUsd: 1.2345,
    requestCount: 3,
    firstDay: '2026-07-01',
    lastDay: '2026-07-02',
    estimated: false,
    ...over
  }
}

describe('buildUsageChatPrompt — base behavior (unaffected without costData)', () => {
  it('returns empty string for a blank question', () => {
    expect(buildUsageChatPrompt('   ', baseCtx())).toBe('')
  })

  it('includes realCost: null when costData is absent', () => {
    const prompt = buildUsageChatPrompt('How much did I spend?', baseCtx())
    const json = JSON.parse(prompt.split('DATA (JSON):\n')[1].split('\n\nQUESTION:')[0])
    expect(json.realCost).toBeNull()
  })

  it('includes realCost: null when costData is explicitly null', () => {
    const prompt = buildUsageChatPrompt('q', baseCtx({ costData: null }))
    const json = JSON.parse(prompt.split('DATA (JSON):\n')[1].split('\n\nQUESTION:')[0])
    expect(json.realCost).toBeNull()
  })
})

describe('buildUsageChatPrompt — real cost data (T47 P5)', () => {
  function extractRealCost(prompt: string): {
    hasEstimated: boolean
    dailyCost: Array<{ day: string; costUsd: number; sessionsWorked: number; estimated: boolean }>
    topModels: Array<{ model: string; costUsd: number; requestCount: number; estimated: boolean }>
    topProjects: Array<{ projectPath: string; costUsd: number; sessionCount: number }>
    topSessions: Array<{ sessionId: string; projectPath: string; costUsd: number }>
  } {
    const json = JSON.parse(prompt.split('DATA (JSON):\n')[1].split('\n\nQUESTION:')[0])
    return json.realCost
  }

  it('shapes dailyCost/topModels/topProjects/topSessions into the prompt', () => {
    const costData: CostChatData = {
      dailyCost: [dailyCost()],
      topModels: [modelRow()],
      topProjects: [projectRow()],
      topSessions: [sessionRow()],
      hasEstimated: false
    }
    const prompt = buildUsageChatPrompt('q', baseCtx({ costData }))
    const realCost = extractRealCost(prompt)
    expect(realCost.hasEstimated).toBe(false)
    expect(realCost.dailyCost).toHaveLength(1)
    expect(realCost.dailyCost[0].day).toBe('2026-07-01')
    expect(realCost.topModels[0].model).toBe('claude-sonnet-4-6')
    expect(realCost.topProjects[0].projectPath).toBe('/home/user/proj')
    expect(realCost.topSessions[0].sessionId).toBe('sess-abc')
  })

  it('rounds costUsd to cents (no sub-cent token noise)', () => {
    const costData: CostChatData = {
      dailyCost: [dailyCost({ costUsd: 12.3456789 })],
      topModels: [modelRow({ costUsd: 5.6789123 })],
      topProjects: [projectRow({ costUsd: 3.14159265 })],
      topSessions: [sessionRow({ costUsd: 1.23456 })],
      hasEstimated: false
    }
    const prompt = buildUsageChatPrompt('q', baseCtx({ costData }))
    const realCost = extractRealCost(prompt)
    expect(realCost.dailyCost[0].costUsd).toBe(12.35)
    expect(realCost.topModels[0].costUsd).toBe(5.68)
    expect(realCost.topProjects[0].costUsd).toBe(3.14)
    expect(realCost.topSessions[0].costUsd).toBe(1.23)
  })

  it('caps topModels/topProjects/topSessions to 5 each (few-KB budget)', () => {
    const many = (n: number, factory: (i: number) => object): object[] =>
      Array.from({ length: n }, (_, i) => factory(i))
    const costData: CostChatData = {
      dailyCost: [],
      topModels: many(12, (i) => modelRow({ model: `model-${i}` })) as ModelCostRollup[],
      topProjects: many(12, (i) => projectRow({ projectPath: `/p${i}` })) as ProjectCostRollup[],
      topSessions: many(12, (i) => sessionRow({ sessionId: `s${i}` })) as SessionCostRollup[],
      hasEstimated: false
    }
    const prompt = buildUsageChatPrompt('q', baseCtx({ costData }))
    const realCost = extractRealCost(prompt)
    expect(realCost.topModels).toHaveLength(5)
    expect(realCost.topProjects).toHaveLength(5)
    expect(realCost.topSessions).toHaveLength(5)
  })

  it('caps dailyCost to the most recent 60 days (few-KB budget over long retention)', () => {
    const days = Array.from({ length: 120 }, (_, i) =>
      dailyCost({ day: `2026-01-${String((i % 28) + 1).padStart(2, '0')}-${i}` })
    )
    const costData: CostChatData = {
      dailyCost: days,
      topModels: [],
      topProjects: [],
      topSessions: [],
      hasEstimated: false
    }
    const prompt = buildUsageChatPrompt('q', baseCtx({ costData }))
    const realCost = extractRealCost(prompt)
    expect(realCost.dailyCost).toHaveLength(60)
    // Keeps the TAIL (most recent), not the head.
    expect(realCost.dailyCost[realCost.dailyCost.length - 1].day).toBe(days[days.length - 1].day)
  })

  it('propagates the estimated flag per row and overall', () => {
    const costData: CostChatData = {
      dailyCost: [dailyCost({ estimated: true })],
      topModels: [modelRow({ estimated: true })],
      topProjects: [projectRow()],
      topSessions: [sessionRow()],
      hasEstimated: true
    }
    const prompt = buildUsageChatPrompt('q', baseCtx({ costData }))
    const realCost = extractRealCost(prompt)
    expect(realCost.hasEstimated).toBe(true)
    expect(realCost.dailyCost[0].estimated).toBe(true)
    expect(realCost.topModels[0].estimated).toBe(true)
  })

  it('keeps the notional dailyRollups field untouched alongside realCost', () => {
    const prompt = buildUsageChatPrompt(
      'q',
      baseCtx({
        rollups: [
          {
            day: '2026-07-01',
            sampleCount: 3,
            fiveHourPeak: 44,
            sevenDayPeak: 60,
            costPeakUsd: 16.3,
            sessionPeak: 4
          }
        ]
      })
    )
    const json = JSON.parse(prompt.split('DATA (JSON):\n')[1].split('\n\nQUESTION:')[0])
    expect(json.dailyRollups).toHaveLength(1)
    expect(json.dailyRollups[0].costPeakUsd).toBe(16.3)
  })
})

describe('system prompt + answer parsing', () => {
  it('the system prompt mentions realCost takes precedence over the notional figure', () => {
    expect(USAGE_CHAT_SYSTEM).toMatch(/realCost/)
    expect(USAGE_CHAT_SYSTEM).toMatch(/notional/i)
  })

  it('parseUsageChatAnswer trims and strips carriage returns', () => {
    expect(parseUsageChatAnswer('  hello\r\nworld  \r\n')).toBe('hello\nworld')
  })
})
