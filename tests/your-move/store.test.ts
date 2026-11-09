import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

  it('corrupt JSON opens empty and the next write repairs it', async () => {
    const file = path.join(dir, 'your-move.json')
    await writeFile(file, '{ not json')
    const s = await openYourMoveStore(file)
    expect(s.state()).toEqual(emptyState())
    await s.transact((st) => ({ next: { ...st, cards: [card] }, result: null }))
    expect(JSON.parse(await readFile(file, 'utf8')).cards).toHaveLength(1)
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
