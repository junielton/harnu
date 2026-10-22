/**
 * T571 (browser pane U4, AC-1) — every cell of the §7.1 tier table, in the pure access gate and at plan level:
 * verb class × origin class × who opened the pane, `free` / `lease` / `refused`, with the read opt-in, the Deny
 * cooldown, "Ask before agent actions" and the per-writer matrix of §7.3.
 */
import { describe, it, expect } from 'vitest'
import {
  BROWSER_OPS,
  browserTier,
  gateBrowserOp,
  gateBrowserOpDetailed,
  isBrowserWriteOp,
  type BrowserOp,
  type BrowserPaneAccess,
  type BrowserTier
} from '../src/main/browser/access'
import type { OriginClass } from '../src/main/browser/origin-class'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { toolByName } from '../src/main/mcp/tool-catalog'

const pane = (over: Partial<BrowserPaneAccess> = {}): BrowserPaneAccess => ({
  openedBy: 'agent',
  originClass: 'local',
  disconnected: false,
  paused: false,
  readOptIn: false,
  leaseActive: false,
  writeDenied: false,
  ...over
})

type Cell = [
  op: BrowserOp,
  args: Record<string, unknown>,
  agent: Record<OriginClass, BrowserTier>,
  operator: BrowserTier
]
const all = (t: BrowserTier): Record<OriginClass, BrowserTier> => ({
  page: t,
  local: t,
  external: t,
  blank: t
})
const extLease = (): Record<OriginClass, BrowserTier> => ({
  page: 'free',
  local: 'free',
  external: 'lease',
  blank: 'free'
})

/** The §7.1 table: one row per verb (with the arguments that decide it), the agent-pane columns, the operator column. */
const TABLE: Cell[] = [
  ['browser_navigate', { url: 'http://x.test/' }, all('free'), 'lease'],
  ['browser_network', { action: 'start' }, extLease(), 'lease'],
  ['browser_network', { action: 'read' }, extLease(), 'lease'],
  ['browser_network', { action: 'stop' }, all('free'), 'free'],
  ['browser_eval', {}, extLease(), 'lease'],
  ['browser_click', {}, extLease(), 'lease'],
  ['browser_type', {}, extLease(), 'lease'],
  ['browser_fill', {}, extLease(), 'lease'],
  ['browser_press', {}, extLease(), 'lease'],
  ['browser_upload', {}, extLease(), 'lease'],
  ['browser_emulate', {}, all('free'), 'lease'],
  ['browser_download', { url: 'https://x.test/f' }, all('free'), 'lease'],
  // By `ref` it clicks the element: the Input tier, a lease on an external page (Q4, T572 delta 1).
  ['browser_download', { ref: 's1e1' }, extLease(), 'lease'],
  ['browser_close', {}, all('free'), 'lease'],
  [
    'browser_set_data',
    {},
    { page: 'free', local: 'refused', external: 'refused', blank: 'refused' },
    'refused'
  ],
  [
    'browser_patch',
    {},
    { page: 'free', local: 'refused', external: 'refused', blank: 'refused' },
    'refused'
  ]
]
const CLASSES: OriginClass[] = ['page', 'local', 'external', 'blank']

