import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { request } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * T456 W1 wiring that is not the coordinator itself: the hook bridge keeps the legacy facts
 * BEFORE the hub sees the event (§5.5), the `park` prefs key and its observe cap (§9.1,
 * AC-T456-12), the bounds beside the policy (§9.1), the MemAvailable reading (§6.3) and the
 * ledger's `negotiation` field (§6.5).
 */

let userDataDir = ''
vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    isPackaged: false
  }
}))

import { startHookServer, handleBridgeEvent, type BridgeEvent } from '../src/main/hook-bridge'
import { markHibernated, resetHibernation, recordPark, parkHistory } from '../src/main/hibernation'
import { legacyParkFacts, parkModeNow } from '../src/main/park-coordinator'
import { setCompanionCliGate, setPrefsKey } from '../src/main/companion/companion-prefs'
import { parseMemAvailableMb } from '../src/main/monitor/proc-parse'

function post(port: number, path: string, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

describe('hook bridge — legacy park facts are read before ingest (§5.5)', () => {
  let close: (() => Promise<void>) | null = null
  afterEach(async () => {
    if (close) await close()
    close = null
    resetHibernation()
    legacyParkFacts.forget('S-park-1')
    legacyParkFacts.forget('S-park-2')
  })

  it('a Stop body’s counts are kept by the time the event reaches the hub', async () => {
    const seen: string[][] = []
    const started = await startHookServer((e: BridgeEvent) => {
      seen.push(legacyParkFacts.busy(e.sessionId))
    }, 'tok')
    close = started.close
    await post(started.port, '/hook/tok/Stop/_', {
      session_id: 'S-park-1',
      background_tasks: [{ id: 't', type: 'shell', status: 'running', command: 'git push' }],
      session_crons: [{ recurring: true, prompt: 'p' }]
    })
    expect(seen).toEqual([['background-task', 'scheduled-wakeup']])
  })

  it('a parked session’s events are dropped by the hub but its facts are still kept', async () => {
    markHibernated('S-park-2')
    const started = await startHookServer((e) => handleBridgeEvent(e, () => null), 'tok')
    close = started.close
    await post(started.port, '/hook/tok/UserPromptSubmit/_', {
      session_id: 'S-park-2',
      source: 'user'
    })
    await post(started.port, '/hook/tok/Stop/_', {
      session_id: 'S-park-2',
      session_crons: [{ recurring: false }]
    })
    expect(legacyParkFacts.lastPromptAt('S-park-2')).not.toBeNull()
    expect(legacyParkFacts.busy('S-park-2')).toEqual(['scheduled-wakeup'])
  })
})

describe('prefs key park (§9.1)', () => {
  afterEach(() => setCompanionCliGate('unknown'))

  it('defaults to ask, and reads what the file holds', () => {
    setCompanionCliGate('ok')
    expect(parkModeNow()).toBe('ask')
    setPrefsKey('park', 'off')
    expect(parkModeNow()).toBe('off')
    setPrefsKey('park', 'nonsense')
    expect(parkModeNow()).toBe('ask')
  })

  it('AC-T456-12 — a CLI above the tested ceiling reads facts', () => {
    setPrefsKey('park', 'ask')
    setCompanionCliGate('above')
    expect(parkModeNow()).toBe('facts')
  })

  it('the cap only lowers: a stored off stays off above the ceiling, so the switch can work', () => {
    setCompanionCliGate('above')
    setPrefsKey('park', 'off')
    expect(parkModeNow()).toBe('off')
    setPrefsKey('park', 'facts')
    expect(parkModeNow()).toBe('facts')
    setPrefsKey('park', 'ask')
    expect(parkModeNow()).toBe('facts')
  })
})

describe('negotiation bounds beside the policy (§9.1, §6.2)', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'harnu-park-bounds-'))
    vi.resetModules()
  })

  it('defaults to the §6.2 values', async () => {
    const store = await import('../src/main/monitor/policy-store')
    expect(store.getNegotiationBounds()).toEqual({
      maxDeclines: 8,
      maxDeferMs: 7_200_000,
      pressureFloorMb: 1_536
    })
  })

  it('reads and clamps the file, and a policy edit keeps them', async () => {
    writeFileSync(
      join(userDataDir, 'monitor-policy.json'),
      JSON.stringify({ maxLive: 3, maxDeclines: 0, maxDeferMs: -5, pressureFloorMb: 512.4 })
    )
    const store = await import('../src/main/monitor/policy-store')
    expect(store.getNegotiationBounds()).toEqual({
      maxDeclines: 1,
      maxDeferMs: 0,
      pressureFloorMb: 512
    })
    store.setPolicy({ maxLive: 4 })
    const onDisk = JSON.parse(readFileSync(join(userDataDir, 'monitor-policy.json'), 'utf8'))
    expect(onDisk).toMatchObject({
      maxLive: 4,
      maxDeclines: 1,
      maxDeferMs: 0,
      pressureFloorMb: 512
    })
    expect(store.getPolicy()).toEqual({ maxLive: 4, lruIdleMs: 900_000, hardIdleMs: 3_600_000 })
  })
})

describe('MemAvailable (§6.3)', () => {
  it('parses /proc/meminfo into MB', () => {
    const meminfo = 'MemTotal:       65645908 kB\nMemFree:  1 kB\nMemAvailable:   23941484 kB\n'
    expect(parseMemAvailableMb(meminfo)).toBe(23_380)
  })

  it('reads null when the line is missing or garbled', () => {
    expect(parseMemAvailableMb('MemTotal: 1 kB\n')).toBeNull()
    expect(parseMemAvailableMb('MemAvailable: lots kB\n')).toBeNull()
    expect(parseMemAvailableMb('')).toBeNull()
  })
})

describe('park ledger — the negotiation field (§6.5)', () => {
  afterEach(() => resetHibernation())

  it('records why a park happened, and nothing when negotiation did not run', () => {
    recordPark('a', 1, { declines: 8, reasons: ['background-task'], why: 'limit' })
    recordPark('b', 2)
    expect(parkHistory()).toEqual([
      {
        sessionKey: 'a',
        parkedAt: 1,
        wokenAt: null,
        wakeGesture: null,
        negotiation: { declines: 8, reasons: ['background-task'], why: 'limit' }
      },
      { sessionKey: 'b', parkedAt: 2, wokenAt: null, wakeGesture: null }
    ])
  })
})
