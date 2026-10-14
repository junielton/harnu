/**
 * T481 (agent terminals B4) — the read gate at PLAN level (AC-B4-2, AC-B4-4).
 *
 * Pure: `terminal-gate-core` on its own, then through `planToolCall` to prove the refusal is a
 * plain deny that comes BEFORE any confirm, in `ask` mode too, in the documented order, and that
 * the explicit folder block and the server kill-switch still outrank it.
 */
import { describe, it, expect } from 'vitest'
import {
  UNKNOWN_TERMINAL,
  canStillWrite,
  gateTerminalOp,
  isTerminalGatedOp,
  resolveTerminalGateState,
  type TerminalGateState
} from '../src/main/terminal-gate-core'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { shapeDenial } from '../src/main/mcp/deny-hint'
import { OBSERVE_MCP_ALLOW, OBSERVE_MCP_DENY } from '../src/main/scheduler-core'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'

const agent = { origin: 'agent', disconnected: false, state: 'running' } as const
const operator = { origin: 'operator', disconnected: false, state: 'running' } as const
const prefs = (readOptIn: boolean): { readOptIn: boolean; writesEnabled: boolean } => ({
  readOptIn,
  writesEnabled: true
})

describe('resolveTerminalGateState', () => {
  it('an unknown id resolves to a state that fails closed', () => {
    expect(resolveTerminalGateState(undefined, prefs(true))).toEqual(UNKNOWN_TERMINAL)
    expect(UNKNOWN_TERMINAL.known).toBe(false)
    expect(UNKNOWN_TERMINAL.readable).toBe(false)
  })

  it('agent-spawned is readable with no opt-in; operator-opened only with it', () => {
    expect(resolveTerminalGateState(agent, prefs(false)).readable).toBe(true)
    expect(resolveTerminalGateState(operator, prefs(false)).readable).toBe(false)
    expect(resolveTerminalGateState(operator, prefs(true)).readable).toBe(true)
  })

  it('a disconnected terminal is not readable even with the opt-in on', () => {
    const s = resolveTerminalGateState({ ...operator, disconnected: true }, prefs(true))
    expect(s.readable).toBe(false)
    expect(s.disconnected).toBe(true)
  })
})

describe('gateTerminalOp — the documented order', () => {
  const base: TerminalGateState = {
    known: true,
    isTerminal: true,
    origin: 'operator',
    disconnected: false,
    state: 'running',
    readable: true,
    ownerSessionId: null
  }

  it('speaks for read_terminal and send_terminal only', () => {
    expect(isTerminalGatedOp('read_terminal')).toBe(true)
    expect(isTerminalGatedOp('send_terminal')).toBe(true)
    expect(isTerminalGatedOp('list_terminals')).toBe(false)
    expect(gateTerminalOp('get_fleet', UNKNOWN_TERMINAL)).toBeNull()
  })

  it('an allowed terminal continues', () => {
    expect(gateTerminalOp('read_terminal', base)).toBeNull()
  })

  it('TERMINAL_NOT_FOUND outranks everything', () => {
    const everythingWrong = {
      ...base,
      known: false,
      isTerminal: false,
      disconnected: true,
      readable: false
    }
    expect(gateTerminalOp('read_terminal', everythingWrong)).toBe('TERMINAL_NOT_FOUND')
  })

  it('NOT_A_TERMINAL comes next', () => {
    const s = { ...base, isTerminal: false, disconnected: true, readable: false }
    expect(gateTerminalOp('read_terminal', s)).toBe('NOT_A_TERMINAL')
  })

  it('TERMINAL_DISCONNECTED beats TERMINAL_READ_NOT_ENABLED', () => {
    const s = { ...base, disconnected: true, readable: false }
    expect(gateTerminalOp('read_terminal', s)).toBe('TERMINAL_DISCONNECTED')
  })

  it('TERMINAL_READ_NOT_ENABLED is the last read refusal', () => {
    expect(gateTerminalOp('read_terminal', { ...base, readable: false })).toBe(
      'TERMINAL_READ_NOT_ENABLED'
    )
  })

  it('every refusal has a deny hint', () => {
    for (const code of [
      'TERMINAL_NOT_FOUND',
      'NOT_A_TERMINAL',
      'TERMINAL_DISCONNECTED',
      'TERMINAL_READ_NOT_ENABLED',
      'TERMINAL_EXITED',
      'TERMINAL_WRITE_NOT_ENABLED',
      'TERMINAL_BUSY',
      'TERMINAL_RATE_LIMIT'
    ]) {
      expect(shapeDenial(code, { folder: '/x' }), code).not.toBeNull()
    }
  })
})

