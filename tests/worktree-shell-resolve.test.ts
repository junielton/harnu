import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
const accessMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => {
  const CUSTOM = Symbol.for('nodejs.util.promisify.custom')
  const execFile: unknown = () => {
    throw new Error('execFile called in its callback form — tests only stub the promisified form')
  }
  ;(execFile as Record<symbol, unknown>)[CUSTOM] = (...args: unknown[]) => execFileMock(...args)
  return { execFile }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, access: (...args: unknown[]) => accessMock(...args) }
})

// worktree-ipc.ts (tested further below in this file) imports `electron`.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import {
  defaultShell,
  resolvePosixShell,
  resetPosixShellCacheForTests,
  posixShellRequirementError
} from '../src/main/shell-resolve'

const ORIGINAL_PLATFORM = process.platform
const ORIGINAL_ENV = { ...process.env }

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

beforeEach(() => {
  resetPosixShellCacheForTests()
  execFileMock.mockReset()
  accessMock.mockReset()
  process.env = { ...ORIGINAL_ENV }
  delete process.env.HARNU_POSIX_SHELL
  delete process.env.CAPY_POSIX_SHELL
  delete process.env.ComSpec
  delete process.env.SHELL
})

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM)
  process.env = { ...ORIGINAL_ENV }
})

