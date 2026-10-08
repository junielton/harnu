import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { request } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// BUG-54: the terminal-ledger integration test below persists through
// `atomicWriteFile` → `app.getPath('userData')`, so `electron` is mocked to a
// fresh tmpdir per test, mirroring the `orchestrator-guard.test.ts` approach.
let userDataDir = ''
vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    isPackaged: false
  }
}))

import { startHookServer, handleBridgeEvent, type BridgeEvent } from '../src/main/hook-bridge'
import { markHibernated, resetHibernation } from '../src/main/hibernation'
import {
  initTerminalLedger,
  handleHookTaskEvent,
  getRestorableTerminalEntries
} from '../src/main/terminal-ledger'

/** POST JSON to the local bridge and resolve with the status + raw response body. */
function post(
  port: number,
  path: string,
  body: unknown
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
      },
      (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

describe('hook bridge server', () => {
  let close: (() => Promise<void>) | null = null
  afterEach(async () => {
    if (close) await close()
    close = null
  })

  it('emits a BridgeEvent and answers 200 {} with no decision field (pure observation)', async () => {
    const events: BridgeEvent[] = []
    const started = await startHookServer((e) => events.push(e), 'tok')
    close = started.close
    const res = await post(started.port, '/hook/tok/Notification/permission_prompt', {
      session_id: 'S1'
    })
    expect(res.status).toBe(200)
    expect(res.text).toBe('{}') // never a permissionDecision/decision field
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      sessionId: 'S1',
      event: 'Notification',
      matcher: 'permission_prompt'
    })
  })

  it('carries the subagent id from the body (a subagent event is not a main-thread one)', async () => {
    const events: BridgeEvent[] = []
    const started = await startHookServer((e) => events.push(e), 'tok')
    close = started.close
    await post(started.port, '/hook/tok/PostToolUse/_', { session_id: 'S5', agent_id: 'agent-9' })
    await post(started.port, '/hook/tok/PostToolUse/_', { session_id: 'S5' })
    await post(started.port, '/hook/tok/PostToolUse/_', { session_id: 'S5', agent_id: '' })
    expect(events[0].agentId).toBe('agent-9')
    expect(events[1].agentId).toBeUndefined()
    expect(events[2].agentId).toBeUndefined()
  })

  it('rejects a wrong token with 403 and emits nothing', async () => {
    const events: BridgeEvent[] = []
    const started = await startHookServer((e) => events.push(e), 'tok')
    close = started.close
    const res = await post(started.port, '/hook/WRONG/Stop/_', { session_id: 'S2' })
    expect(res.status).toBe(403)
    expect(events).toHaveLength(0)
  })

  it('maps the "_" tag to no matcher (event-only states)', async () => {
    const events: BridgeEvent[] = []
    const started = await startHookServer((e) => events.push(e), 'tok')
    close = started.close
    await post(started.port, '/hook/tok/Stop/_', { session_id: 'S3' })
    expect(events[0]).toMatchObject({ sessionId: 'S3', event: 'Stop' })
    expect(events[0].matcher).toBeUndefined()
  })

  it('derives the matcher from the body reason for SessionEnd', async () => {
    const events: BridgeEvent[] = []
    const started = await startHookServer((e) => events.push(e), 'tok')
    close = started.close
    await post(started.port, '/hook/tok/SessionEnd/_', { session_id: 'S4', reason: 'clear' })
    expect(events[0]).toMatchObject({ sessionId: 'S4', event: 'SessionEnd', matcher: 'clear' })
  })

  it('captures the StopFailure error_type + resets_at (ISO → epoch-ms), still observer-pure', async () => {
    const events: BridgeEvent[] = []
    const started = await startHookServer((e) => events.push(e), 'tok')
    close = started.close
    const iso = '2026-06-18T12:00:00.000Z'
    const res = await post(started.port, '/hook/tok/StopFailure/_', {
      session_id: 'S5',
      error_type: 'rate_limit',
      resets_at: iso
    })
    expect(res.status).toBe(200)
    expect(res.text).toBe('{}') // pure observer — never decides
    expect(events[0]).toMatchObject({
      sessionId: 'S5',
      event: 'StopFailure',
      failureReason: 'rate_limit'
    })
    expect(events[0].resetsAt).toBe(Date.parse(iso))
  })

  it('classifies a StopFailure with no error_type as unknown, no resetsAt', async () => {
    const events: BridgeEvent[] = []
    const started = await startHookServer((e) => events.push(e), 'tok')
    close = started.close
    await post(started.port, '/hook/tok/StopFailure/_', { session_id: 'S6' })
    expect(events[0].failureReason).toBe('unknown')
    expect(events[0].resetsAt).toBeUndefined()
  })

  it('does not leak failure parsing onto non-StopFailure events', async () => {
    const events: BridgeEvent[] = []
    const started = await startHookServer((e) => events.push(e), 'tok')
    close = started.close
    await post(started.port, '/hook/tok/Stop/_', { session_id: 'S7', error_type: 'rate_limit' })
    expect(events[0].failureReason).toBeUndefined()
    expect(events[0].resetsAt).toBeUndefined()
  })
})

