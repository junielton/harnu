/**
 * T358 S5 — process hygiene of the mission behavior-eval harness
 * (`scripts/eval/mission-behavior/procs.mjs`). The harness starts processes that
 * bill the operator; these tests pin that it kills exactly what it started —
 * escalating to SIGKILL when SIGTERM is ignored — and never anything else.
 * Everything runs against a fake process table: no process is spawned.
 */
import { describe, it, expect } from 'vitest'
import {
  createLedger,
  escalate,
  groupTarget,
  parseStat
} from '../scripts/eval/mission-behavior/procs.mjs'

interface FakeProc {
  ppid: number
  starttime: string
  cwd: string
  /** Signals this process ignores (it survives them). */
  ignores?: string[]
}

/** A fake `/proc` + `kill` pair over a mutable table. */
function fakeSystem(table: Record<number, FakeProc>): {
  fs: {
    listPids: () => number[]
    readStat: (pid: number) => { pid: number; ppid: number; pgid: number; starttime: string } | null
    readCwd: (pid: number) => string | null
  }
  kill: (pid: number, signal: string) => void
  sent: Array<[number, string]>
} {
  const sent: Array<[number, string]> = []
  return {
    fs: {
      listPids: () => Object.keys(table).map(Number),
      readStat: (pid) =>
        table[pid]
          ? { pid, ppid: table[pid].ppid, pgid: pid, starttime: table[pid].starttime }
          : null,
      readCwd: (pid) => table[pid]?.cwd ?? null
    },
    kill: (pid, signal) => {
      sent.push([pid, signal])
      const p = table[pid]
      if (p && !(p.ignores ?? []).includes(signal)) delete table[pid]
    },
    sent
  }
}

const noSleep = async (): Promise<void> => {}

describe('parseStat', () => {
  it('reads ppid, pgid and start time past a command name holding spaces and parens', () => {
    const stat =
      '4242 (claude (x) y) S 4200 4242 4242 0 -1 4194304 0 0 0 0 0 0 0 0 20 0 1 0 987654 8519680 477'
    expect(parseStat(stat)).toEqual({ pid: 4242, ppid: 4200, pgid: 4242, starttime: '987654' })
  })

  it('returns null for text that is not a stat line', () => {
    expect(parseStat('garbage')).toBeNull()
  })
})

describe('escalate', () => {
  it('SIGTERMs, and SIGKILLs only what survives the grace period', async () => {
    const alive = { a: true, b: true }
    const sent: string[] = []
    const target = (name: 'a' | 'b', ignoresTerm: boolean) => ({
      label: name,
      alive: () => alive[name],
      send: (signal: string) => {
        sent.push(`${name}:${signal}`)
        if (signal === 'SIGKILL' || !ignoresTerm) alive[name] = false
      }
    })
    const res = await escalate([target('a', false), target('b', true)], {
      graceMs: 300,
      pollMs: 100,
      sleep: noSleep
    })
    expect(res).toEqual({ terminated: ['a'], killed: ['b'] })
    expect(sent).toEqual(['a:SIGTERM', 'b:SIGTERM', 'b:SIGKILL'])
  })

  it('never signals a target that is already gone', async () => {
    const sent: string[] = []
    const res = await escalate(
      [{ label: 'gone', alive: () => false, send: (s: string) => void sent.push(s) }],
      { sleep: noSleep }
    )
    expect(sent).toEqual([])
    expect(res).toEqual({ terminated: [], killed: [] })
  })
})

