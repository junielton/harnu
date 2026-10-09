import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { workStampOf } from '../src/main/gc/gc-work-stamp'
import type { ExecFn } from '../src/main/reaper/dehydrate-shell'

/**
 * TM-05: the fingerprint the force path compares, against a real git repository. "Edited after
 * the dialog opened" is a claim about the filesystem, so a stubbed `git status` would only
 * assert the arguments we meant to type.
 */

const run = promisify(execFile)
const exec: ExecFn = async (file, args, opts) => {
  const r = await run(file, [...args], { ...opts, encoding: 'utf8', windowsHide: true })
  return { stdout: r.stdout }
}
const git = (cwd: string, ...args: string[]): Promise<unknown> => run('git', ['-C', cwd, ...args])

let root: string
let repo: string

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-stamp-'))
  repo = path.join(root, 'repo')
  await fs.mkdir(repo)
  await git(repo, 'init', '-q', '-b', 'main')
  await git(repo, 'config', 'user.email', 't@example.com')
  await git(repo, 'config', 'user.name', 't')
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', 'init')
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const set = async (name: string, text: string, mtimeSec: number): Promise<void> => {
  const p = path.join(repo, name)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, text)
  await fs.utimes(p, mtimeSec, mtimeSec)
}

describe('workStampOf', () => {
  it('is null for a worktree with no uncommitted work', async () => {
    expect(await workStampOf(exec, repo)).toBeNull()
  })

  it('is stable while nothing changes', async () => {
    await set('a.txt', 'two\n', 1_700_000_000)
    expect(await workStampOf(exec, repo)).toBe(await workStampOf(exec, repo))
  })

  it('moves when an ALREADY modified tracked file is edited again', async () => {
    await set('a.txt', 'two\n', 1_700_000_000)
    const before = await workStampOf(exec, repo)
    await set('a.txt', 'three!\n', 1_700_000_100)
    const after = await workStampOf(exec, repo)
    expect(before).not.toBeNull()
    expect(after).not.toBe(before)
  })

  it('moves when a file inside an untracked directory is edited', async () => {
    await set('new/dir/x.txt', 'x\n', 1_700_000_000)
    const before = await workStampOf(exec, repo)
    await set('new/dir/x.txt', 'xx\n', 1_700_000_050)
    expect(await workStampOf(exec, repo)).not.toBe(before)
  })

  it('moves when a new untracked file appears, and returns to null once everything is reverted', async () => {
    const before = await workStampOf(exec, repo)
    await set('another.txt', 'y\n', 1_700_000_000)
    expect(await workStampOf(exec, repo)).not.toBe(before)
    await fs.rm(path.join(repo, 'another.txt'))
    await fs.rm(path.join(repo, 'new'), { recursive: true })
    await git(repo, 'checkout', '--', 'a.txt')
    expect(await workStampOf(exec, repo)).toBeNull()
  })

  it('rejects when git cannot read the folder, so a caller fails closed', async () => {
    await expect(workStampOf(exec, path.join(root, 'missing'))).rejects.toBeTruthy()
  })
})
