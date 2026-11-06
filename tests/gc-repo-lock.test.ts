// A per-repo lock around shelve cycles (U2.2 AC-6): two Harnu instances (`--user-data-dir`) can run
// against one repository, and only one may shelve in it at a time.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

describe('withRepoLock — reclaiming a stale lock is atomic (AC-6)', () => {
  const STALE_AT = 1_000
  const LATER = STALE_AT + 31 * 60_000
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** Both acquirers have judged the lock stale before either acts on it. */
  const barrier = (n: number): (() => Promise<void>) => {
    let arrived = 0
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    return async () => {
      if (++arrived >= n) open()
      await gate
    }
  }

  it('two acquirers racing on a stale lock: exactly one wins and the work never overlaps', async () => {
    for (let round = 0; round < 8; round++) {
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: STALE_AT }))
      const beforeReclaim = barrier(2)
      let active = 0
      let maxActive = 0
      const work = (name: string) => async (): Promise<string> => {
        active++
        maxActive = Math.max(maxActive, active)
        await sleep(60)
        active--
        return name
      }
      const opts = { now: () => LATER, beforeReclaim }
      const [a, b] = await Promise.all([
        withRepoLock(repo, work('a'), opts),
        withRepoLock(repo, work('b'), opts)
      ])
      const wins = [a, b].filter((r) => r.ok)
      expect(wins, `round ${round}`).toHaveLength(1)
      expect([a, b].filter((r) => !r.ok && r.reason === 'locked')).toHaveLength(1)
      expect(maxActive).toBe(1)
      expect(existsSync(lockFile)).toBe(false)
      expect(existsSync(`${lockFile}.reclaim`)).toBe(false)
    }
  })

  it('a slow reclaimer never deletes a lock someone took in the meantime', async () => {
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: STALE_AT }))
    const gateA = (() => {
      let open!: () => void
      return { wait: new Promise<void>((r) => (open = r)), open }
    })()
    // A reclaims and holds the lock; B judged the same stale lock but acts only after A holds it.
    let aHolds!: () => void
    const aHolding = new Promise<void>((r) => (aHolds = r))
    const a = withRepoLock(
      repo,
      async () => {
        aHolds()
        await gateA.wait
        return 'a'
      },
      { now: () => LATER }
    )
    await aHolding
    const b = await withRepoLock(repo, async () => 'b', {
      now: () => LATER,
      beforeReclaim: async () => undefined
    })
    expect(b).toMatchObject({ ok: false, reason: 'locked' })
    expect(existsSync(lockFile)).toBe(true)
    gateA.open()
    expect(await a).toEqual({ ok: true, value: 'a' })
    expect(existsSync(lockFile)).toBe(false)
  })

  it('a holder that was reclaimed from under it never removes the lock of the one that reclaimed', async () => {
    const hold = (): { wait: Promise<void>; open: () => void } => {
      let open!: () => void
      return { wait: new Promise<void>((r) => (open = r)), open }
    }
    const gateA = hold()
    const gateB = hold()
    let aHolds!: () => void
    const aHolding = new Promise<void>((r) => (aHolds = r))
    let bHolds!: () => void
    const bHolding = new Promise<void>((r) => (bHolds = r))
    // A takes a fresh lock, then runs longer than the stale age.
    const a = withRepoLock(
      repo,
      async () => {
        aHolds()
        await gateA.wait
        return 'a'
      },
      { now: () => STALE_AT }
    )
    await aHolding
    // B, much later, sees A's lock as stale and reclaims it.
    const b = withRepoLock(
      repo,
      async () => {
        bHolds()
        await gateB.wait
        return 'b'
      },
      { now: () => LATER }
    )
    await bHolding
    gateA.open()
    expect(await a).toEqual({ ok: true, value: 'a' })
    // A finished first; B's lock must still be there.
    expect(existsSync(lockFile)).toBe(true)
    gateB.open()
    expect(await b).toEqual({ ok: true, value: 'b' })
    expect(existsSync(lockFile)).toBe(false)
  })

  it('a reclaim guard left by a crashed reclaimer does not block for ever', async () => {
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: STALE_AT }))
    const guard = `${lockFile}.reclaim`
    writeFileSync(guard, '')
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(guard, old, old)
    const first = await withRepoLock(repo, async () => 'x', { now: () => LATER })
    // The first attempt may only clear the dead guard; the next one gets the lock.
    const second = await withRepoLock(repo, async () => 'y', { now: () => LATER })
    expect([first, second].some((r) => r.ok)).toBe(true)
    expect(existsSync(guard)).toBe(false)
  })
})
