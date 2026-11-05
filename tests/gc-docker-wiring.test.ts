// Source-level wiring checks for Docker autonomy (U3.1 AC-4, AC-5), in the style of
// tests/gc-shelve-wiring.test.ts: the parts that need electron are not run here, but the seams
// between them must be there, and this unit must not change any Docker state.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import type { CycleRecord } from '../src/main/gc/gc-wire'

const read = (rel: string): string =>
  readFileSync(path.join(__dirname, '..', 'src', ...rel.split('/')), 'utf8')

describe('wire types are plain data', () => {
  it('a cycle with a Docker record and the paused flag survives JSON', () => {
    const cycle = {
      paused: true,
      docker: {
        mode: 'act',
        found: 2,
        acted: 1,
        refused: 1,
        failed: 0,
        deferred: 0,
        locked: false,
        paused: false,
        pausedReason: null
      }
    } as unknown as CycleRecord
    expect(JSON.parse(JSON.stringify(cycle))).toEqual(cycle)
    expect(JSON.parse(JSON.stringify(defaultGcPrefs()))).toEqual(defaultGcPrefs())
  })
})

describe('the service wires the Docker slot behind its own switch', () => {
  const ipc = read('main/gc/gc-ipc.ts')
  it('gives the cycle a docker hook built on runDockerCycle, the machine-wide lock and the kill switch', () => {
    expect(ipc).toMatch(/docker:\s*\(\)\s*=>\s*runDockerCycle/)
    expect(ipc).toMatch(/withLockFile\(dockerLockPath\(\)/)
    expect(ipc).toMatch(/withDockerDisabled/)
  })
  it('has its own acknowledgement channel, separate from the autopilot’s and shelving’s', () => {
    expect(ipc).toMatch(/ipcMain\.handle\('gc:docker:ack'/)
    expect(ipc).toMatch(/withDockerAcknowledged/)
    expect(read('preload/index.ts')).toMatch(/gcAckDockerReport/)
    expect(read('renderer/src/stores/gc.ts')).toMatch(/ackDockerReport/)
  })
  it('plans nothing and changes no Docker state in this unit', () => {
    expect(ipc).toMatch(/plan:\s*async\s*\(\)\s*=>\s*\[\]/)
    const cycle = read('main/gc/docker-cycle.ts')
    expect(cycle).not.toMatch(/execFile|spawn|child_process|docker (down|rm|network)/)
  })
})