describe('browserTier — every cell of the §7.1 table', () => {
  for (const [op, args, agent, operator] of TABLE) {
    for (const cls of CLASSES) {
      it(`${op} ${JSON.stringify(args)} on an agent pane showing a ${cls} page is ${agent[cls]}`, () => {
        expect(browserTier(op, pane({ originClass: cls }), args)).toBe(agent[cls])
      })
      if (op !== 'browser_network' || args.action !== 'stop') {
        it(`${op} ${JSON.stringify(args)} on an operator pane showing a ${cls} page is ${
          op === 'browser_set_data' || op === 'browser_patch'
            ? cls === 'page'
              ? 'free'
              : 'refused'
            : operator
        }`, () => {
          const expected =
            op === 'browser_set_data' || op === 'browser_patch'
              ? cls === 'page'
                ? 'free'
                : 'refused'
              : operator
          expect(browserTier(op, pane({ openedBy: 'operator', originClass: cls }), args)).toBe(
            expected
          )
        })
      }
    }
  }

  it('open, list and the read verbs are free everywhere (an operator pane’s reads are the opt-in gate, not a lease)', () => {
    for (const op of [
      'browser_open',
      'browser_list',
      'browser_snapshot',
      'browser_screenshot',
      'browser_console',
      'browser_wait_for'
    ] as const) {
      expect(browserTier(op, pane({ openedBy: 'operator', originClass: 'external' })), op).toBe(
        'free'
      )
      expect(browserTier(op, undefined), op).toBe('free')
    }
  })

  it('covers every write verb the spec names: nothing in BROWSER_OPS is silently unclassified', () => {
    const tabled = new Set(TABLE.map(([op]) => op))
    for (const op of BROWSER_OPS) {
      if (!isBrowserWriteOp(op)) continue
      if (op === 'browser_open') continue
      expect(tabled.has(op), op).toBe(true)
    }
  })
})

describe('the gate around the tier', () => {
  const run = (op: BrowserOp, p: BrowserPaneAccess, extra: object = {}): string | null =>
    gateBrowserOp(op, { pane: p, writesEnabled: true, ...extra })

  it('a lease row without a lease is not a refusal for the plan (it becomes the confirm) but is for the handler', () => {
    const ext = pane({ originClass: 'external' })
    expect(run('browser_click', ext)).toBeNull()
    expect(run('browser_click', ext, { enforceLease: true })).toBe('BROWSER_LEASE_ENDED')
    expect(run('browser_click', { ...ext, leaseActive: true }, { enforceLease: true })).toBeNull()
  })

  it('the Deny cooldown refuses a lease row only, and outranks an active lease being absent', () => {
    expect(run('browser_eval', pane({ originClass: 'external', writeDenied: true }))).toBe(
      'BROWSER_WRITE_DENIED'
    )
    expect(run('browser_eval', pane({ originClass: 'local', writeDenied: true }))).toBeNull()
  })

  it('a refused row is NOT_A_PAGE_PANE, never a lease', () => {
    expect(run('browser_set_data', pane({ originClass: 'external' }))).toBe('NOT_A_PAGE_PANE')
    expect(run('browser_patch', pane({ originClass: 'page' }))).toBeNull()
  })

  it('an operator pane needs the folder opt-in for every pane-addressed verb but browser_set_data, before content and the kill-switch', () => {
    const op = pane({ openedBy: 'operator' })
    for (const verb of [
      'browser_click',
      'browser_navigate',
      'browser_close',
      'browser_snapshot',
      'browser_patch'
    ] as const) {
      expect(run(verb, op), verb).toBe('BROWSER_READ_NOT_ENABLED')
      expect(run(verb, op, { writesEnabled: false }), verb).toBe('BROWSER_READ_NOT_ENABLED')
    }
    expect(run('browser_snapshot', { ...op, readOptIn: true })).toBeNull()
    // set_data only writes the sidecar: exempt. patch can run script and reports what matched: not exempt.
    const page = pane({ openedBy: 'operator', originClass: 'page' })
    expect(run('browser_set_data', page)).toBeNull()
    expect(run('browser_patch', page)).toBe('BROWSER_READ_NOT_ENABLED')
    expect(run('browser_patch', { ...page, readOptIn: true })).toBeNull()
    expect(run('browser_list', undefined)).toBeNull()
  })

  it('keeps the documented order: pane → Disconnect → opt-in → content → kill-switch → Pause → tier', () => {
    const base = pane({
      openedBy: 'operator',
      readOptIn: true,
      originClass: 'external',
      paused: true,
      writeDenied: true
    })
    const r = (over: Partial<BrowserPaneAccess>, input: object = {}): string | null =>
      gateBrowserOp('browser_press', {
        pane: { ...base, ...over },
        writesEnabled: true,
        args: { keys: ['Banana'] },
        ...input
      })
    expect(r({ disconnected: true })).toBe('BROWSER_DISCONNECTED')
    expect(r({ readOptIn: false })).toBe('BROWSER_READ_NOT_ENABLED')
    expect(r({})).toBe('BROWSER_KEY_UNKNOWN') // content outranks the kill-switch, Pause and the tier
    expect(
      gateBrowserOp('browser_press', {
        pane: base,
        writesEnabled: false,
        args: { keys: ['Enter'] }
      })
    ).toBe('BROWSER_WRITES_DISABLED')
    expect(
      gateBrowserOp('browser_press', { pane: base, writesEnabled: true, args: { keys: ['Enter'] } })
    ).toBe('BROWSER_PAUSED')
    expect(
      gateBrowserOp('browser_press', {
        pane: { ...base, paused: false },
        writesEnabled: true,
        args: { keys: ['Enter'] }
      })
    ).toBe('BROWSER_WRITE_DENIED')
  })

  it('carries the offending key in the detail', () => {
    const d = gateBrowserOpDetailed('browser_press', {
      pane: pane(),
      writesEnabled: true,
      args: { keys: ['Banana'] }
    })
    expect(d?.content?.detail).toContain('"Banana" is not a key')
  })
})

