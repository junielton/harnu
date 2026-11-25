import { describe, it, expect, afterEach, vi } from 'vitest'
import { request } from 'node:http'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/your-move-hook-payload', isPackaged: false },
  ipcMain: { handle: () => undefined, on: () => undefined }
}))

import {
  startHookServer,
  handleBridgeEvent,
  addTaskEventObserver,
  type BridgeEvent,
  type HookTaskEvent
} from '../../src/main/hook-bridge'
import { resetHubForTests } from '../../src/main/detect/task-state-hub'
import { buildHookSettingsBlob } from '../../src/main/hook-settings-blob'

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

describe('hook payload fields for in-main observers', () => {
  let close: (() => Promise<void>) | null = null
  afterEach(async () => {
    if (close) await close()
    close = null
    resetHubForTests()
  })

  it('a Stop POST reaches observers with transcriptPath, cwd and lastAssistantMessage', async () => {
    const events: BridgeEvent[] = []
    const started = await startHookServer((e) => events.push(e), 'tok')
    close = started.close
    await post(started.port, '/hook/tok/Stop/_', {
      session_id: 'S1',
      transcript_path: '/tmp/x/S1.jsonl',
      cwd: '/work/acme',
      last_assistant_message: 'Shall I continue?'
    })
    expect(events[0].payload).toEqual({
      transcriptPath: '/tmp/x/S1.jsonl',
      cwd: '/work/acme',
      lastAssistantMessage: 'Shall I continue?'
    })
  })

  it('a UserPromptSubmit POST reaches observers with prompt', async () => {
    const events: BridgeEvent[] = []
    const started = await startHookServer((e) => events.push(e), 'tok')
    close = started.close
    await post(started.port, '/hook/tok/UserPromptSubmit/_', {
      session_id: 'S1',
      prompt: 'Go'
    })
    expect(events[0].payload).toEqual({ prompt: 'Go' })
  })

  it('ignores payload fields that are not strings', async () => {
    const events: BridgeEvent[] = []
    const started = await startHookServer((e) => events.push(e), 'tok')
    close = started.close
    await post(started.port, '/hook/tok/Stop/_', {
      session_id: 'S1',
      transcript_path: 7,
      cwd: { a: 1 },
      prompt: null,
      last_assistant_message: ['x']
    })
    expect(events[0].payload).toBeUndefined()
  })

  it('observers receive the payload; the renderer claude:hook payload carries none of these fields', () => {
    const seen: HookTaskEvent[] = []
    const off = addTaskEventObserver((e) => seen.push(e))
    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { send } }
    handleBridgeEvent(
      {
        sessionId: 'S9',
        event: 'Stop',
        ts: 1,
        payload: { transcriptPath: '/t.jsonl', cwd: '/c', lastAssistantMessage: 'hi', prompt: 'p' }
      },
      () => win as never
    )
    off()
    expect(seen[0].payload).toEqual({
      transcriptPath: '/t.jsonl',
      cwd: '/c',
      lastAssistantMessage: 'hi',
      prompt: 'p'
    })
    const rendered = send.mock.calls.find((c) => c[0] === 'claude:hook')?.[1]
    expect(rendered).toBeDefined()
    expect(JSON.stringify(rendered)).not.toMatch(
      /transcriptPath|lastAssistantMessage|"prompt"|"cwd"/
    )
    expect(rendered.payload).toBeUndefined()
  })

  it('the response body is still {} with no decision field', async () => {
    const started = await startHookServer(() => undefined, 'tok')
    close = started.close
    const res = await post(started.port, '/hook/tok/Stop/_', {
      session_id: 'S1',
      transcript_path: '/t.jsonl',
      last_assistant_message: 'x'
    })
    expect(res.status).toBe(200)
    expect(res.text).toBe('{}')
  })

  it('the per-session blob subscribes StopFailure', () => {
    const blob = buildHookSettingsBlob(1234, 'tok')
    expect(Object.keys(blob.hooks)).toContain('StopFailure')
    expect(JSON.stringify(blob.hooks.StopFailure)).toContain('/hook/tok/StopFailure/_')
  })
})
