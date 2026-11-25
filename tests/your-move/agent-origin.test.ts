/**
 * BUG-308 delta 1: who Harnu spawned a session for, kept across restarts. The live marker lives
 * in memory only, so what it says is written down; sessions older than this file are covered by
 * the companion audit log. Only a sure `agent` is ever `true`.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgentOrigins } from '../../src/main/your-move/agent-origin'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'your-move-origin-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const row = (sid: string, trust: string): string =>
  JSON.stringify({ kind: 'binding', change: 'bound', sid, trust, profile: 'interactive' })

const origins = (
  live: Record<string, 'agent' | 'operator'> = {},
  now: () => number = () => 1_000_000
): ReturnType<typeof createAgentOrigins> =>
  createAgentOrigins({
    file: path.join(dir, 'agents.json'),
    auditFiles: [path.join(dir, 'audit.1.ndjson'), path.join(dir, 'audit.ndjson')],
    live: (id) => live[id],
    now
  })

describe('agent-spawned sessions', () => {
  it('writes down what the live marker says, so a restart still knows', async () => {
    const a = origins({ dispatched: 'agent', mine: 'operator' })
    expect(await a.isAgentSpawned('dispatched')).toBe(true)
    expect(await a.isAgentSpawned('mine')).toBe(false)
    await a.idle()
    // a new run: no live marker at all, or a resume the operator's click stamped
    expect(await origins().isAgentSpawned('dispatched')).toBe(true)
    expect(await origins({ dispatched: 'operator' }).isAgentSpawned('dispatched')).toBe(true)
    expect(await origins().isAgentSpawned('mine')).toBe(false)
  })

  it('note() records a session while it runs, before anyone asks', async () => {
    const a = origins({ dispatched: 'agent' })
    a.note('dispatched')
    await a.idle()
    expect(await origins().isAgentSpawned('dispatched')).toBe(true)
  })

  it('reads the companion audit, both generations; only trust agent counts', async () => {
    await writeFile(path.join(dir, 'audit.1.ndjson'), `${row('older', 'agent')}\n`)
    await writeFile(
      path.join(dir, 'audit.ndjson'),
      [row('newer', 'agent'), row('mine', 'operator'), row('ticking', 'tick'), '{"torn'].join('\n')
    )
    const a = origins()
    expect(await a.isAgentSpawned('older')).toBe(true)
    expect(await a.isAgentSpawned('newer')).toBe(true)
    expect(await a.isAgentSpawned('mine')).toBe(false)
    expect(await a.isAgentSpawned('ticking')).toBe(false)
    expect(await a.isAgentSpawned('absent')).toBe(false)
  })

  it('reads the audit again only after a while', async () => {
    let at = 1_000_000
    const a = origins({}, () => at)
    expect(await a.isAgentSpawned('later')).toBe(false)
    await writeFile(path.join(dir, 'audit.ndjson'), `${row('later', 'agent')}\n`)
    expect(await a.isAgentSpawned('later')).toBe(false)
    at += 61_000
    expect(await a.isAgentSpawned('later')).toBe(true)
  })

  it('knows nothing when there is nothing to read, and a broken file is not fatal', async () => {
    await writeFile(path.join(dir, 'agents.json'), 'not json')
    const a = origins()
    expect(await a.isAgentSpawned('anyone')).toBe(false)
  })

  it('a live marker that throws is no answer, not an error', async () => {
    const a = createAgentOrigins({
      file: path.join(dir, 'agents.json'),
      auditFiles: [],
      live: () => {
        throw new Error('no pty')
      },
      now: () => 1
    })
    expect(await a.isAgentSpawned('anyone')).toBe(false)
    expect(() => a.note('anyone')).not.toThrow()
  })
})