// T482 (B5): the write half. Order: NOT_FOUND → NOT_A_TERMINAL → DISCONNECTED → EXITED →
// READ_NOT_ENABLED → WRITE_NOT_ENABLED (transitional until the lease of B6).
describe('gateTerminalOp — send_terminal (B5)', () => {
  const agentState: TerminalGateState = {
    known: true,
    isTerminal: true,
    origin: 'agent',
    disconnected: false,
    state: 'running',
    readable: true,
    ownerSessionId: 's'
  }

  it('an agent-spawned, connected, running terminal continues', () => {
    expect(gateTerminalOp('send_terminal', agentState)).toBeNull()
  })

  it('an exited terminal is still readable but cannot be typed into', () => {
    const s = { ...agentState, state: 'exited' as const }
    expect(gateTerminalOp('read_terminal', s)).toBeNull()
    expect(gateTerminalOp('send_terminal', s)).toBe('TERMINAL_EXITED')
  })

  it('TERMINAL_DISCONNECTED outranks TERMINAL_EXITED', () => {
    const s = { ...agentState, state: 'exited' as const, disconnected: true, readable: false }
    expect(gateTerminalOp('send_terminal', s)).toBe('TERMINAL_DISCONNECTED')
  })

  it('TERMINAL_EXITED outranks the read opt-in refusal', () => {
    const s = {
      ...agentState,
      origin: 'operator' as const,
      state: 'exited' as const,
      readable: false
    }
    expect(gateTerminalOp('send_terminal', s)).toBe('TERMINAL_EXITED')
  })

  it('an operator terminal whose folder has not opted in is TERMINAL_READ_NOT_ENABLED', () => {
    const s = { ...agentState, origin: 'operator' as const, readable: false }
    expect(gateTerminalOp('send_terminal', s)).toBe('TERMINAL_READ_NOT_ENABLED')
  })

  it('an operator terminal that IS readable is still refused for writes until B6', () => {
    const s = { ...agentState, origin: 'operator' as const, readable: true }
    expect(gateTerminalOp('read_terminal', s)).toBeNull()
    expect(gateTerminalOp('send_terminal', s)).toBe('TERMINAL_WRITE_NOT_ENABLED')
  })

  it('an unresolved state fails closed', () => {
    expect(gateTerminalOp('send_terminal', UNKNOWN_TERMINAL)).toBe('TERMINAL_NOT_FOUND')
  })

  it.each(['TERMINAL_EXITED', 'TERMINAL_WRITE_NOT_ENABLED'])(
    '%s is a plan-level deny that never confirms, in ask mode too',
    (code) => {
      const state: TerminalGateState =
        code === 'TERMINAL_EXITED'
          ? { ...agentState, state: 'exited' }
          : { ...agentState, origin: 'operator' }
      for (const ask of [false, true]) {
        const plan = planToolCall({
          tool: 'send_terminal',
          input: buildPlanInput('send_terminal', { terminalId: 'h-1', input: 'x' }, '/work/app'),
          policy: { serverEnabled: true, ask, denyFolders: [], knownRoots: ['/work'] },
          now: 1,
          terminal: state
        })
        expect(plan).toMatchObject({ verdict: 'deny', shouldConfirm: false, shouldDispatch: false })
        expect(plan.auditRecord.result).toBe(code)
        expect(plan.auditRecord.disclosedPayloadSummary).toBe('none')
      }
    }
  )

  it('an unresolved terminal in the plan fails closed for a send as well', () => {
    const plan = planToolCall({
      tool: 'send_terminal',
      input: buildPlanInput('send_terminal', { terminalId: 'h-1', input: 'x' }, '/work/app'),
      policy: { serverEnabled: true, ask: false, denyFolders: [], knownRoots: ['/work'] },
      now: 1
    })
    expect(plan.auditRecord.result).toBe('TERMINAL_NOT_FOUND')
  })
})

