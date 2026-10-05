import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  defaultPrefs,
  normalizePrefs,
  prefsFile,
  readPrefs,
  writePrefs
} from '../src/main/containers/containers-prefs'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-containers-prefs-'))
  dirs.push(dir)
  return dir
}

describe('defaultPrefs (PRD §6, provisional)', () => {
  it('ships the documented defaults', () => {
    expect(defaultPrefs()).toEqual({
      version: 1,
      autoScan: true,
      intervalMs: 3_600_000,
      zombieAfterDays: 2,
      notifyOnNewZombies: true
    })
  })
})

describe('normalizePrefs', () => {
  it('returns defaults for junk and fills missing keys', () => {
    for (const junk of [null, undefined, 'x', 42, []]) {
      expect(normalizePrefs(junk)).toEqual(defaultPrefs())
    }
    expect(normalizePrefs({ autoScan: false })).toEqual({ ...defaultPrefs(), autoScan: false })
  })

  it('clamps intervalMs to 30 min – 24 h', () => {
    expect(normalizePrefs({ intervalMs: 1 }).intervalMs).toBe(1_800_000)
    expect(normalizePrefs({ intervalMs: -5 }).intervalMs).toBe(1_800_000)
    expect(normalizePrefs({ intervalMs: 999_999_999 }).intervalMs).toBe(86_400_000)
    expect(normalizePrefs({ intervalMs: 7_200_000.4 }).intervalMs).toBe(7_200_000)
    expect(normalizePrefs({ intervalMs: Number.NaN }).intervalMs).toBe(3_600_000)
    expect(normalizePrefs({ intervalMs: '1h' }).intervalMs).toBe(3_600_000)
  })

  it('clamps zombieAfterDays to at least 1 whole day', () => {
    expect(normalizePrefs({ zombieAfterDays: 0 }).zombieAfterDays).toBe(1)
    expect(normalizePrefs({ zombieAfterDays: -3 }).zombieAfterDays).toBe(1)
    expect(normalizePrefs({ zombieAfterDays: 2.6 }).zombieAfterDays).toBe(3)
    expect(normalizePrefs({ zombieAfterDays: 30 }).zombieAfterDays).toBe(30)
    expect(normalizePrefs({ zombieAfterDays: Infinity }).zombieAfterDays).toBe(2)
  })

  it('ignores wrong-typed booleans', () => {
    expect(normalizePrefs({ autoScan: 'no' }).autoScan).toBe(true)
    expect(normalizePrefs({ notifyOnNewZombies: 0 }).notifyOnNewZombies).toBe(true)
    expect(normalizePrefs({ notifyOnNewZombies: false }).notifyOnNewZombies).toBe(false)
  })
})

describe('prefs file', () => {
  it('lives at <userData>/containers-prefs.json and is written atomically', async () => {
    const dir = await tmp()
    const file = prefsFile(dir)
    expect(path.basename(file)).toBe('containers-prefs.json')
    const rename = vi.spyOn(fs, 'rename')
    await writePrefs(file, { ...defaultPrefs(), zombieAfterDays: 5 })
    expect(rename).toHaveBeenCalledWith(`${file}.tmp`, file)
    expect(await fs.readdir(dir)).toEqual(['containers-prefs.json'])
    expect(await readPrefs(file)).toEqual({ ...defaultPrefs(), zombieAfterDays: 5 })
  })

  it('never persists an out-of-bounds value', async () => {
    const file = prefsFile(await tmp())
    await writePrefs(file, { ...defaultPrefs(), intervalMs: 5, zombieAfterDays: 0 })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({
      intervalMs: 1_800_000,
      zombieAfterDays: 1
    })
  })

  it('reads a missing or corrupt file as the defaults', async () => {
    const dir = await tmp()
    expect(await readPrefs(prefsFile(dir))).toEqual(defaultPrefs())
    await fs.writeFile(prefsFile(dir), '{ nope', 'utf8')
    expect(await readPrefs(prefsFile(dir))).toEqual(defaultPrefs())
  })
})
