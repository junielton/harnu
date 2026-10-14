/**
 * T476 (agent terminals U1) — main's projection behind the chip (`terminal:chip`).
 */
import { describe, it, expect } from 'vitest'
import { TerminalLeases } from '../src/main/terminal-lease'
import { TerminalRegistry, terminalChipState } from '../src/main/terminal-registry'

const SIZE = { cols: 80, rows: 24 }

function setup(): { reg: TerminalRegistry; leases: TerminalLeases } {
  return { reg: new TerminalRegistry(() => 1_000), leases: new TerminalLeases(() => 1_000) }
}

describe('terminalChipState', () => {
  it('projects an agent terminal: origin, owner, nothing disconnected', () => {
    const { reg } = setup()
    const rec = reg.register({
      terminalId: 'h-1',
      ptyId: 'p-1',
      folder: '/f',
      origin: 'agent',
      ownerSessionId: 'sess-1',
      size: SIZE
    })
    expect(terminalChipState(rec, false)).toEqual({
      terminalId: 'h-1',
      origin: 'agent',
      ownerSessionId: 'sess-1',
      disconnected: false,
      exited: false,
      leaseActive: false
    })
  })

  it('follows the synthetic→real owner rekey', () => {
    const { reg } = setup()
    const rec = reg.register({
      terminalId: 'h-1',
      ptyId: 'p-1',
      folder: '/f',
      origin: 'agent',
      ownerSessionId: 'synthetic-a',
      size: SIZE
    })
    reg.rekeyOwner('synthetic-a', 'real-b')
    expect(terminalChipState(rec, false).ownerSessionId).toBe('real-b')
  })

  it('a lease counts only while the terminal is running and connected', () => {
    const { reg } = setup()
    const rec = reg.register({
      terminalId: 'h-1',
      ptyId: 'p-1',
      folder: '/f',
      origin: 'operator',
      size: SIZE
    })
    expect(terminalChipState(rec, true).leaseActive).toBe(true)
    reg.disconnect('h-1')
    expect(terminalChipState(rec, true)).toMatchObject({ disconnected: true, leaseActive: false })
  })

  it('an exited terminal reads exited, with no lease', () => {
    const { reg } = setup()
    const rec = reg.register({
      terminalId: 'h-1',
      ptyId: 'p-1',
      folder: '/f',
      origin: 'agent',
      size: SIZE
    })
    reg.markExited('p-1', 0)
    expect(terminalChipState(rec, true)).toMatchObject({ exited: true, leaseActive: false })
  })
})
