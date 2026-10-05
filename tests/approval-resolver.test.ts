import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Tests for the Approval Inbox parking resolver (approval-inbox spec §5.x). The
 * `electron` mock points app.getPath at a tmpdir (so writeMode persists) and
 * captures ipcMain handlers; a fake window captures the streamed events.
 */

let userDataDir = ''
const handlers = new Map<string, (...a: unknown[]) => unknown>()
const sent: Array<{ channel: string; payload: unknown }> = []

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn) }
}))

import {
  approvalResolver,
  respondApproval,
  listPendingApprovals,
  registerApprovalResolver,
  closeApprovals,
  _resetApprovals
} from '../src/main/approval-resolver'
import {
  writeMode,
  setInterceptFolders,
  getShadowLog,
  _resetResponderState
} from '../src/main/responder-registry'
import { parseHookRequest } from '../src/main/responder-dispatch'

/** The worktree folder used as the ramp target for the active parking tests. */
const WT = '/repo/wt'

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const bashReq = (): ReturnType<typeof parseHookRequest> =>
  parseHookRequest(
    'PreToolUse',
    undefined,
    { session_id: 'S1', cwd: WT, tool_name: 'Bash', tool_input: { command: 'ls' } },
    'S1'
  )

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'approval-'))
  handlers.clear()
  sent.length = 0
  _resetResponderState()
  _resetApprovals()
  registerApprovalResolver({ getWindow: () => fakeWin as never })
})

describe('approvalResolver — mode gating', () => {
  it('abstains synchronously in shadow (no parking, zero latency)', async () => {
    await writeMode('shadow')
    const r = approvalResolver.resolve(bashReq(), new AbortController().signal)
    expect(r).toBeNull()
    expect(listPendingApprovals()).toHaveLength(0)
  })

  it('abstains in off', async () => {
    await writeMode('off')
    expect(approvalResolver.resolve(bashReq(), new AbortController().signal)).toBeNull()
  })

  it('abstains for a non-tool-gate event even in active', async () => {
    await writeMode('active')
    setInterceptFolders([WT]) // arm the per-folder ramp so active parks this folder
    const req = parseHookRequest(
      'UserPromptSubmit',
      undefined,
      { session_id: 'S1', prompt: 'hi' },
      'S1'
    )
    expect(approvalResolver.resolve(req, new AbortController().signal)).toBeNull()
  })

  it('active + folder OFF the ramp → preview (no park, one would-gate shadow entry)', async () => {
    await writeMode('active')
    setInterceptFolders(['/some/other/folder']) // WT is NOT on the ramp
    const r = approvalResolver.resolve(bashReq(), new AbortController().signal)
    expect(r).toBeNull() // never blocked off-ramp
    expect(listPendingApprovals()).toHaveLength(0)
    const log = getShadowLog()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ sessionId: 'S1', by: 'approval-inbox', event: 'PreToolUse' })
    expect(log[0].summary).toContain('Bash')
  })

  it('shadow mode → preview (would-gate entry) for a gated event', async () => {
    await writeMode('shadow')
    approvalResolver.resolve(bashReq(), new AbortController().signal)
    expect(listPendingApprovals()).toHaveLength(0)
    expect(getShadowLog()).toHaveLength(1)
  })
})

describe('approvalResolver — parking + resolution (active)', () => {
  it('parks a tool call, streams it pending, and resolves on Allow/Deny', async () => {
    await writeMode('active')
    setInterceptFolders([WT]) // arm the per-folder ramp so active parks this folder
    const ctrl = new AbortController()
    const p = approvalResolver.resolve(bashReq(), ctrl.signal) as Promise<unknown>
    await tick()
    const pendingEv = sent.find((s) => s.channel === 'hook:approval:pending')
    expect(pendingEv).toBeTruthy()
    const wire = pendingEv!.payload as {
      requestId: string
      toolName: string
      toolInput: Record<string, string>
    }
    expect(wire.toolName).toBe('Bash')
    expect(wire.toolInput).toEqual({ command: 'ls' })
    expect(listPendingApprovals()).toHaveLength(1)

    expect(respondApproval(wire.requestId, 'deny')).toBe(true)
    expect(await p).toEqual({ permissionDecision: 'deny', by: 'approval-inbox' })
    expect(sent.find((s) => s.channel === 'hook:approval:resolved')?.payload).toEqual({
      requestId: wire.requestId,
      reason: 'decided'
    })
    expect(listPendingApprovals()).toHaveLength(0)
  })

  it('fails open (null) + streams timeout when the deadline aborts', async () => {
    await writeMode('active')
    setInterceptFolders([WT]) // arm the per-folder ramp so active parks this folder
    const ctrl = new AbortController()
    const p = approvalResolver.resolve(bashReq(), ctrl.signal) as Promise<unknown>
    await tick()
    expect(listPendingApprovals()).toHaveLength(1)
    ctrl.abort()
    expect(await p).toBeNull()
    expect(sent.find((s) => s.channel === 'hook:approval:resolved')?.payload).toMatchObject({
      reason: 'timeout'
    })
    expect(listPendingApprovals()).toHaveLength(0)
  })

  it('respondApproval returns false for an unknown / already-settled request', async () => {
    expect(respondApproval('nope', 'allow')).toBe(false)
    await writeMode('active')
    setInterceptFolders([WT]) // arm the per-folder ramp so active parks this folder
    const ctrl = new AbortController()
    const p = approvalResolver.resolve(bashReq(), ctrl.signal) as Promise<unknown>
    await tick()
    const id = (sent[0].payload as { requestId: string }).requestId
    expect(respondApproval(id, 'allow')).toBe(true)
    expect(respondApproval(id, 'deny')).toBe(false) // already settled
    await p
  })
})

describe('hook:respond IPC validation (lesson security/001)', () => {
  it('rejects an empty requestId or a non allow/deny decision', async () => {
    const respond = handlers.get('hook:respond')!
    expect(await respond({}, { requestId: '', decision: 'allow' })).toEqual({ ok: false })
    expect(await respond({}, { requestId: 'x', decision: 'maybe' })).toEqual({ ok: false })
    expect(await respond({}, { requestId: 'x' })).toEqual({ ok: false })
    expect(await respond({}, { requestId: 'unknown-id', decision: 'allow' })).toEqual({ ok: false })
  })

  it('hook:approvals:list returns the live parked wires', async () => {
    await writeMode('active')
    setInterceptFolders([WT]) // arm the per-folder ramp so active parks this folder
    approvalResolver.resolve(bashReq(), new AbortController().signal)
    await tick()
    const list = handlers.get('hook:approvals:list')!
    expect((await list()) as unknown[]).toHaveLength(1)
  })
})

describe('closeApprovals teardown', () => {
  it('settles every parked approval as timeout and clears', async () => {
    await writeMode('active')
    setInterceptFolders([WT]) // arm the per-folder ramp so active parks this folder
    const p = approvalResolver.resolve(bashReq(), new AbortController().signal) as Promise<unknown>
    await tick()
    closeApprovals()
    expect(await p).toBeNull()
    expect(listPendingApprovals()).toHaveLength(0)
  })
})