describe('AC-B4-2 — refusals are plan-level denies, before any confirm', () => {
  const policy = (
    over: Record<string, unknown> = {}
  ): Parameters<typeof planToolCall>[0]['policy'] => ({
    serverEnabled: true,
    ask: false,
    denyFolders: [],
    knownRoots: ['/work'],
    ...over
  })
  const input = buildPlanInput('read_terminal', { terminalId: 'h-1' }, '/work/app')
  const state = (over: Partial<TerminalGateState>): TerminalGateState => ({
    known: true,
    isTerminal: true,
    origin: 'operator',
    disconnected: false,
    state: 'running',
    readable: false,
    ownerSessionId: null,
    ...over
  })

  for (const ask of [false, true]) {
    it(`ask=${ask}: a refused read is a deny that never confirms and never dispatches`, () => {
      const plan = planToolCall({
        tool: 'read_terminal',
        input,
        policy: policy({ ask }),
        now: 1,
        terminal: state({})
      })
      expect(plan.verdict).toBe('deny')
      expect(plan.shouldConfirm).toBe(false)
      expect(plan.shouldDispatch).toBe(false)
      expect(plan.auditRecord.result).toBe('TERMINAL_READ_NOT_ENABLED')
      expect(plan.auditRecord.verdict).toBe('deny')
    })
  }

  it('walks the documented order through the plan', () => {
    const run = (terminal: TerminalGateState | undefined): string =>
      planToolCall({ tool: 'read_terminal', input, policy: policy(), now: 1, terminal }).auditRecord
        .result
    expect(run(UNKNOWN_TERMINAL)).toBe('TERMINAL_NOT_FOUND')
    expect(run(state({ isTerminal: false }))).toBe('NOT_A_TERMINAL')
    expect(run(state({ disconnected: true }))).toBe('TERMINAL_DISCONNECTED')
    expect(run(state({}))).toBe('TERMINAL_READ_NOT_ENABLED')
  })

  it('an unresolved state fails closed rather than skipping the gate', () => {
    const plan = planToolCall({ tool: 'read_terminal', input, policy: policy(), now: 1 })
    expect(plan.verdict).toBe('deny')
    expect(plan.auditRecord.result).toBe('TERMINAL_NOT_FOUND')
  })

  it('a readable terminal dispatches, in free and in ask mode (a read never confirms)', () => {
    for (const ask of [false, true]) {
      const plan = planToolCall({
        tool: 'read_terminal',
        input,
        policy: policy({ ask }),
        now: 1,
        terminal: state({ readable: true })
      })
      expect(plan.verdict).toBe('allow')
      expect(plan.shouldDispatch).toBe(true)
      expect(plan.shouldConfirm).toBe(false)
    }
  })

  it('does not gate list_terminals (it lists unreadable terminals on purpose)', () => {
    const plan = planToolCall({
      tool: 'list_terminals',
      input: buildPlanInput('list_terminals', {}, undefined),
      policy: policy(),
      now: 1
    })
    expect(plan.verdict).toBe('allow')
  })
})

