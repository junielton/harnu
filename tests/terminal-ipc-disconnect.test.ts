/**
 * T487 (agent terminals B7) — the IPC half of Disconnect and the activity stream: the renderer's
 * `terminal:disconnect` is the only way in, it is permanent (no reconnect channel exists), and an
 * agent read/write reaches every window as ONE coalesced `terminal:activity` per 250 ms.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  sent: [] as Array<{ channel: string; payload: unknown }>
}))

vi.mock('electron', () => {
  const wc = {
    getType: (): string => 'window',
    isDestroyed: (): boolean => false,
    on: (): void => {},
    send: (channel: string, payload: unknown): void => {
      h.sent.push({ channel, payload })
    }
  }
  return {
    app: { on: (): void => {}, isPackaged: false, getPath: (): string => '/tmp' },
    ipcMain: {
      handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown): void => {
        h.handlers.set(ch, fn)
      },
      on: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown): void => {
        h.handlers.set(ch, fn)
      }
    },
    webContents: { getAllWebContents: (): unknown[] => [wc] },
    BrowserWindow: class {},
    dialog: {},
    shell: {}
  }
})
vi.mock('node-pty', () => ({ spawn: (): unknown => ({}) }))

import { registerTerminalIpc } from '../src/main/terminal-ipc'
import { terminalRegistry } from '../src/main/terminal-registry'
import { terminalLeases } from '../src/main/terminal-lease'
import { ACTIVITY_WINDOW_MS } from '../src/main/terminal-activity'

beforeAll(() => {
  registerTerminalIpc({ dispatch: async () => ({}) })
})

beforeEach(() => {
  vi.useFakeTimers()
  h.sent.length = 0
  terminalRegistry.register({
    terminalId: 'h-ipc',
    ptyId: 'p-ipc',
    folder: '/f',
    origin: 'agent',
    size: { cols: 80, rows: 24 }
  })
})
afterEach(() => {
  vi.useRealTimers()
  terminalRegistry.forget('h-ipc')
  terminalLeases.revokeAll()
})

describe('terminal:disconnect', () => {
  it('disconnects a known terminal and ends its lease; the PTY record stays running', async () => {
    terminalLeases.grant('h-ipc', '/f', 'p-ipc')
    expect(await h.handlers.get('terminal:disconnect')!({}, 'h-ipc')).toBe(true)
    const rec = terminalRegistry.get('h-ipc')!
    expect(rec.disconnected).toBe(true)
    expect(rec.state).toBe('running')
    expect(terminalLeases.isActive('h-ipc', 'p-ipc')).toBe(false)
  })

  it('answers false for an unknown id or a non-string, and never throws', async () => {
    expect(await h.handlers.get('terminal:disconnect')!({}, 'h-nope')).toBe(false)
    expect(await h.handlers.get('terminal:disconnect')!({}, 42)).toBe(false)
  })

  it('is permanent: no terminal channel reconnects', () => {
    const names = [...h.handlers.keys()].filter((k) => k.startsWith('terminal:'))
    expect(names.some((n) => /connect/i.test(n) && n !== 'terminal:disconnect')).toBe(false)
    expect(names).toContain('terminal:disconnect')
  })
})

describe('terminal:activity', () => {
  const activity = (): unknown[] =>
    h.sent.filter((s) => s.channel === 'terminal:activity').map((s) => s.payload)

  it('an agent read reaches every window at once; a burst folds into one trailing event', () => {
    terminalRegistry.noteAgentRead('h-ipc')
    expect(activity()).toMatchObject([{ terminalId: 'h-ipc', kind: 'read' }])
    for (let i = 0; i < 10; i++) terminalRegistry.noteAgentWrite('h-ipc')
    expect(activity()).toHaveLength(1)
    vi.advanceTimersByTime(ACTIVITY_WINDOW_MS)
    expect(activity()).toHaveLength(2)
    expect(activity()[1]).toMatchObject({ terminalId: 'h-ipc', kind: 'write' })
  })
})
