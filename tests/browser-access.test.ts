/**
 * T568 (browser pane U1, AC-9) — the access gate (spec §6.3, §7.1, §7.4): refusal order, kill-switch,
 * Disconnect, Pause and the tier of operator-opened panes.
 */
import { describe, it, expect } from 'vitest'
import {
  BROWSER_OPS,
  PAUSE_MS,
  browserTier,
  createBrowserAccess,
  describePaneAccess,
  gateBrowserOp,
  isBrowserWriteOp,
  type BrowserPaneAccess
} from '../src/main/browser/access'

const agentPane: BrowserPaneAccess = {
  openedBy: 'agent',
  originClass: 'local',
  disconnected: false,
  paused: false
}
const operatorPane: BrowserPaneAccess = { ...agentPane, openedBy: 'operator' }

describe('gateBrowserOp', () => {
  it('lets every U1 verb through on a free agent pane', () => {
    for (const op of ['browser_navigate', 'browser_close'] as const) {
      expect(gateBrowserOp(op, { pane: agentPane, writesEnabled: true }), op).toBeNull()
    }
    expect(gateBrowserOp('browser_open', { pane: undefined, writesEnabled: true })).toBeNull()
    expect(gateBrowserOp('browser_list', { pane: undefined, writesEnabled: true })).toBeNull()
  })

  it('refuses an unknown pane id', () => {
    expect(gateBrowserOp('browser_navigate', { pane: undefined, writesEnabled: true })).toBe(
      'PANE_NOT_FOUND'
    )
    expect(gateBrowserOp('browser_close', { pane: undefined, writesEnabled: true })).toBe(
      'PANE_NOT_FOUND'
    )
  })

  it('refuses everything, close included, on a disconnected pane', () => {
    const pane = { ...agentPane, disconnected: true }
    for (const op of ['browser_navigate', 'browser_close', 'browser_snapshot'] as const) {
      expect(gateBrowserOp(op, { pane, writesEnabled: true }), op).toBe('BROWSER_DISCONNECTED')
    }
  })

  it('kill-switch off refuses every write but keeps list and close working (Q6)', () => {
    expect(gateBrowserOp('browser_open', { pane: undefined, writesEnabled: false })).toBe(
      'BROWSER_WRITES_DISABLED'
    )
    expect(gateBrowserOp('browser_navigate', { pane: agentPane, writesEnabled: false })).toBe(
      'BROWSER_WRITES_DISABLED'
    )
    expect(gateBrowserOp('browser_eval', { pane: agentPane, writesEnabled: false })).toBe(
      'BROWSER_WRITES_DISABLED'
    )
    expect(gateBrowserOp('browser_close', { pane: agentPane, writesEnabled: false })).toBeNull()
    expect(gateBrowserOp('browser_list', { pane: undefined, writesEnabled: false })).toBeNull()
    expect(gateBrowserOp('browser_snapshot', { pane: agentPane, writesEnabled: false })).toBeNull()
  })

  it('paused refuses writes, close included, and lets reads work', () => {
    const pane = { ...agentPane, paused: true }
    expect(gateBrowserOp('browser_navigate', { pane, writesEnabled: true })).toBe('BROWSER_PAUSED')
    expect(gateBrowserOp('browser_close', { pane, writesEnabled: true })).toBe('BROWSER_PAUSED')
    expect(gateBrowserOp('browser_snapshot', { pane, writesEnabled: true })).toBeNull()
  })

  it('decides in the spec order: not found → disconnected → kill-switch → paused → tier', () => {
    const everything = { ...operatorPane, disconnected: true, paused: true }
    expect(gateBrowserOp('browser_navigate', { pane: everything, writesEnabled: false })).toBe(
      'BROWSER_DISCONNECTED'
    )
    const pausedOperator = { ...operatorPane, paused: true }
    expect(gateBrowserOp('browser_navigate', { pane: pausedOperator, writesEnabled: false })).toBe(
      'BROWSER_WRITES_DISABLED'
    )
    expect(gateBrowserOp('browser_navigate', { pane: pausedOperator, writesEnabled: true })).toBe(
      'BROWSER_PAUSED'
    )
    expect(gateBrowserOp('browser_navigate', { pane: operatorPane, writesEnabled: true })).toBe(
      'NOT_YET_AVAILABLE'
    )
  })

  it('never lets a write reach an operator-opened pane before the lease exists', () => {
    for (const op of ['browser_navigate', 'browser_close'] as const) {
      expect(gateBrowserOp(op, { pane: operatorPane, writesEnabled: true }), op).toBe(
        'NOT_YET_AVAILABLE'
      )
    }
  })
})

