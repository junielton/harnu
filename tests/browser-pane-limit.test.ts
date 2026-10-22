/**
 * T574 (browser pane U7, AC-3) — the agent pane cap (spec §10.1, decision 28): 4 agent-opened panes per folder, the
 * 5th `browser_open` refuses `PANE_LIMIT` at PLAN level (before any confirm) with the reusable panes in
 * `nextActions`; operator-opened panes are unlimited.
 */
import { describe, expect, it } from 'vitest'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { shapeDenial } from '../src/main/mcp/deny-hint'
import { gateBrowserOpDetailed, type BrowserGateInput } from '../src/main/browser/access'
import { resolveGateInput } from '../src/main/browser/gate-resolve'
import { MAX_AGENT_PANES_PER_FOLDER, createBrowserRegistry } from '../src/main/browser/registry'

const FOLDER = '/work/app'
const policy = (ask: boolean): Parameters<typeof planToolCall>[0]['policy'] => ({
  serverEnabled: true,
  ask,
  denyFolders: [],
  knownRoots: ['/work']
})
const open = (args: Record<string, unknown>, browser: BrowserGateInput, ask: boolean) =>
  planToolCall({
    tool: 'browser_open',
    input: buildPlanInput('browser_open', { folder: FOLDER, ...args }, FOLDER),
    policy: policy(ask),
    now: 1,
    browser
  })
const held = (n: number): string[] => Array.from({ length: n }, (_, i) => `bp-${i + 1}`)
const input = (agentPaneIds?: string[]): BrowserGateInput => ({
  pane: undefined,
  writesEnabled: true,
  ...(agentPaneIds ? { agentPaneIds } : {})
})

describe('the cap is 4', () => {
  it('is one named constant', () => {
    expect(MAX_AGENT_PANES_PER_FOLDER).toBe(4)
  })
})

describe.each([false, true])('browser_open at the cap, plan level, ask=%s', (ask) => {
  const never = { verdict: 'deny', shouldConfirm: false, shouldDispatch: false } as const

  it('lets the first four through the plan', () => {
    for (let n = 0; n < 4; n++) {
      const plan = open({ url: 'http://localhost:3000' }, input(held(n)), ask)
      expect(plan.auditRecord.result, `with ${n} held`).not.toMatch(/PANE_LIMIT/)
    }
  })

  it('refuses the fifth with the reusable panes, and never confirms', () => {
    const plan = open({ url: 'http://localhost:3009' }, input(held(4)), ask)
    expect(plan).toMatchObject(never)
    expect(plan.auditRecord.result).toBe('PANE_LIMIT: bp-1,bp-2,bp-3,bp-4')
    const hint = shapeDenial(plan.auditRecord.result, { folder: FOLDER })
    expect(hint?.error).toBe('PANE_LIMIT')
    const text = JSON.stringify(hint?.nextActions)
    for (const id of held(4)) expect(text).toContain(id)
  })

  it('does not judge the cap when the held panes are unknown (the verb judges it again)', () => {
    const plan = open({ url: 'http://localhost:3009' }, input(), ask)
    expect(plan.auditRecord.result).not.toMatch(/PANE_LIMIT/)
  })

  it('leaves the path and html forms to the verb, which may reuse a pane already showing the file', () => {
    for (const args of [{ path: 'docs/a.html' }, { html: '<p>x</p>', name: 'p' }]) {
      const plan = open(args, input(held(4)), ask)
      expect(plan.auditRecord.result, JSON.stringify(args)).not.toMatch(/PANE_LIMIT/)
    }
  })

  it('a content refusal still comes first, and the kill-switch before the cap', () => {
    expect(open({ url: 'javascript:alert(1)' }, input(held(4)), ask).auditRecord.result).toBe(
      'URL_SCHEME_BLOCKED'
    )
    const off: BrowserGateInput = { pane: undefined, writesEnabled: false, agentPaneIds: held(4) }
    expect(open({ url: 'http://localhost:3000' }, off, ask).auditRecord.result).toBe(
      'BROWSER_WRITES_DISABLED'
    )
  })
})

describe('the gate itself', () => {
  it('names the panes to reuse on the refusal', () => {
    const refusal = gateBrowserOpDetailed('browser_open', {
      pane: undefined,
      writesEnabled: true,
      args: { folder: FOLDER, url: 'http://localhost:1' },
      agentPaneIds: held(4)
    })
    expect(refusal).toEqual({ reason: 'PANE_LIMIT', reusablePaneIds: held(4) })
  })

  it('only browser_open is capped', () => {
    for (const op of ['browser_list', 'browser_navigate'] as const) {
      const r = gateBrowserOpDetailed(op, {
        pane: undefined,
        writesEnabled: true,
        agentPaneIds: held(9)
      })
      expect(r?.reason).not.toBe('PANE_LIMIT')
    }
  })
})

describe('what counts toward the cap', () => {
  const rec = (paneId: string, openedBy: 'agent' | 'operator', folder = FOLDER) => ({
    paneId,
    folder,
    name: paneId,
    openedBy,
    partition: openedBy,
    ownerSessionId: null,
    createdAt: Number(paneId.replace(/\D/g, '')) || 1,
    lastActiveAt: 1,
    seenHosts: new Set<string>(),
    flagged: null
  })

  it('counts only agent-opened panes of the folder: operator panes are unlimited', () => {
    const reg = createBrowserRegistry(() => 1)
    for (let i = 1; i <= 12; i++) reg.add(rec(`op-${i}`, 'operator'))
    for (let i = 1; i <= 3; i++) reg.add(rec(`bp-${i}`, 'agent'))
    reg.add(rec('bp-9', 'agent', '/work/other'))
    expect(reg.agentPanesIn(FOLDER).map((p) => p.paneId)).toEqual(['bp-1', 'bp-2', 'bp-3'])
    expect(reg.agentPanesIn('/work/other')).toHaveLength(1)
  })

  it('resolves the held panes into the plan-level gate input for browser_open', () => {
    const resolved = resolveGateInput({
      rec: undefined,
      liveUrl: '',
      writesEnabled: true,
      disconnected: false,
      paused: false,
      harnuPorts: [],
      trustedHosts: [],
      agentPaneIds: held(4)
    })
    expect(resolved.input.agentPaneIds).toEqual(held(4))
  })
})
