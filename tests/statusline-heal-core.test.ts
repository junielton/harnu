import { describe, expect, it, vi } from 'vitest'
import {
  HEAL_LOG_MAX_BYTES,
  HEAL_LOG_MAX_LINES,
  HEAL_NOTICE_COOLDOWN_MS,
  buildHealLogLine,
  classifyStatusLine,
  planHealNotice,
  runHealTick,
  staleProcs,
  trimHealLog,
  type HealNoticeState,
  type HealTickDeps,
  type LiveClaudeProc
} from '../src/main/statusline-heal-core'

const OURS = 'sh "/home/u/.config/harnu/statusline/statusline-writer.sh"'
const T0 = Date.parse('2026-10-19T11:02:30.000Z')

const proc = (over: Partial<LiveClaudeProc> = {}): LiveClaudeProc => ({
  sessionKey: 'sess-a',
  pid: 4242,
  startedAtMs: T0 - 3_600_000,
  ...over
})

describe('classifyStatusLine', () => {
  it('treats an absent key as missing', () => {
    expect(classifyStatusLine(undefined, OURS, true)).toBe('missing')
    expect(classifyStatusLine(null, OURS, false)).toBe('missing')
  })

  it('accepts our own command', () => {
    expect(classifyStatusLine({ type: 'command', command: OURS }, OURS, true)).toBe('ok')
  })

  it('reports a foreign command as replaced only where it was ours before', () => {
    const foreign = { type: 'command', command: 'my-own-statusline.sh' }
    expect(classifyStatusLine(foreign, OURS, true)).toBe('replaced')
    // never installed by this run: a user's own statusLine is theirs, nothing to report
    expect(classifyStatusLine(foreign, OURS, false)).toBe('ok')
  })
})

describe('buildHealLogLine (AC-3)', () => {
  it('is one ndjson line with the timestamp, the finding, the settings mtime and the live pids', () => {
    const line = buildHealLogLine({
      atMs: T0,
      finding: 'missing',
      settingsMtimeMs: T0 - 5_000,
      procs: [proc(), proc({ sessionKey: 'sess-b', pid: 99, startedAtMs: T0 + 1_000 })]
    })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd().includes('\n')).toBe(false)
    const parsed = JSON.parse(line)
    expect(parsed.at).toBe('2026-10-19T11:02:30.000Z')
    expect(parsed.finding).toBe('missing')
    expect(parsed.settingsMtime).toBe(new Date(T0 - 5_000).toISOString())
    expect(parsed.settingsMtimeMs).toBe(T0 - 5_000)
    expect(parsed.claude).toEqual([
      { pid: 4242, sessionKey: 'sess-a', startedAt: new Date(T0 - 3_600_000).toISOString() },
      { pid: 99, sessionKey: 'sess-b', startedAt: new Date(T0 + 1_000).toISOString() }
    ])
  })

  it('records a null mtime when settings.json did not exist', () => {
    const parsed = JSON.parse(
      buildHealLogLine({ atMs: T0, finding: 'missing', settingsMtimeMs: null, procs: [] })
    )
    expect(parsed.settingsMtime).toBeNull()
    expect(parsed.claude).toEqual([])
  })
})

describe('trimHealLog (AC-3 bounded)', () => {
  it('keeps everything under the caps', () => {
    const log = 'a\nb\nc\n'
    expect(trimHealLog(log)).toBe(log)
  })

  it('keeps only the newest lines past the line cap', () => {
    const lines = Array.from({ length: HEAL_LOG_MAX_LINES + 25 }, (_, i) => `{"n":${i}}`)
    const out = trimHealLog(lines.join('\n') + '\n')
      .trimEnd()
      .split('\n')
    expect(out).toHaveLength(HEAL_LOG_MAX_LINES)
    expect(out[out.length - 1]).toBe(`{"n":${HEAL_LOG_MAX_LINES + 24}}`)
    expect(out[0]).toBe('{"n":25}')
  })

  it('keeps the newest lines when the byte cap is the binding one, never cutting a line', () => {
    const big = 'x'.repeat(1000)
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ n: i, pad: big }))
    const out = trimHealLog(lines.join('\n') + '\n')
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(HEAL_LOG_MAX_BYTES)
    const kept = out.trimEnd().split('\n')
    for (const l of kept) expect(() => JSON.parse(l)).not.toThrow()
    expect(JSON.parse(kept[kept.length - 1]).n).toBe(199)
  })
})

