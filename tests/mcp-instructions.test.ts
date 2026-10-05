import { describe, it, expect } from 'vitest'
import {
  HARNU_MCP_INSTRUCTIONS_BODY,
  buildHarnuMcpInstructions
} from '../src/main/mcp/instructions'
import { memoryLanguageLine } from '../src/main/memory-language'

/**
 * T93 piece 3 — the MCP server's `InitializeResult.instructions` digest, served
 * over the native channel `claude` injects as `## harnu`. These pin the CONTRACT:
 * it must name the few verbs a session needs, teach the two "do this FIRST"
 * habits, carry the runtime app-language line, and stay a PRIMER (≤80 lines) —
 * not a copy of the full `harnu-features.md` environment doc.
 */
describe('HARNU_MCP_INSTRUCTIONS_BODY content sanity', () => {
  it('names Harnu and frames itself as the mcp__harnu verbs', () => {
    expect(HARNU_MCP_INSTRUCTIONS_BODY).toMatch(/Harnu/)
    expect(HARNU_MCP_INSTRUCTIONS_BODY).toMatch(/mcp__harnu__/)
    expect(HARNU_MCP_INSTRUCTIONS_BODY).toContain('harnu.dev')
    // The old tool prefix / domain must not leak into what the agent reads.
    expect(HARNU_MCP_INSTRUCTIONS_BODY).not.toMatch(/mcp__capy|capy\.run/)
  })

  it('teaches the memory-first habit by verb name', () => {
    for (const verb of ['memory_read', 'memory_query', 'get_fleet', 'plan_mission', 'open_file']) {
      expect(HARNU_MCP_INSTRUCTIONS_BODY, `missing ${verb}`).toContain(verb)
    }
    expect(HARNU_MCP_INSTRUCTIONS_BODY).toMatch(/memory_read[^]*FIRST/)
  })

  it('tells the agent that mutations do NOT ask — the free-by-default posture', () => {
    // The blob is the ONLY self-awareness channel for a session Harnu did not spawn,
    // so a stale "every mutation asks the operator" here would make agents park work
    // that would have just run. Pin the truth.
    expect(HARNU_MCP_INSTRUCTIONS_BODY).toMatch(/do NOT ask/i)
    expect(HARNU_MCP_INSTRUCTIONS_BODY).not.toMatch(/Mutations pass a human confirm/i)
    // The verbs that run free are named.
    for (const verb of ['create_session', 'create_worktree', 'spawn_terminal', 'memory_append']) {
      expect(HARNU_MCP_INSTRUCTIONS_BODY, `missing ${verb}`).toContain(verb)
    }
  })

  it('names the two things that can still refuse, and the two verbs that still ask', () => {
    expect(HARNU_MCP_INSTRUCTIONS_BODY).toMatch(/SERVER_DISABLED/)
    expect(HARNU_MCP_INSTRUCTIONS_BODY).toMatch(/FOLDER_NOT_ALLOWED/)
    expect(HARNU_MCP_INSTRUCTIONS_BODY).toMatch(/submit_manifest/)
    expect(HARNU_MCP_INSTRUCTIONS_BODY).toMatch(/blocked/i)
  })

  it('still explains the grant semantics for the opt-in ask mode', () => {
    expect(HARNU_MCP_INSTRUCTIONS_BODY).toMatch(/confirm/i)
    expect(HARNU_MCP_INSTRUCTIONS_BODY).toMatch(/grantBudgetRemaining/)
    expect(HARNU_MCP_INSTRUCTIONS_BODY).toMatch(/Ask before agent actions/i)
  })

  it('stays a primer — non-empty and ≤80 lines', () => {
    const lines = HARNU_MCP_INSTRUCTIONS_BODY.split('\n')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.length).toBeLessThanOrEqual(80)
    expect(HARNU_MCP_INSTRUCTIONS_BODY.trim().length).toBeGreaterThan(0)
  })
})

describe('buildHarnuMcpInstructions appends the runtime language line', () => {
  it('appends the T85 project-memory language line as the final paragraph', () => {
    const line = memoryLanguageLine('pt-BR')
    const out = buildHarnuMcpInstructions(line)
    expect(out.startsWith(HARNU_MCP_INSTRUCTIONS_BODY)).toBe(true)
    expect(out.endsWith(line)).toBe(true)
    expect(out).toContain('Portuguese (Brazil)')
  })

  it('names English for the en locale', () => {
    const out = buildHarnuMcpInstructions(memoryLanguageLine('en'))
    expect(out).toContain('English')
  })

  it('degrades to the bare body when the language line is blank', () => {
    expect(buildHarnuMcpInstructions('')).toBe(HARNU_MCP_INSTRUCTIONS_BODY)
    expect(buildHarnuMcpInstructions('   ')).toBe(HARNU_MCP_INSTRUCTIONS_BODY)
  })

  it('the assembled instructions still fit a primer budget (≤80 lines)', () => {
    const out = buildHarnuMcpInstructions(memoryLanguageLine('en'))
    expect(out.split('\n').length).toBeLessThanOrEqual(80)
  })
})
