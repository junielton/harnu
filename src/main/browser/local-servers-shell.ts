/**
 * The process reader behind the start page's "Running in this folder" (browser-tabs spec S-5): which ports do the
 * processes under a terminal's shell listen on. Linux reads `/proc` (the shell's descendants from
 * `/proc/<pid>/task/*\/children`, their socket inodes from `/proc/<pid>/fd`, matched to the `LISTEN` rows of
 * `/proc/net/tcp` and `/proc/net/tcp6`); macOS asks `lsof`. Read-only, nothing is spawned on Linux.
 *
 * The parsers are pure and tested against recorded fixtures; the real file system and `execFile` enter only through
 * {@link ProcIo} and `runCommand`, so a test supplies both.
 */
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { runFile } from '../spawn-runner'
import type { Listener } from './local-servers'

/** The `/proc` reads, as plain functions: each answers `null` or `[]` for a path that is gone. */
export interface ProcIo {
  readText(path: string): string | null
  listDir(path: string): string[]
  readLink(path: string): string | null
}

export interface ShellDeps {
  procIo: ProcIo
  /** Runs `file args` and resolves its stdout (an exit code of 1 with output, as `lsof` gives for "nothing", is not an error). */
  runCommand(file: string, args: readonly string[]): Promise<string>
  /**
   * Harnu's own pid. Its control server's listening socket is inherited by every shell it spawns, so a shell's tree
   * "listens" on a port that is Harnu's, not the operator's; a listener on a socket this pid holds is dropped.
   */
  ownPid?: number
}

/** A `LISTEN` row of `/proc/net/tcp[6]`. */
export interface NetListenRow {
  inode: string
  address: string
  port: number
}

/** The kernel's TCP state for `LISTEN`. */
const LISTEN_STATE = '0A'

/** Descendant walk cap: a fork bomb under a shell must not turn the start page into a stall. */
const MAX_PROCESSES = 2000

/** Bytes of one hex group in order, reversed: `/proc/net` prints each 32-bit word in host (little-endian) order. */
function wordBytes(hex: string): number[] {
  const out: number[] = []
  for (let i = 6; i >= 0; i -= 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16))
  return out
}

function formatIpv4(bytes: readonly number[]): string {
  return bytes.join('.')
}

/** `::` compression of the longest zero run of length 2 or more, lower-case hex groups. */
function formatIpv6(bytes: readonly number[]): string {
  const groups: number[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0))
  let bestStart = -1
  let bestLen = 0
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > bestLen) {
      bestStart = i
      bestLen = j - i
    }
    i = j
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(':')
  const head = groups.slice(0, bestStart).map((g) => g.toString(16))
  const tail = groups.slice(bestStart + bestLen).map((g) => g.toString(16))
  return `${head.join(':')}::${tail.join(':')}`
}

/** Decodes the hex address of a `/proc/net/tcp` (8 digits) or `/proc/net/tcp6` (32 digits) row. */
function decodeAddress(hex: string): string | null {
  if (/^[0-9A-Fa-f]{8}$/.test(hex)) return formatIpv4(wordBytes(hex))
  if (!/^[0-9A-Fa-f]{32}$/.test(hex)) return null
  const bytes: number[] = []
  for (let w = 0; w < 4; w++) bytes.push(...wordBytes(hex.slice(w * 8, w * 8 + 8)))
  if (bytes.every((b) => b === 0)) return '::'
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return '::1'
  // An IPv4 listener seen through an IPv6 socket: `::ffff:a.b.c.d` is `a.b.c.d`.
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return formatIpv4(bytes.slice(12))
  }
  return formatIpv6(bytes)
}

/** The `LISTEN` rows of one `/proc/net/tcp` or `/proc/net/tcp6` file. */
export function parseProcNetTcp(text: string): NetListenRow[] {
  const rows: NetListenRow[] = []
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || f[3] !== LISTEN_STATE) continue
    const [addrHex, portHex] = (f[1] ?? '').split(':')
    const address = decodeAddress(addrHex ?? '')
    const port = Number.parseInt(portHex ?? '', 16)
    const inode = f[9] ?? ''
    if (address === null || !Number.isInteger(port) || port <= 0 || inode === '0') continue
    rows.push({ inode, address, port })
  }
  return rows
}

function sortListeners(list: Listener[]): Listener[] {
  return list.sort(
    (a, b) =>
      a.port - b.port ||
      a.pid - b.pid ||
      (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)
  )
}

/** Every pid at or under `roots`, following `/proc/<pid>/task/<tid>/children`. */
function descendantsFromProc(roots: readonly number[], io: ProcIo): number[] {
  const seen = new Set<number>()
  const queue = [...roots]
  while (queue.length > 0 && seen.size < MAX_PROCESSES) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    for (const tid of io.listDir(`/proc/${pid}/task`)) {
      for (const child of (io.readText(`/proc/${pid}/task/${tid}/children`) ?? '').split(/\s+/)) {
        const n = Number.parseInt(child, 10)
        if (Number.isInteger(n) && n > 0 && !seen.has(n)) queue.push(n)
      }
    }
  }
  return [...seen]
}

/** The socket inodes a process holds open (`/proc/<pid>/fd`). */
export function socketInodesOf(pid: number, io: ProcIo): Set<string> {
  const out = new Set<string>()
  for (const fd of io.listDir(`/proc/${pid}/fd`)) {
    const inode = /^socket:\[(\d+)\]$/.exec(io.readLink(`/proc/${pid}/fd/${fd}`) ?? '')?.[1]
    if (inode !== undefined) out.add(inode)
  }
  return out
}

