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
  delayMs: 0,
  /** Optional per-call answer (BUG-240 AC-8): receives the `gh` args, returns stdout. */
  respond: null as null | ((args: string[]) => string),
  /** Every `gh` invocation's args, in order. */
  log: [] as string[][]
}))

/** BUG-240: every real `git` spawn the product code makes, in order. */
const gitLog = vi.hoisted(() => ({ calls: [] as string[][] }))

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
      gh.log.push(args)
      const mode = gh.mode
      const stdout = gh.respond ? gh.respond(args) : gh.stdout
      setTimeout(() => {
        if (mode === 'absent') cb(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }))
        else cb(null, { stdout, stderr: '' })
      }, gh.delayMs)
      return
    }
    if (file === 'git') gitLog.calls.push(args)
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
  gh.respond = null
  gh.log = []
  gitLog.calls = []
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

  it('counts the commits the worktree branch holds beyond the default branch (T547)', async () => {
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    const j = await findPrsForWorktrees(repo, { worktrees: [wt], branches: [], numbers: [] })
    expect(j.worktrees[wt].commits).toBe(1)
  })

  it('counts zero commits for the main checkout itself — nothing beyond its own branch (T547)', async () => {
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    const j = await findPrsForWorktrees(repo, { worktrees: [repo], branches: [], numbers: [] })
    expect(j.worktrees[repo].commits).toBe(0)
  })

  describe('a stacked step counts only its own commits (T547)', () => {
    let stacked = ''

    /** feat/base: 20 commits over main; feat/stacked: 5 more on top of feat/base. */
    beforeAll(async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-prjoin-stack-'))
      const base = path.join(dir, 'base')
      stacked = path.join(dir, 'stacked')
      const commit = (cwd: string, n: number): void => {
        for (let i = 0; i < n; i++)
          git(
            cwd,
            '-c',
            'user.email=t@t',
            '-c',
            'user.name=t',
            'commit',
            '-q',
            '--allow-empty',
            '-m',
            `c${i}`
          )
      }
      git(repo, 'worktree', 'add', '-q', '-b', 'feat/base', base)
      commit(base, 20)
      git(repo, 'worktree', 'add', '-q', '-b', 'feat/stacked', stacked, 'feat/base')
      commit(stacked, 5)
    })

    it('counts from the open PR base when the branch has a PR', async () => {
      gh.stdout = JSON.stringify([
        {
          number: 20,
          headRefName: 'feat/stacked',
          baseRefName: 'feat/base',
          state: 'OPEN',
          url: 'u20'
        }
      ])
      const { findPrsForWorktrees } = await import('../src/main/pr-stack')
      const j = await findPrsForWorktrees(repo, { worktrees: [stacked], branches: [], numbers: [] })
      expect(j.worktrees[stacked].commits).toBe(5)
    })

    it('falls back to the default branch when there is no PR', async () => {
      gh.stdout = '[]'
      const { findPrsForWorktrees } = await import('../src/main/pr-stack')
      const j = await findPrsForWorktrees(repo, { worktrees: [stacked], branches: [], numbers: [] })
      expect(j.worktrees[stacked].commits).toBe(25)
    })

    it('falls back to the default branch when gh is absent', async () => {
      gh.mode = 'absent'
      const { findPrsForWorktrees } = await import('../src/main/pr-stack')
      const j = await findPrsForWorktrees(repo, { worktrees: [stacked], branches: [], numbers: [] })
      expect(j.worktrees[stacked].commits).toBe(25)
    })

    it('ignores a closed PR — only an open one names the base', async () => {
      gh.stdout = JSON.stringify([
        {
          number: 21,
          headRefName: 'feat/stacked',
          baseRefName: 'feat/base',
          state: 'CLOSED',
          url: 'u21'
        }
      ])
      const { findPrsForWorktrees } = await import('../src/main/pr-stack')
      const j = await findPrsForWorktrees(repo, { worktrees: [stacked], branches: [], numbers: [] })
      expect(j.worktrees[stacked].commits).toBe(25)
    })

    it('falls back when the PR base is not a ref git knows here', async () => {
      gh.stdout = JSON.stringify([
        {
          number: 22,
          headRefName: 'feat/stacked',
          baseRefName: 'gone/branch',
          state: 'OPEN',
          url: 'u22'
        }
      ])
      const { findPrsForWorktrees } = await import('../src/main/pr-stack')
      const j = await findPrsForWorktrees(repo, { worktrees: [stacked], branches: [], numbers: [] })
      expect(j.worktrees[stacked].commits).toBe(25)
    })
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

// ---------------------------------------------------------------------------
// BUG-240 S-1 — a repeat derive on unchanged worktrees spawns no git.
// ---------------------------------------------------------------------------

const ident = ['-c', 'user.email=t@t', '-c', 'user.name=t']
const commitIn = (cwd: string, msg: string): void => {
  git(cwd, ...ident, 'commit', '-q', '--allow-empty', '-m', msg)
}
/** Spawns that carry `sub` as their git subcommand (`git -C <path> <sub> …`). */
const spawned = (sub: string): number => gitLog.calls.filter((a) => a[2] === sub).length
const refsOf = (
  worktrees: string[]
): Parameters<typeof import('../src/main/pr-stack').findPrsForWorktrees>[1] => ({
  worktrees,
  branches: [],
  numbers: []
})

/** A fresh repo with one root commit on `main` and a linked worktree `feat/x` one commit ahead. */
async function freshRepo(tag: string): Promise<{ repo: string; wt: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `harnu-bug240-${tag}-`))
  const repo = path.join(dir, 'main')
  const wt = path.join(dir, 'wt')
  await fs.mkdir(repo)
  git(repo, 'init', '-q', '-b', 'main')
  commitIn(repo, 'root')
  git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt)
  commitIn(wt, 'x1')
  return { repo, wt, dir }
}