describe('the process ledger', () => {
  // 100 = the harness's xvfb-run (root), 101 = Electron, 102 = an Electron helper,
  // 200 = a claude session Harnu spawned into the sandbox (own session, still a
  // child of Electron), 201 = something that session started,
  // 900 = an unrelated operator process that happens to sit in the sandbox too.
  const SANDBOX = '/tmp/harnu-mission-eval-x/scenario'
  function table(): Record<number, FakeProc> {
    return {
      100: { ppid: 1, starttime: 't100', cwd: '/repo' },
      101: { ppid: 100, starttime: 't101', cwd: '/repo' },
      102: { ppid: 101, starttime: 't102', cwd: '/repo' },
      200: { ppid: 101, starttime: 't200', cwd: SANDBOX, ignores: ['SIGTERM'] },
      201: { ppid: 200, starttime: 't201', cwd: '/elsewhere' },
      900: { ppid: 1, starttime: 't900', cwd: SANDBOX }
    }
  }

  it('records the tree the harness started and nothing else', () => {
    const sys = fakeSystem(table())
    const ledger = createLedger(sys)
    ledger.trackRoot(100)
    ledger.snapshot()
    expect(
      ledger
        .alive()
        .map((e: { pid: number }) => e.pid)
        .sort()
    ).toEqual([100, 101, 102, 200, 201])
  })

  it('keeps a spawned session after the instance dies and it is reparented to init', () => {
    const t = table()
    const sys = fakeSystem(t)
    const ledger = createLedger(sys)
    ledger.trackRoot(100)
    ledger.snapshot()
    delete t[100]
    delete t[101]
    delete t[102]
    t[200].ppid = 1
    ledger.snapshot()
    expect(
      ledger
        .alive()
        .map((e: { pid: number }) => e.pid)
        .sort()
    ).toEqual([200, 201])
  })

  it('never treats a recycled pid as one of its own', () => {
    const t = table()
    const sys = fakeSystem(t)
    const ledger = createLedger(sys)
    ledger.trackRoot(100)
    ledger.snapshot()
    const recorded = ledger.alive().find((e: { pid: number }) => e.pid === 200)
    // The session exits and the kernel hands its pid to an unrelated process.
    t[200] = { ppid: 1, starttime: 'reused', cwd: SANDBOX }
    expect(ledger.alive().map((e: { pid: number }) => e.pid)).not.toContain(200)
    ledger.target(recorded).send('SIGKILL')
    expect(sys.sent).toEqual([])
  })

  it('selects a scenario’s sessions and what they started, not the Electron helpers or a stranger', () => {
    const sys = fakeSystem(table())
    const ledger = createLedger(sys)
    ledger.trackRoot(100)
    ledger.snapshot()
    expect(
      ledger
        .aliveUnder(SANDBOX)
        .map((e: { pid: number }) => e.pid)
        .sort()
    ).toEqual([200, 201])
  })

  it('escalates to SIGKILL on a session that ignores SIGTERM, and leaves the stranger alone', async () => {
    const t = table()
    const sys = fakeSystem(t)
    const ledger = createLedger(sys)
    ledger.trackRoot(100)
    ledger.snapshot()
    const res = await escalate(
      ledger.aliveUnder(SANDBOX).map((e: { pid: number }) => ledger.target(e)),
      { graceMs: 200, pollMs: 100, sleep: noSleep }
    )
    expect(res.killed).toEqual(['pid 200'])
    expect(sys.sent).toEqual([
      [200, 'SIGTERM'],
      [201, 'SIGTERM'],
      [200, 'SIGKILL']
    ])
    expect(t[900]).toBeDefined()
    expect(t[101]).toBeDefined()
  })
})

describe('groupTarget', () => {
  it('signals the negative pgid and reads ESRCH as gone', () => {
    let members = 1
    const calls: Array<[number, string | number]> = []
    const kill = (pid: number, signal: string | number): void => {
      calls.push([pid, signal])
      if (signal === 0 && members === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
      if (signal === 'SIGKILL') members = 0
    }
    const g = groupTarget(4242, { kill })
    expect(g.alive()).toBe(true)
    g.send('SIGKILL')
    expect(g.alive()).toBe(false)
    expect(calls).toEqual([
      [-4242, 0],
      [-4242, 'SIGKILL'],
      [-4242, 0]
    ])
  })
})
