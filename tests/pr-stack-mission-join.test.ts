/**
 * T358 S6 — `findPrsForWorktrees`, the one narrow join `mission_get` reads PRs
 * and commits through (design `docs/specs/2026-09-26-mission-progress/design.md`
 * §7: "join against pr-stack.ts … the same way the Folder View's PR Stack does").
 *
 * `git` runs for real against a throwaway repo; `gh` is faked at the
 * `execFile` seam so the test controls whether it is installed. The T360 smoke
 * test (Q3) is the reason the absent case matters: PR data depends on `gh`, and
 * a machine without it must degrade to "no PR data", never to an error.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const gh = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'absent',
  calls: 0,
  stdout: '[]',
  /** How long `gh` takes to answer (Mission v3 S2 single-flight tests). */
  delayMs: 0
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
      gh.calls++
      const mode = gh.mode
      const stdout = gh.stdout
      setTimeout(() => {
        if (mode === 'absent') cb(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))
        else cb(null, { stdout, stderr: '' })
      }, gh.delayMs)
      return
    }
    real.execFile(file, args, opts, (err, stdout, stderr) =>
      err ? cb(err) : cb(null, { stdout: String(stdout), stderr: String(stderr) })
    )
  }
  return { ...real, execFile }
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

let repo = ''
let wt = ''

beforeAll(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-prjoin-'))
  repo = path.join(base, 'main')
  wt = path.join(base, 'wt')
  await fs.mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(
    repo,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'root'
  )
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/child', wt)
  git(
    wt,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'child work'
  )
})

beforeEach(() => {
  // A fresh module per test: the PR fetch is cached per repo root (Mission v3 §3.8).
  vi.resetModules()
  gh.mode = 'ok'
  gh.calls = 0
  gh.delayMs = 0
  gh.stdout = JSON.stringify([
    { number: 7, headRefName: 'feat/child', baseRefName: 'main', state: 'OPEN', url: 'u7' },
    { number: 8, headRefName: 'feat/other', baseRefName: 'main', state: 'MERGED', url: 'u8' },
    { number: 9, headRefName: 'feat/child', baseRefName: 'main', state: 'CLOSED', url: 'u9' }
  ])
})

describe('findPrsForWorktrees', () => {
  it('joins a worktree to its branch, its head commit and the PRs whose head is that branch', async () => {
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    const j = await findPrsForWorktrees(repo, { worktrees: [wt], branches: [], numbers: [] })
    expect(j.ghAvailable).toBe(true)
    const w = j.worktrees[wt]
    expect(w.exists).toBe(true)
    expect(w.branch).toBe('feat/child')
    expect(w.head?.subject).toBe('child work')
    expect(w.head?.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(Number.isFinite(Date.parse(w.head?.at ?? ''))).toBe(true)
    expect(w.prs.map((p) => p.number).sort()).toEqual([7, 9])
  })

  it('joins bare branches and PR numbers from ONE gh call', async () => {
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    const j = await findPrsForWorktrees(repo, {
      worktrees: [wt],
      branches: ['feat/other'],
      numbers: [8, 404]
    })
    expect(gh.calls).toBe(1)
    expect(j.branches['feat/other'].map((p) => p.number)).toEqual([8])
    expect(j.numbers[8]?.state).toBe('MERGED')
    expect(j.numbers[404]).toBeNull()
  })

  it('a missing worktree path is exists: false, not a throw', async () => {
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    const gone = path.join(os.tmpdir(), 'harnu-prjoin-does-not-exist')
    const j = await findPrsForWorktrees(repo, { worktrees: [gone], branches: [], numbers: [] })
    expect(j.worktrees[gone]).toEqual({ exists: false, branch: null, head: null, prs: [] })
  })

  it('degrades when gh is absent: ghAvailable false, git data still there, no PRs', async () => {
    gh.mode = 'absent'
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    const j = await findPrsForWorktrees(repo, { worktrees: [wt], branches: ['x'], numbers: [7] })
    expect(j.ghAvailable).toBe(false)
    expect(j.worktrees[wt]).toMatchObject({ exists: true, branch: 'feat/child', prs: [] })
    expect(j.branches.x).toEqual([])
    expect(j.numbers[7]).toBeNull()
  })

  it('never calls gh when there is nothing to join', async () => {
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    const j = await findPrsForWorktrees(repo, { worktrees: [], branches: [], numbers: [] })
    expect(gh.calls).toBe(0)
    expect(j.ghAvailable).toBeNull()
  })
})

describe('the PR fetch behind findPrsForWorktrees (Mission v3 §3.8)', () => {
  const refs = { worktrees: [] as string[], branches: ['feat/other'], numbers: [7] }

  it('is single-flight per repo root: two concurrent joins call gh once', async () => {
    gh.delayMs = 50
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    const [a, b] = await Promise.all([
      findPrsForWorktrees(repo, refs),
      findPrsForWorktrees(repo, { worktrees: [wt], branches: [], numbers: [8] })
    ])
    expect(gh.calls).toBe(1)
    expect(a.numbers[7]?.state).toBe('OPEN')
    expect(b.numbers[8]?.state).toBe('MERGED')
    expect(b.worktrees[wt].prs.map((p) => p.number).sort()).toEqual([7, 9])
  })

  it('is cached for 60 s, then fetched again', async () => {
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    await findPrsForWorktrees(repo, refs)
    await findPrsForWorktrees(repo, refs)
    expect(gh.calls).toBe(1)
    const real = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 60_001)
    try {
      await findPrsForWorktrees(repo, refs)
    } finally {
      spy.mockRestore()
    }
    expect(gh.calls).toBe(2)
  })

  it('does not cache a failure: the next call retries gh', async () => {
    gh.mode = 'absent'
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    expect((await findPrsForWorktrees(repo, refs)).ghAvailable).toBe(false)
    gh.mode = 'ok'
    const j = await findPrsForWorktrees(repo, refs)
    expect(gh.calls).toBe(2)
    expect(j.ghAvailable).toBe(true)
    expect(j.numbers[7]?.state).toBe('OPEN')
  })

  it('keeps one cache per repo root', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-prjoin-other-'))
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    await findPrsForWorktrees(repo, refs)
    await findPrsForWorktrees(other, refs)
    await findPrsForWorktrees(repo, refs)
    expect(gh.calls).toBe(2)
  })

  it('a wait budget answers ghAvailable false in time, while the fetch lands in the cache', async () => {
    gh.delayMs = 300
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    const t0 = Date.now()
    const late = await findPrsForWorktrees(repo, refs, { waitMs: 20 })
    expect(Date.now() - t0).toBeLessThan(250)
    expect(late.ghAvailable).toBe(false)
    expect(late.numbers[7]).toBeNull()
    await new Promise((r) => setTimeout(r, 350))
    const warm = await findPrsForWorktrees(repo, refs, { waitMs: 20 })
    expect(warm.ghAvailable).toBe(true)
    expect(warm.numbers[7]?.state).toBe('OPEN')
    expect(gh.calls).toBe(1)
  })
})
