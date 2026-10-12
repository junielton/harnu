// AC-B3 on a real repository: a worktree locked with `git worktree lock --reason`, its reason read
// back through the real porcelain, "Unlock and remove" unlocking it with the real git, and main's
// real `canUnregister` (the check that refuses a lock) flipping from false to true.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { cpSync as copyDir } from 'node:fs'
import { createGitGuided } from '../src/main/gc/gc-guided'
import { canUnregister } from '../src/main/reaper/worktree-admin-shell'

const git = async (repo: string, args: string[]): Promise<string> =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

let root = ''
let repo = ''
let wt = ''

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'harnu-guided-git-')))
  repo = path.join(root, 'repo')
  wt = path.join(root, 'wt')
  mkdirSync(repo)
  const run = (...a: string[]): void =>
    void execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' })
  run('init', '-q', '-b', 'main')
  run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  run('worktree', 'add', '-q', '-b', 'feat/x', wt)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('unlocking a real locked worktree', () => {
  it('reads the reason git recorded, then unlocks with git itself', async () => {
    execFileSync('git', ['-C', repo, 'worktree', 'lock', '--reason', 'portable disk', wt])
    const g = createGitGuided(git)

    expect(await g.lockReason(repo, wt)).toBe('portable disk')
    // The check that makes main refuse a locked worktree is real here, not a flag.
    expect(await canUnregister(repo, wt, git)).toBe(false)

    await g.unlock(repo, wt)

    expect(await g.lockReason(repo, wt)).toBeUndefined()
    expect(await canUnregister(repo, wt, git)).toBe(true)
  })

  it('puts the lock back with its ORIGINAL reason (rollback after a refused remove)', async () => {
    execFileSync('git', ['-C', repo, 'worktree', 'lock', '--reason', 'usb', wt])
    const g = createGitGuided(git)
    const reason = await g.lockReason(repo, wt)
    await g.unlock(repo, wt)
    expect(await g.lockReason(repo, wt)).toBeUndefined()

    await g.lock(repo, wt, reason ?? null)

    expect(await g.lockReason(repo, wt)).toBe('usb')
    expect(await canUnregister(repo, wt, git)).toBe(false)
  })

  it('a reason git C-quotes round-trips byte for byte through the read and the rollback (delta 2)', async () => {
    const reason = 'café "x" \\ 日本'
    execFileSync('git', ['-C', repo, 'worktree', 'lock', '--reason', reason, wt])
    const g = createGitGuided(git)
    const file = path.join(repo, '.git', 'worktrees', path.basename(wt), 'locked')
    const original = readFileSync(file)
    const read = await g.lockReason(repo, wt)
    expect(read).toBe(reason)

    await g.unlock(repo, wt)
    await g.lock(repo, wt, read ?? null)

    expect(await g.lockReason(repo, wt)).toBe(reason)
    // The very bytes git had recorded.
    expect(readFileSync(file).equals(original)).toBe(true)
  })

  it('leading and trailing spaces in the reason are kept, byte for byte (delta 3)', async () => {
    const reason = '  padded  '
    execFileSync('git', ['-C', repo, 'worktree', 'lock', '--reason', reason, wt])
    const g = createGitGuided(git)
    const file = path.join(repo, '.git', 'worktrees', path.basename(wt), 'locked')
    const original = readFileSync(file)
    expect(await g.lockReason(repo, wt)).toBe(reason)

    await g.unlock(repo, wt)
    await g.lock(repo, wt, reason)

    expect(readFileSync(file).equals(original)).toBe(true)
  })

  it('a reason that is only spaces is a reason, not "no reason" (delta 3)', async () => {
    execFileSync('git', ['-C', repo, 'worktree', 'lock', '--reason', '   ', wt])
    expect(await createGitGuided(git).lockReason(repo, wt)).toBe('   ')
  })

  it('a lock that had no reason goes back with none', async () => {
    const g = createGitGuided(git)
    await g.lock(repo, wt, null)
    expect(await g.lockReason(repo, wt)).toBeNull()
  })

  it('a lock with no reason reads as null, an unlocked worktree as undefined', async () => {
    const g = createGitGuided(git)
    expect(await g.lockReason(repo, wt)).toBeUndefined()
    execFileSync('git', ['-C', repo, 'worktree', 'lock', wt])
    expect(await g.lockReason(repo, wt)).toBeNull()
  })

  it('names git’s own complaint when the worktree is not locked', async () => {
    await expect(createGitGuided(git).unlock(repo, wt)).rejects.toThrow(/not locked/i)
  })
})

describe('canUnregister as if unlocked, against real admin directories (delta 2)', () => {
  const unlockedAnswer = (): Promise<boolean> =>
    canUnregister(repo, wt, git, { assumeUnlocked: true })

  it('a locked worktree can be unregistered once unlocked, and not before', async () => {
    execFileSync('git', ['-C', repo, 'worktree', 'lock', wt])
    expect(await canUnregister(repo, wt, git)).toBe(false)
    expect(await unlockedAnswer()).toBe(true)
  })

  it('an AMBIGUOUS registration is still refused as if unlocked', async () => {
    const admin = path.join(repo, '.git', 'worktrees')
    copyDir(path.join(admin, path.basename(wt)), path.join(admin, 'stale-duplicate'), {
      recursive: true
    })
    execFileSync('git', ['-C', repo, 'worktree', 'lock', wt])
    expect(await unlockedAnswer()).toBe(false)
  })
})

describe('a worktree’s identity, against real git (delta 3)', () => {
  it('is stable while the worktree lives, and changes when it is removed and added again', async () => {
    const g = createGitGuided(git)
    const a = await g.identityOf(repo, wt)
    expect(a).toMatchObject({ adminId: path.basename(wt), gitdir: `${wt}/.git` })
    expect(typeof a?.head).toBe('string')
    expect(await g.identityOf(repo, wt)).toEqual(a)

    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt])
    await new Promise((r) => setTimeout(r, 25))
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'feat/again', wt])
    const b = await g.identityOf(repo, wt)
    expect(b).not.toBeNull()
    expect(b).not.toEqual(a)
  })

  it('works for a locked worktree, which is what an interrupted unlock has', async () => {
    execFileSync('git', ['-C', repo, 'worktree', 'lock', wt])
    expect(await createGitGuided(git).identityOf(repo, wt)).not.toBeNull()
  })

  it('is null for a folder git has no registration for', async () => {
    expect(await createGitGuided(git).identityOf(repo, path.join(root, 'nowhere'))).toBeNull()
  })
})
