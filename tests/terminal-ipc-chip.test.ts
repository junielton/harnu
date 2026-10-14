/**
 * T476 (agent terminals U1) — `terminal:chip`: the handler behind the chip's projection reads
 * the lease LIVE and answers null for anything that is not a terminal.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { on: (): void => {}, isPackaged: false, getPath: (): string => '/tmp' },
  ipcMain: { handle: (): void => {}, on: (): void => {} },
  webContents: { getAllWebContents: (): unknown[] => [] },
  BrowserWindow: class {},
  dialog: {},
  shell: {}
}))
vi.mock('node-pty', () => ({ spawn: (): unknown => ({}) }))

import { terminalChipFor, wireTerminalChipChanged } from '../src/main/terminal-ipc'
import { TerminalLeases, LEASE_IDLE_MS } from '../src/main/terminal-lease'
import { TerminalRegistry } from '../src/main/terminal-registry'

describe('terminalChipFor', () => {
  it('is null for a non-string or unknown id', () => {
    const reg = new TerminalRegistry()
    const leases = new TerminalLeases()
    expect(terminalChipFor(reg, leases, 42)).toBeNull()
    expect(terminalChipFor(reg, leases, 'h-nope')).toBeNull()
  })

  it('reports the lease while it is live and not once it idles out', () => {
    const clock = { t: 0 }
    const reg = new TerminalRegistry(() => clock.t)
    const leases = new TerminalLeases(() => clock.t)
    reg.register({
      terminalId: 'h-op',
      ptyId: 'p',
      folder: '/f',
      origin: 'operator',
      size: { cols: 80, rows: 24 }
    })
    expect(terminalChipFor(reg, leases, 'h-op')?.leaseActive).toBe(false)
    leases.grant('h-op', '/f', 'p')
    expect(terminalChipFor(reg, leases, 'h-op')?.leaseActive).toBe(true)
    clock.t = LEASE_IDLE_MS
    expect(terminalChipFor(reg, leases, 'h-op')?.leaseActive).toBe(false)
  })

  it('a Disconnect shows up at once', () => {
    const reg = new TerminalRegistry()
    const leases = new TerminalLeases()
    reg.register({
      terminalId: 'h-a',
      ptyId: 'p',
      folder: '/f',
      origin: 'agent',
      size: { cols: 80, rows: 24 }
    })
    reg.disconnect('h-a')
    expect(terminalChipFor(reg, leases, 'h-a')?.disconnected).toBe(true)
  })

  it('a lease granted for a different PTY does not count: the pane was restored under the same id', () => {
    const reg = new TerminalRegistry()
    const leases = new TerminalLeases()
    reg.register({
      terminalId: 'h-op',
      ptyId: 'p-new',
      folder: '/f',
      origin: 'operator',
      size: { cols: 80, rows: 24 }
    })
    leases.grant('h-op', '/f', 'p-old')
    expect(terminalChipFor(reg, leases, 'h-op')?.leaseActive).toBe(false)
    // …and the same check dropped the stale lease, which the chip must hear about (see below).
    expect(leases.activeIds()).toEqual([])
  })
})

describe('wireTerminalChipChanged', () => {
  it('sends the terminal id on every grant and every way a lease ends', () => {
    const leases = new TerminalLeases(() => 1_000)
    const sent: string[] = []
    const off = wireTerminalChipChanged(leases, (e) => sent.push(e.terminalId))

    leases.grant('a', '/f', 'p')
    leases.revoke('a') // Disconnect / exit
    leases.grant('b', '/f/x', 'p')
    leases.revokeUnder('/f') // folder blocked
    leases.grant('c', '/g', 'p')
    leases.revokeFolder('/g') // read opt-in turned off
    leases.grant('d', '/h', 'p')
    leases.grant('e', '/h', 'p')
    leases.revokeAll() // kill-switch off
    leases.grant('f', '/i', 'p')
    leases.deny('f') // the operator declined
    expect(sent).toEqual(['a', 'a', 'b', 'b', 'c', 'c', 'd', 'e', 'd', 'e', 'f', 'f'])

    off()
    leases.grant('z', '/f', 'p')
    expect(sent).toHaveLength(12)
  })

  it('an idled-out or PTY-mismatched lease dropped on a check is announced; a no-op revoke is not', () => {
    const clock = { t: 0 }
    const leases = new TerminalLeases(() => clock.t)
    const sent: string[] = []
    wireTerminalChipChanged(leases, (e) => sent.push(e.terminalId))
    leases.revoke('nobody')
    leases.deny('nobody')
    expect(sent).toEqual([])
    leases.grant('a', '/f', 'p')
    clock.t = LEASE_IDLE_MS
    expect(leases.isActive('a', 'p')).toBe(false)
    expect(sent).toEqual(['a', 'a'])
  })

  it('a throwing listener never fails the lease table', () => {
    const leases = new TerminalLeases()
    leases.onChange(() => {
      throw new Error('display bug')
    })
    expect(() => leases.grant('a', '/f', 'p')).not.toThrow()
    expect(leases.isActive('a', 'p')).toBe(true)
  })
})
