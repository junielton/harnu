import { PROTOCOL_VERSION, type BootId, type EndpointName } from '../contract'

/**
 * Validates the content of the rendezvous file before the mod uses it (SEC-4, contract §2). Pure
 * and `$`-free: the path to the file is baked at staging, and the file itself is untrusted input.
 * A `socketPath` that is not inside the directory of the rendezvous file is refused.
 */

export interface Endpoint {
  transport: 'unix' | 'tcp'
  socketPath?: string
  port?: number
  token: string
  bootId: BootId
  protoMin: number
  protoMax: number
}

const dirOf = (path: string): string => {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut <= 0 ? '' : path.slice(0, cut)
}

/** Absolute, no NUL, no `..` segment, and strictly inside `dir`. */
export function insideDir(path: string, dir: string): boolean {
  if (dir === '' || path.includes('\0') || !path.startsWith('/')) return false
  if (!path.startsWith(`${dir}/`) || path.length === dir.length + 1) return false
  return !path.split('/').includes('..')
}

/** `null` for anything the mod must not connect to, and for a host with no protocol overlap. */
export function parseEndpoint(raw: string, rendezvousPath: string): Endpoint | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const f = parsed as Record<string, unknown>
  if (f.v !== 1) return null
  if (typeof f.token !== 'string' || f.token.length === 0 || f.token.length > 512) return null
  if (typeof f.bootId !== 'string' || f.bootId.length === 0 || f.bootId.length > 128) return null
  const { protoMin, protoMax } = f
  if (typeof protoMin !== 'number' || typeof protoMax !== 'number') return null
  if (!Number.isInteger(protoMin) || !Number.isInteger(protoMax) || protoMin > protoMax) return null
  if (PROTOCOL_VERSION < protoMin || PROTOCOL_VERSION > protoMax) return null
  const base = { token: f.token, bootId: f.bootId as BootId, protoMin, protoMax }
  if (f.transport === 'unix') {
    if (typeof f.socketPath !== 'string') return null
    if (!insideDir(f.socketPath, dirOf(rendezvousPath))) return null
    return { ...base, transport: 'unix', socketPath: f.socketPath }
  }
  if (f.transport === 'tcp') {
    const port = f.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
    return { ...base, transport: 'tcp', port }
  }
  return null
}

/** `http://harnu/v1/<route>` over a Unix socket, `http://127.0.0.1:<port>/v1/<route>` over TCP. */
export function endpointUrl(ep: Endpoint, route: EndpointName): string {
  const host = ep.transport === 'unix' ? 'harnu' : `127.0.0.1:${ep.port}`
  return `http://${host}/v1/${route}`
}
