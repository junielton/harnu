import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionTail } from '../src/main/claude-reader'

/**
 * T38 slice 1b — the transcript-tail reader for the context digest. Writes a
 * temp JSONL (mirrors tests/claude-reader.test.ts) and asserts the ring buffer:
 * last-N in order, sidechain excluded, missing file → [].
 */
const line = (o: Record<string, unknown>): string => JSON.stringify(o)
const user = (text: string, isSidechain = false): string =>
  line({ type: 'user', isSidechain, message: { role: 'user', content: text } })
const asst = (text: string): string =>
  line({
    type: 'assistant',
    isSidechain: false,
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  })

let dir = ''
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'tail-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})
async function write(lines: string[]): Promise<string> {
  const p = join(dir, 's.jsonl')
  await fs.writeFile(p, lines.join('\n') + '\n', 'utf8')
  return p
}

describe('readSessionTail', () => {
  it('returns the last N user/assistant turns in order', async () => {
    const p = await write([user('u1'), asst('a1'), user('u2'), asst('a2'), user('u3')])
    const tail = await readSessionTail(p, 3)
    expect(tail.map((t) => `${t.role}:${t.text}`)).toEqual(['user:u2', 'assistant:a2', 'user:u3'])
  })

  it('excludes sidechain turns', async () => {
    const p = await write([user('main1'), user('SIDE', true), asst('a1')])
    const tail = await readSessionTail(p, 10)
    expect(tail.map((t) => t.text)).toEqual(['main1', 'a1'])
  })

  it('returns [] for a missing file and for n <= 0', async () => {
    expect(await readSessionTail(join(dir, 'nope.jsonl'), 5)).toEqual([])
    const p = await write([user('u1')])
    expect(await readSessionTail(p, 0)).toEqual([])
  })
})
