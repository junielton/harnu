/**
 * T489 (agent terminals B8) — the pure `waitFor` engine, with an injected clock and fake timers.
 *
 * AC-B8-1 (every `wait.reason`, the first condition wins), AC-B8-3 (`idleMs` counts from the last
 * byte of the send), AC-B8-6 (pattern limits, the 64 KiB / 100 ms bounds, the ReDoS budget), and
 * the echo-skip rules behind AC-B8-2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MATCH_MAX_BYTES,
  PATTERN_MAX_CHARS,
  checkWaitFor,
  compileWaitPattern,
  matchSurface,
  skipEcho,
  tailBytes,
  vmExec,
  waitForOutput,
  type MatchExec,
  type WaitIo,
  type WaitSpec
} from '../src/main/terminal-wait'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => vi.useRealTimers())

interface Rig {
  io: WaitIo
  state: {
    lastOutputAt: number
    exited: boolean
    aborted: boolean
    surface: string
    surfaceCalls: number[]
  }
  abort: () => void
}

function rig(over: Partial<WaitIo> = {}): Rig {
  const state = {
    lastOutputAt: 0,
    exited: false,
    aborted: false,
    surface: '',
    surfaceCalls: [] as number[]
  }
  let wake: () => void = () => {}
  const woken = new Promise<void>((r) => (wake = r))
  const io: WaitIo = {
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    sentAt: Date.now(),
    lastOutputAt: () => state.lastOutputAt,
    hasExited: () => state.exited,
    surface: async () => {
      state.surfaceCalls.push(Date.now())
      return state.surface
    },
    abort: { is: () => state.aborted, wake: () => woken },
    ...over
  }
  return {
    io,
    state,
    abort: () => {
      state.aborted = true
      wake()
    }
  }
}

/** Output arrives: the text the program printed and the stamp the registry would set. */
const output = (r: Rig, text: string): void => {
  r.state.surface = text
  r.state.lastOutputAt = Date.now()
}

async function run(
  r: Rig,
  spec: WaitSpec,
  ms: number
): Promise<Awaited<ReturnType<typeof waitForOutput>>> {
  const p = waitForOutput(r.io, spec)
  await vi.advanceTimersByTimeAsync(ms)
  return p
}

