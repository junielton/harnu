import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  readOrCreateToken,
  readStoredPort,
  writeStore,
  rotateToken
} from '../src/main/mcp/token-store'

/**
 * BUG-35 / ADR-0004 — the control server used to mint a fresh `randomUUID()`
 * token on every `start()` (`server.ts`), so restarting it permanently broke
 * every already-running session's Harnu tool calls (403, stale bearer). This
 * pins the persisted-token mechanism directly: two reads must yield the same
 * secret, and the store round-trips the port so `start()` can re-bind it too.
 */
describe('mcp token store', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mcp-token-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('returns the same token across two readOrCreateToken calls', async () => {
    const first = await readOrCreateToken(dir)
    const second = await readOrCreateToken(dir)
    expect(first).toBe(second)
  })

  it('only writes once across two readOrCreateToken calls (second call is a pure read)', async () => {
    const writeFile = vi.fn(async (targetPath: string, body: string, mode: number) => {
      await fs.writeFile(targetPath, body, { mode })
    })
    const readFile = (p: string): Promise<string> => fs.readFile(p, 'utf8')

    await readOrCreateToken(dir, { writeFile, readFile })
    await readOrCreateToken(dir, { writeFile, readFile })

    expect(writeFile).toHaveBeenCalledTimes(1)
  })

  it('persists the token file at mode 0600', async () => {
    await readOrCreateToken(dir)
    const stat = await fs.stat(path.join(dir, 'mcp-token.json'))
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('mints a fresh token and rewrites the store when the on-disk JSON is corrupt (D5)', async () => {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'mcp-token.json'), 'not json{{{', { mode: 0o600 })

    const token = await readOrCreateToken(dir)
    expect(token).toBeTruthy()

    // Rewritten: a second read now returns the SAME (newly minted) token.
    const second = await readOrCreateToken(dir)
    expect(second).toBe(token)
  })

  it('rotateToken returns a value different from the prior token and persists it', async () => {
    const original = await readOrCreateToken(dir)
    const rotated = await rotateToken(dir)
    expect(rotated).not.toBe(original)

    const readBack = await readOrCreateToken(dir)
    expect(readBack).toBe(rotated)
  })

  it('rotateToken preserves the previously stored port', async () => {
    await writeStore(dir, { token: 'seed-token', port: 54321 })
    await rotateToken(dir)
    expect(await readStoredPort(dir)).toBe(54321)
  })

  it('readStoredPort round-trips the port written by writeStore', async () => {
    await writeStore(dir, { token: 'a-token', port: 61234 })
    expect(await readStoredPort(dir)).toBe(61234)
  })

  it('readStoredPort is undefined when no port has ever been stored', async () => {
    await readOrCreateToken(dir)
    expect(await readStoredPort(dir)).toBeUndefined()
  })

  it('a missing store directory does not throw — mints and persists on first run', async () => {
    const freshDir = path.join(dir, 'nested', 'userData')
    const token = await readOrCreateToken(freshDir)
    expect(token).toBeTruthy()
    expect(await readOrCreateToken(freshDir)).toBe(token)
  })
})
