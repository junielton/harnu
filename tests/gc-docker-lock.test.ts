// The Docker slot's lock (U3.1 AC-4): Docker is one daemon per machine, so the lock is a file in the
// temp dir (not in a repo), shared by every Harnu instance (`--user-data-dir`) of the same user.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { dockerLockPath, withLockFile } from '../src/main/gc/repo-lock-shell'

let root: string
let file: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'harnu-dlock-'))
  file = path.join(root, 'docker.lock')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('withLockFile', () => {
  it('runs the work, holds the file meanwhile and removes it afterwards', async () => {
    const out = await withLockFile(file, async () => {
      expect(existsSync(file)).toBe(true)
      return 7
    })
    expect(out).toEqual({ ok: true, value: 7 })
    expect(existsSync(file)).toBe(false)
  })

  it('a second caller (another instance) is refused while the first holds it', async () => {
    let open!: () => void
    const wait = new Promise<void>((r) => (open = r))
    const first = withLockFile(file, async () => {
      await wait
      return 'first'
    })
    await new Promise((r) => setTimeout(r, 30))
    const second = await withLockFile(file, async () => 'second')
    expect(second).toMatchObject({ ok: false, reason: 'locked', holder: { pid: process.pid } })
    open()
    expect(await first).toEqual({ ok: true, value: 'first' })
    expect(await withLockFile(file, async () => 'again')).toEqual({ ok: true, value: 'again' })
  })

  it('reclaims the lock of a holder that died', async () => {
    writeFileSync(file, JSON.stringify({ pid: 999_999_999, at: Date.now(), token: 'dead' }))
    const out = await withLockFile(file, async () => 'ok', { alive: () => false })
    expect(out).toEqual({ ok: true, value: 'ok' })
  })
})

describe('dockerLockPath', () => {
  it('lives in the given temp dir and carries the user id, so users never share a file', () => {
    expect(dockerLockPath('/tmp', 1000)).toBe(path.join('/tmp', 'harnu-docker-autonomy-1000.lock'))
    expect(dockerLockPath('/tmp', null)).toBe(path.join('/tmp', 'harnu-docker-autonomy-u.lock'))
  })
})
