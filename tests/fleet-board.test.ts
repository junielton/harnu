import { describe, it, expect } from 'vitest'
import {
  classifyBoardState,
  buildBoard,
  lastPtyLine,
  BOARD_STATES,
  type BoardSession,
  type BoardState
} from '../src/renderer/src/components/fleet-board'

/** Factory for a board-session slice (mirrors session-sort.test.ts `s`). */
const bs = (
  sessionId: string,
  over: Partial<Omit<BoardSession, 'sessionId'>> = {}
): BoardSession => ({
  sessionId,
  taskState: over.taskState,
  status: over.status ?? 'idle',
  isSidechain: over.isSidechain ?? false,
  modified: over.modified ?? '',
  // `activity` is the store-resolved verdict; default `idle`. Working/stuck cases
  // set it explicitly (the store computes it from `resolveActivity`).
  activity: over.activity ?? 'idle',
  folderAlias: over.folderAlias ?? 'repo'
})

const states = (buckets: ReturnType<typeof buildBoard>): BoardState[] => buckets.map((b) => b.state)
const ids = (arr: ReadonlyArray<{ sessionId: string }>): string[] => arr.map((x) => x.sessionId)

describe('classifyBoardState (FSM + activity → bucket)', () => {
  it('needs-input is sticky even when the activity says idle', () => {
    expect(classifyBoardState({ taskState: 'needs-input', activity: 'idle' })).toBe('needs-input')
  })

  it('failed → errored', () => {
    expect(classifyBoardState({ taskState: 'failed', activity: 'idle' })).toBe('errored')
  })

  it('completed → done', () => {
    expect(classifyBoardState({ taskState: 'completed', activity: 'idle' })).toBe('done')
  })

  it('non-terminal states defer to the canonical activity verdict', () => {
    expect(classifyBoardState({ taskState: 'working', activity: 'working' })).toBe('working')
    expect(classifyBoardState({ taskState: 'working', activity: 'stuck' })).toBe('stuck')
    expect(classifyBoardState({ taskState: 'working', activity: 'idle' })).toBe('idle')
    expect(classifyBoardState({ taskState: undefined, activity: 'working' })).toBe('working')
    expect(classifyBoardState({ taskState: 'idle', activity: 'idle' })).toBe('idle')
  })

  it('T91: a transcript needs-input (no hook) lands in the needs-input bucket', () => {
    expect(
      classifyBoardState({ taskState: undefined, transcriptState: 'needs-input', activity: 'idle' })
    ).toBe('needs-input')
  })

  it('T91: a live hook keeps priority over a stale transcript needs-input', () => {
    expect(
      classifyBoardState({
        taskState: 'working',
        transcriptState: 'needs-input',
        activity: 'working'
      })
    ).toBe('working')
  })

  it('BUG-13: board and dot agree — a quiet working session is working, not idle', () => {
    // resolveActivity returned working (under N); the board must not drift to idle.
    expect(classifyBoardState({ taskState: 'working', activity: 'working' })).toBe('working')
  })

  it('BUG-13: a working session gone quiet ≥ N lands in the stuck bucket', () => {
    expect(classifyBoardState({ taskState: 'working', activity: 'stuck' })).toBe('stuck')
  })

  it('an unknown future taskState still defers to activity (no phantom bucket)', () => {
    expect(classifyBoardState({ taskState: 'teleporting' as never, activity: 'idle' })).toBe('idle')
  })
})

