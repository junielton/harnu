import { request, type IncomingHttpHeaders } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EndpointFile } from '../../../src/main/companion/contract'

export interface Reply {
  status: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any
  raw: string
  ms: number
  headers: IncomingHttpHeaders
}

export interface PostOpts {
  path?: string
  method?: string
  body?: unknown // an object is JSON-encoded, a string or Buffer is sent as is
  headers?: Record<string, string>
  bearer?: string | null // null: no Authorization header
  chunked?: Buffer[]
}

/** A Unix-socket path must stay under 90 bytes: use a short temp base, never a long TMPDIR. */
export function shortTmp(prefix: string): string {
  const base =
    Buffer.byteLength(join(tmpdir(), 'hc-xxxxxx', 'companion', 'c.sock')) <= 80 ? tmpdir() : '/tmp'
  return mkdtempSync(join(base, prefix))
}

/** One HTTP/1.1 POST to the host named by an endpoint file, over its socket or loopback port. */
export function post(ep: EndpointFile, route: string, opts: PostOpts = {}): Promise<Reply> {
  const started = performance.now()
  const isUnix = ep.transport === 'unix'
  const headers: Record<string, string> = {
    host: isUnix ? 'harnu' : `127.0.0.1:${ep.port}`,
    ...(opts.bearer === null ? {} : { authorization: `Bearer ${opts.bearer ?? ep.token}` }),
    ...(opts.chunked ? { 'transfer-encoding': 'chunked' } : { 'content-type': 'application/json' }),
    ...opts.headers
  }
  return new Promise((resolve, reject) => {
    const req = request(
      {
        ...(isUnix ? { socketPath: ep.socketPath } : { host: '127.0.0.1', port: ep.port }),
        path: opts.path ?? `/v1/${route}`,
        method: opts.method ?? 'POST',
        headers,
        agent: false
      },
      (res) => {
        let raw = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (raw += c))
        res.on('end', () => {
          let json: unknown = null
          try {
            json = JSON.parse(raw)
          } catch {
            /* a non-JSON body */
          }
          resolve({
            status: res.statusCode ?? 0,
            json,
            raw,
            ms: performance.now() - started,
            headers: res.headers
          })
        })
      }
    )
    req.on('error', reject)
    if (opts.chunked) {
      for (const c of opts.chunked) req.write(c)
      req.end()
    } else {
      const b = opts.body
      req.end(
        typeof b === 'string' || Buffer.isBuffer(b) ? b : b === undefined ? '' : JSON.stringify(b)
      )
    }
  })
}