describe('BUG-240: no git spawns when nothing changed', () => {
  it('repeat join on an unchanged worktree spawns no git', async () => {
    const { repo: r, wt: w } = await freshRepo('repeat')
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    const first = await findPrsForWorktrees(r, refsOf([w, r]))
    expect(gitLog.calls.length).toBeGreaterThan(0)
    gitLog.calls = []
    const second = await findPrsForWorktrees(r, refsOf([w, r]))
    expect(gitLog.calls).toEqual([])
    expect(second.worktrees).toEqual(first.worktrees)
    expect(second.worktrees[w]).toMatchObject({ exists: true, branch: 'feat/x', commits: 1 })
  })

  it('a new commit invalidates the cached head and count', async () => {
    const { repo: r, wt: w } = await freshRepo('commit')
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    const before = (await findPrsForWorktrees(r, refsOf([w]))).worktrees[w]
    commitIn(w, 'x2')
    const after = (await findPrsForWorktrees(r, refsOf([w]))).worktrees[w]
    expect(after.head?.sha).toBe(git(w, 'rev-parse', 'HEAD'))
    expect(after.head?.sha).not.toBe(before.head?.sha)
    expect(after.head?.subject).toBe('x2')
    expect(before.commits).toBe(1)
    expect(after.commits).toBe(2)
  })

  it('checkout and a moved base invalidate the cache', async () => {
    const { repo: r, wt: w } = await freshRepo('checkout')
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    expect((await findPrsForWorktrees(r, refsOf([w]))).worktrees[w].branch).toBe('feat/x')
    git(w, 'checkout', '-q', '-b', 'feat/y')
    expect((await findPrsForWorktrees(r, refsOf([w]))).worktrees[w].branch).toBe('feat/y')
    // The base moves: `main` gains a commit that the worktree branch now has too.
    git(r, 'update-ref', 'refs/heads/main', git(w, 'rev-parse', 'HEAD'))
    const moved = (await findPrsForWorktrees(r, refsOf([w]))).worktrees[w]
    expect(moved.commits).toBe(0)
  })

  it('a link that is not a working tree spawns no git', async () => {
    const { dir } = await freshRepo('notwt')
    const file = path.join(dir, 'spec.md')
    const plain = path.join(dir, 'plain')
    await fs.writeFile(file, '# spec')
    await fs.mkdir(plain)
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    const j = await findPrsForWorktrees(path.join(dir, 'main'), refsOf([file, plain]))
    expect(gitLog.calls).toEqual([])
    const gone = { exists: false, branch: null, head: null, prs: [] }
    expect(j.worktrees[file]).toEqual(gone)
    expect(j.worktrees[plain]).toEqual(gone)
  })

  it('default branch is read once per repo', async () => {
    const { repo: r, wt: w, dir } = await freshRepo('default')
    const other = path.join(dir, 'wt2')
    git(r, 'worktree', 'add', '-q', '-b', 'feat/z', other)
    const base = git(r, 'rev-parse', 'main')
    // origin/main = the root, origin/develop = one commit up on feat/x.
    git(r, 'update-ref', 'refs/remotes/origin/main', base)
    git(r, 'update-ref', 'refs/remotes/origin/develop', git(w, 'rev-parse', 'HEAD'))
    git(r, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    commitIn(w, 'x2')
    const { findPrsForWorktrees } = await import('../src/main/pr-stack')
    expect((await findPrsForWorktrees(r, refsOf([w]))).worktrees[w].commits).toBe(2)
    await findPrsForWorktrees(r, refsOf([other]))
    await findPrsForWorktrees(r, refsOf([w, other]))
    expect(spawned('symbolic-ref')).toBeLessThanOrEqual(1)
    // origin/HEAD moves: the next call sees it.
    git(r, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
    expect((await findPrsForWorktrees(r, refsOf([w]))).worktrees[w].commits).toBe(1)
    expect(spawned('symbolic-ref')).toBeLessThanOrEqual(2)
  })

  it('concurrent derives share one lookup', async () => {
    const mergedOid = 'a'.repeat(40)
    gh.respond = (args): string => {
      if (args[0] === 'pr' && args[1] === 'view')
        return JSON.stringify({ mergeCommit: { oid: mergedOid } })
      if (args[0] === 'run') return JSON.stringify([{ status: 'completed', conclusion: 'success' }])
      return gh.stdout
    }
    // One derive in a fresh module is the yardstick for "one set of spawns".
    const a = await freshRepo('conc-a')
    const solo = await import('../src/main/pr-stack')
    await solo.findPrsForWorktrees(a.repo, refsOf([a.wt]))
    await solo.findMainCi(a.repo, [8])
    const oneSet = gitLog.calls.length
    const oneGh = gh.log.filter((c) => (c[0] === 'pr' && c[1] === 'view') || c[0] === 'run').length
    expect(oneSet).toBeGreaterThan(0)
    expect(oneGh).toBe(2)

    vi.resetModules()
    gitLog.calls = []
    gh.log = []
    const b = await freshRepo('conc-b')
    const both = await import('../src/main/pr-stack')
    await Promise.all([
      (async (): Promise<void> => {
        await both.findPrsForWorktrees(b.repo, refsOf([b.wt]))
        await both.findMainCi(b.repo, [8])
      })(),
      (async (): Promise<void> => {
        await both.findPrsForWorktrees(b.repo, refsOf([b.wt]))
        await both.findMainCi(b.repo, [8])
      })()
    ])
    expect(gitLog.calls.length).toBe(oneSet)
    expect(gh.log.filter((c) => (c[0] === 'pr' && c[1] === 'view') || c[0] === 'run').length).toBe(
      2
    )
  })
})

describe('BUG-240 AC-5: refs the reader cannot judge', () => {
  /** What git itself says about a worktree, asked directly. */
  const realAnswer = (w: string, base: string): object => ({
    exists: true,
    branch: git(w, 'rev-parse', '--abbrev-ref', 'HEAD'),
    head: {
      sha: git(w, 'rev-parse', 'HEAD'),
      subject: git(w, 'log', '-1', '--format=%s'),
      at: git(w, 'log', '-1', '--format=%cI')
    },
    commits: Number(git(w, 'rev-list', '--count', `${base}..HEAD`)),
    prs: []
  })

  /** Each makes `git/refs` answer "can't tell" while real git still reads the repo. */
  const unreadable: Record<string, (r: string, w: string) => Promise<void> | void> = {
    'a reftable directory in the common dir': async (r) => {
      await fs.mkdir(path.join(r, '.git', 'reftable'))
    },
    'extensions.refStorage in the config': (r) => {
      git(r, 'config', 'core.repositoryformatversion', '1')
      git(r, 'config', 'extensions.refStorage', 'files')
    },
    'a HEAD on a remote-tracking ref, not a branch': (r, w) => {
      git(r, 'update-ref', 'refs/remotes/origin/keep', git(r, 'rev-parse', 'main'))
      git(w, 'symbolic-ref', 'HEAD', 'refs/remotes/origin/keep')
    },
    'a branch that is itself a symbolic ref': (r, w) => {
      git(r, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/feat/x')
      git(w, 'symbolic-ref', 'HEAD', 'refs/heads/alias')
    }
  }

  it('the join falls back to git when refs are unreadable', async () => {
    for (const [label, breakRefs] of Object.entries(unreadable)) {
      const { repo: r, wt: w } = await freshRepo('unsure')
      await breakRefs(r, w)
      vi.resetModules()
      gh.stdout = '[]'
      gitLog.calls = []
      const { findPrsForWorktrees } = await import('../src/main/pr-stack')
      const expected = realAnswer(w, 'main')

      const first = await findPrsForWorktrees(r, refsOf([w]))
      expect(gitLog.calls.length, `${label}: the fallback must spawn git`).toBeGreaterThan(0)
      expect(spawned('log'), `${label}: head asked of git`).toBe(1)
      expect(spawned('rev-list'), `${label}: count asked of git`).toBeGreaterThan(0)
      expect(first.worktrees[w], `${label}: first answer`).toEqual(expected)

      // "Can't tell" is never stored: the next call asks git again, and is still right.
      gitLog.calls = []
      const second = await findPrsForWorktrees(r, refsOf([w]))
      expect(spawned('log'), `${label}: not cached`).toBe(1)
      expect(spawned('rev-list'), `${label}: count not cached`).toBeGreaterThan(0)
      expect(second.worktrees[w], `${label}: second answer`).toEqual(expected)
    }
  })
})
