import { describe, expect, it } from 'vitest'
import {
  TOMBSTONE_MS,
  TerminalRegistry,
  isTerminalReply,
  terminalAccess,
  type RegisterTerminalInput
} from '../src/main/terminal-registry'

const SIZE = { cols: 120, rows: 30 }

function input(over: Partial<RegisterTerminalInput> = {}): RegisterTerminalInput {
  return {
    terminalId: 'h-1',
    ptyId: 'pty-1',
    folder: '/work/app',
    origin: 'agent',
    ownerSessionId: 'sess-1',
    size: SIZE,
    ...over
  }
}

function make(): { reg: TerminalRegistry; clock: { t: number } } {
  const clock = { t: 1_000 }
  return { reg: new TerminalRegistry(() => clock.t), clock }
}

describe('TerminalRegistry', () => {
  it('noteAgentRead stamps lastAgentReadAt, and is a no-op for an unknown id (T480)', () => {
    const { reg, clock } = make()
    const rec = reg.register(input())
    clock.t = 5_000
    reg.noteAgentRead('h-1')
    expect(rec.lastAgentReadAt).toBe(5_000)
    expect(() => reg.noteAgentRead('h-nope')).not.toThrow()
  })

  it('noteAgentWrite stamps lastAgentWriteAt and never the operator stamp (T482)', () => {
    const { reg, clock } = make()
    const rec = reg.register(input())
    expect(rec.lastAgentWriteAt).toBeNull()
    clock.t = 7_000
    reg.noteAgentWrite('h-1')
    expect(rec.lastAgentWriteAt).toBe(7_000)
    expect(rec.lastOperatorWriteAt).toBeNull()
    expect(() => reg.noteAgentWrite('h-nope')).not.toThrow()
  })

  it('registers a running record that is addressable by terminal id and by pty id', () => {
    const { reg } = make()
    const rec = reg.register(input())
    expect(rec).toMatchObject({
      terminalId: 'h-1',
      ptyId: 'pty-1',
      origin: 'agent',
      ownerSessionId: 'sess-1',
      state: 'running',
      size: SIZE,
      title: null,
      lastAgentReadAt: null,
      lastOperatorWriteAt: null
    })
    expect(reg.get('h-1')).toBe(rec)
    expect(reg.getByPtyId('pty-1')).toBe(rec)
  })

  it('fails closed to an operator origin and a null owner', () => {
    const { reg } = make()
    const rec = reg.register(input({ origin: 'bogus' as never, ownerSessionId: undefined }))
    expect(rec.origin).toBe('operator')
    expect(rec.ownerSessionId).toBeNull()
  })

  it('forget() removes the record and leaves nothing behind (rollback)', () => {
    const { reg } = make()
    reg.register(input())
    reg.forget('h-1')
    expect(reg.get('h-1')).toBeUndefined()
    expect(reg.getByPtyId('pty-1')).toBeUndefined()
    expect(reg.hasPty('pty-1')).toBe(false)
    expect(reg.list()).toEqual([])
  })

  it('counts only live agent terminals of that exact folder', () => {
    const { reg } = make()
    reg.register(input({ terminalId: 'a', ptyId: 'pa' }))
    reg.register(input({ terminalId: 'b', ptyId: 'pb' }))
    reg.register(input({ terminalId: 'c', ptyId: 'pc', folder: '/work/other' }))
    reg.register(input({ terminalId: 'd', ptyId: 'pd', origin: 'operator' }))
    expect(reg.liveAgentCount('/work/app')).toBe(2)
    reg.markExited('pa', 0)
    expect(reg.liveAgentCount('/work/app')).toBe(1)
  })

  describe('exit and tombstone (AC-B1-8)', () => {
    it('a natural exit keeps the record as an exited tombstone', () => {
      const { reg, clock } = make()
      reg.register(input())
      clock.t = 5_000
      const rec = reg.markExited('pty-1', 3)
      expect(rec?.state).toBe('exited')
      expect(rec?.exit).toEqual({ code: 3, at: 5_000, reason: 'natural' })
      expect(reg.get('h-1')?.state).toBe('exited')
    })

    it('is closed iff markClosing ran before the exit', () => {
      const { reg } = make()
      reg.register(input({ terminalId: 'a', ptyId: 'pa' }))
      reg.register(input({ terminalId: 'b', ptyId: 'pb' }))
      reg.markClosing('pa')
      expect(reg.markExited('pa', 0)?.exit?.reason).toBe('closed')
      expect(reg.markExited('pb', 0)?.exit?.reason).toBe('natural')
    })

    it('markClosing for an unknown pty is a no-op and does not poison a later pty', () => {
      const { reg } = make()
      reg.markClosing('ghost')
      reg.register(input({ ptyId: 'ghost' }))
      expect(reg.markExited('ghost', 0)?.exit?.reason).toBe('natural')
    })

    it('a second exit does not rewrite the first', () => {
      const { reg, clock } = make()
      reg.register(input())
      reg.markExited('pty-1', 1)
      clock.t += 1_000
      reg.markExited('pty-1', 9)
      expect(reg.get('h-1')?.exit?.code).toBe(1)
    })

    it('survives 10 minutes minus a tick, then disappears', () => {
      const { reg, clock } = make()
      reg.register(input())
      clock.t = 2_000
      reg.markExited('pty-1', 0)
      clock.t = 2_000 + TOMBSTONE_MS - 1
      expect(reg.get('h-1')).toBeDefined()
      clock.t = 2_000 + TOMBSTONE_MS
      expect(reg.get('h-1')).toBeUndefined()
      expect(reg.getByPtyId('pty-1')).toBeUndefined()
      expect(reg.list()).toEqual([])
    })

    it('a running terminal never expires', () => {
      const { reg, clock } = make()
      reg.register(input())
      clock.t += TOMBSTONE_MS * 5
      expect(reg.get('h-1')?.state).toBe('running')
    })
  })

  describe('owner rekey (AC-B1-9)', () => {
    it('rewrites every terminal that named the synthetic id, and only those', () => {
      const { reg } = make()
      reg.register(input({ terminalId: 'a', ptyId: 'pa', ownerSessionId: 'synthetic-1' }))
      reg.register(input({ terminalId: 'b', ptyId: 'pb', ownerSessionId: 'synthetic-1' }))
      reg.register(input({ terminalId: 'c', ptyId: 'pc', ownerSessionId: 'other' }))
      reg.register(input({ terminalId: 'd', ptyId: 'pd', ownerSessionId: null }))
      expect(reg.rekeyOwner('synthetic-1', 'real-1')).toBe(2)
      expect(reg.get('a')?.ownerSessionId).toBe('real-1')
      expect(reg.get('b')?.ownerSessionId).toBe('real-1')
      expect(reg.get('c')?.ownerSessionId).toBe('other')
      expect(reg.get('d')?.ownerSessionId).toBeNull()
      expect(reg.ownedBy('real-1').map((r) => r.terminalId)).toEqual(['a', 'b'])
      expect(reg.ownedBy('synthetic-1')).toEqual([])
    })

    it('an exited terminal is rekeyed too (the chip + audit keep the real id)', () => {
      const { reg } = make()
      reg.register(input({ ownerSessionId: 'synthetic-1' }))
      reg.markExited('pty-1', 0)
      reg.rekeyOwner('synthetic-1', 'real-1')
      expect(reg.get('h-1')?.ownerSessionId).toBe('real-1')
    })
  })

  describe('operator keystrokes (AC-B1-10)', () => {
    it('stamps lastOperatorWriteAt for ordinary input', () => {
      const { reg, clock } = make()
      reg.register(input())
      clock.t = 9_000
      expect(reg.noteOperatorWrite('pty-1', 'ls -la\r')).toBe(true)
      expect(reg.get('h-1')?.lastOperatorWriteAt).toBe(9_000)
    })

    it('does not stamp for a payload that is wholly a terminal reply', () => {
      const { reg } = make()
      reg.register(input())
      expect(reg.noteOperatorWrite('pty-1', '\x1b[12;40R')).toBe(false)
      expect(reg.get('h-1')?.lastOperatorWriteAt).toBeNull()
    })

    it('stamps when a reply is glued to a real key (the payload is not wholly a reply)', () => {
      const { reg } = make()
      reg.register(input())
      expect(reg.noteOperatorWrite('pty-1', '\x1b[12;40Rl')).toBe(true)
    })

    it('is a no-op for a PTY that is not registered', () => {
      const { reg } = make()
      expect(reg.noteOperatorWrite('nope', 'x')).toBe(false)
    })
  })

  describe('program title', () => {
    it('records the last OSC 0/2 title, truncated', () => {
      const { reg } = make()
      reg.register(input())
      reg.noteOutput('pty-1', 'a\x1b]0;first\x07b\x1b]2;second\x1b\\c')
      expect(reg.get('h-1')?.title).toBe('second')
      reg.noteOutput('pty-1', `\x1b]0;${'x'.repeat(500)}\x07`)
      expect(reg.get('h-1')?.title).toHaveLength(200)
    })

    it('survives a title split across two chunks', () => {
      const { reg } = make()
      reg.register(input())
      reg.noteOutput('pty-1', 'hello \x1b]0;ver')
      reg.noteOutput('pty-1', 'bose\x07 world')
      expect(reg.get('h-1')?.title).toBe('verbose')
    })

    it('ignores other OSC sequences and plain output, but still stamps lastOutputAt', () => {
      const { reg, clock } = make()
      reg.register(input())
      clock.t = 4_000
      reg.noteOutput('pty-1', '\x1b]8;;http://x\x07link\x1b]8;;\x07')
      expect(reg.get('h-1')?.title).toBeNull()
      expect(reg.get('h-1')?.lastOutputAt).toBe(4_000)
    })
  })

  describe('slot reservation (parallel spawns)', () => {
    it('reserves up to the limit counting live terminals, then refuses', () => {
      const { reg } = make()
      reg.register(input({ terminalId: 'a', ptyId: 'pa' }))
      expect(reg.reserveSlot('/work/app', 3)).toBe(true)
      expect(reg.reserveSlot('/work/app', 3)).toBe(true)
      expect(reg.reserveSlot('/work/app', 3)).toBe(false)
    })

    it('a released slot can be claimed again, and release never goes negative', () => {
      const { reg } = make()
      expect(reg.reserveSlot('/work/app', 1)).toBe(true)
      expect(reg.reserveSlot('/work/app', 1)).toBe(false)
      reg.releaseSlot('/work/app')
      reg.releaseSlot('/work/app')
      expect(reg.reserveSlot('/work/app', 1)).toBe(true)
      expect(reg.reserveSlot('/work/app', 2)).toBe(true)
    })

    it('is per folder', () => {
      const { reg } = make()
      expect(reg.reserveSlot('/a', 1)).toBe(true)
      expect(reg.reserveSlot('/b', 1)).toBe(true)
    })
  })

  it('noteResize keeps the reported size current', () => {
    const { reg } = make()
    reg.register(input())
    reg.noteResize('pty-1', 80, 24)
    expect(reg.get('h-1')?.size).toEqual({ cols: 80, rows: 24 })
  })
})

