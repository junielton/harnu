import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStallLog } from '../src/main/monitor/stall-log'
import type { StallRecord } from '../src/main/monitor/stall-core'

const rec = (atMs: number, owner: string): StallRecord => ({
  atMs,
  thread: 'main',
  durationMs: 120,
  owner,
  ownerKind: 'job'
})

let dir = ''
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

describe('stall log boot load', () => {
  it('keeps a record appended while the previous run is being loaded', async () => {
    dir = await mkdtemp(join(tmpdir(), 'stall-log-'))
    const now = Date.now()
    const old = rec(now - 60_000, 'job:from-last-run')
    await writeFile(join(dir, 'stalls.jsonl'), JSON.stringify(old) + '\n')

    const log = createStallLog(dir)
    const loaded = log.load(now) // not awaited: boot never waits for it
    log.append(rec(now, 'job:during-boot'))
    const flushed = log.flush() // a flush landing mid-load must not be truncated away
    await Promise.all([loaded, flushed])

    const text = await readFile(join(dir, 'stalls.jsonl'), 'utf8')
    expect(text).toContain('job:from-last-run')
    expect(text).toContain('job:during-boot')
    await log.dispose()
  })
})
