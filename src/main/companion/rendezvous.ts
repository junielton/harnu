/**
 * Transport choice and the rendezvous file of the companion host (T389 P1W1 §7.3, contract §2).
 *
 * `<userData>/companion/endpoint.json` tells the mod where the host listens. It is written
 * atomically (temp file plus rename, through `mcp/atomic-write.ts`) at mode 0600, on every boot,
 * before the listener accepts a request. The mod re-reads it on every connect failure, which is
 * what removes the per-boot-token orphaning of the legacy loopback bridge.
 */

import { promises as fs } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { atomicWriteFile } from '../mcp/atomic-write'
import { SOCKET_PATH_MAX_BYTES, type BootId, type EndpointFile } from './contract'

export type Transport = { transport: 'unix'; socketPath: string } | { transport: 'tcp' }

/**
 * TCP when the platform has no Unix sockets or the absolute path is over the engine's limit
 * ("near 100 B", types L4897; 90 is the design margin). The path is measured in bytes.
 */
export function chooseTransport(socketPath: string, platform: NodeJS.Platform): Transport {
  if (platform === 'win32' || Buffer.byteLength(socketPath) > SOCKET_PATH_MAX_BYTES) {
    return { transport: 'tcp' }
  }
  return { transport: 'unix', socketPath }
}

export const endpointPath = (dir: string): string => join(dir, 'endpoint.json')
export const socketPathOf = (dir: string): string => join(dir, 'c.sock')

export interface PreviousEndpoint {
  token: string | null
  port: number | null
}

/**
 * Pure. A stable endpoint token keeps a re-reading mod from one avoidable 403 (ADR-0004), so a
 * non-empty string token is reused; the old port is only a preference for the next TCP bind.
 */
export function parsePreviousEndpoint(raw: string): PreviousEndpoint {
  const none: PreviousEndpoint = { token: null, port: null }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return none
    const { token, port } = parsed as Record<string, unknown>
    return {
      token: typeof token === 'string' && token.length > 0 ? token : null,
      port:
        typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : null
    }
  } catch {
    return none
  }
}

export async function readPreviousEndpoint(dir: string): Promise<PreviousEndpoint> {
  try {
    return parsePreviousEndpoint(await fs.readFile(endpointPath(dir), 'utf8'))
  } catch {
    return { token: null, port: null }
  }
}

export async function writeEndpoint(dir: string, file: EndpointFile): Promise<void> {
  await atomicWriteFile(endpointPath(dir), `${JSON.stringify(file)}\n`, 0o600)
}

/** Removes the rendezvous file only when this boot wrote it (a later boot's file is left alone). */
export async function removeEndpoint(dir: string, bootId: BootId): Promise<void> {
  try {
    const raw = await fs.readFile(endpointPath(dir), 'utf8')
    const parsed = JSON.parse(raw) as { bootId?: unknown }
    if (parsed.bootId !== bootId) return
    await fs.unlink(endpointPath(dir))
  } catch {
    // already gone, or unreadable: nothing of ours to withdraw
  }
}

/**
 * Is anything listening on this Unix socket path?
 * - `absent`: no such file.
 * - `stale`: the file is there and nobody answers (connection refused, or not a socket): a leftover
 *   from a crash, safe to unlink.
 * - `live`: a process accepted the connection, or did not answer in time. Never unlinked: a second
 *   Harnu on the same data directory must not tear a live socket from under the first.
 */
export function probeSocket(path: string, timeoutMs: number): Promise<'live' | 'stale' | 'absent'> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: 'live' | 'stale' | 'absent'): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(v)
    }
    const sock = connect(path)
    const timer = setTimeout(() => done('live'), timeoutMs)
    sock.once('connect', () => done('live'))
    sock.once('error', (err: NodeJS.ErrnoException) =>
      done(err.code === 'ENOENT' ? 'absent' : 'stale')
    )
  })
}
