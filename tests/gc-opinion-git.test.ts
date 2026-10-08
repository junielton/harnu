import { describe, it, expect, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  describeGitError,
  gatherDiff,
  gatherKeyGit,
  resolveDefaultRef,
  type GitRunner
} from '../src/main/gc/opinion-git'

// The dossier's git facts fail closed (T444 delta 4, item 1): a git error is an explicit "could not be
// computed", never an empty string that the prompt would read as "no difference" or "no changes".
// Real git on throwaway repos; the buffer-overflow and timeout cases use a runner that fails.

const run = promisify(execFile)
const roots: string[] = []
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const git: GitRunner = async (cwd, args) =>
  (await run('git', ['-C', cwd, ...args], { maxBuffer: 1 << 20 })).stdout

async function sh(cwd: string, ...args: string[]): Promise<void> {
  await run('git', ['-C', cwd, ...args])
}

/** A repo whose default branch is `branch`, with one commit on it. No remote. */
async function repo(branch: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'harnu-opinion-git-'))
  roots.push(root)
  const dir = join(root, 'repo')
  mkdirSync(dir)
  await sh(dir, 'init', '-q', '-b', branch)
  await sh(dir, 'config', 'user.email', 'a@b.c')
  await sh(dir, 'config', 'user.name', 'adv')
  writeFileSync(join(dir, 'app.txt'), 'v1\n')
  await sh(dir, 'add', '.')
  await sh(dir, 'commit', '-qm', 'init')
  return dir
}

/** A worktree on a new branch with one extra commit, so the diff against the default is non-empty. */
async function withFeature(dir: string): Promise<string> {
  const wt = join(dir, '..', 'wt')
  await sh(dir, 'worktree', 'add', '-q', '-b', 'feature', wt)
  writeFileSync(join(wt, 'feature.txt'), 'new\n')
  await sh(wt, 'add', '.')
  await sh(wt, 'commit', '-qm', 'feature')
  return wt
}

const overflow = (): Error =>
  Object.assign(new RangeError('stdout maxBuffer length exceeded'), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  })

describe('resolveDefaultRef', () => {
  it('finds `master` in a local-only repo that has no origin and no origin/HEAD', async () => {
    const dir = await repo('master')
    expect(await resolveDefaultRef(git, dir)).toEqual({ ok: true, value: 'master' })
  })

  it('finds `main` the same way', async () => {
    const dir = await repo('main')
    expect(await resolveDefaultRef(git, dir)).toEqual({ ok: true, value: 'main' })
  })

  it('prefers origin/HEAD when it is set', async () => {
    const dir = await repo('main')
    const bare = join(dir, '..', 'bare.git')
    await run('git', ['clone', '-q', '--bare', dir, bare])
    await sh(dir, 'remote', 'add', 'origin', bare)
    await sh(dir, 'fetch', '-q', 'origin')
    await sh(dir, 'remote', 'set-head', 'origin', 'main')
    expect(await resolveDefaultRef(git, dir)).toEqual({ ok: true, value: 'origin/main' })
  })

  it('finds origin/master after a `remote add` that never set origin/HEAD', async () => {
    const dir = await repo('master')
    const bare = join(dir, '..', 'bare.git')
    await run('git', ['clone', '-q', '--bare', dir, bare])
    await sh(dir, 'remote', 'add', 'origin', bare)
    await sh(dir, 'fetch', '-q', 'origin')
    const r = await resolveDefaultRef(git, dir)
    expect(r).toEqual({ ok: true, value: 'origin/master' })
  })

  it('is an error, never a silent fallback, when no default branch exists', async () => {
    const dir = await repo('trunk')
    const r = await resolveDefaultRef(git, dir)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/no default branch/i)
  })
})

