import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const createWorktreeMock = vi.hoisted(() => vi.fn())
vi.mock('../src/main/worktree-ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/worktree-ipc')>()
  return { ...actual, createWorktree: createWorktreeMock }
})

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { WorktreeProvisionError } from '../src/main/worktree-manifest'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'

const createWorktreeHandler = WIRED_TOOLS.find((t) => t.op === 'create_worktree')!.handler!

const baseCtx = { folder: '/repo', folders: [], denyFolders: [], bridge: undefined }

function textPayload(res: CallToolResult): Record<string, unknown> {
  const first = res.content[0]
  if (!first || first.type !== 'text') throw new Error('expected a text content block')
  return JSON.parse(first.text)
}

describe('createWorktreeHandler — BUG-28 structured MCP ACK', () => {
  // NB: each test sets its own mock behavior via mockRejectedValue/mockResolvedValue
  // before invoking the handler, so no beforeEach reset is needed here — and
  // `createWorktreeMock.mockReset()` in a beforeEach was observed to make Vitest
  // misreport a resolved call as an unhandled rejection with this vi.mock('../src/main/worktree-ipc', importOriginal) setup.

  it('returns a structured isError result naming the missing binary, rolledBack, and the deleted branch', async () => {
    createWorktreeMock.mockRejectedValue(
      new WorktreeProvisionError({
        stage: 'setup',
        step: { index: 1, total: 1 },
        command: 'npm ci',
        kind: 'binary-missing',
        binary: 'npm',
        path: '/usr/bin',
        rolledBack: true,
        branchDeleted: 'feat/x'
      })
    )
    const res = await createWorktreeHandler({ branch: 'feat/x' }, baseCtx)
    expect(res.isError).toBe(true)
    const payload = textPayload(res)
    expect(payload.error).toBe('WORKTREE_PROVISION_FAILED')
    expect(payload.kind).toBe('binary-missing')
    expect(payload.binary).toBe('npm')
    expect(payload.rolledBack).toBe(true)
    expect(payload.branchDeleted).toBe('feat/x')
    // Acceptance: an agent reads this and never needs to probe `list_worktrees`.
    expect(payload.stage).toBe('setup')
    expect(payload.command).toBe('npm ci')
  })

  it('carries stage/step/command and no binary field for a command-failed error', async () => {
    createWorktreeMock.mockRejectedValue(
      new WorktreeProvisionError({
        stage: 'setup',
        step: { index: 2, total: 3 },
        command: 'npm run build',
        kind: 'command-failed',
        exitCode: 1,
        stderr: 'Error: broke',
        rolledBack: true,
        branchDeleted: 'feat/x'
      })
    )
    const res = await createWorktreeHandler({ branch: 'feat/x' }, baseCtx)
    expect(res.isError).toBe(true)
    const payload = textPayload(res)
    expect(payload.stage).toBe('setup')
    expect(payload.step).toEqual({ index: 2, total: 3 })
    expect(payload.command).toBe('npm run build')
    expect(payload.binary).toBeUndefined()
    expect(payload.exitCode).toBe(1)
  })

  it('propagates a non-provision error unchanged (e.g. an unsafe-target validation failure)', async () => {
    createWorktreeMock.mockRejectedValue(
      new Error('worktree target resolves to an unsafe path: /x')
    )
    await expect(createWorktreeHandler({ branch: 'feat/x' }, baseCtx)).rejects.toThrow(
      'worktree target resolves to an unsafe path: /x'
    )
  })

  it('returns the normal ok:true ACK on success (regression guard)', async () => {
    createWorktreeMock.mockResolvedValue({
      path: '/wt/feat-x',
      base: 'main',
      branch: 'feat/x',
      adopted: { path: '/wt/feat-x' },
      warnings: []
    })
    const res = await createWorktreeHandler({ branch: 'feat/x' }, baseCtx)
    expect(res.isError).toBeUndefined()
    const payload = textPayload(res)
    expect(payload.ok).toBe(true)
    expect(payload.path).toBe('/wt/feat-x')
  })
})