describe('at plan level: free mode and "Ask before agent actions"', () => {
  const policy = (ask: boolean): Parameters<typeof planToolCall>[0]['policy'] => ({
    serverEnabled: true,
    ask,
    denyFolders: [],
    knownRoots: ['/work']
  })
  const plan = (
    tool: string,
    args: Record<string, unknown>,
    p: BrowserPaneAccess,
    ask: boolean
  ): ReturnType<typeof planToolCall> =>
    planToolCall({
      tool,
      input: buildPlanInput(tool, { paneId: 'bp-1', ...args }, '/work/app'),
      policy: policy(ask),
      now: 1,
      browser: { pane: p, writesEnabled: true }
    })
  const ARGS: Record<string, Record<string, unknown>> = {
    browser_eval: { expression: '1' },
    browser_click: { ref: 's1e1' },
    browser_type: { text: 'x' },
    browser_fill: { fields: [{ ref: 's1e1', value: 'x' }] },
    browser_press: { keys: ['Enter'] }
  }

  for (const op of Object.keys(ARGS)) {
    it(`${op}: free on a local pane (free mode), a normal confirm in ask mode`, () => {
      expect(plan(op, ARGS[op]!, pane(), false)).toMatchObject({
        verdict: 'allow',
        shouldDispatch: true,
        silentAllowInAgentFolder: true
      })
      const asked = plan(op, ARGS[op]!, pane(), true)
      expect(asked).toMatchObject({ verdict: 'confirm', shouldConfirm: true })
      expect(asked.browserLeaseConfirm).toBeUndefined()
    })

    it(`${op}: a lease row on an external page confirms in BOTH modes and is a lease confirm`, () => {
      for (const ask of [false, true]) {
        const p = plan(op, ARGS[op]!, pane({ originClass: 'external' }), ask)
        expect(p, `ask=${ask}`).toMatchObject({ verdict: 'confirm', shouldConfirm: true })
        expect(p.browserLeaseConfirm).toEqual({ paneId: 'bp-1' })
        expect(p.grantAllow).toBeUndefined()
      }
    })

    it(`${op}: with the lease active a lease row runs (free: silent-allow; ask: browserLeaseAllow), audited LEASE`, () => {
      const leased = pane({ originClass: 'external', leaseActive: true })
      const free = plan(op, ARGS[op]!, leased, false)
      expect(free).toMatchObject({ verdict: 'allow', shouldDispatch: true })
      expect(free.auditRecord.result).toBe('LEASE: bp-1')
      const ask = plan(op, ARGS[op]!, leased, true)
      expect(ask).toMatchObject({ verdict: 'allow', shouldDispatch: true })
      expect(ask.browserLeaseAllow).toEqual({ paneId: 'bp-1' })
      expect(ask.auditRecord.result).toBe('LEASE: bp-1')
    })

    it(`${op}: an operator pane is a lease row for any class, and refused without the opt-in`, () => {
      const op1 = plan(op, ARGS[op]!, pane({ openedBy: 'operator', readOptIn: true }), false)
      expect(op1).toMatchObject({ verdict: 'confirm' })
      expect(op1.browserLeaseConfirm).toBeDefined()
      const noOptIn = plan(op, ARGS[op]!, pane({ openedBy: 'operator' }), true)
      expect(noOptIn).toMatchObject({ verdict: 'deny', shouldConfirm: false })
      expect(noOptIn.auditRecord.result).toBe('BROWSER_READ_NOT_ENABLED')
    })
  }

  it('the audit line for a script or typed text is scrubbed, escaped and cut to 200 characters (spec §7.5)', () => {
    const secret =
      "fetch('/x', {headers:{Authorization:'Bearer abcdefghijklmnopqrstuvwxyz0123456789'}})"
    const scrubbed = plan('browser_eval', { expression: secret }, pane(), false)
    expect(scrubbed.auditRecord.disclosedPayloadSummary).toContain(
      'browser_eval pane=bp-1 origin=local'
    )
    expect(scrubbed.auditRecord.disclosedPayloadSummary).not.toContain(
      'abcdefghijklmnopqrstuvwxyz0123456789'
    )
    const long = plan('browser_eval', { expression: `x = ${'y'.repeat(400)}` }, pane(), false)
    const line = long.auditRecord.disclosedPayloadSummary
    expect(line.length).toBeLessThan(330)
    expect(line).toContain('…')
    const typed = plan('browser_type', { text: 'a\nb"c\u202e', ref: 's1e1' }, pane(), false)
    expect(typed.auditRecord.disclosedPayloadSummary).toContain('text="a\\nb\\"c\\u{202e}"')
  })

  it('the host and class are audited, never the path or query', () => {
    const p = plan('browser_click', { ref: 's1e1' }, pane({ originClass: 'external' }), false)
    expect(p.auditRecord.disclosedPayloadSummary).toBe(
      'browser_click pane=bp-1 origin=external ref=s1e1'
    )
  })
})