describe('defaultShell', () => {
  it('uses $SHELL on POSIX, falling back to /bin/bash', () => {
    setPlatform('linux')
    expect(defaultShell()).toBe('/bin/bash')
    process.env.SHELL = '/usr/bin/zsh'
    expect(defaultShell()).toBe('/usr/bin/zsh')
  })

  it('uses %ComSpec% on Windows, falling back to powershell.exe', () => {
    setPlatform('win32')
    expect(defaultShell()).toBe('powershell.exe')
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'
    expect(defaultShell()).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})

describe('resolvePosixShell', () => {
  it('honors the HARNU_POSIX_SHELL escape hatch before probing anything else', async () => {
    process.env.HARNU_POSIX_SHELL = 'C:\\tools\\msys64\\usr\\bin\\bash.exe'
    const resolved = await resolvePosixShell()
    expect(resolved).toBe('C:\\tools\\msys64\\usr\\bin\\bash.exe')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('still honors the pre-rename CAPY_POSIX_SHELL when HARNU_POSIX_SHELL is unset', async () => {
    process.env.CAPY_POSIX_SHELL = 'C:\\legacy\\bash.exe'
    expect(await resolvePosixShell()).toBe('C:\\legacy\\bash.exe')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('prefers HARNU_POSIX_SHELL over CAPY_POSIX_SHELL when both are set', async () => {
    process.env.HARNU_POSIX_SHELL = 'C:\\new\\bash.exe'
    process.env.CAPY_POSIX_SHELL = 'C:\\legacy\\bash.exe'
    expect(await resolvePosixShell()).toBe('C:\\new\\bash.exe')
  })

  it('falls back to `where.exe bash` when no override is set', async () => {
    execFileMock.mockResolvedValue({
      stdout: 'C:\\Program Files\\Git\\bin\\bash.exe\r\n',
      stderr: ''
    })
    const resolved = await resolvePosixShell()
    expect(resolved).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
    expect(execFileMock).toHaveBeenCalledWith('where.exe', ['bash'], expect.anything())
  })

  it('falls back to the standard Git-for-Windows install paths when where.exe finds nothing', async () => {
    execFileMock.mockRejectedValue(new Error('not found'))
    process.env['ProgramFiles'] = 'C:\\Program Files'
    accessMock.mockImplementation((path: string) =>
      path === 'C:\\Program Files\\Git\\bin\\bash.exe'
        ? Promise.resolve()
        : Promise.reject(new Error('ENOENT'))
    )
    const resolved = await resolvePosixShell()
    expect(resolved).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it('resolves to null when nothing is found', async () => {
    execFileMock.mockRejectedValue(new Error('not found'))
    accessMock.mockRejectedValue(new Error('ENOENT'))
    const resolved = await resolvePosixShell()
    expect(resolved).toBeNull()
  })

  it('caches the result per process — only probes once', async () => {
    execFileMock.mockResolvedValue({ stdout: 'C:\\Program Files\\Git\\bin\\bash.exe', stderr: '' })
    await resolvePosixShell()
    await resolvePosixShell()
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })
})

describe('posixShellRequirementError', () => {
  it('names Git Bash and the HARNU_POSIX_SHELL escape hatch', () => {
    const err = posixShellRequirementError()
    expect(err.message).toMatch(/Git Bash|HARNU_POSIX_SHELL/)
    expect(err.message).toContain('HARNU_POSIX_SHELL')
  })
})

// ---------------------------------------------------------------------------
// worktree-ipc.ts — the injectable seams that consume shell-resolve.ts
// ---------------------------------------------------------------------------

import {
  applySeedPlan,
  runManifestCommand,
  manifestNeedsPosixShell,
  assertPosixShellAvailable
} from '../src/main/worktree-ipc'

describe('runManifestCommand — shell resolution', () => {
  it('runs manifest commands through the resolved POSIX shell on Windows, not "sh"', async () => {
    const runFile = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    await runManifestCommand('npm ci', '/wt/feat-login', {
      runFile,
      platform: () => 'win32',
      resolvePosixShell: async () => 'C:\\Program Files\\Git\\bin\\bash.exe'
    })
    expect(runFile).toHaveBeenCalledWith(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      ['-c', 'npm ci'],
      expect.objectContaining({ cwd: '/wt/feat-login' })
    )
  })

  it('rejects when no POSIX shell resolves on Windows, and never spawns "sh"', async () => {
    const runFile = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    await expect(
      runManifestCommand('npm ci', '/wt/feat-login', {
        runFile,
        platform: () => 'win32',
        resolvePosixShell: async () => null
      })
    ).rejects.toThrow(/Git Bash|CAPY_POSIX_SHELL/)
    expect(runFile).not.toHaveBeenCalled()
  })

  it('still resolves to sh -c on POSIX, unchanged (AC5 regression guard)', async () => {
    const runFile = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    await runManifestCommand('npm ci', '/wt/feat-login', {
      runFile,
      platform: () => 'linux',
      resolvePosixShell: async () => null // never consulted on POSIX
    })
    expect(runFile).toHaveBeenCalledWith(
      'sh',
      ['-c', 'npm ci'],
      expect.objectContaining({ cwd: '/wt/feat-login', env: expect.any(Object) })
    )
  })
})

describe('manifestNeedsPosixShell', () => {
  it('is false for a manifest with no setup steps and no delegated create', () => {
    expect(manifestNeedsPosixShell({ setup: [], create: undefined })).toBe(false)
  })

  it('is true when the manifest has setup steps', () => {
    expect(manifestNeedsPosixShell({ setup: ['npm ci'], create: undefined })).toBe(true)
  })

  it('is true for a delegated create even with no setup steps', () => {
    expect(manifestNeedsPosixShell({ setup: [], create: './scripts/create.sh {branch}' })).toBe(
      true
    )
  })
})

describe('assertPosixShellAvailable — ADR-0005 D3 pre-flight', () => {
  it('resolves immediately when the manifest needs no shell at all', async () => {
    const resolvePosixShellMock = vi.fn()
    await assertPosixShellAvailable(false, {
      platform: () => 'win32',
      resolvePosixShell: resolvePosixShellMock
    })
    expect(resolvePosixShellMock).not.toHaveBeenCalled()
  })

  it('resolves immediately on POSIX regardless of shell resolution', async () => {
    const resolvePosixShellMock = vi.fn()
    await assertPosixShellAvailable(true, {
      platform: () => 'linux',
      resolvePosixShell: resolvePosixShellMock
    })
    expect(resolvePosixShellMock).not.toHaveBeenCalled()
  })

  it('rejects with the D3 error on Windows when no POSIX shell resolves', async () => {
    await expect(
      assertPosixShellAvailable(true, {
        platform: () => 'win32',
        resolvePosixShell: async () => null
      })
    ).rejects.toThrow(/Git Bash|CAPY_POSIX_SHELL/)
  })

  it('resolves on Windows when a POSIX shell is found', async () => {
    await expect(
      assertPosixShellAvailable(true, {
        platform: () => 'win32',
        resolvePosixShell: async () => 'C:\\Program Files\\Git\\bin\\bash.exe'
      })
    ).resolves.toBeUndefined()
  })
})

describe('applySeedPlan — seed copy via fs.cp (D4)', () => {
  it('on Windows, copies via fs.cp and never spawns "cp"', async () => {
    const runFile = vi.fn()
    const fsCp = vi.fn().mockResolvedValue(undefined)
    // lstat/mkdir/rm are real fs calls the module keeps unmocked (not part of
    // this seam) — point the op at real, disposable temp paths instead.
    const os = await import('node:os')
    const path = await import('node:path')
    const fs = await import('node:fs/promises')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bug29-seed-'))
    const from = path.join(dir, 'src.txt')
    const to = path.join(dir, 'dst.txt')
    await fs.writeFile(from, 'hi')

    await applySeedPlan([{ kind: 'copy', entry: 'src.txt', from, to }], [], {
      runFile,
      fsCp,
      platform: () => 'win32'
    })

    expect(runFile).not.toHaveBeenCalled()
    expect(fsCp).toHaveBeenCalledWith(from, to)
  })

  it('on Linux, tries cp --reflink=auto first and never falls back when it succeeds', async () => {
    const runFile = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    const fsCp = vi.fn()
    const os = await import('node:os')
    const path = await import('node:path')
    const fs = await import('node:fs/promises')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bug29-seed-'))
    const from = path.join(dir, 'src.txt')
    const to = path.join(dir, 'dst.txt')
    await fs.writeFile(from, 'hi')

    await applySeedPlan([{ kind: 'copy', entry: 'src.txt', from, to }], [], {
      runFile,
      fsCp,
      platform: () => 'linux'
    })

    expect(runFile).toHaveBeenCalledWith(
      'cp',
      ['-a', '--reflink=auto', from, to],
      expect.anything()
    )
    expect(fsCp).not.toHaveBeenCalled()
  })

  it('on Linux, falls back to fs.cp when the cp runner rejects (AC4)', async () => {
    const runFile = vi.fn().mockRejectedValue(new Error('spawn cp ENOENT'))
    const fsCp = vi.fn().mockResolvedValue(undefined)
    const os = await import('node:os')
    const path = await import('node:path')
    const fs = await import('node:fs/promises')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bug29-seed-'))
    const from = path.join(dir, 'src.txt')
    const to = path.join(dir, 'dst.txt')
    await fs.writeFile(from, 'hi')

    await expect(
      applySeedPlan([{ kind: 'copy', entry: 'src.txt', from, to }], [], {
        runFile,
        fsCp,
        platform: () => 'linux'
      })
    ).resolves.toBeUndefined()

    expect(fsCp).toHaveBeenCalledWith(from, to)
  })
})
