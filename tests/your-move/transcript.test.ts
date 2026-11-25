import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFrom } from '../../src/main/your-move/transcript'

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-transcript-'))
  file = path.join(dir, 't.jsonl')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readFrom', () => {
  it('returns only complete lines; nextOffset stops after the last newline', async () => {
    const complete = '{"a":1}\n{"b":2}\n'
    await writeFile(file, complete + '{"c":')
    const r = await readFrom(file, 0)
    expect(r.lines).toEqual([{ a: 1 }, { b: 2 }])
    expect(r.nextOffset).toBe(Buffer.byteLength(complete))
    expect(r.size).toBe(Buffer.byteLength(complete) + 5)
    expect(r.shrunk).toBe(false)
  })

  it('a malformed JSON line is skipped and the offset still passes it', async () => {
    const body = '{"a":1}\nnot json\n[1,2]\n{"b":2}\n'
    await writeFile(file, body)
    const r = await readFrom(file, 0)
    expect(r.lines).toEqual([{ a: 1 }, { b: 2 }])
    expect(r.nextOffset).toBe(Buffer.byteLength(body))
  })

  it('offset beyond size reports shrunk:true and nextOffset:size', async () => {
    await writeFile(file, '{"a":1}\n')
    const r = await readFrom(file, 9999)
    expect(r).toMatchObject({ lines: [], shrunk: true, nextOffset: 8, size: 8 })
  })

  it('counts offsets in bytes, not characters', async () => {
    const first = '{"t":"✓✓✓"}\n'
    await writeFile(file, first + '{"b":2}\n')
    const r = await readFrom(file, Buffer.byteLength(first))
    expect(r.lines).toEqual([{ b: 2 }])
  })

  it('offset at the end returns nothing and keeps the offset', async () => {
    await writeFile(file, '{"a":1}\n')
    expect(await readFrom(file, 8)).toMatchObject({ lines: [], nextOffset: 8, shrunk: false })
  })

  it('a missing file reads as empty at offset 0', async () => {
    expect(await readFrom(path.join(dir, 'nope.jsonl'), 0)).toMatchObject({
      lines: [],
      nextOffset: 0,
      size: 0
    })
  })

  it('{ tail } starts at most that many bytes back, aligned after a newline', async () => {
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, pad: 'p'.repeat(20) }))
    await writeFile(file, lines.join('\n') + '\n')
    const r = await readFrom(file, { tail: 200 })
    expect(r.lines.length).toBeGreaterThan(0)
    expect(r.lines.length).toBeLessThan(50)
    expect(r.lines[r.lines.length - 1]).toMatchObject({ i: 49 })
    // every line is whole: the partial line at the cut was dropped
    for (const l of r.lines) expect(typeof l.i).toBe('number')
    const whole = await readFrom(file, { tail: 10_000_000 })
    expect(whole.lines).toHaveLength(50)
  })
})