describe('AC-B8-1 — wait.reason, the first condition to fire wins', () => {
  it('pattern: matches what the program printed, reports the matched text', async () => {
    const r = rig()
    setTimeout(() => output(r, 'running\n12 passed in 3s'), 300)
    const res = await run(r, { pattern: '\\d+ passed' }, 2000)
    expect(res.reason).toBe('pattern')
    expect(res.match).toBe('12 passed')
    // Not before the output existed, and promptly after it (the 100 ms matcher interval + a tick).
    expect(res.waitedMs).toBeGreaterThanOrEqual(300)
    expect(res.waitedMs).toBeLessThanOrEqual(450)
  })

  it('idle: no output for idleMs, counted from the send', async () => {
    const r = rig()
    const res = await run(r, { idleMs: 400 }, 2000)
    expect(res.reason).toBe('idle')
    expect(res.waitedMs).toBeGreaterThanOrEqual(400)
    expect(res.waitedMs).toBeLessThan(500)
  })

  it('idle restarts on every output byte', async () => {
    const r = rig()
    for (const t of [200, 400, 600]) setTimeout(() => output(r, `tick ${t}`), t)
    const res = await run(r, { idleMs: 300 }, 3000)
    expect(res.reason).toBe('idle')
    // 600 (last byte) + 300 quiet.
    expect(res.waitedMs).toBeGreaterThanOrEqual(900)
    expect(res.waitedMs).toBeLessThan(1000)
  })

  it('timeout: a hard stop, not an error; the default is 15 s', async () => {
    const r = rig()
    const res = await run(r, { pattern: 'never appears' }, 20_000)
    expect(res.reason).toBe('timeout')
    expect(res.waitedMs).toBe(15_000)

    const r2 = rig()
    const res2 = await run(r2, { pattern: 'never appears', timeoutMs: 1000 }, 3000)
    expect(res2).toMatchObject({ reason: 'timeout', waitedMs: 1000 })
  })

  it('timeoutMs alone waits for it (e.g. to see whether the program ends)', async () => {
    const r = rig()
    const res = await run(r, { timeoutMs: 700 }, 2000)
    expect(res).toMatchObject({ reason: 'timeout', waitedMs: 700 })
  })

  it('exited: the PTY ended while waiting', async () => {
    const r = rig()
    setTimeout(() => {
      output(r, 'bye')
      r.state.exited = true
    }, 250)
    const res = await run(r, { pattern: 'never appears', timeoutMs: 5000 }, 3000)
    expect(res.reason).toBe('exited')
    expect(res.waitedMs).toBeGreaterThanOrEqual(250)
    expect(res.waitedMs).toBeLessThan(5000)
  })

  it('exited: a match in the final bytes still wins over the exit', async () => {
    const r = rig()
    setTimeout(() => {
      output(r, 'all done\n3 passed')
      r.state.exited = true
    }, 250)
    const res = await run(r, { pattern: '\\d+ passed', timeoutMs: 5000 }, 3000)
    expect(res).toMatchObject({ reason: 'pattern', match: '3 passed' })
  })

  it('exited: the exit is never declared before the matcher has seen the last output', async () => {
    const r = rig()
    setTimeout(() => {
      output(r, 'x')
      r.state.exited = true
    }, 250)
    await run(r, { pattern: 'zzz', timeoutMs: 5000 }, 3000)
    // The last surface read is at or after the last output.
    expect(Math.max(...r.state.surfaceCalls)).toBeGreaterThanOrEqual(r.state.lastOutputAt)
  })

  it('disconnected: ends at once, mid-sleep, whatever the other conditions say', async () => {
    const r = rig()
    setTimeout(() => r.abort(), 130)
    const res = await run(r, { pattern: 'zzz', idleMs: 10_000, timeoutMs: 60_000 }, 1000)
    expect(res.reason).toBe('disconnected')
    expect(res.waitedMs).toBeGreaterThanOrEqual(130)
    expect(res.waitedMs).toBeLessThan(180)
  })

  it('disconnected: also cuts a surface read that is still in flight', async () => {
    const r = rig({
      surface: () => new Promise<string>(() => {}) // a model that never answers
    })
    setTimeout(() => r.abort(), 500)
    const res = await run(r, { pattern: 'zzz' }, 2000)
    expect(res.reason).toBe('disconnected')
    expect(res.waitedMs).toBeLessThan(600)
  })

  it('the first condition wins: pattern before idle, idle before pattern, either before timeout', async () => {
    const early = rig()
    setTimeout(() => output(early, 'ok done'), 120)
    expect((await run(early, { pattern: 'done', idleMs: 600 }, 2000)).reason).toBe('pattern')

    const late = rig()
    setTimeout(() => output(late, 'ok done'), 900)
    expect((await run(late, { pattern: 'done', idleMs: 300 }, 3000)).reason).toBe('idle')

    const slow = rig()
    setTimeout(() => output(slow, 'ok done'), 900)
    expect((await run(slow, { pattern: 'done', idleMs: 5000, timeoutMs: 500 }, 3000)).reason).toBe(
      'timeout'
    )
  })

  it('a match in the very last bytes is not lost to an idle', async () => {
    const r = rig()
    // Output lands 40 ms before the idle would fire; the matcher has to run before `idle` is declared.
    setTimeout(() => output(r, '5 passed'), 160)
    const res = await run(r, { pattern: 'passed', idleMs: 200 }, 2000)
    expect(res.reason).toBe('pattern')
  })
})

describe('AC-B8-3 — idleMs counts from the last byte of the send, not from the call start', () => {
  it('output before the send does not shorten the quiet period', async () => {
    const sentAt = Date.now() + 0
    const r = rig({ sentAt })
    // The program's last output was long before the send.
    r.state.lastOutputAt = sentAt - 60_000
    const res = await run(r, { idleMs: 500 }, 2000)
    expect(res.reason).toBe('idle')
    expect(res.waitedMs).toBeGreaterThanOrEqual(500)
  })

  it('a send that went out later than the wait began (a long queue) is the clock', async () => {
    // The caller starts waiting, but the last byte of the send was 200 ms into it.
    const r = rig({ sentAt: Date.now() + 200 })
    const res = await run(r, { idleMs: 300 }, 2000)
    expect(res.reason).toBe('idle')
    expect(res.waitedMs).toBeGreaterThanOrEqual(500)
  })
})