describe('isTerminalReply', () => {
  it.each([
    ['CPR', '\x1b[12;40R'],
    ['CPR (private)', '\x1b[?12;40R'],
    ['DSR ok', '\x1b[0n'],
    ['DA1', '\x1b[?62;4c'],
    ['DA2', '\x1b[>0;276;0c'],
    ['DECRPM', '\x1b[?2004;2$y'],
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
    ['DCS reply', '\x1bP1$r0m\x1b\\'],
    ['OSC reply (BEL)', '\x1b]11;rgb:0000/0000/0000\x07'],
    ['OSC reply (ST)', '\x1b]11;rgb:0000/0000/0000\x1b\\'],
    ['several in a row', '\x1b[?62;4c\x1b[12;1R\x1b[I']
  ])('%s is a reply', (_name, data) => {
    expect(isTerminalReply(data)).toBe(true)
  })

  it.each([
    ['empty', ''],
    ['plain text', 'ls\r'],
    ['an arrow key', '\x1b[A'],
    ['Enter', '\r'],
    ['Esc alone', '\x1b'],
    ['reply then a key', '\x1b[12;40Rx'],
    ['a key then a reply', 'x\x1b[12;40R']
  ])('%s is not a reply', (_name, data) => {
    expect(isTerminalReply(data)).toBe(false)
  })
})

describe('terminalAccess — writableReason is present iff writable is off', () => {
  const on = { readOptIn: true, writesEnabled: true }
  const base = { origin: 'agent', disconnected: false, state: 'running' } as const

  it.each([
    ['agent, running', base, on, { writable: 'free' }],
    ['operator with opt-in', { ...base, origin: 'operator' }, on, { writable: 'confirm' }],
    ['disconnected', { ...base, disconnected: true }, on, { writable: 'revoked' }],
    ['exited', { ...base, state: 'exited' }, on, { writable: 'off', writableReason: 'exited' }],
    [
      'operator, no opt-in',
      { ...base, origin: 'operator' },
      { readOptIn: false, writesEnabled: true },
      { writable: 'off', writableReason: 'read-not-enabled' }
    ],
    [
      'kill-switch off',
      base,
      { readOptIn: true, writesEnabled: false },
      { writable: 'off', writableReason: 'kill-switch' }
    ]
  ] as const)('%s', (_n, rec, prefs, expected) => {
    const access = terminalAccess(rec, prefs)
    expect(access).toMatchObject(expected)
    expect('writableReason' in access && access.writableReason !== undefined).toBe(
      access.writable === 'off'
    )
  })
})
