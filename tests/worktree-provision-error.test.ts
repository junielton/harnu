import { beforeEach, describe, expect, it, vi } from 'vitest'

// worktree-ipc.ts pulls in `electron` (ipcMain) — never touched by these seams,
// but the module-level import still needs a stub to load in vitest's node env.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import {
  runManifestCommand,
  rollbackWorktree,
  ManifestCommandFailure
} from '../src/main/worktree-ipc'

beforeEach(() => {
  vi.clearAllMocks()
})

// ── BUG-28: runManifestCommand classifies its failure ──────────────────────

describe('runManifestCommand — BUG-28 failure classification', () => {
  it('throws a ManifestCommandFailure naming the missing binary on exit 127 (dash/sh dialect)', async () => {
    const runFile = vi.fn().mockRejectedValue({
      code: 127,
      stderr: 'sh: 1: npm: not found'
    })
    await expect(
      runManifestCommand('npm ci', '/wt/feat-login', {
        runFile,
        platform: () => 'linux',
        resolvePosixShell: async () => null
      })
    ).rejects.toMatchObject({
      classification: { kind: 'binary-missing', binary: 'npm' }
    })
  })

  it('throws a ManifestCommandFailure classified binary-missing on Node ENOENT', async () => {
    const runFile = vi.fn().mockRejectedValue({ code: 'ENOENT', stderr: '' })
    const err = await runManifestCommand('npm ci', '/wt/feat-login', {
      runFile,
      platform: () => 'linux',
      resolvePosixShell: async () => null
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ManifestCommandFailure)
    expect((err as ManifestCommandFailure).classification.kind).toBe('binary-missing')
  })

  it('throws a ManifestCommandFailure classified command-failed on a real non-zero exit', async () => {
    const runFile = vi.fn().mockRejectedValue({
      code: 1,
      stderr: 'Error: something broke'
    })
    const err = await runManifestCommand('npm run build', '/wt/feat-login', {
      runFile,
      platform: () => 'linux',
      resolvePosixShell: async () => null
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ManifestCommandFailure)
    const failure = err as ManifestCommandFailure
    expect(failure.classification).toEqual({ kind: 'command-failed', exitCode: 1 })
    expect(failure.rawStderr).toBe('Error: something broke')
  })

  it('throws a ManifestCommandFailure classified timeout on a killed/SIGTERM rejection', async () => {
    const runFile = vi.fn().mockRejectedValue({ killed: true, signal: 'SIGTERM', stderr: '' })
    const err = await runManifestCommand('npm ci', '/wt/feat-login', {
      runFile,
      platform: () => 'linux',
      resolvePosixShell: async () => null
    }).catch((e) => e)
    expect(err).toBeInstanceOf(ManifestCommandFailure)
    expect((err as ManifestCommandFailure).classification.kind).toBe('timeout')
  })

  it('still throws before spawning when no POSIX shell resolves on Windows (BUG-29 regression guard)', async () => {
    const runFile = vi.fn()
    await expect(
      runManifestCommand('npm ci', '/wt/feat-login', {
        runFile,
        platform: () => 'win32',
        resolvePosixShell: async () => null
      })
    ).rejects.toThrow(/Git Bash|CAPY_POSIX_SHELL/)
    expect(runFile).not.toHaveBeenCalled()
  })
})

// ── BUG-28: rollbackWorktree reports what it actually undid ────────────────

describe('rollbackWorktree — BUG-28 rollback reporting', () => {
  it('reports rolledBack:true and the deleted branch on a clean rollback', async () => {
    const runFile = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const result = await rollbackWorktree('/repo', '/repo/../wt/feat-x', 'feat/x', { runFile })
    expect(result).toEqual({ rolledBack: true, branchDeleted: 'feat/x' })
    expect(runFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'worktree', 'remove', '--force', '/repo/../wt/feat-x'],
      expect.anything()
    )
    expect(runFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/repo', 'branch', '-D', 'feat/x'],
      expect.anything()
    )
  })

  it('reports rolledBack:false when the worktree remove itself fails', async () => {
    const runFile = vi
      .fn()
      .mockRejectedValueOnce(new Error('worktree remove failed'))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    const result = await rollbackWorktree('/repo', '/repo/../wt/feat-x', 'feat/x', { runFile })
    expect(result.rolledBack).toBe(false)
  })

  it('reports branchDeleted:null (never a lie) when the branch delete itself fails', async () => {
    const runFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // worktree remove ok
      .mockRejectedValueOnce(new Error('branch still checked out')) // branch -D fails
    const result = await rollbackWorktree('/repo', '/repo/../wt/feat-x', 'feat/x', { runFile })
    expect(result).toEqual({ rolledBack: true, branchDeleted: null })
  })

  it('never attempts a branch delete for a ref checkout (createdBranch === null)', async () => {
    const runFile = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const result = await rollbackWorktree('/repo', '/repo/../wt/feat-x', null, { runFile })
    expect(result).toEqual({ rolledBack: true, branchDeleted: null })
    expect(runFile).toHaveBeenCalledTimes(1)
  })
})
