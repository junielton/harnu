// U3.7 AC-4: the stale-volume ledger, a small userData file like the new-zombie one.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  STALE_LEDGER_MAX,
  readStaleLedger,
  staleLedgerFile,
  writeStaleLedger
} from '../src/main/gc/stale-volume-shell'

let dir = ''
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-stale-ledger-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('the stale-volume ledger', () => {
  it('lives in userData under its own name', () => {
    expect(staleLedgerFile('/data')).toBe(
      path.join('/data', 'containers-stale-volumes-notified.json')
    )
  })

  it('round-trips a set through a file', async () => {
    const file = staleLedgerFile(dir)
    await writeStaleLedger(file, new Set(['a', 'b']))
    expect([...(await readStaleLedger(file))].sort()).toEqual(['a', 'b'])
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ version: 1, keys: ['a', 'b'] })
  })

  it('a missing or corrupt file reads as empty', async () => {
    const file = staleLedgerFile(dir)
    expect((await readStaleLedger(file)).size).toBe(0)
    await fs.writeFile(file, '{not json', 'utf8')
    expect((await readStaleLedger(file)).size).toBe(0)
    await fs.writeFile(file, JSON.stringify({ version: 1, keys: [1, 'ok', null] }), 'utf8')
    expect([...(await readStaleLedger(file))]).toEqual(['ok'])
  })

  it('the write is atomic: no temp file is left behind', async () => {
    const file = staleLedgerFile(dir)
    await writeStaleLedger(file, new Set(['a']))
    expect(await fs.readdir(dir)).toEqual([path.basename(file)])
  })

  it('keeps the newest keys when the set outgrows its cap', async () => {
    const file = staleLedgerFile(dir)
    const keys = Array.from({ length: STALE_LEDGER_MAX + 10 }, (_, i) => `k${i}`)
    await writeStaleLedger(file, new Set(keys))
    const back = await readStaleLedger(file)
    expect(back.size).toBe(STALE_LEDGER_MAX)
    expect(back.has('k0')).toBe(false)
    expect(back.has(`k${STALE_LEDGER_MAX + 9}`)).toBe(true)
  })
})
