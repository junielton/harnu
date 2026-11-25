/**
 * "Running in this folder" (browser-tabs spec S-5, AC-25): the pure core joins the folder's Docker host ports with the
 * ports listened on under its Harnu terminals. Named, labelled, deduped (Docker wins), sorted by port; a non-loopback
 * bind shows as `<address>:<port>`; on `win32` the terminal rows are empty and Docker rows still show.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildLocalServers, type Listener } from '../src/main/browser/local-servers'
import { TerminalRegistry } from '../src/main/terminal-registry'

const FOLDER = '/home/user/org/proj/www'

const listener = (over: Partial<Listener> & Pick<Listener, 'port'>): Listener => ({
  pid: 4101,
  processName: 'node',
  address: '127.0.0.1',
  ...over
})

describe('docker and terminals', () => {
  it('lists the folder’s Docker host ports named by service, labelled docker', async () => {
    const rows = await buildLocalServers({
      folder: FOLDER,
      platform: 'linux',
      stacks: [
        { folder: FOLDER, name: 'api-gateway', hostPorts: [8080] },
        { folder: '/home/user/org/other/www', name: 'portal', hostPorts: [3000] }
      ],
      terminals: [],
      listeners: async () => []
    })
    expect(rows).toEqual([{ name: 'api-gateway', url: 'http://localhost:8080', source: 'docker' }])
  })

  it('lists ports listened on under the folder’s terminals: folder basename, process name as label', async () => {
    const listeners = vi.fn(async () => [
      listener({ port: 5173, processName: 'vite' }),
      listener({ port: 4000, processName: 'node', address: '::1', pid: 4102 }),
      listener({ port: 9000, processName: 'python3', address: '::', pid: 4103 }),
      listener({ port: 8081, processName: 'node', address: '0.0.0.0', pid: 4104 })
    ])
    const rows = await buildLocalServers({
      folder: FOLDER,
      platform: 'linux',
      stacks: [],
      terminals: [
        { folder: FOLDER, shellPid: 4100 },
        { folder: FOLDER, shellPid: 4200 },
        { folder: '/home/user/org/other/www', shellPid: 4300 }
      ],
      listeners
    })
    // One read for every shell of the folder, none for another folder's.
    expect(listeners).toHaveBeenCalledTimes(1)
    expect(listeners).toHaveBeenCalledWith([4100, 4200])
    expect(rows).toEqual([
      { name: 'www', url: 'http://localhost:4000', source: 'node' },
      { name: 'www', url: 'http://localhost:5173', source: 'vite' },
      { name: 'www', url: 'http://localhost:8081', source: 'node' },
      { name: 'www', url: 'http://localhost:9000', source: 'python3' }
    ])
  })

  it('shows a listener bound only to another address as <address>:<port>', async () => {
    const rows = await buildLocalServers({
      folder: FOLDER,
      platform: 'linux',
      stacks: [],
      terminals: [{ folder: FOLDER, shellPid: 4100 }],
      listeners: async () => [
        listener({ port: 3000, processName: 'ruby', address: '192.168.1.20' }),
        listener({ port: 3001, processName: 'ruby', address: 'fe80::1' })
      ]
    })
    expect(rows.map((r) => r.url)).toEqual(['http://192.168.1.20:3000', 'http://[fe80::1]:3001'])
  })

  it('dedupes by port with Docker winning, and sorts by port', async () => {
    const rows = await buildLocalServers({
      folder: FOLDER,
      platform: 'linux',
      stacks: [{ folder: FOLDER, name: 'db-admin', hostPorts: [8080, 5432] }],
      terminals: [{ folder: FOLDER, shellPid: 4100 }],
      listeners: async () => [
        listener({ port: 8080, processName: 'node' }),
        listener({ port: 3000, processName: 'vite' }),
        listener({ port: 3000, processName: 'vite', address: '::1' })
      ]
    })
    expect(rows).toEqual([
      { name: 'www', url: 'http://localhost:3000', source: 'vite' },
      { name: 'db-admin', url: 'http://localhost:5432', source: 'docker' },
      { name: 'db-admin', url: 'http://localhost:8080', source: 'docker' }
    ])
  })

  it('on win32 the terminal rows are empty and never read; Docker rows still show', async () => {
    const listeners = vi.fn(async () => [listener({ port: 5173 })])
    const rows = await buildLocalServers({
      folder: FOLDER,
      platform: 'win32',
      stacks: [{ folder: FOLDER, name: 'api-gateway', hostPorts: [8080] }],
      terminals: [{ folder: FOLDER, shellPid: 4100 }],
      listeners
    })
    expect(listeners).not.toHaveBeenCalled()
    expect(rows).toEqual([{ name: 'api-gateway', url: 'http://localhost:8080', source: 'docker' }])
  })

  it('a folder with nothing running has no rows, and a failed listener read costs only the terminal rows', async () => {
    expect(
      await buildLocalServers({
        folder: FOLDER,
        platform: 'linux',
        stacks: [],
        terminals: [],
        listeners: async () => []
      })
    ).toEqual([])
    const rows = await buildLocalServers({
      folder: FOLDER,
      platform: 'linux',
      stacks: [{ folder: FOLDER, name: 'api-gateway', hostPorts: [8080] }],
      terminals: [{ folder: FOLDER, shellPid: 4100 }],
      listeners: async () => {
        throw new Error('lsof missing')
      }
    })
    expect(rows).toEqual([{ name: 'api-gateway', url: 'http://localhost:8080', source: 'docker' }])
  })
})

describe('the terminal registry accessor', () => {
  const reg = (): TerminalRegistry => {
    const r = new TerminalRegistry(() => 1000)
    const base = { origin: 'operator' as const, size: { cols: 80, rows: 24 } }
    r.register({ ...base, terminalId: 'h-a', ptyId: 'p-a', folder: FOLDER, shellPid: 4100 })
    r.register({ ...base, terminalId: 'h-b', ptyId: 'p-b', folder: FOLDER, shellPid: 4200 })
    r.register({
      ...base,
      terminalId: 'h-c',
      ptyId: 'p-c',
      folder: '/home/user/org/other/www',
      shellPid: 4300
    })
    r.register({ ...base, terminalId: 'h-d', ptyId: 'p-d', folder: FOLDER })
    return r
  }

  it('lists the folder’s live terminals with their shell pid', () => {
    expect(reg().listTerminalsByFolder(FOLDER)).toEqual([
      { terminalId: 'h-a', shellPid: 4100 },
      { terminalId: 'h-b', shellPid: 4200 }
    ])
  })

  it('leaves out an exited terminal and one whose pid is not known', () => {
    const r = reg()
    r.markExited('p-b', 0)
    expect(r.listTerminalsByFolder(FOLDER)).toEqual([{ terminalId: 'h-a', shellPid: 4100 }])
    expect(r.listTerminalsByFolder('/nowhere')).toEqual([])
  })
})