/**
 * T178 row #8 — a `Stop`/`SessionEnd` POSTed by a dying (or already-dead)
 * process can land AFTER the kill and, unguarded, both notifies and
 * re-animates a parked row's `taskState`. `handleBridgeEvent` is the folded
 * fan-out `registerHookBridge` wires into `startHookServer` — extracted so the
 * guard is testable without spinning up the HTTP server or an electron
 * BrowserWindow.
 */
describe('handleBridgeEvent — dropping a late event for a parked session (T178 row #8)', () => {
  afterEach(() => resetHibernation())

  function fakeWindow(send: (channel: string, payload: unknown) => void): {
    isDestroyed: () => boolean
    webContents: { send: typeof send }
  } {
    return { isDestroyed: () => false, webContents: { send } }
  }

  it('sends nothing to the renderer for a hibernated session', () => {
    markHibernated('parked-1')
    const send = vi.fn()
    handleBridgeEvent({ sessionId: 'parked-1', event: 'Stop', ts: 1 }, () => fakeWindow(send))
    expect(send).not.toHaveBeenCalled()
  })

  it('never calls a task-event observer for a hibernated session', async () => {
    const { addTaskEventObserver } = await import('../src/main/hook-bridge')
    markHibernated('parked-1')
    const observer = vi.fn()
    const off = addTaskEventObserver(observer)
    handleBridgeEvent({ sessionId: 'parked-1', event: 'Stop', ts: 1 }, () => null)
    expect(observer).not.toHaveBeenCalled()
    off()
  })

  it('still forwards a claude:hook send for a LIVE session', () => {
    const send = vi.fn()
    handleBridgeEvent({ sessionId: 'live-1', event: 'Stop', ts: 1 }, () => fakeWindow(send))
    expect(send).toHaveBeenCalledWith(
      'claude:hook',
      expect.objectContaining({ sessionId: 'live-1', event: 'Stop' })
    )
  })

  it('still calls a task-event observer for a LIVE session', async () => {
    const { addTaskEventObserver } = await import('../src/main/hook-bridge')
    const observer = vi.fn()
    const off = addTaskEventObserver(observer)
    handleBridgeEvent({ sessionId: 'live-2', event: 'Stop', ts: 1 }, () => null)
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'live-2' }))
    off()
  })
})

describe('terminal ledger integration (BUG-54)', () => {
  beforeEach(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'harnu-terminal-ledger-'))
    await initTerminalLedger() // fresh empty ledger — the tmpdir has no file yet
  })

  it('a StopFailure edge (folded to taskState "failed") reaches the ledger writer', () => {
    handleHookTaskEvent({
      sessionId: 'S-failed',
      taskState: 'failed',
      event: 'StopFailure',
      ts: 12_345,
      failureReason: 'rate_limit',
      resetsAt: 99_999
    })
    expect(getRestorableTerminalEntries({})).toContainEqual({
      sessionId: 'S-failed',
      state: 'failed',
      failureReason: 'rate_limit',
      resetsAt: 99_999,
      at: 12_345
    })
  })

  it('a completed edge reaches the ledger writer with no failure metadata', () => {
    handleHookTaskEvent({
      sessionId: 'S-completed',
      taskState: 'completed',
      event: 'SessionEnd',
      ts: 5_000
    })
    expect(getRestorableTerminalEntries({})).toContainEqual({
      sessionId: 'S-completed',
      state: 'completed',
      at: 5_000
    })
  })

  it("sheds a stale failed entry on the session's next sign of life", () => {
    handleHookTaskEvent({
      sessionId: 'S-resumed',
      taskState: 'failed',
      event: 'StopFailure',
      ts: 1,
      failureReason: 'unknown'
    })
    expect(getRestorableTerminalEntries({}).some((e) => e.sessionId === 'S-resumed')).toBe(true)
    handleHookTaskEvent({
      sessionId: 'S-resumed',
      taskState: 'working',
      event: 'UserPromptSubmit',
      ts: 2
    })
    expect(getRestorableTerminalEntries({}).some((e) => e.sessionId === 'S-resumed')).toBe(false)
  })
})