describe('the per-writer matrix (§7.3)', () => {
  it('the gate does not know who writes: session, mod and act worker are the same tier by construction', () => {
    // `gateBrowserOp` has no writer argument; two calls with the same input are the same call.
    const input = { pane: pane({ originClass: 'external' }), writesEnabled: true }
    expect(gateBrowserOp('browser_eval', input)).toBe(gateBrowserOp('browser_eval', { ...input }))
  })

  it('an observe worker cannot call any acting verb (derived deny list), but its read verbs stay allowed', async () => {
    const { OBSERVE_MCP_ALLOW, OBSERVE_MCP_DENY } = await import('../src/main/scheduler-core')
    for (const op of [
      'browser_eval',
      'browser_click',
      'browser_type',
      'browser_fill',
      'browser_press',
      'browser_navigate',
      'browser_network',
      'browser_close',
      'browser_open'
    ]) {
      expect(OBSERVE_MCP_DENY, op).toContain(`mcp__harnu__${op}`)
      expect(OBSERVE_MCP_ALLOW, op).not.toContain(`mcp__harnu__${op}`)
    }
    for (const op of ['browser_list', 'browser_snapshot', 'browser_wait_for']) {
      expect(OBSERVE_MCP_ALLOW, op).toContain(`mcp__harnu__${op}`)
    }
  })

  it('every acting verb is a mutation that is not replayable', () => {
    for (const op of Object.keys({
      browser_eval: 1,
      browser_click: 1,
      browser_type: 1,
      browser_fill: 1,
      browser_press: 1
    })) {
      const def = toolByName(op)!
      expect(def.mutates, op).toBe(true)
      expect(def.replayable, op).toBe(false)
    }
  })
})