describe('staleProcs (AC-4)', () => {
  it('names only the processes that started before the heal', () => {
    const before = proc({ sessionKey: 'old', startedAtMs: T0 - 1 })
    const after = proc({ sessionKey: 'new', startedAtMs: T0 + 1 })
    const same = proc({ sessionKey: 'same', startedAtMs: T0 })
    expect(staleProcs([before, after, same], T0).map((p) => p.sessionKey)).toEqual(['old'])
  })
})

describe('planHealNotice (AC-4 — one notice, no spam)', () => {
  const fresh: HealNoticeState = { lastKey: null, lastAtMs: 0 }

  it('posts one notice naming the sessions that started before the heal', () => {
    const { notice, next } = planHealNotice(fresh, T0, [
      proc({ sessionKey: 'b' }),
      proc({ sessionKey: 'a' }),
      proc({ sessionKey: 'later', startedAtMs: T0 + 5 })
    ])
    expect(notice).toEqual({ atMs: T0, sessionKeys: ['a', 'b'] })
    expect(next).toEqual({ lastKey: 'a|b', lastAtMs: T0 })
  })

  it('posts a notice even when no session was running (the key was still removed)', () => {
    const { notice } = planHealNotice(fresh, T0, [])
    expect(notice).toEqual({ atMs: T0, sessionKeys: [] })
  })

  it('suppresses a repeat inside the cooldown, whatever the sessions', () => {
    const first = planHealNotice(fresh, T0, [proc({ sessionKey: 'a' })])
    const again = planHealNotice(first.next, T0 + 60_000, [proc({ sessionKey: 'z' })])
    expect(again.notice).toBeNull()
    expect(again.next).toEqual(first.next) // a suppressed repeat does not extend the window
  })

  it('suppresses the same stale set an hour-scale window after the cooldown', () => {
    const first = planHealNotice(fresh, T0, [proc({ sessionKey: 'a' })])
    const later = T0 + HEAL_NOTICE_COOLDOWN_MS + 1
    expect(planHealNotice(first.next, later, [proc({ sessionKey: 'a' })]).notice).toBeNull()
  })

  it('posts again when a different set of sessions is stale after the cooldown', () => {
    const first = planHealNotice(fresh, T0, [proc({ sessionKey: 'a' })])
    const later = T0 + HEAL_NOTICE_COOLDOWN_MS + 1
    const second = planHealNotice(first.next, later, [proc({ sessionKey: 'a', startedAtMs: T0 })])
    // 'a' started at T0, before `later`, and is the same key: still suppressed
    expect(second.notice).toBeNull()
    const third = planHealNotice(first.next, later, [proc({ sessionKey: 'b', startedAtMs: T0 })])
    expect(third.notice).toEqual({ atMs: later, sessionKeys: ['b'] })
  })
})

