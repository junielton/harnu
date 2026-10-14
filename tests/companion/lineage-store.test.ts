import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createLineageStore,
  LINEAGE_MAX_ENTRIES,
  loadLineage
} from '../../src/main/companion/lineage-store'

/** T455 W2 AC-6: `<userData>/companion/lineage.json` (spec §6.3 step 2). Ids only. */

const sid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
const A = sid(1)
const B = sid(2)
const C = sid(3)

let dir: string
let path: string
let t = 1_790_000_000_000

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lineage-'))
  path = join(dir, 'companion', 'lineage.json')
  t = 1_790_000_000_000
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const store = () => createLineageStore({ path, now: () => ++t })

describe('lineage.json (AC-6)', () => {
  it('records a lineage naming another session, survives a restart, ids only', () => {
    const s = store()
    expect(s.record(B, { kind: 'fork', from: A })).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { entries: Record<string, unknown>[] }
    expect(raw.entries).toEqual([{ sid: B, kind: 'fork', from: A, at: t }])
    for (const e of raw.entries)
      expect(Object.keys(e).sort()).toEqual(['at', 'from', 'kind', 'sid'])
    // a new process reads it back
    expect(loadLineage(path).get(B)).toEqual({ sid: B, kind: 'fork', from: A, at: t })
    expect(store().lookup(B)).toMatchObject({ kind: 'fork', from: A })
  })

  it('a lineage that names no other session is not recorded', () => {
    const s = store()
    expect(s.record(A, { kind: 'new', from: null })).toBe(false)
    expect(s.record(A, { kind: 'resume', from: A })).toBe(false) // `--resume <id>` names itself
    expect(existsSync(path)).toBe(false)
  })

  it('the same lineage twice is written once; a new one for the same sid replaces it', () => {
    const s = store()
    s.record(B, { kind: 'fork', from: A })
    expect(s.record(B, { kind: 'fork', from: A })).toBe(false)
    expect(s.record(B, { kind: 'resume', from: C })).toBe(true)
    expect(loadLineage(path).get(B)).toMatchObject({ kind: 'resume', from: C })
    expect(s.entries()).toHaveLength(1)
  })

  it('refuses anything that is not a session id (no text, no path)', () => {
    const s = store()
    expect(s.record('../../etc/passwd', { kind: 'fork', from: A })).toBe(false)
    expect(s.record(B, { kind: 'fork', from: 'a prompt with spaces' })).toBe(false)
    expect(s.record(B, { kind: 'banana' as never, from: A })).toBe(false)
    expect(existsSync(path)).toBe(false)
  })

  it('keeps at most the cap, the oldest dropped (10,000 in production)', () => {
    expect(LINEAGE_MAX_ENTRIES).toBe(10_000)
    const s = createLineageStore({ path, now: () => ++t, maxEntries: 50 })
    for (let i = 0; i < 55; i++) s.record(sid(i + 10), { kind: 'fork', from: A })
    const all = loadLineage(path)
    expect(all.size).toBe(50)
    expect(all.has(sid(10))).toBe(false)
    expect(all.has(sid(14))).toBe(false)
    expect(all.has(sid(15))).toBe(true)
    expect(all.has(sid(64))).toBe(true)
  })

  it('a file over the cap (written by a later build) is trimmed on load, oldest first', () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      sid: sid(i + 100),
      kind: 'fork',
      from: A,
      at: i
    }))
    writeFileSync(join(dir, 'big.json'), JSON.stringify({ v: 1, entries }))
    const m = loadLineage(join(dir, 'big.json'), 50)
    expect(m.size).toBe(50)
    expect(m.has(sid(100))).toBe(false)
    expect(m.has(sid(159))).toBe(true)
  })

  it('writes atomically: no temp file is left behind, a torn file reads as empty', () => {
    const s = store()
    s.record(B, { kind: 'fork', from: A })
    expect(readdirSync(join(dir, 'companion'))).toEqual(['lineage.json'])
    writeFileSync(path, '{"v":1,"entries":[{"sid"')
    expect(loadLineage(path).size).toBe(0)
    expect(loadLineage(join(dir, 'missing.json')).size).toBe(0)
    // a store over a torn file starts clean and writes a whole file again
    expect(store().record(C, { kind: 'fork', from: A })).toBe(true)
    expect(loadLineage(path).get(C)).toMatchObject({ from: A })
  })

  it('drops foreign entries when it loads (only ids survive)', () => {
    writeFileSync(
      join(dir, 'x.json'),
      JSON.stringify({
        v: 1,
        entries: [
          { sid: B, kind: 'fork', from: A, at: 1, prompt: 'never kept' },
          { sid: 'not an id', kind: 'fork', from: A, at: 2 },
          { sid: C, kind: 'resume', from: A, at: 3 }
        ]
      })
    )
    const m = loadLineage(join(dir, 'x.json'))
    expect([...m.keys()]).toEqual([B, C])
    expect(m.get(B)).toEqual({ sid: B, kind: 'fork', from: A, at: 1 })
  })
})