describe('gatherDiff', () => {
  it('gives the correct diff in a repo with only master and no origin/HEAD', async () => {
    const dir = await repo('master')
    const wt = await withFeature(dir)
    const d = await gatherDiff(git, dir, wt)
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(d.value).toContain('feature.txt')
      expect(d.value).toMatch(/1 file changed/)
    }
  })

  it('an item identical to the default is a successful empty diff, not an error', async () => {
    const dir = await repo('main')
    const wt = join(dir, '..', 'wt')
    await sh(dir, 'worktree', 'add', '-q', '-b', 'same', wt)
    expect(await gatherDiff(git, dir, wt)).toEqual({ ok: true, value: '' })
  })

  it('fails closed when there is no default ref at all', async () => {
    const dir = await repo('trunk')
    const wt = await withFeature(dir)
    const d = await gatherDiff(git, dir, wt)
    expect(d.ok).toBe(false)
  })

  it('fails closed when the histories are unrelated (git has no merge base)', async () => {
    const dir = await repo('main')
    const wt = join(dir, '..', 'wt')
    await sh(dir, 'worktree', 'add', '-q', '--orphan', '-b', 'island', wt)
    writeFileSync(join(wt, 'x.txt'), 'x\n')
    await sh(wt, 'add', '.')
    await sh(wt, 'commit', '-qm', 'island')
    const d = await gatherDiff(git, dir, wt)
    expect(d.ok).toBe(false)
  })

  it('fails closed when git itself fails (overflow or timeout) instead of reading as no difference', async () => {
    const failing: GitRunner = async (_cwd, args) => {
      if (args[0] === 'diff') throw overflow()
      return git(_cwd, args)
    }
    const dir = await repo('main')
    const wt = await withFeature(dir)
    const d = await gatherDiff(failing, dir, wt)
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toMatch(/too large/i)
  })
})

describe('gatherKeyGit', () => {
  it('reads the head and the dirty files', async () => {
    const dir = await repo('main')
    writeFileSync(join(dir, 'scratch.log'), 'x')
    const k = await gatherKeyGit(git, dir)
    expect(k.head.ok).toBe(true)
    expect(k.dirty).toEqual({ ok: true, value: ['?? scratch.log'] })
  })

  it('a clean worktree is a successful empty list', async () => {
    const dir = await repo('main')
    expect((await gatherKeyGit(git, dir)).dirty).toEqual({ ok: true, value: [] })
  })

  it('a status that overflows maxBuffer is an error, not a clean worktree', async () => {
    const dir = await repo('main')
    const failing: GitRunner = async (cwd, args) => {
      if (args[0] === 'status') throw overflow()
      return git(cwd, args)
    }
    const k = await gatherKeyGit(failing, dir)
    expect(k.dirty.ok).toBe(false)
    if (!k.dirty.ok) expect(k.dirty.reason).toMatch(/too large/i)
    expect(k.head.ok).toBe(true)
  })

  it('a status that times out is an error too', async () => {
    const dir = await repo('main')
    const failing: GitRunner = async (cwd, args) => {
      if (args[0] === 'status')
        throw Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' })
      return git(cwd, args)
    }
    const k = await gatherKeyGit(failing, dir)
    expect(k.dirty.ok).toBe(false)
    if (!k.dirty.ok) expect(k.dirty.reason).toMatch(/timed out/i)
  })

  it('an unreadable head is an error', async () => {
    const failing: GitRunner = async () => {
      throw new Error('fatal: not a git repository')
    }
    const k = await gatherKeyGit(failing, '/nowhere')
    expect(k.head.ok).toBe(false)
    expect(k.dirty.ok).toBe(false)
  })
})

describe('describeGitError', () => {
  it('names an overflow, a timeout, and otherwise the first line of git’s own message', () => {
    expect(describeGitError(overflow())).toMatch(/too large/i)
    expect(describeGitError(Object.assign(new Error('x'), { killed: true }))).toMatch(/timed out/i)
    expect(
      describeGitError(
        Object.assign(new Error('Command failed'), { stderr: 'fatal: bad revision\nmore' })
      )
    ).toBe('fatal: bad revision')
    expect(describeGitError('plain')).toBe('plain')
    expect(describeGitError(new Error('y'.repeat(500))).length).toBeLessThanOrEqual(160)
  })
})