/** Linux: the listening sockets of the shells' process trees, from `/proc`. */
export function readProcListeners(
  shellPids: readonly number[],
  io: ProcIo,
  excludeInodes: ReadonlySet<string> = new Set()
): Listener[] {
  const byInode = new Map<string, NetListenRow>()
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const row of parseProcNetTcp(io.readText(file) ?? '')) {
      if (!excludeInodes.has(row.inode)) byInode.set(row.inode, row)
    }
  }
  if (byInode.size === 0) return []

  const out = new Map<string, Listener>()
  for (const pid of descendantsFromProc(shellPids, io)) {
    let processName: string | null = null
    for (const fd of io.listDir(`/proc/${pid}/fd`)) {
      const inode = /^socket:\[(\d+)\]$/.exec(io.readLink(`/proc/${pid}/fd/${fd}`) ?? '')?.[1]
      const row = inode === undefined ? undefined : byInode.get(inode)
      if (!row) continue
      processName ??= (io.readText(`/proc/${pid}/comm`) ?? '').trim() || String(pid)
      out.set(`${pid}:${row.address}:${row.port}`, {
        pid,
        port: row.port,
        processName,
        address: row.address
      })
    }
  }
  return sortListeners([...out.values()])
}

/** `lsof` escapes unprintable bytes of a command name as `\xHH` (a space is `\x20`). */
function unescapeLsof(name: string): string {
  return name.replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) =>
    String.fromCharCode(Number.parseInt(h, 16))
  )
}

const LSOF_ROW = /^(\S+)\s+(\d+)\s+\S+\s+\S+\s+(IPv[46])\s+\S+\s+\S+\s+TCP\s+(\S+)\s+\(LISTEN\)\s*$/

/** The `LISTEN` rows of `lsof -nP -iTCP -sTCP:LISTEN` output. */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = []
  for (const line of text.split('\n')) {
    const m = LSOF_ROW.exec(line)
    if (!m) continue
    const name = m[4] ?? ''
    const colon = name.lastIndexOf(':')
    const port = Number.parseInt(name.slice(colon + 1), 10)
    if (colon < 0 || !Number.isInteger(port) || port <= 0) continue
    let address = name.slice(0, colon).replace(/^\[|\]$/g, '')
    if (address === '*') address = m[3] === 'IPv6' ? '::' : '0.0.0.0'
    out.push({
      pid: Number.parseInt(m[2] ?? '', 10),
      port,
      processName: unescapeLsof(m[1] ?? ''),
      address
    })
  }
  return out
}

/** macOS: `ps -Ao pid=,ppid=` rows to the pids at or under `roots`. */
function descendantsFromPs(roots: readonly number[], ps: string): number[] {
  const kids = new Map<number, number[]>()
  for (const line of ps.split('\n')) {
    const [pid, ppid] = line
      .trim()
      .split(/\s+/)
      .map((n) => Number.parseInt(n, 10))
    if (
      pid === undefined ||
      ppid === undefined ||
      !Number.isInteger(pid) ||
      !Number.isInteger(ppid)
    )
      continue
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid])
  }
  const seen = new Set<number>()
  const queue = [...roots]
  while (queue.length > 0 && seen.size < MAX_PROCESSES) {
    const pid = queue.shift()!
    if (seen.has(pid)) continue
    seen.add(pid)
    queue.push(...(kids.get(pid) ?? []))
  }
  return [...seen].sort((a, b) => a - b)
}

/** The listening sockets of the processes under `shellPids`: Linux `/proc`, macOS `lsof`, nothing elsewhere. */
export async function listenersFor(
  platform: NodeJS.Platform | string,
  shellPids: readonly number[],
  deps: ShellDeps
): Promise<Listener[]> {
  if (shellPids.length === 0) return []
  if (platform === 'linux') {
    const own =
      deps.ownPid === undefined ? new Set<string>() : socketInodesOf(deps.ownPid, deps.procIo)
    return readProcListeners(shellPids, deps.procIo, own)
  }
  if (platform !== 'darwin') return []
  const pids = descendantsFromPs(shellPids, await deps.runCommand('ps', ['-Ao', 'pid=,ppid=']))
  const out = await deps.runCommand('lsof', [
    '-nP',
    '-iTCP',
    '-sTCP:LISTEN',
    '-a',
    '-p',
    pids.join(',')
  ])
  const found = parseLsof(out)
  if (deps.ownPid === undefined) return sortListeners(found)
  const own = parseLsof(
    await deps.runCommand('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(deps.ownPid)])
  )
  const ownPorts = new Set(own.map((l) => l.port))
  return sortListeners(found.filter((l) => !ownPorts.has(l.port)))
}

/** The real `/proc`: a path that is gone (a process that exited between two reads) is `null` or `[]`. */
export const realProcIo: ProcIo = {
  readText(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
  listDir(path) {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
  readLink(path) {
    try {
      return readlinkSync(path)
    } catch {
      return null
    }
  }
}

/**
 * The real command runner, through the one spawn runner (`spawn-runner.ts`): stdout even on a non-zero exit (`lsof`
 * exits 1 when nothing matches), 5 s ceiling.
 */
export async function realRunCommand(file: string, args: readonly string[]): Promise<string> {
  try {
    return (await runFile(file, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown }
    if (e.code === 1 && typeof e.stdout === 'string') return e.stdout
    throw err
  }
}
