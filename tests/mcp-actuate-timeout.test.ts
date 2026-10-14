/**
 * T478 — a mutating verb that opts out of replay (`replayable: false`, i.e. `spawn_terminal`) has
 * no idempotency `callId`, but it is still a mutation: when it trips the tool deadline it must
 * keep its `:timeout` shadow entry and its late-completion audit + shadow, exactly as a
 * replayable mutation does. A read never gets either.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (): string => '/tmp', getAppPath: (): string => '/tmp' },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

const shadow = vi.hoisted(() => ({ entries: [] as Array<{ event: string }> }))
vi.mock('../src/main/responder-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  pushShadowEntry: (e: { event: string }): void => {
    shadow.entries.push(e)
  }
}))

import { actuate } from '../src/main/mcp/server'
import { TOOL_CALL_DEADLINE_MS } from '../src/main/mcp/deadline'
import { getAuditLog } from '../src/main/mcp/audit-log'
import { _resetIdempotencyRegistry } from '../src/main/mcp/idempotency-registry'
import type { McpToolDef } from '../src/main/mcp/tool-catalog'

type Ctx = Parameters<typeof actuate>[2]
const ctx = { folder: '/work/app', folders: [], denyFolders: [], bridge: undefined } as Ctx
const ok: CallToolResult = { content: [{ type: 'text', text: '{"ok":true}' }] }

function def(over: Partial<McpToolDef>, handler: McpToolDef['handler']): McpToolDef {
  return {
    name: 'x',
    description: 'x',
    inputSchema: {} as never,
    mutates: true,
    op: 'spawn_terminal',
    handler,
    ...over
  } as McpToolDef
}

/** Run one call whose handler settles AFTER the deadline, and let the late settlement land. */
async function runLate(d: McpToolDef): Promise<CallToolResult> {
  let release!: () => void
  const slow = new Promise<CallToolResult>((resolve) => {
    release = () => resolve(ok)
  })
  d.handler = (): Promise<CallToolResult> => slow
  const p = actuate(d, {}, ctx)
  await vi.advanceTimersByTimeAsync(TOOL_CALL_DEADLINE_MS + 1)
  const res = await p
  release()
  await vi.advanceTimersByTimeAsync(1)
  return res
}

const lateAudits = (): number => getAuditLog().filter((r) => r.verdict === 'late-completion').length

beforeEach(() => {
  vi.useFakeTimers()
  shadow.entries.length = 0
  _resetIdempotencyRegistry()
})
afterEach(() => vi.useRealTimers())

describe('actuate — TOOL_TIMEOUT trail for a non-replayable mutation', () => {
  it('a replayable mutation keeps its timeout shadow entry and late-completion trail (baseline)', async () => {
    const before = lateAudits()
    const res = await runLate(def({ op: 'create_session' }, undefined))
    expect(res.isError).toBe(true)
    expect(shadow.entries.map((e) => e.event)).toEqual([
      'mcp:create_session:timeout',
      'mcp:create_session:late-success'
    ])
    expect(lateAudits()).toBe(before + 1)
  })

  it('a non-replayable mutation (spawn_terminal) keeps the SAME trail', async () => {
    const before = lateAudits()
    const res = await runLate(def({ op: 'spawn_terminal', replayable: false }, undefined))
    expect(res.isError).toBe(true)
    expect(shadow.entries.map((e) => e.event)).toEqual([
      'mcp:spawn_terminal:timeout',
      'mcp:spawn_terminal:late-success'
    ])
    expect(lateAudits()).toBe(before + 1)
  })

  it('a read leaves no mutation trail', async () => {
    const before = lateAudits()
    await runLate(def({ op: 'list_terminals', mutates: false }, undefined))
    expect(shadow.entries).toEqual([])
    expect(lateAudits()).toBe(before)
  })
})
