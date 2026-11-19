/**
 * The shell side of the start page's "Running in this folder" (browser-tabs spec S-5, AC-42): the `/proc` and `lsof`
 * readers parse recorded fixtures (neutral process names, no client paths) into `{ pid, port, processName }` listeners.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  listenersFor,
  parseLsof,
  parseProcNetTcp,
  readProcListeners,
  type ProcIo
} from '../src/main/browser/local-servers-shell'

const FIXTURES = join(__dirname, 'fixtures', 'local-servers')
const text = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

interface FixtureProc {
  comm: string
  children: number[]
  fds: string[]
}
const tree = (JSON.parse(text('proc-fd.json')) as { tree: Record<string, FixtureProc> }).tree

/** A virtual `/proc` built from the recorded tree: one thread per process, `tid == pid`. */
const procIo: ProcIo = {
  readText(path) {
    if (path === '/proc/net/tcp') return text('proc-net-tcp.txt')
    if (path === '/proc/net/tcp6') return text('proc-net-tcp6.txt')
    const comm = /^\/proc\/(\d+)\/comm$/.exec(path)
    if (comm) return tree[comm[1]!] ? `${tree[comm[1]!]!.comm}\n` : null
    const kids = /^\/proc\/(\d+)\/task\/(\d+)\/children$/.exec(path)
    if (kids) return tree[kids[1]!] ? tree[kids[1]!]!.children.join(' ') : null
    return null
  },
  listDir(path) {
    const task = /^\/proc\/(\d+)\/task$/.exec(path)
    if (task) return tree[task[1]!] ? [task[1]!] : []
    const fd = /^\/proc\/(\d+)\/fd$/.exec(path)
    if (fd) return tree[fd[1]!] ? tree[fd[1]!]!.fds.map((_, i) => String(i)) : []
    return []
  },
  readLink(path) {
    const fd = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path)
    return fd ? (tree[fd[1]!]?.fds[Number(fd[2])] ?? null) : null
  }
}

describe('fixtures', () => {
  it('parses LISTEN rows of /proc/net/tcp (little-endian addresses, ports in hex)', () => {
    expect(parseProcNetTcp(text('proc-net-tcp.txt'))).toEqual([
      { inode: '41001', address: '127.0.0.1', port: 5173 },
      { inode: '41002', address: '0.0.0.0', port: 8080 },
      { inode: '41003', address: '192.168.1.20', port: 3000 },
      { inode: '99999', address: '0.0.0.0', port: 22 }
    ])
  })

  it('parses /proc/net/tcp6: loopback, wildcard and v4-mapped addresses', () => {
    expect(parseProcNetTcp(text('proc-net-tcp6.txt'))).toEqual([
      { inode: '41005', address: '::1', port: 4000 },
      { inode: '41006', address: '::', port: 9000 },
      { inode: '41007', address: '127.0.0.1', port: 6001 }
    ])
  })

  it("reads a shell's descendants' sockets from /proc into { pid, port, processName }", () => {
    const got = readProcListeners([4100], procIo)
    expect(got).toEqual([
      { pid: 4102, port: 4000, processName: 'esbuild', address: '::1' },
      { pid: 4101, port: 5173, processName: 'node', address: '127.0.0.1' },
      { pid: 4103, port: 6001, processName: 'python3', address: '127.0.0.1' },
      { pid: 4103, port: 8080, processName: 'python3', address: '0.0.0.0' },
      { pid: 4103, port: 9000, processName: 'python3', address: '::' }
    ])
    // A process outside the shell's tree (pid 4110, sshd) never shows, whatever it listens on.
    expect(got.some((l) => l.port === 3000 || l.port === 22)).toBe(false)
  })

  it('a pid that is gone yields nothing instead of throwing', () => {
    expect(readProcListeners([999999], procIo)).toEqual([])
  })

  it('parses lsof LISTEN rows: pid, port, process name (escapes decoded), bind address', () => {
    expect(parseLsof(text('lsof.txt'))).toEqual([
      { pid: 4101, port: 5173, processName: 'node', address: '127.0.0.1' },
      { pid: 4103, port: 8080, processName: 'python3', address: '0.0.0.0' },
      { pid: 4110, port: 3000, processName: 'ruby', address: '192.168.1.20' },
      { pid: 4101, port: 4000, processName: 'node', address: '::1' },
      { pid: 4103, port: 9000, processName: 'python3', address: '::' },
      { pid: 4120, port: 6000, processName: 'Code H', address: '127.0.0.1' }
    ])
  })

  it('macOS asks lsof for the shell pids and their descendants; Linux never runs a command', async () => {
    const calls: Array<[string, readonly string[]]> = []
    const runCommand = async (file: string, args: readonly string[]): Promise<string> => {
      calls.push([file, args])
      return file === 'ps' ? '4100 1\n4101 4100\n4103 4100\n4110 1\n' : text('lsof.txt')
    }
    const mac = await listenersFor('darwin', [4100], { procIo, runCommand })
    expect(calls[0]?.[0]).toBe('ps')
    expect(calls[1]).toEqual([
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', '4100,4101,4103']
    ])
    expect(mac.map((l) => l.port)).toContain(5173)

    calls.length = 0
    const linux = await listenersFor('linux', [4100], { procIo, runCommand })
    expect(calls).toEqual([])
    expect(linux.map((l) => l.port)).toEqual([4000, 5173, 6001, 8080, 9000])

    expect(await listenersFor('win32', [4100], { procIo, runCommand })).toEqual([])
  })
})
