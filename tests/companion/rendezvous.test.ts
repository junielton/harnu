import { createServer, type Server } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  chooseTransport,
  endpointPath,
  parsePreviousEndpoint,
  probeSocket,
  readPreviousEndpoint,
  removeEndpoint,
  writeEndpoint
} from '../../src/main/companion/rendezvous'
import { SOCKET_PATH_MAX_BYTES, type EndpointFile } from '../../src/main/companion/contract'

let dir: string
const servers: Server[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hc-rdv-'))
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))))
  rmSync(dir, { recursive: true, force: true })
})

const endpoint = (over: Partial<EndpointFile> = {}): EndpointFile => ({
  v: 1,
  transport: 'unix',
  socketPath: '/tmp/x/c.sock',
  token: 'tok-1',
  bootId: 'b_1',
  protoMin: 1,
  protoMax: 1,
  writtenAt: 1,
  ...over
})

describe('transport choice', () => {
  it('falls back to tcp for long paths and win32', () => {
    const exact = '/' + 'a'.repeat(SOCKET_PATH_MAX_BYTES - 1) // 90 bytes
    expect(Buffer.byteLength(exact)).toBe(90)
    expect(chooseTransport(exact, 'linux')).toEqual({ transport: 'unix', socketPath: exact })
    const long = exact + 'a' // 91 bytes
    expect(Buffer.byteLength(long)).toBe(91)
    expect(chooseTransport(long, 'linux')).toEqual({ transport: 'tcp' })
    expect(chooseTransport('/tmp/c.sock', 'win32')).toEqual({ transport: 'tcp' })
    expect(chooseTransport('/tmp/c.sock', 'darwin')).toEqual({
      transport: 'unix',
      socketPath: '/tmp/c.sock'
    })
  })

  it('measures bytes, not characters', () => {
    const multi = '/' + 'é'.repeat(45) // 46 chars, 91 bytes
    expect(chooseTransport(multi, 'linux')).toEqual({ transport: 'tcp' })
  })
})

describe('previous endpoint', () => {
  it('reuses a non-empty string token and remembers the port', () => {
    expect(parsePreviousEndpoint(JSON.stringify({ token: 't', port: 5000 }))).toEqual({
      token: 't',
      port: 5000
    })
    expect(parsePreviousEndpoint(JSON.stringify({ token: '', port: 0 }))).toEqual({
      token: null,
      port: null
    })
    expect(parsePreviousEndpoint(JSON.stringify({ token: 7, port: '80' }))).toEqual({
      token: null,
      port: null
    })
    expect(parsePreviousEndpoint('{ nope')).toEqual({ token: null, port: null })
    expect(parsePreviousEndpoint('null')).toEqual({ token: null, port: null })
    expect(parsePreviousEndpoint(JSON.stringify({ token: 't', port: 70000 })).port).toBeNull()
  })

  it('reads it from disk, and a missing file is nothing', async () => {
    expect(await readPreviousEndpoint(dir)).toEqual({ token: null, port: null })
    writeFileSync(endpointPath(dir), JSON.stringify({ token: 'old', port: 4242 }))
    expect(await readPreviousEndpoint(dir)).toEqual({ token: 'old', port: 4242 })
  })
})

describe('endpoint file', () => {
  it('is written atomically at mode 0600 and removed only when it is ours', async () => {
    await writeEndpoint(dir, endpoint())
    const file = endpointPath(dir)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(endpoint())
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // another boot rewrote it: a late stop of the first boot must not delete the new one
    await writeEndpoint(dir, endpoint({ bootId: 'b_2' }))
    await removeEndpoint(dir, 'b_1')
    expect(existsSync(file)).toBe(true)
    await removeEndpoint(dir, 'b_2')
    expect(existsSync(file)).toBe(false)
    await removeEndpoint(dir, 'b_2') // already gone: no throw
  })
})

describe('stale socket probe', () => {
  it('absent: no file', async () => {
    expect(await probeSocket(join(dir, 'c.sock'), 250)).toBe('absent')
  })

  it('stale: a leftover file with no listener, or a regular file', async () => {
    const path = join(dir, 'c.sock')
    await new Promise<void>((resolve) => {
      const s = createServer()
      s.listen(path, () => {
        // closing a net server unlinks the file; keep a stale inode by recreating it below
        s.close(() => resolve())
      })
    })
    writeFileSync(path, '') // a plain file where the socket was
    expect(await probeSocket(path, 250)).toBe('stale')
  })

  it('live: another process answers', async () => {
    const path = join(dir, 'c.sock')
    const s = createServer()
    servers.push(s)
    await new Promise<void>((r) => s.listen(path, r))
    expect(await probeSocket(path, 250)).toBe('live')
  })
})
