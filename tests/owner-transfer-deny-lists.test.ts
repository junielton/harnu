/**
 * T654 AC-5 / AC-6 — the owner-transfer verbs are a recovery path for the OWNER session only.
 * Both deny lists are derived from the tool catalog (a verb is denied until someone allows it by
 * name), so the new verbs must show up on them automatically, under both server prefixes.
 * (A steward allowlist used to be the one trap here, admitting every `mission_*` verb by prefix; it
 * is gone with the steward, Missions v4 S-38.)
 */
import { describe, it, expect } from 'vitest'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import { OBSERVE_MCP_ALLOW, OBSERVE_MCP_DENY } from '../src/main/scheduler-core'

const TRANSFER_VERBS = ['mission_transfer_owner'] as const

describe('the transfer verbs are in the catalog', () => {
  it.each(TRANSFER_VERBS)('%s is a mutating, ungrantable catalog verb', (verb) => {
    const tool = MCP_TOOLS.find((t) => t.name === verb)
    expect(tool, `${verb} missing from MCP_TOOLS`).toBeDefined()
    expect(tool!.mutates).toBe(true)
  })
})

describe.each(TRANSFER_VERBS)('%s', (verb) => {
  it('is on the derived observe deny list under both server prefixes, and never allowed', () => {
    expect(OBSERVE_MCP_DENY).toContain(`mcp__harnu__${verb}`)
    expect(OBSERVE_MCP_DENY).toContain(`mcp__capy__${verb}`)
    expect(OBSERVE_MCP_ALLOW.filter((r) => r.endsWith(`__${verb}`))).toEqual([])
  })
})
