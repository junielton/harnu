import { promises as fsp } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyState, type YourMoveCard } from '../../src/main/your-move/core'
import { openYourMoveStore } from '../../src/main/your-move/store'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-store-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const card: YourMoveCard = {
  id: 'a',
  sessionId: 's1',
  folder: '/org/proj/www',
  kind: 'decide',
  ask: 'Pick one',
  source: 'judge',
  lane: 'observe',
  openedAt: 1,
  updatedAt: 1
}

describe('your move store', () => {
  it('persists across reopen, file mode 0600', async () => {
    const file = path.join(dir, 'nested', 'your-move.json')
    const a = await openYourMoveStore(file)
    await a.transact((s) => ({ next: { ...s, cards: [card] }, result: null }))
    const b = await openYourMoveStore(file)
    expect(b.state().cards).toEqual([card])
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  const asideOf = async (file: string): Promise<string[]> =>
    (await readdir(path.dirname(file))).filter((f) =>
      f.startsWith(`${path.basename(file)}.unreadable-`)
    )

  it('a missing file opens empty', async () => {
    const file = path.join(dir, 'your-move.json')
    const s = await openYourMoveStore(file)
    expect(s.state()).toEqual(emptyState())
    expect(await asideOf(file)).toEqual([]) // first run is not a failure: nothing is kept aside
  })

  it('corrupt JSON is kept aside before the store opens empty', async () => {
    const file = path.join(dir, 'your-move.json')
    const bytes = '{ "version": 1, "cards": [ {not json'
    await writeFile(file, bytes)
    const s = await openYourMoveStore(file)
    expect(s.state()).toEqual(emptyState())
    // the copy exists before any write, byte for byte
    const aside = await asideOf(file)
    expect(aside).toHaveLength(1)
    expect(await readFile(path.join(dir, aside[0]), 'utf8')).toBe(bytes)
    // the first write overwrites the file, never the copy
    await s.transact((st) => ({ next: { ...st, cards: [card] }, result: null }))
    expect(JSON.parse(await readFile(file, 'utf8')).cards).toHaveLength(1)
    expect(await readFile(path.join(dir, aside[0]), 'utf8')).toBe(bytes)
  })

  it('an unknown version is kept aside before the store opens empty', async () => {
    const file = path.join(dir, 'your-move.json')
    const bytes = JSON.stringify({ version: 2, cards: [card], cursors: {}, newField: true })
    await writeFile(file, bytes)
    const s = await openYourMoveStore(file)
    expect(s.state()).toEqual(emptyState())
    const aside = await asideOf(file)
    expect(aside).toHaveLength(1)
    expect(await readFile(path.join(dir, aside[0]), 'utf8')).toBe(bytes) // survives a downgrade
  })

  it('a file whose cards are not a list is kept aside too', async () => {
    const file = path.join(dir, 'your-move.json')
    await writeFile(file, JSON.stringify({ version: 1, cards: 'oops', cursors: {} }))
    await openYourMoveStore(file)
    expect(await asideOf(file)).toHaveLength(1)
  })

  it('a read error other than ENOENT rejects and leaves the file untouched', async () => {
    // a directory where the file should be: readFile fails with EISDIR
    const asDir = path.join(dir, 'a-directory.json')
    await mkdir(asDir)
    await writeFile(path.join(asDir, 'inside'), 'x')
    await expect(openYourMoveStore(asDir)).rejects.toThrow()
    expect(await readFile(path.join(asDir, 'inside'), 'utf8')).toBe('x')
    expect(await asideOf(asDir)).toEqual([])
    // a file the process may not read: EACCES (skipped as root, which can read anything)
    if (process.getuid?.() !== 0) {
      const file = path.join(dir, 'your-move.json')
      await writeFile(file, '{"version":1,"cards":[],"cursors":{}}')
      await chmod(file, 0o000)
      try {
        await expect(openYourMoveStore(file)).rejects.toThrow()
      } finally {
        await chmod(file, 0o600)
      }
      expect(await readFile(file, 'utf8')).toBe('{"version":1,"cards":[],"cursors":{}}')
      expect(await asideOf(file)).toEqual([])
    }
  })

  it('if the copy cannot be made, the store rejects and the file is not touched', async () => {
    const file = path.join(dir, 'your-move.json')
    await writeFile(file, '{ corrupt')
    const spy = vi.spyOn(fsp, 'copyFile').mockRejectedValue(new Error('ENOSPC'))
    try {
      await expect(openYourMoveStore(file)).rejects.toThrow('ENOSPC')
    } finally {
      spy.mockRestore()
    }
    expect(await readFile(file, 'utf8')).toBe('{ corrupt')
  })

  it('a failed write leaves state and listeners exactly as they were', async () => {
    // A directory where the file should be makes the rename fail.
    const file = path.join(dir, 'your-move.json')
    const s = await openYourMoveStore(file)
    await s.transact((st) => ({ next: { ...st, cards: [card] }, result: null }))
    const cb = vi.fn()
    s.onChange(cb)
    cb.mockClear()
    await rm(file)
    await import('node:fs/promises').then((fs) => fs.mkdir(file))
    await expect(
      s.transact((st) => ({ next: { ...st, cards: [] }, result: null }))
    ).rejects.toThrow()
    expect(s.state().cards).toEqual([card])
    expect(cb).not.toHaveBeenCalled()
  })

  it('state() is a deep copy and a throwing listener does not block the write', async () => {
    const s = await openYourMoveStore(path.join(dir, 'your-move.json'))
    s.onChange(() => {
      throw new Error('boom')
    })
    const seen = vi.fn()
    s.onChange(seen)
    await s.transact((st) => ({ next: { ...st, cards: [card] }, result: null }))
    expect(seen).toHaveBeenCalledTimes(1)
    s.state().cards.push({ ...card, id: 'x' })
    expect(s.state().cards).toHaveLength(1)
  })

  it('serializes concurrent transactions, each seeing the previous result', async () => {
    const s = await openYourMoveStore(path.join(dir, 'your-move.json'))
    await Promise.all(
      [1, 2, 3].map((n) =>
        s.transact((st) => ({
          next: { ...st, cards: [...st.cards, { ...card, id: `c${n}` }] },
          result: n
        }))
      )
    )
    expect(s.state().cards.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
  })
})
