// AC-B3 on a real repository: a worktree locked with `git worktree lock --reason`, its reason read
// back through the real porcelain, "Unlock and remove" unlocking it with the real git, and main's
// real `canUnregister` (the check that refuses a lock) flipping from false to true.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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