describe('AC-B8-6 — the matcher is bounded', () => {
  it('runs at most once every 100 ms, however fast the output changes', async () => {
    const r = rig()
    const t = setInterval(() => output(r, `line ${Date.now()}`), 5)
    const res = await run(r, { pattern: 'never', timeoutMs: 1000 }, 2000)
    clearInterval(t)
    expect(res.reason).toBe('timeout')
    const calls = r.state.surfaceCalls
    expect(calls.length).toBeGreaterThan(5)
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]! - calls[i - 1]!).toBeGreaterThanOrEqual(100)
    }
    expect(calls.length).toBeLessThanOrEqual(11)
  })

  it('does not run again while the output has not changed', async () => {
    const r = rig()
    output(r, 'quiet')
    r.state.lastOutputAt -= 10 // it printed before the wait looked
    await run(r, { pattern: 'never', timeoutMs: 1000 }, 2000)
    expect(r.state.surfaceCalls.length).toBe(1)
  })

  it('never hands the matcher more than 64 KiB, and keeps the newest', async () => {
    const seen: number[] = []
    const exec: MatchExec = (re, text) => {
      seen.push(Buffer.byteLength(text))
      return re.exec(text)
    }
    const r = rig({ exec })
    output(r, 'x'.repeat(300_000) + '\nthe end passed')
    const res = await run(r, { pattern: 'the end passed' }, 1000)
    expect(res.reason).toBe('pattern')
    expect(Math.max(...seen)).toBeLessThanOrEqual(MATCH_MAX_BYTES)
  })

  it('tailBytes keeps the tail by BYTES, so multi-byte text is bounded too', () => {
    const text = 'é'.repeat(MATCH_MAX_BYTES) // 2 bytes each
    expect(Buffer.byteLength(tailBytes(text))).toBeLessThanOrEqual(MATCH_MAX_BYTES)
    expect(tailBytes('short')).toBe('short')
  })

  it('a pattern that blows the time budget is switched off, and the wait ends on something else', async () => {
    const exec: MatchExec = () => 'timeout'
    const r = rig({ exec })
    output(r, 'anything')
    const res = await run(r, { pattern: 'x', idleMs: 300 }, 2000)
    expect(res).toMatchObject({ reason: 'idle', patternDisabled: true })
    // Switched off means it is not tried again.
    expect(r.state.surfaceCalls.length).toBe(1)
  })

  it('the real matcher cuts a catastrophic pattern off (node:vm budget) instead of freezing', () => {
    vi.useRealTimers()
    const re = new RegExp('a*a*a*a*a*a*b', 'm')
    const t0 = Date.now()
    expect(vmExec(re, 'a'.repeat(60_000))).toBe('timeout')
    expect(Date.now() - t0).toBeLessThan(1000)
    // A nested quantifier too.
    expect(vmExec(new RegExp('(a+)+$', 'm'), `${'a'.repeat(40)}!`)).toBe('timeout')
  })

  it('the real matcher still matches ordinary patterns, and resets lastIndex-free state between runs', () => {
    vi.useRealTimers()
    const re = new RegExp('(\\d+) passed', 'm')
    expect(vmExec(re, 'x\n12 passed\n')?.[0]).toBe('12 passed')
    expect(vmExec(re, 'nothing')).toBeNull()
    expect(vmExec(re, '7 passed')?.[1]).toBe('7')
  })
})