describe('browserTier and verb classes', () => {
  it('is lease for a write on an operator pane and free everywhere else', () => {
    expect(browserTier('browser_navigate', operatorPane)).toBe('lease')
    expect(browserTier('browser_close', operatorPane)).toBe('lease')
    expect(browserTier('browser_navigate', agentPane)).toBe('free')
    expect(browserTier('browser_open', undefined)).toBe('free')
    expect(browserTier('browser_snapshot', operatorPane)).toBe('free')
  })

  it('classifies the seven read verbs the spec names as not writes', () => {
    for (const op of [
      'browser_list',
      'browser_snapshot',
      'browser_screenshot',
      'browser_console',
      'browser_wait_for'
    ]) {
      expect(isBrowserWriteOp(op), op).toBe(false)
    }
    for (const op of [
      'browser_open',
      'browser_navigate',
      'browser_close',
      'browser_network',
      'browser_eval'
    ]) {
      expect(isBrowserWriteOp(op), op).toBe(true)
    }
    expect(BROWSER_OPS).toHaveLength(19)
  })
})

describe('describePaneAccess', () => {
  it('reports a free agent pane as readable and free', () => {
    expect(describePaneAccess(agentPane, true)).toEqual({ readable: true, writable: 'free' })
  })

  it('reports each reason for a pane that is not freely writable', () => {
    expect(describePaneAccess({ ...agentPane, disconnected: true }, true)).toEqual({
      readable: false,
      writable: 'revoked',
      writableReason: 'disconnected'
    })
    expect(describePaneAccess(agentPane, false)).toEqual({
      readable: true,
      writable: 'off',
      writableReason: 'kill-switch'
    })
    expect(describePaneAccess({ ...agentPane, paused: true }, true)).toEqual({
      readable: true,
      writable: 'paused',
      writableReason: 'paused'
    })
    expect(describePaneAccess(operatorPane, true)).toEqual({
      readable: false,
      writable: 'off',
      writableReason: 'read-not-enabled'
    })
  })
})

describe('createBrowserAccess', () => {
  it('disconnects permanently and ends a pause', () => {
    let now = 1000
    const access = createBrowserAccess(() => now)
    access.pause('p1')
    expect(access.disconnect('p1')).toBe(true)
    expect(access.isDisconnected('p1')).toBe(true)
    expect(access.isPaused('p1')).toBe(false)
    expect(access.disconnect('p1')).toBe(false)
    now += PAUSE_MS * 100
    expect(access.isDisconnected('p1')).toBe(true)
  })

  it('pauses for 10 minutes by default, reports the end time, and lapses by itself', () => {
    let now = 5000
    const access = createBrowserAccess(() => now)
    expect(access.pausedUntil('p1')).toBeNull()
    expect(access.pause('p1')).toBe(5000 + PAUSE_MS)
    expect(access.isPaused('p1')).toBe(true)
    now += PAUSE_MS - 1
    expect(access.isPaused('p1')).toBe(true)
    now += 1
    expect(access.isPaused('p1')).toBe(false)
    expect(access.pausedUntil('p1')).toBeNull()
  })

  it('resumes early and keeps panes independent', () => {
    const access = createBrowserAccess(() => 0)
    access.pause('a')
    access.pause('b')
    access.resume('a')
    expect(access.isPaused('a')).toBe(false)
    expect(access.isPaused('b')).toBe(true)
  })

  it('forgets a closed pane entirely', () => {
    const access = createBrowserAccess(() => 0)
    access.disconnect('a')
    access.pause('b')
    access.forget('a')
    access.forget('b')
    expect(access.isDisconnected('a')).toBe(false)
    expect(access.isPaused('b')).toBe(false)
  })
})