describe('runHealTick (AC-3 + AC-4 end to end, injected deps)', () => {
  function makeDeps(over: Partial<HealTickDeps> = {}): HealTickDeps & {
    appended: string[]
    notices: unknown[]
  } {
    const appended: string[] = []
    const notices: unknown[] = []
    const deps: HealTickDeps = {
      now: () => T0,
      enabled: async () => true,
      readSettings: async () => ({ kind: 'ok', statusLine: undefined, mtimeMs: T0 - 7_000 }),
      reinstall: vi.fn(async () => {}),
      appendLog: async (line) => {
        appended.push(line)
      },
      liveProcs: () => [proc()],
      notice: (n) => {
        notices.push(n)
      },
      wasOurs: () => true,
      ourCommand: () => OURS,
      noticeState: { lastKey: null, lastAtMs: 0 },
      ...over
    }
    return Object.assign(deps, { appended, notices })
  }

  it('re-installs, appends one log line and posts one notice when the key is missing', async () => {
    const deps = makeDeps()
    await runHealTick(deps)
    expect(deps.reinstall).toHaveBeenCalledTimes(1)
    expect(deps.appended).toHaveLength(1)
    const logged = JSON.parse(deps.appended[0])
    expect(logged.finding).toBe('missing')
    expect(logged.settingsMtimeMs).toBe(T0 - 7_000)
    expect(logged.claude).toHaveLength(1)
    expect(deps.notices).toEqual([{ atMs: T0, sessionKeys: ['sess-a'] }])
  })

  it('logs the heal BEFORE it rewrites settings.json, so the evidence is the pre-heal mtime', async () => {
    const order: string[] = []
    const deps = makeDeps({
      appendLog: async () => {
        order.push('log')
      },
      reinstall: vi.fn(async () => {
        order.push('reinstall')
      })
    })
    await runHealTick(deps)
    expect(order).toEqual(['log', 'reinstall'])
  })

  it('does nothing when the key is present and ours', async () => {
    const deps = makeDeps({
      readSettings: async () => ({
        kind: 'ok',
        statusLine: { type: 'command', command: OURS },
        mtimeMs: T0
      })
    })
    await runHealTick(deps)
    expect(deps.reinstall).not.toHaveBeenCalled()
    expect(deps.appended).toEqual([])
    expect(deps.notices).toEqual([])
  })

  it('logs evidence for a replaced statusLine but neither re-installs nor notifies', async () => {
    const deps = makeDeps({
      readSettings: async () => ({
        kind: 'ok',
        statusLine: { type: 'command', command: 'foreign.sh' },
        mtimeMs: T0
      })
    })
    await runHealTick(deps)
    expect(deps.reinstall).not.toHaveBeenCalled()
    expect(JSON.parse(deps.appended[0]).finding).toBe('replaced')
    expect(deps.notices).toEqual([])
  })

  it('logs a persistent replaced statusLine once, not on every tick', async () => {
    const deps = makeDeps({
      readSettings: async () => ({
        kind: 'ok',
        statusLine: { type: 'command', command: 'foreign.sh' },
        mtimeMs: T0
      })
    })
    await runHealTick(deps)
    await runHealTick(deps)
    expect(deps.appended).toHaveLength(1)
  })

  it('leaves a corrupt or unreadable settings.json alone', async () => {
    const deps = makeDeps({ readSettings: async () => ({ kind: 'unreadable' }) })
    await runHealTick(deps)
    expect(deps.reinstall).not.toHaveBeenCalled()
    expect(deps.appended).toEqual([])
  })

  it('is a no-op while telemetry is disabled', async () => {
    const deps = makeDeps({ enabled: async () => false })
    await runHealTick(deps)
    expect(deps.reinstall).not.toHaveBeenCalled()
    expect(deps.appended).toEqual([])
  })

  it('still re-installs when the evidence log cannot be written', async () => {
    const deps = makeDeps({
      appendLog: async () => {
        throw new Error('EACCES')
      }
    })
    await runHealTick(deps)
    expect(deps.reinstall).toHaveBeenCalledTimes(1)
  })

  it('does not repeat the notice when the key vanishes again a minute later', async () => {
    let t = T0
    const deps = makeDeps({ now: () => t })
    await runHealTick(deps)
    t += 60_000
    await runHealTick(deps)
    expect(deps.reinstall).toHaveBeenCalledTimes(2) // each loss is still healed...
    expect(deps.appended).toHaveLength(2) // ...and each leaves evidence...
    expect(deps.notices).toHaveLength(1) // ...but the operator is told once
  })
})