describe('AC-B8-6 — a pattern that cannot be used is refused up front', () => {
  it.each([
    ['over 200 characters', 'a'.repeat(PATTERN_MAX_CHARS + 1)],
    ['does not compile', '(unclosed'],
    ['does not compile (bad class)', '[z-a]'],
    ['is empty', ''],
    ['matches the empty string', 'x*'],
    ['matches the empty string (anchors)', '^$']
  ])('%s → WAIT_PATTERN_INVALID', (_label, pattern) => {
    expect(compileWaitPattern(pattern).ok).toBe(false)
    expect(checkWaitFor({ pattern })).toMatchObject({ ok: false })
  })

  it('exactly 200 characters is fine, and so is a plain alternation; flags are fixed to m', () => {
    expect(compileWaitPattern('a'.repeat(PATTERN_MAX_CHARS)).ok).toBe(true)
    const ok = compileWaitPattern('passed|failed')
    expect(ok.ok && ok.re.flags).toBe('m')
    expect(checkWaitFor(undefined)).toBeNull()
    expect(checkWaitFor({ idleMs: 100 })).toBeNull()
  })
})

describe('AC-B8-2 — the match surface skips the echo of what was typed', () => {
  it('the prompt before the cursor and a verbatim echo of the input are not matched', () => {
    expect(matchSurface('$ grep failed log\nbuild failed: x', 2, 'grep failed log')).toBe(
      'build failed: x'
    )
  })

  it('a log with no match leaves nothing for the pattern to hit', () => {
    const surface = matchSurface('$ grep failed log\n$ ', 2, 'grep failed log')
    expect(/failed/m.test(surface)).toBe(false)
  })

  it('a log that does contain the word matches the PROGRAM line, not the echo', () => {
    const surface = matchSurface('$ grep failed log\n2 tests failed\n$ ', 2, 'grep failed log')
    expect(surface.startsWith('2 tests failed')).toBe(true)
    expect(surface.indexOf('failed')).toBe('2 tests '.length)
  })

  it('a transient prompt (powerlevel10k, fish) erases the prompt block and echoes the command again: all of it is echo', () => {
    // What a real zsh+p10k screen holds after `grep failed log` + Enter, from the row the
    // prompt block started on: a spacer, the redrawn command, then the program's output.
    const screen = [
      '',
      '❯ grep failed log',
      '2 tests failed',
      '',
      '  ~/proj  main  09:52 ',
      '❯ '
    ].join('\n')
    expect(matchSurface(screen, 2, 'grep failed log').startsWith('2 tests failed')).toBe(true)
    // The same, when the command was rewritten twice (transient line, then the accepted line).
    const twice = ['grep failed log   ', '❯ grep failed log', 'nothing here'].join('\n')
    expect(matchSurface(twice, 2, 'grep failed log')).toBe('nothing here')
  })

  it('the echo is still arriving: nothing yet', () => {
    expect(matchSurface('$ grep fai', 2, 'grep failed log')).toBe('')
    expect(matchSurface('', 0, 'grep failed log')).toBe('')
    expect(matchSurface('$ ', 2, 'grep failed log')).toBe('')
  })

  it('no echo (a password typed with echo off): only the prompt is cut', () => {
    expect(matchSurface('Password: \nwelcome', 10, 'hunter2')).toBe('\nwelcome')
    expect(matchSurface('Password: ', 10, 'hunter2')).toBe('')
  })

  it('output that merely starts like the input is not swallowed', () => {
    expect(skipEcho('grep: log: No such file', 0, 'grep failed log')).toBe(
      'grep: log: No such file'
    )
  })

  it('a program line that only CONTAINS the typed text is output, not echo', () => {
    expect(matchSurface('$ echo ok\nok then: echo ok is the command\n', 2, 'echo ok')).toBe(
      'ok then: echo ok is the command\n'
    )
  })

  it('multi-line input: continuation prompts in front of each echoed line are echo too', () => {
    expect(skipEcho('echo a\n> echo b\na\nb', 0, 'echo a\necho b\n')).toBe('a\nb')
  })

  it('keys only (no input): the surface is everything after the cursor', () => {
    expect(matchSurface('$ \nresult', 2, undefined)).toBe('\nresult')
  })

  it('a cursor offset past the end of the text cuts everything', () => {
    expect(matchSurface('$', 5, undefined)).toBe('')
  })
})
