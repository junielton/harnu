// The read-only host-connection probe behind the pause rule "an established connection to one of the
// stack's published ports keeps it running" (autonomous cleanup U3.5, risk 10).

import { describe, expect, it } from 'vitest'
import {
  parseLsofEstablished,
  parseSsEstablished,
  readEstablishedPorts
} from '../src/main/containers/docker-listeners-shell'

const SS = [
  '0      0              127.0.0.1:5432         127.0.0.1:51234',
  '0      0                  [::1]:8080            [::1]:40022',
  '0      0                      *:3306        10.0.0.7:60110',
  '0      0   [::ffff:127.0.0.1]:6379  [::ffff:127.0.0.1]:41000',
  '0      0              127.0.0.1:51234        127.0.0.1:5432',
  '',
  'garbage line'
].join('\n')

const LSOF = [
  'p1234',
  'f12',
  'n127.0.0.1:5432->127.0.0.1:51234',
  'p4321',
  'n[::1]:8080->[::1]:40022',
  'n*:3306',
  'n127.0.0.1:51234->127.0.0.1:5432'
].join('\n')

describe('parseSsEstablished', () => {
  it('lists the local port of every established connection, IPv4, IPv6 and wildcard forms', () => {
    expect(parseSsEstablished(SS)).toEqual([5432, 8080, 3306, 6379, 51234])
  })

  it('reads nothing from empty or malformed output', () => {
    expect(parseSsEstablished('')).toEqual([])
    expect(parseSsEstablished('not a table')).toEqual([])
  })
})

describe('parseLsofEstablished', () => {
  it('takes the local side of each connection and skips listen-only lines', () => {
    expect(parseLsofEstablished(LSOF)).toEqual([5432, 8080, 51234])
  })
})

describe('readEstablishedPorts', () => {
  const run = (stdout: string) => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = []
    return {
      calls,
      run: async (cmd: string, args: readonly string[]) => {
        calls.push({ cmd, args })
        return { stdout }
      }
    }
  }

  it('on Linux runs `ss` with fixed arguments and counts connections per local port', async () => {
    const r = run(SS)
    const counts = await readEstablishedPorts({ run: r.run, platform: 'linux' })
    expect(r.calls).toEqual([{ cmd: 'ss', args: ['-H', '-t', '-n', 'state', 'established'] }])
    expect(counts?.get(5432)).toBe(1)
    expect(counts?.get(8080)).toBe(1)
    expect(counts?.get(9999)).toBeUndefined()
  })

  it('on macOS runs `lsof`', async () => {
    const r = run(LSOF)
    const counts = await readEstablishedPorts({ run: r.run, platform: 'darwin' })
    expect(r.calls[0]).toEqual({
      cmd: 'lsof',
      args: ['-nP', '-iTCP', '-sTCP:ESTABLISHED', '-Fn']
    })
    expect(counts?.get(5432)).toBe(1)
  })

  it('has no probe on Windows: unknown, never "none"', async () => {
    const r = run('')
    expect(await readEstablishedPorts({ run: r.run, platform: 'win32' })).toBeNull()
    expect(r.calls).toEqual([])
  })

  it('a command that fails is unknown, never "none"', async () => {
    const counts = await readEstablishedPorts({
      run: async () => {
        throw new Error('ss: command not found')
      },
      platform: 'linux'
    })
    expect(counts).toBeNull()
  })
})
