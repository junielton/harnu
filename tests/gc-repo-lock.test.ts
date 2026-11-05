// A per-repo lock around shelve cycles (U2.2 AC-6): two Harnu instances (`--user-data-dir`) can run
// against one repository, and only one may shelve in it at a time.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { withRepoLock } from '../src/main/gc/repo-lock-shell'

let root: string
let repo: string
let lockFile: string

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-lock-'))
  repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  lockFile = path.join(repo, '.git', 'harnu-gc.lock')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const gate = (): { wait: Promise<void>; open: () => void } => {
  let open!: () => void
  const wait = new Promise<void>((r) => (open = r))
  return { wait, open }
}

describe('withRepoLock', () => {
  it('runs the work and removes the lock afterwards', async () => {
    const out = await withRepoLock(repo, async () => {
      expect(existsSync(lockFile)).toBe(true)
      return 42
    })
    expect(out).toEqual({ ok: true, value: 42 })
    expect(existsSync(lockFile)).toBe(false)
  })

  it('a second caller on the same repo is refused while the first holds it, and names the holder', async () => {
    const g = gate()
    const first = withRepoLock(repo, async () => {
      await g.wait
      return 'first'
    })
    await new Promise((r) => setTimeout(r, 30))
    const second = await withRepoLock(repo, async () => 'second')
    expect(second).toMatchObject({ ok: false, reason: 'locked', holder: { pid: process.pid } })
    g.open()
    expect(await first).toEqual({ ok: true, value: 'first' })
    // and the lock is free again
    expect(await withRepoLock(repo, async () => 'third')).toEqual({ ok: true, value: 'third' })
  })

  it('removes the lock when the work throws, and still throws', async () => {
    await expect(
      withRepoLock(repo, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(existsSync(lockFile)).toBe(false)
  })

  it('a lock older than the stale age is reclaimed', async () => {
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: 1_000 }))
    const out = await withRepoLock(repo, async () => 'ok', { now: () => 1_000 + 31 * 60_000 })
    expect(out).toEqual({ ok: true, value: 'ok' })
  })

  it('a lock whose process is dead is reclaimed', async () => {
    writeFileSync(lockFile, JSON.stringify({ pid: 4_000_000, at: Date.now() }))
    const out = await withRepoLock(repo, async () => 'ok', { alive: () => false })
    expect(out).toEqual({ ok: true, value: 'ok' })
  })

  it('a fresh lock held by a live foreign process is respected', async () => {
    writeFileSync(lockFile, JSON.stringify({ pid: 4_000_000, at: Date.now() }))
    const out = await withRepoLock(repo, async () => 'no', { alive: () => true })
    expect(out).toMatchObject({ ok: false, reason: 'locked', holder: { pid: 4_000_000 } })
    expect(JSON.parse(readFileSync(lockFile, 'utf8')).pid).toBe(4_000_000)
  })

  it('an unreadable lock file is treated as held (fail closed) until it is stale', async () => {
    writeFileSync(lockFile, '{ not json')
    const out = await withRepoLock(repo, async () => 'no')
    expect(out).toMatchObject({ ok: false, reason: 'locked', holder: null })
  })

  it('a folder that is not a repository cannot be locked', async () => {
    const plain = path.join(root, 'plain')
    execFileSync('mkdir', [plain])
    const out = await withRepoLock(plain, async () => 'no')
    expect(out).toMatchObject({ ok: false, reason: 'unavailable' })
  })

  it('locks are per repo: another repository is not blocked', async () => {
    const other = path.join(root, 'other')
    execFileSync('git', ['init', '-q', '-b', 'main', other])
    const g = gate()
    const first = withRepoLock(repo, async () => g.wait)
    await new Promise((r) => setTimeout(r, 30))
    expect(await withRepoLock(other, async () => 'free')).toEqual({ ok: true, value: 'free' })
    g.open()
    await first
  })
})
