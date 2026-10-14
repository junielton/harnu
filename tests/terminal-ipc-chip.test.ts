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

import { terminalChipFor } from '../src/main/terminal-ipc'
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
    leases.grant('h-op', '/f')
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
})
