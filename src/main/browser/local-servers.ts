/**
 * "Running in this folder" on the browser start page (browser-tabs spec S-5, D-5): the servers a folder has up, from
 * two sources. Pure (ADR-0001): the containers scan, the terminal registry and the process reader reach it as plain
 * data, so the join, the naming and the dedupe are testable without Docker, `/proc` or electron.
 *
 * - Docker rows: the host ports of the folder's running containers, named by compose service or container name.
 * - Terminal rows: ports listened on by processes running under the folder's Harnu terminals (Linux and macOS),
 *   named by the folder's basename and labelled with the listening process.
 */

/** One listening socket, as `local-servers-shell.ts` reads it. */
export interface Listener {
  pid: number
  port: number
  processName: string
  /** The bind address: `127.0.0.1`, `0.0.0.0`, `::1`, `::`, or any other address. */
  address: string
}

/** A running container with published host ports (one entry per container, the folder is its attributed folder). */
export interface LocalServerStack {
  folder: string
  name: string
  hostPorts: readonly number[]
}

export interface LocalServerTerminal {
  folder: string
  shellPid: number
}

/** What the renderer lists: `url` is the address the row opens, `source` its label (`docker` or a process name). */
export interface LocalServerRow {
  name: string
  url: string
  source: string
}

export interface LocalServersInput {
  folder: string
  platform: NodeJS.Platform | string
  stacks: readonly LocalServerStack[]
  terminals: readonly LocalServerTerminal[]
  /** The listening sockets of the processes under these shell pids (`local-servers-shell.ts`). */
  listeners(pids: number[]): Promise<Listener[]> | Listener[]
}

/**
 * The label a Docker row carries. A template literal on purpose: it is a display label, not the docker binary, which
 * `containers-shell.ts` alone may name (tests/containers-wire.test.ts).
 */
const DOCKER_LABEL = `docker`

/** Loopback and wildcard binds are reachable as `localhost`; any other address is shown as itself. */
const LOCAL_BINDS = new Set(['127.0.0.1', '0.0.0.0', '::1', '::'])

export function serverUrl(address: string, port: number): string {
  if (LOCAL_BINDS.has(address)) return `http://localhost:${port}`
  return address.includes(':') ? `http://[${address}]:${port}` : `http://${address}:${port}`
}

/** The last path segment, whichever separator the platform used. */
function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter((p) => p.length > 0)
  return parts.at(-1) ?? path
}

/** Loopback and wildcard binds first, so a port bound twice shows its `localhost` form. */
function bindRank(address: string): number {
  return LOCAL_BINDS.has(address) ? 0 : 1
}

export async function buildLocalServers(input: LocalServersInput): Promise<LocalServerRow[]> {
  const byPort = new Map<number, LocalServerRow>()

  for (const stack of input.stacks) {
    if (stack.folder !== input.folder) continue
    for (const port of stack.hostPorts) {
      // Docker wins a port: the first container to claim it keeps it.
      if (!byPort.has(port)) {
        byPort.set(port, {
          name: stack.name,
          url: serverUrl('127.0.0.1', port),
          source: DOCKER_LABEL
        })
      }
    }
  }

  // Windows has no terminal port detection (NG-6): the terminal rows are empty and nothing is read.
  const shells = input.terminals.filter((t) => t.folder === input.folder).map((t) => t.shellPid)
  if (input.platform !== 'win32' && shells.length > 0) {
    let found: Listener[] = []
    try {
      found = await input.listeners(shells)
    } catch {
      // A reader that fails (no `lsof`, a vanished pid) costs the terminal rows, never the Docker ones.
    }
    const name = basename(input.folder)
    for (const l of [...found].sort((a, b) => bindRank(a.address) - bindRank(b.address))) {
      if (!byPort.has(l.port)) {
        byPort.set(l.port, { name, url: serverUrl(l.address, l.port), source: l.processName })
      }
    }
  }

  return [...byPort.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row)
}