describe('AC-B4-4 — block, kill-switch, and the observe allowlist', () => {
  const input = buildPlanInput('read_terminal', { terminalId: 'h-1' }, '/work/blocked')
  const readable: TerminalGateState = {
    known: true,
    isTerminal: true,
    origin: 'agent',
    disconnected: false,
    state: 'running',
    readable: true
  }

  it('a blocked folder is FOLDER_NOT_ALLOWED, ahead of the terminal refusals', () => {
    const plan = planToolCall({
      tool: 'read_terminal',
      input,
      policy: { serverEnabled: true, ask: false, denyFolders: ['/work/blocked'], knownRoots: [] },
      now: 1,
      // Every terminal refusal would also apply; the block must win.
      terminal: { ...readable, readable: false, disconnected: true }
    })
    expect(plan.auditRecord.result).toBe('FOLDER_NOT_ALLOWED')
  })

  it('server off is SERVER_DISABLED, ahead of the terminal refusals', () => {
    const plan = planToolCall({
      tool: 'read_terminal',
      input,
      policy: { serverEnabled: false, ask: false, denyFolders: [], knownRoots: [] },
      now: 1,
      terminal: UNKNOWN_TERMINAL
    })
    expect(plan.auditRecord.result).toBe('SERVER_DISABLED')
  })

  it('the blocked-folder check also covers list_terminals with a folder', () => {
    const plan = planToolCall({
      tool: 'list_terminals',
      input: buildPlanInput('list_terminals', { folder: '/work/blocked' }, '/work/blocked'),
      policy: { serverEnabled: true, ask: false, denyFolders: ['/work/blocked'], knownRoots: [] },
      now: 1
    })
    expect(plan.auditRecord.result).toBe('FOLDER_NOT_ALLOWED')
  })

  it.each(['mcp__harnu__', 'mcp__capy__'])(
    'an observe tick may call read_terminal and list_terminals — %s',
    (prefix) => {
      for (const verb of ['read_terminal', 'list_terminals']) {
        expect(OBSERVE_MCP_ALLOW).toContain(`${prefix}${verb}`)
        expect(OBSERVE_MCP_DENY).not.toContain(`${prefix}${verb}`)
      }
    }
  )

  it('the deny list stays derived: spawn_terminal and send_terminal are denied (AC-B4-4 carry-in)', () => {
    for (const prefix of ['mcp__harnu__', 'mcp__capy__']) {
      expect(OBSERVE_MCP_DENY).toContain(`${prefix}spawn_terminal`)
      // B5: the verb now exists. The deny list is the catalog minus the allow list, so keeping
      // it OUT of the allow list is what keeps it denied.
      expect(OBSERVE_MCP_DENY).toContain(`${prefix}send_terminal`)
      expect(OBSERVE_MCP_ALLOW).not.toContain(`${prefix}send_terminal`)
    }
    // And every catalog verb that is not allowed is denied — nothing falls between the lists.
    const allowed = new Set(OBSERVE_MCP_ALLOW)
    for (const t of MCP_TOOLS) {
      const name = `mcp__harnu__${t.name}`
      expect(allowed.has(name) || OBSERVE_MCP_DENY.includes(name), t.name).toBe(true)
    }
  })
})

describe('canStillWrite — the one check before every write of a send', () => {
  const ok = { folderBlocked: false, deadlineFired: false, readOptIn: false }

  it('lets a running, connected agent terminal be typed into', () => {
    expect(canStillWrite(agent, ok)).toBeNull()
  })

  it('refuses in the documented order: deadline, swept, blocked folder, then the gate', () => {
    const everything = { folderBlocked: true, deadlineFired: true, readOptIn: false }
    expect(canStillWrite(undefined, everything)).toBe('DEADLINE_FIRED')
    expect(canStillWrite(undefined, { ...everything, deadlineFired: false })).toBe(
      'TERMINAL_NOT_FOUND'
    )
    expect(
      canStillWrite({ ...agent, state: 'exited' }, { ...everything, deadlineFired: false })
    ).toBe('FOLDER_NOT_ALLOWED')
    expect(canStillWrite({ ...agent, state: 'exited' }, ok)).toBe('TERMINAL_EXITED')
    expect(canStillWrite({ ...agent, disconnected: true }, ok)).toBe('TERMINAL_DISCONNECTED')
  })

  it('still refuses a terminal the operator opened (typing into those is unit B6)', () => {
    expect(canStillWrite(operator, { ...ok, readOptIn: true })).toBe('TERMINAL_WRITE_NOT_ENABLED')
    expect(canStillWrite(operator, ok)).toBe('TERMINAL_READ_NOT_ENABLED')
  })
})