describe('buildBoard (group + order + drop empty)', () => {
  it('orders buckets by BOARD_STATES urgency and drops empty ones', () => {
    const out = buildBoard([
      bs('a', { taskState: 'completed' }),
      bs('b', { taskState: 'needs-input' }),
      bs('s', { taskState: 'working', activity: 'stuck' }),
      bs('c', { taskState: 'working', activity: 'working' })
    ])
    // present states only, in canonical order: needs-input, stuck, working, done
    expect(states(out)).toEqual(['needs-input', 'stuck', 'working', 'done'])
    // no empty buckets (errored, idle absent)
    expect(out.every((b) => b.sessions.length > 0)).toBe(true)
  })

  it('BOARD_STATES is the canonical urgency order (stuck between errored and working)', () => {
    expect([...BOARD_STATES]).toEqual([
      'needs-input',
      'errored',
      'stuck',
      'working',
      'idle',
      'done'
    ])
  })

  it('within a bucket, sorts by modified desc; invalid/empty date sinks to end', () => {
    const w = { taskState: 'working' as const, activity: 'working' as const }
    const out = buildBoard([
      bs('old', { ...w, modified: '2026-06-01T10:00:00.000Z' }),
      bs('bad', { ...w, modified: '' }),
      bs('new', { ...w, modified: '2026-06-20T10:00:00.000Z' })
    ])
    expect(ids(out[0].sessions)).toEqual(['new', 'old', 'bad'])
  })

  it('stable tiebreak on equal modified (preserves input order)', () => {
    const t = '2026-06-10T10:00:00.000Z'
    const out = buildBoard([
      bs('x', { taskState: 'idle', modified: t }),
      bs('y', { taskState: 'idle', modified: t }),
      bs('z', { taskState: 'idle', modified: t })
    ])
    expect(ids(out[0].sessions)).toEqual(['x', 'y', 'z'])
  })

  it('empty input → empty array', () => {
    expect(buildBoard([])).toEqual([])
  })

  it('does not mutate the input', () => {
    const input = [
      bs('a', { taskState: 'needs-input', modified: '2026-06-01T00:00:00.000Z' }),
      bs('b', { taskState: 'working', modified: '2026-06-02T00:00:00.000Z' })
    ]
    const snapshot = JSON.parse(JSON.stringify(input))
    const out = buildBoard(input)
    expect(out).not.toBe(input)
    expect(input).toEqual(snapshot)
  })

  it('assumes sidechains are pre-filtered by the caller (does not filter)', () => {
    // documents the contract: buildBoard classifies whatever it gets.
    const out = buildBoard([bs('side', { taskState: 'working', isSidechain: true })])
    expect(ids(out[0].sessions)).toEqual(['side'])
  })
})

describe('lastPtyLine (sanitize PTY snapshot)', () => {
  it('strips ANSI and returns the last readable line', () => {
    expect(lastPtyLine('\x1b[32mok\x1b[0m\n\x1b[31mfail\x1b[0m')).toBe('fail')
  })

  it('picks the last NON-empty line, skipping trailing blanks', () => {
    expect(lastPtyLine('first\nsecond\n\n  \n')).toBe('second')
  })

  it('resolves carriage returns to the final rewrite segment', () => {
    expect(lastPtyLine('Progress: 10%\rProgress: 100%')).toBe('Progress: 100%')
  })

  it('truncates to maxLen with an ellipsis', () => {
    const long = 'x'.repeat(120)
    const out = lastPtyLine(long, 10)
    expect(out.length).toBeLessThanOrEqual(10)
    expect(out.endsWith('…')).toBe(true)
  })

  it('empty / whitespace-only snapshot → empty string', () => {
    expect(lastPtyLine('')).toBe('')
    expect(lastPtyLine('  \n\t\n')).toBe('')
  })

  it('never throws on weird control bytes', () => {
    expect(() => lastPtyLine('\x07\x1b[2K\rdone\x00')).not.toThrow()
    expect(lastPtyLine('\x07\x1b[2K\rdone\x00')).toContain('done')
  })

  it('strips charset-designation escapes (ESC ( B …) leaving no residue', () => {
    // The real bug seen in the board: `\x1b(B` left a literal "(B" behind.
    expect(lastPtyLine('\x1b(Bhello')).toBe('hello')
    expect(lastPtyLine('done\x1b(B')).toBe('done')
    expect(lastPtyLine('\x1b(B\x1b(B\x1b(Bclean')).toBe('clean')
    expect(lastPtyLine('a\x1b)0b')).toBe('ab')
  })

  it('strips OSC sequences (window title etc.) terminated by BEL or ST', () => {
    expect(lastPtyLine('\x1b]0;some title\x07ok')).toBe('ok')
    expect(lastPtyLine('\x1b]2;title\x1b\\done')).toBe('done')
  })
})
