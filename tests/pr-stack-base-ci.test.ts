/**
 * BUG-294 — `findBaseCi` reads the CI of a base branch's CURRENT tip: one `gh run list --branch`
 * per branch, held for a short window and never kept when it fails. `gh` is faked at the `execFile`
 * seam and the clock is moved with `Date.now`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface Run {
  headSha: string
  status: string
  conclusion: string
}

const gh = vi.hoisted(() => ({
  /** Runs per branch, newest first, as `gh run list --branch <b>` lists them. */
  byBranch: {} as Record<string, Array<{ headSha: string; status: string; conclusion: string }>>,
  log: [] as string[][],
  failOnce: false
}))

vi.mock('electron', () => ({ ipcMain: { handle: (): void => {} } }))
vi.mock('../src/main/appimage-env', () => ({
  spawnEnvOnce: async (): Promise<Record<string, string>> => ({ ...process.env }) as never
}))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  type Cb = (err: Error | null, out?: { stdout: string; stderr: string }) => void
  const execFile = (_file: string, args: string[], _opts: object, cb: Cb): void => {
    gh.log.push(args)
    if (gh.failOnce) {
      gh.failOnce = false
      setTimeout(() => cb(Object.assign(new Error('gh exploded'), { code: 1 })), 0)
      return
    }
    const branch = args[args.indexOf('--branch') + 1]
    setTimeout(() => cb(null, { stdout: JSON.stringify(gh.byBranch[branch] ?? []), stderr: '' }), 0)
  }
  return { ...real, execFile }
})

const ok = (sha: string): Run => ({ headSha: sha, status: 'completed', conclusion: 'success' })
const bad = (sha: string): Run => ({ headSha: sha, status: 'completed', conclusion: 'failure' })
const going = (sha: string): Run => ({ headSha: sha, status: 'in_progress', conclusion: '' })
const MIN = 60_000

let now = 0
const asks = (): number => gh.log.filter((a) => a[0] === 'run').length

beforeEach(() => {
  vi.resetModules()
  gh.byBranch = {}
  gh.log = []
  gh.failOnce = false
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('findBaseCi', () => {
  it('reads the verdict of the newest commit that has runs, not of older ones', async () => {
    const { findBaseCi } = await import('../src/main/pr-stack')
    // Newest first: the tip (b) is green; an older commit (a) failed.
    gh.byBranch.main = [ok('b'), ok('b'), bad('a')]
    expect(await findBaseCi('/tmp/r', ['main'])).toEqual({
      ghAvailable: true,
      byBase: { main: 'passing' }
    })
    expect(asks()).toBe(1)
  })

  it('a failing run on the tip commit makes the tip failing; one still going makes it pending', async () => {
    const { findBaseCi } = await import('../src/main/pr-stack')
    gh.byBranch.main = [ok('b'), bad('b'), ok('a')]
    gh.byBranch.release = [going('c'), ok('c')]
    const r = await findBaseCi('/tmp/r', ['main', 'release'])
    expect(r.byBase).toEqual({ main: 'failing', release: 'pending' })
  })

  it('a branch with no runs is unknown', async () => {
    const { findBaseCi } = await import('../src/main/pr-stack')
    expect((await findBaseCi('/tmp/r', ['main'])).byBase.main).toBe('unknown')
  })

  it('asks once per branch however many callers ask, and again after the window', async () => {
    const { findBaseCi } = await import('../src/main/pr-stack')
    gh.byBranch.main = [bad('a')]
    await Promise.all([findBaseCi('/tmp/r', ['main']), findBaseCi('/tmp/r', ['main'])])
    expect(asks()).toBe(1)
    now += 30_000
    await findBaseCi('/tmp/r', ['main'])
    expect(asks()).toBe(1)
    // A fix landed: the tip must show within a minute, not after the merge commit's ten.
    gh.byBranch.main = [ok('b'), bad('a')]
    now += 31_000
    expect((await findBaseCi('/tmp/r', ['main'])).byBase.main).toBe('passing')
    expect(asks()).toBe(2)
    now += 5 * MIN
    await findBaseCi('/tmp/r', ['main'])
    expect(asks()).toBe(3)
  })

  it('a failed read is "could not read" and is not kept', async () => {
    const { findBaseCi } = await import('../src/main/pr-stack')
    gh.byBranch.main = [ok('a')]
    gh.failOnce = true
    expect(await findBaseCi('/tmp/r', ['main'])).toEqual({ ghAvailable: false, byBase: {} })
    expect((await findBaseCi('/tmp/r', ['main'])).byBase.main).toBe('passing')
    expect(asks()).toBe(2)
  })

  it('asks nothing for no branches', async () => {
    const { findBaseCi } = await import('../src/main/pr-stack')
    expect(await findBaseCi('/tmp/r', [])).toEqual({ ghAvailable: null, byBase: {} })
    expect(asks()).toBe(0)
  })
})
