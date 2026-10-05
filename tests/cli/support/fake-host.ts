import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { mkdtemp, rm, writeFile, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A stand-in for Harnu's companion host (P1W2 §7.9): an HTTP server on a Unix socket in a temp
 * directory that writes an `endpoint.json`, records every request and answers from a script.
 * It never imports the real host, so negative paths (garbage, hang, closed socket) stay
 * reproducible. The endpoint file mirrors contract §2 and is deliberately self-contained.
 */

export interface RecordedRequest {
  route: string
  method: string
  headers: IncomingHttpHeaders
  body: string
  /** Milliseconds since the host started. */
  atMs: number
}

export type FakeAnswer =
  | { kind: 'ok'; body?: unknown }
  | { kind: 'failure'; body: unknown }
  | { kind: 'garbage' }
  | { kind: 'hang' }
  | { kind: 'close' }

export type FakeScript = (req: RecordedRequest) => FakeAnswer

export interface FakeHost {
  dir: string
  socketPath: string
  endpointPath: string
  requests: RecordedRequest[]
  stop(): Promise<void>
}

export async function startFakeHost(
  script: FakeScript = () => ({ kind: 'ok' })
): Promise<FakeHost> {
  const dir = await mkdtemp(join(tmpdir(), 'harnu-fh-'))
  const socketPath = join(dir, 'c.sock')
  const endpointPath = join(dir, 'endpoint.json')
  const requests: RecordedRequest[] = []
  const hung = new Set<import('node:http').ServerResponse>()
  const started = Date.now()

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const rec: RecordedRequest = {
        route: req.url ?? '',
        method: req.method ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        atMs: Date.now() - started
      }
      requests.push(rec)
      const answer = script(rec)
      if (answer.kind === 'hang') {
        hung.add(res)
        return
      }
      if (answer.kind === 'close') {
        req.socket.destroy()
        return
      }
      if (answer.kind === 'garbage') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(Buffer.from([0xff, 0xfe, 0x00, 0x7b]))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer.kind === 'ok' ? (answer.body ?? { ok: true }) : answer.body))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })

  const endpoint = {
    v: 1,
    transport: 'unix',
    socketPath,
    token: 'fake-endpoint-token',
    bootId: 'fake-boot',
    protoMin: 1,
    protoMax: 1,
    writtenAt: Date.now()
  }
  const tmp = `${endpointPath}.tmp`
  await writeFile(tmp, JSON.stringify(endpoint), { mode: 0o600 })
  await rename(tmp, endpointPath)

  return {
    dir,
    socketPath,
    endpointPath,
    requests,
    async stop() {
      for (const r of hung) r.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
