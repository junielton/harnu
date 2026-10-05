import { describe, it, expect } from 'vitest'
import type { TaskState } from '../src/preload'
import {
  clampSessionWindow,
  keepSession,
  DEFAULT_SESSION_WINDOW_MS,
  SESSION_WINDOW_PRESETS,
  type WindowSession,
  type WindowCtx
} from '../src/renderer/src/stores/session-window'

const NOW = Date.parse('2026-06-16T12:00:00.000Z')
const H = 60 * 60 * 1000
const WINDOW_48H = 48 * H

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString()
}

function session(over: Partial<WindowSession> = {}): WindowSession {
  return {
    sessionId: 's1',
    status: 'idle',
    modified: ago(0),
    ...over
  }
}

function ctx(over: Partial<WindowCtx> = {}): WindowCtx {
  return {
    nowMs: NOW,
    windowMs: WINDOW_48H,
    searchActive: false,
    revealed: false,
    selectedId: null,
    livePtySessionIds: new Set<string>(),
    ...over
  }
}

describe('clampSessionWindow', () => {
  it('passes through every allowed preset unchanged', () => {
    for (const p of SESSION_WINDOW_PRESETS) {
      expect(clampSessionWindow(p)).toBe(p)
    }
  })

  it('accepts 0 (the "All" preset)', () => {
    expect(clampSessionWindow(0)).toBe(0)
  })

  it('falls back to the 48h default for a non-preset value', () => {
    expect(clampSessionWindow(123_456)).toBe(DEFAULT_SESSION_WINDOW_MS)
    expect(clampSessionWindow(Number.NaN)).toBe(DEFAULT_SESSION_WINDOW_MS)
    expect(DEFAULT_SESSION_WINDOW_MS).toBe(48 * H)
  })
})

describe('keepSession — within-window decision', () => {
  it('keeps a session modified inside the window', () => {
    expect(keepSession(session({ modified: ago(24 * H) }), ctx())).toBe(true)
  })

  it('keeps a session exactly at the window edge', () => {
    expect(keepSession(session({ modified: ago(WINDOW_48H) }), ctx())).toBe(true)
  })

  it('hides a session modified beyond the window', () => {
    expect(keepSession(session({ modified: ago(WINDOW_48H + 1) }), ctx())).toBe(false)
  })
})

describe('keepSession — always-keep guards', () => {
  const old = (): WindowSession => session({ modified: ago(30 * 24 * H) }) // 30d old, beyond any window

  it('keeps everything when the window is "All" (0)', () => {
    expect(keepSession(old(), ctx({ windowMs: 0 }))).toBe(true)
  })

  it('keeps everything while a text search is active', () => {
    expect(keepSession(old(), ctx({ searchActive: true }))).toBe(true)
  })

  it('keeps everything when the folder is revealed', () => {
    expect(keepSession(old(), ctx({ revealed: true }))).toBe(true)
  })

  it('keeps the currently-selected session', () => {
    expect(keepSession(old(), ctx({ selectedId: 's1' }))).toBe(true)
  })

  it('keeps a session with a live PTY', () => {
    expect(keepSession(old(), ctx({ livePtySessionIds: new Set(['s1']) }))).toBe(true)
  })

  it.each<[TaskState | undefined, WindowSession['status'], boolean]>([
    ['working', 'idle', true],
    ['needs-input', 'idle', true],
    [undefined, 'active', true],
    [undefined, 'idle', false]
  ])('liveness taskState=%s status=%s → keep=%s', (taskState, status, keep) => {
    expect(keepSession(session({ modified: ago(30 * 24 * H), taskState, status }), ctx())).toBe(
      keep
    )
  })

  it('keeps a synthetic session even when far beyond the window', () => {
    expect(keepSession(session({ modified: ago(30 * 24 * H), synthetic: true }), ctx())).toBe(true)
  })

  it('fails open: keeps a session whose modified is unparseable', () => {
    expect(keepSession(session({ modified: 'not-a-date' }), ctx())).toBe(true)
  })
})
