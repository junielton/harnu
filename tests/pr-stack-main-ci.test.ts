/**
 * BUG-240 S-1 — `findMainCi` (the campaign `main` gate) must not re-ask GitHub for
 * what it already knows: a merged PR's merge commit never changes, and a finished
 * CI run only changes on a re-run. `gh` is faked at the `execFile` seam and the clock
 * is moved with `Date.now`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const gh = vi.hoisted(() => ({
  oid: 'a'.repeat(40) as string | null,
  runs: [] as Array<{ status: string; conclusion: string }>,
  log: [] as string[][],
  delayMs: 0
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
    const stdout =
      args[0] === 'pr'
        ? JSON.stringify({ mergeCommit: gh.oid ? { oid: gh.oid } : null })
        : JSON.stringify(gh.runs)
    setTimeout(() => cb(null, { stdout, stderr: '' }), gh.delayMs)
  }
  return { ...real, execFile }
})

const passing = [{ status: 'completed', conclusion: 'success' }]
const failing = [{ status: 'completed', conclusion: 'failure' }]
const running = [{ status: 'in_progress', conclusion: '' }]
const MIN = 60_000

let now = 0
const asks = (kind: 'pr' | 'run'): number => gh.log.filter((a) => a[0] === kind).length

beforeEach(() => {
  vi.resetModules()
  gh.oid = 'a'.repeat(40)
  gh.runs = passing
  gh.log = []
  gh.delayMs = 0
  now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('findMainCi', () => {
  it('main CI is cached by merge commit and re-checked on a schedule', async () => {
    const { findMainCi } = await import('../src/main/pr-stack')
    const repo = '/tmp/some-repo'

    // First ask: one merge-commit lookup, one run list.
    let r = await findMainCi(repo, [7])
    expect(r.byNumber[7]).toBe('passing')
    expect([asks('pr'), asks('run')]).toEqual([1, 1])

    // A passing verdict is not re-asked for 10 minutes; the merge commit never is.
    now += 9 * MIN
    r = await findMainCi(repo, [7])
    expect(r.byNumber[7]).toBe('passing')
    expect([asks('pr'), asks('run')]).toEqual([1, 1])

    // After the window it asks the runs again (and only the runs); a re-run that
    // went red is reported.
    gh.runs = failing
    now += 2 * MIN
    r = await findMainCi(repo, [7])
    expect(r.byNumber[7]).toBe('failing')
    expect([asks('pr'), asks('run')]).toEqual([1, 2])

    // A failing verdict is held for 10 minutes too.
    now += 5 * MIN
    await findMainCi(repo, [7])
    expect(asks('run')).toBe(2)
  })

  it('re-asks a pending verdict after 60 s', async () => {
    const { findMainCi } = await import('../src/main/pr-stack')
    gh.runs = running
    expect((await findMainCi('/tmp/r', [7])).byNumber[7]).toBe('pending')
    now += 30_000
    await findMainCi('/tmp/r', [7])
    expect(asks('run')).toBe(1)
    gh.runs = passing
    now += 31_000
    expect((await findMainCi('/tmp/r', [7])).byNumber[7]).toBe('passing')
    expect([asks('pr'), asks('run')]).toEqual([1, 2])
  })

  it('holds an empty verdict (no runs) for 10 minutes', async () => {
    const { findMainCi } = await import('../src/main/pr-stack')
    gh.runs = []
    expect((await findMainCi('/tmp/r', [7])).byNumber[7]).toBe('unknown')
    now += 5 * MIN
    await findMainCi('/tmp/r', [7])
    expect(asks('run')).toBe(1)
    now += 6 * MIN
    await findMainCi('/tmp/r', [7])
    expect(asks('run')).toBe(2)
  })

  it('does not keep a lookup that found no merge commit', async () => {
    const { findMainCi } = await import('../src/main/pr-stack')
    gh.oid = null
    expect((await findMainCi('/tmp/r', [7])).byNumber[7]).toBeNull()
    gh.oid = 'b'.repeat(40)
    expect((await findMainCi('/tmp/r', [7])).byNumber[7]).toBe('passing')
    expect(asks('pr')).toBe(2)
  })

  it('shares one lookup between concurrent callers', async () => {
    const { findMainCi } = await import('../src/main/pr-stack')
    gh.delayMs = 30
    await Promise.all([findMainCi('/tmp/r', [7, 8]), findMainCi('/tmp/r', [7])])
    expect(asks('pr')).toBe(2) // one per PR number, not per caller
    expect(asks('run')).toBe(2)
  })

  it('keeps one verdict per repo', async () => {
    const { findMainCi } = await import('../src/main/pr-stack')
    await findMainCi('/tmp/r1', [7])
    await findMainCi('/tmp/r2', [7])
    expect(asks('pr')).toBe(2)
  })
})
