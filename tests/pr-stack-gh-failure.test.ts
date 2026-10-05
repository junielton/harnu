/**
 * BUG-148 — a slow or failed `gh pr list` must not read as "GitHub CLI is
 * unavailable". `gh` is faked at the `execFile` seam so each test picks the
 * failure; `git` runs for real against a throwaway repo.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { classifyGhFailure } from '../src/main/pr-stack-core'

type Fail = Record<string, unknown> & { message: string }

const gh = vi.hoisted(() => ({
  fail: null as null | Record<string, unknown>,
  listOpts: null as null | { timeout?: number; maxBuffer?: number }
}))

vi.mock('electron', () => ({ ipcMain: { handle: (): void => {} } }))
vi.mock('../src/main/appimage-env', () => ({
  spawnEnvOnce: async (): Promise<Record<string, string>> => ({ ...process.env }) as never
}))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  type Cb = (err: Error | null, out?: { stdout: string; stderr: string }) => void
  const execFile = (file: string, args: string[], opts: object, cb: Cb): void => {
    if (file === 'gh') {
      // Only the PR list is under test; the thread query always succeeds empty.
      if (args[0] === 'api') return cb(null, { stdout: '{}', stderr: '' })
      gh.listOpts = opts as typeof gh.listOpts
      if (gh.fail) return cb(Object.assign(new Error('gh failed'), gh.fail))
      return cb(null, { stdout: '[]', stderr: '' })
    }
    real.execFile(file, args, opts, (err, stdout, stderr) =>
      err ? cb(err) : cb(null, { stdout: String(stdout), stderr: String(stderr) })
    )
  }
  return { ...real, execFile }
})

let repo: string
beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-gh-failure-'))
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
})
beforeEach(() => {
  gh.fail = null
  gh.listOpts = null
})

const TIMEOUT: Fail = { killed: true, signal: 'SIGTERM', code: null, message: 'timed out' }
const ENOENT: Fail = { code: 'ENOENT', message: 'spawn gh ENOENT' }

describe('classifyGhFailure', () => {
  it('reads a killed/timed-out child as a transient timeout', () => {
    expect(classifyGhFailure(TIMEOUT)).toBe('timeout')
    expect(classifyGhFailure({ code: 'ETIMEDOUT' })).toBe('timeout')
  })

  it('reads a buffer overflow as output-too-large', () => {
    expect(classifyGhFailure({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })).toBe('outputTooLarge')
  })

  it('reads network errors and rate limits as network', () => {
    expect(classifyGhFailure({ code: 1, stderr: 'error connecting to api.github.com' })).toBe(
      'network'
    )
    expect(
      classifyGhFailure({ code: 1, stderr: 'dial tcp: lookup api.github.com: no such host' })
    ).toBe('network')
    expect(classifyGhFailure({ code: 1, stderr: 'GraphQL: API rate limit exceeded' })).toBe(
      'network'
    )
  })

  it('reads a missing binary, no auth, or a non-GitHub remote as genuinely unavailable', () => {
    expect(classifyGhFailure(ENOENT)).toBeNull()
    expect(
      classifyGhFailure({
        code: 4,
        stderr: 'To get started with GitHub CLI, please run: gh auth login'
      })
    ).toBeNull()
    expect(
      classifyGhFailure({
        code: 1,
        stderr:
          'none of the git remotes configured for this repository point to a known GitHub host'
      })
    ).toBeNull()
  })

  it('treats an unrecognised failure as transient, never as "unavailable"', () => {
    expect(classifyGhFailure({ code: 1, stderr: 'something odd' })).toBe('other')
    expect(classifyGhFailure(new Error('boom'))).toBe('other')
    expect(classifyGhFailure('not even an error')).toBe('other')
  })
})

describe('loadPrStack gh failure handling', () => {
  it('a timeout is a refresh failure, not an unavailable CLI', async () => {
    gh.fail = TIMEOUT
    const { loadPrStack } = await import('../src/main/pr-stack')
    const snap = await loadPrStack(repo)
    expect(snap.ghAvailable).toBe(true)
    expect(snap.ghFailure).toBe('timeout')
  })

  it('ENOENT stays ghAvailable: false with no refresh failure', async () => {
    gh.fail = ENOENT
    const { loadPrStack } = await import('../src/main/pr-stack')
    const snap = await loadPrStack(repo)
    expect(snap.ghAvailable).toBe(false)
    expect(snap.ghFailure).toBeNull()
  })

  it('a healthy answer carries no failure', async () => {
    const { loadPrStack } = await import('../src/main/pr-stack')
    const snap = await loadPrStack(repo)
    expect(snap.ghAvailable).toBe(true)
    expect(snap.ghFailure).toBeNull()
  })

  it('gives the PR list the shared bulk budget, not the 15s network one', async () => {
    const { loadPrStack } = await import('../src/main/pr-stack')
    const { GH_PR_LIST_OPTS } = await import('../src/main/reaper/scan-core')
    await loadPrStack(repo)
    expect(gh.listOpts?.timeout).toBe(GH_PR_LIST_OPTS.timeout)
    expect(gh.listOpts?.maxBuffer).toBe(GH_PR_LIST_OPTS.maxBuffer)
    expect(gh.listOpts?.timeout).toBeGreaterThan(15_000)
  })
})
