/**
 * Read-only probe of the host's established TCP connections (autonomous cleanup U3.5, design §4 U3
 * "Park": "a host listener on its ports"). A client still connected to a stack's published port
 * means the stack is in use whatever its containers are doing (risk 10).
 *
 * Linux asks `ss`, macOS asks `lsof`; Windows has no probe here. Anything that cannot be read is
 * `null` ("could not tell"), which the eligibility rules treat as a refusal and never as "no
 * connections". Nothing here opens, closes or changes a connection.
 */

import { execFile } from 'node:child_process'

export interface ListenerDeps {
  /** Runs `cmd args` with no shell; rejects on a non-zero exit. */
  run(cmd: string, args: readonly string[]): Promise<{ stdout: string }>
  platform: NodeJS.Platform
}

/** The port after the last `:` of `host:port`, `[v6]:port` or `*:port`; null when it is not a number. */
function portOf(endpoint: string): number | null {
  const m = /:(\d{1,5})$/.exec(endpoint)
  return m ? Number(m[1]) : null
}

/**
 * Local port of each connection in `ss -H -t -n state established`: columns are Recv-Q, Send-Q,
 * Local Address:Port, Peer Address:Port. A line that does not have them is skipped.
 */
export function parseSsEstablished(stdout: string): number[] {
  const ports: number[] = []
  for (const line of stdout.split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 4) continue
    const port = portOf(cols[2] ?? '')
    if (port !== null) ports.push(port)
  }
  return ports
}

/**
 * Local port of each connection in `lsof -nP -iTCP -sTCP:ESTABLISHED -Fn`: `n<local>-><peer>`
 * lines. A listen-only line (`n*:3306`) has no peer and is skipped.
 */
export function parseLsofEstablished(stdout: string): number[] {
  const ports: number[] = []
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('n')) continue
    const [local, peer] = line.slice(1).split('->')
    if (peer === undefined) continue
    const port = portOf(local ?? '')
    if (port !== null) ports.push(port)
  }
  return ports
}

/**
 * Established connections per local port, or null when the platform has no probe or the command
 * failed. Both ends of a loopback connection appear, so only a port the caller asks about means
 * anything.
 */
export async function readEstablishedPorts(
  deps: ListenerDeps
): Promise<Map<number, number> | null> {
  let ports: number[]
  try {
    if (deps.platform === 'linux') {
      ports = parseSsEstablished(
        (await deps.run('ss', ['-H', '-t', '-n', 'state', 'established'])).stdout
      )
    } else if (deps.platform === 'darwin') {
      ports = parseLsofEstablished(
        (await deps.run('lsof', ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-Fn'])).stdout
      )
    } else {
      return null
    }
  } catch {
    return null
  }
  const counts = new Map<number, number>()
  for (const p of ports) counts.set(p, (counts.get(p) ?? 0) + 1)
  return counts
}

/** `execFile` as the probe's runner: no shell, a short timeout, a bounded buffer. */
export const execRun: ListenerDeps['run'] = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      { windowsHide: true, timeout: 10_000, maxBuffer: 8 << 20 },
      (err, stdout) => (err ? reject(err) : resolve({ stdout }))
    )
  })
