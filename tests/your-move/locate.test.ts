import { mkdir, mkdtemp, readdir, access, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTranscriptLocator, type LocatorFs } from '../../src/main/your-move/locate'

const SLUGS = 40
const SESSIONS = 60

let root: string
let calls: number
let clock: number
const countingFs: LocatorFs = {
  readdir: async (dir) => {
    calls++
    return readdir(dir)
  },
  access: async (file) => {
    calls++
    return access(file)
  }
}
const slugDir = (m: number): string => path.join(root, `-home-user-proj-${m}`)
const idOf = (i: number): string => `sess-${String(i).padStart(4, '0')}`
const locator = () => createTranscriptLocator({ root, fs: countingFs, now: () => clock })

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'your-move-locate-'))
  calls = 0
  clock = 1_000_000
  for (let m = 0; m < SLUGS; m++) await mkdir(slugDir(m))
  // Session i lives in slug i % SLUGS: the worst case probes most of the slugs before it hits.
  for (let i = 0; i < SESSIONS; i++) {
    await writeFile(path.join(slugDir(i % SLUGS), `${idOf(i)}.jsonl`), '{}\n')
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('transcript locator', () => {
  it('locates N sessions across M slugs with one listing, not N x M probes (AC-1)', async () => {
    const loc = locator()
    for (let i = 0; i < SESSIONS; i++) {
      expect(await loc.locate(idOf(i))).toBe(path.join(slugDir(i % SLUGS), `${idOf(i)}.jsonl`))
    }
    // One listing of the root plus one per slug: O(M), whatever N is.
    expect(calls).toBeLessThanOrEqual(SLUGS + 1)
  })

  it('a found path is remembered: the next tick touches no directory (AC-1)', async () => {
    const loc = locator()
    for (let i = 0; i < SESSIONS; i++) await loc.locate(idOf(i))
    calls = 0
    for (let i = 0; i < SESSIONS; i++) await loc.locate(idOf(i))
    expect(calls).toBe(0)
  })

  it('a path the hook payload carried is used as given, with no fs call (AC-1)', async () => {
    const loc = locator()
    const given = path.join(slugDir(3), 'sess-hooked.jsonl')
    loc.note('sess-hooked', given)
    expect(await loc.locate('sess-hooked')).toBe(given)
    expect(calls).toBe(0)
  })

  it('a session with no transcript costs one bounded lookup, not one per tick (AC-3)', async () => {
    const loc = locator()
    for (let tick = 0; tick < 5; tick++) {
      for (let i = 0; i < 20; i++) expect(await loc.locate(`ghost-${i}-0000`)).toBeNull()
      clock += 60_000
    }
    expect(calls).toBeLessThanOrEqual(SLUGS + 1)
  })

  it('a transcript that appears after a miss is found once the miss ages out (AC-3)', async () => {
    const loc = locator()
    expect(await loc.locate('sess-late')).toBeNull()
    await writeFile(path.join(slugDir(7), 'sess-late.jsonl'), '{}\n')
    clock += 10 * 60_000
    expect(await loc.locate('sess-late')).toBe(path.join(slugDir(7), 'sess-late.jsonl'))
  })

  it('a hook payload path beats an earlier miss (AC-3)', async () => {
    const loc = locator()
    expect(await loc.locate('sess-late')).toBeNull()
    const given = path.join(slugDir(7), 'sess-late.jsonl')
    loc.note('sess-late', given)
    expect(await loc.locate('sess-late')).toBe(given)
  })

  it('an unreadable root answers null', async () => {
    await rm(root, { recursive: true, force: true })
    expect(await locator().locate(idOf(0))).toBeNull()
  })
})
