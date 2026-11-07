/**
 * T654 AC-5 / AC-6 — the owner-transfer verbs are a recovery path for the OWNER session only.
 * Both deny lists are derived from the tool catalog (a verb is denied until someone allows it by
 * name), so the new verbs must show up on them automatically, under both server prefixes. The
 * steward allowlist is the one trap: it admits every `mission_*` verb by prefix, so
 * `mission_transfer_owner` has to be carved out by name.
 */
import { describe, it, expect } from 'vitest'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import { OBSERVE_MCP_ALLOW, OBSERVE_MCP_DENY } from '../src/main/scheduler-core'
import {
  STEWARD_ALLOW_VERBS,
  STEWARD_MCP_ALLOW,
  STEWARD_MCP_DENY,
  stewardCallRefusal
} from '../src/main/steward-core'

const TRANSFER_VERBS = ['mission_transfer_owner', 'campaign_transfer_owner'] as const
const MISSION = 'mnt-0a0a0a0a'

describe('the transfer verbs are in the catalog', () => {
  it.each(TRANSFER_VERBS)('%s is a mutating, ungrantable catalog verb', (verb) => {
    const tool = MCP_TOOLS.find((t) => t.name === verb)
    expect(tool, `${verb} missing from MCP_TOOLS`).toBeDefined()
    expect(tool!.mutates).toBe(true)
  })
})

describe.each(TRANSFER_VERBS)('%s', (verb) => {
  it('is not on the steward allowlist (even though it starts with mission_)', () => {
    expect(STEWARD_ALLOW_VERBS).not.toContain(verb)
    expect(STEWARD_MCP_ALLOW.filter((r) => r.endsWith(`__${verb}`))).toEqual([])
  })

  it('is on the derived steward deny list under both server prefixes', () => {
    expect(STEWARD_MCP_DENY).toContain(`mcp__harnu__${verb}`)
    expect(STEWARD_MCP_DENY).toContain(`mcp__capy__${verb}`)
  })

  it('is on the derived observe deny list under both server prefixes, and never allowed', () => {
    expect(OBSERVE_MCP_DENY).toContain(`mcp__harnu__${verb}`)
    expect(OBSERVE_MCP_DENY).toContain(`mcp__capy__${verb}`)
    expect(OBSERVE_MCP_ALLOW.filter((r) => r.endsWith(`__${verb}`))).toEqual([])
  })

  it('stewardCallRefusal refuses it STEWARD_VERB_NOT_ALLOWED, on its own mission too', () => {
    expect(
      stewardCallRefusal({ op: verb, args: { missionId: MISSION }, missionId: MISSION })
    ).toMatch(/^STEWARD_VERB_NOT_ALLOWED/)
  })
})
