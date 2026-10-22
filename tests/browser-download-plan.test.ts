/**
 * T572 (browser pane U5, AC-8) — downloads: which ones may happen, what a saved file is called, and the one-shot
 * allowance a `browser_download` call arms.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  DOWNLOAD_COMPLETE_TIMEOUT_MS,
  MAX_DOWNLOAD_BYTES,
  createDownloadArms,
  decideDownload,
  downloadResult,
  isInsideReal,
  overLimit,
  resolveDownloadTarget,
  type DownloadFsIo,
  sanitizeDownloadName,
  uniqueDownloadName
} from '../src/main/browser/download-plan'

describe('sanitizeDownloadName', () => {
  it('keeps an ordinary name', () => {
    expect(sanitizeDownloadName('report.pdf')).toBe('report.pdf')
    expect(sanitizeDownloadName('my file (1).tar.gz')).toBe('my file (1).tar.gz')
  })

  it('strips every directory, both separators, and traversal', () => {
    expect(sanitizeDownloadName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeDownloadName('..\\..\\Windows\\system.ini')).toBe('system.ini')
    expect(sanitizeDownloadName('/abs/path/x.txt')).toBe('x.txt')
    expect(sanitizeDownloadName('..')).toBe('download')
    expect(sanitizeDownloadName('.')).toBe('download')
  })

  it('removes control characters, NULs and characters Windows rejects', () => {
    expect(sanitizeDownloadName('a\u0000b\nc.txt')).toBe('a_b_c.txt')
    expect(sanitizeDownloadName('a<b>:"|?*.txt')).toBe('a_b______.txt')
  })

  it('never produces a hidden file or a trailing dot', () => {
    expect(sanitizeDownloadName('.bashrc')).toBe('bashrc')
    expect(sanitizeDownloadName('name. . ')).toBe('name')
  })

  it('renames Windows device names', () => {
    expect(sanitizeDownloadName('CON')).toBe('_CON')
    expect(sanitizeDownloadName('nul.txt')).toBe('_nul.txt')
  })

  it('an empty name is `download`', () => {
    expect(sanitizeDownloadName('')).toBe('download')
    expect(sanitizeDownloadName('///')).toBe('download')
    expect(sanitizeDownloadName('  ')).toBe('download')
  })

  it('cuts a very long name to 120 characters and keeps the extension', () => {
    const out = sanitizeDownloadName(`${'a'.repeat(300)}.pdf`)
    expect([...out].length).toBeLessThanOrEqual(120)
    expect(out.endsWith('.pdf')).toBe(true)
  })
})

describe('uniqueDownloadName', () => {
  it('returns the name when it is free', () => {
    expect(uniqueDownloadName('a.txt', () => false)).toBe('a.txt')
  })

  it('never overwrites: it numbers before the extension', () => {
    const taken = new Set(['a.txt', 'a (1).txt'])
    expect(uniqueDownloadName('a.txt', (n) => taken.has(n))).toBe('a (2).txt')
  })

  it('handles a name with no extension', () => {
    const taken = new Set(['README'])
    expect(uniqueDownloadName('README', (n) => taken.has(n))).toBe('README (1)')
  })
})

describe('decideDownload (spec §3.2, Q16)', () => {
  const base = { armed: false, gesturePending: false, promptPending: false, totalBytes: 0 }

  it('cancels a download nobody asked for', () => {
    expect(decideDownload(base)).toEqual({ action: 'cancel', reason: 'not-requested' })
  })

  it('saves an armed agent download with no prompt', () => {
    expect(decideDownload({ ...base, armed: true })).toEqual({ action: 'save-agent' })
  })

  it('asks the operator after a real gesture', () => {
    expect(decideDownload({ ...base, gesturePending: true })).toEqual({ action: 'prompt' })
  })

  it('one question at a time: a second gesture download is cancelled', () => {
    expect(decideDownload({ ...base, gesturePending: true, promptPending: true })).toEqual({
      action: 'cancel',
      reason: 'prompt-busy'
    })
  })

  it('an armed call wins over a pending gesture (the call IS the request)', () => {
    expect(decideDownload({ ...base, armed: true, gesturePending: true })).toEqual({
      action: 'save-agent'
    })
  })

  it('a known size over the limit is cancelled first, armed or not', () => {
    const big = MAX_DOWNLOAD_BYTES + 1
    expect(decideDownload({ ...base, armed: true, totalBytes: big })).toEqual({
      action: 'cancel',
      reason: 'too-large'
    })
    expect(decideDownload({ ...base, gesturePending: true, totalBytes: big }).action).toBe('cancel')
    expect(decideDownload({ ...base, armed: true, totalBytes: MAX_DOWNLOAD_BYTES })).toEqual({
      action: 'save-agent'
    })
  })

  it('watches the running total when no size was announced', () => {
    expect(overLimit(MAX_DOWNLOAD_BYTES)).toBe(false)
    expect(overLimit(MAX_DOWNLOAD_BYTES + 1)).toBe(true)
  })
})

describe('downloadResult', () => {
  const ok = {
    savedAs: '/w/.harnu/out/downloads/a.txt',
    relPath: '.harnu/out/downloads/a.txt',
    bytes: 5,
    mime: 'text/plain',
    tooLarge: false
  }

  it('a completed download is the ACK shape', () => {
    expect(downloadResult({ ...ok, state: 'completed' })).toEqual({
      ok: true,
      path: '.harnu/out/downloads/a.txt',
      bytes: 5,
      mime: 'text/plain',
      name: 'a.txt'
    })
  })

  it('maps the other end states to a code', () => {
    expect(downloadResult({ ...ok, state: 'cancelled' })).toMatchObject({
      code: 'DOWNLOAD_CANCELLED'
    })
    expect(downloadResult({ ...ok, state: 'interrupted' })).toMatchObject({
      code: 'DOWNLOAD_FAILED'
    })
    expect(downloadResult({ ...ok, state: 'cancelled', tooLarge: true })).toMatchObject({
      code: 'DOWNLOAD_TOO_LARGE'
    })
  })
})

describe('the one-shot allowance', () => {
  function harness() {
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
    const arms = createDownloadArms({
      setTimer: (fn, ms) => {
        const t = { fn, ms, live: true }
        timers.push(t)
        return t
      },
      clearTimer: (h) => {
        ;(h as { live: boolean }).live = false
      }
    })
    const fire = (i: number): void => {
      if (timers[i]!.live) timers[i]!.fn()
    }
    return { arms, timers, fire }
  }

  it('is claimed once: a second download in the same call is not allowed', () => {
    const { arms } = harness()
    arms.arm('p1', { timeoutMs: 5000 })
    expect(arms.isArmed('p1')).toBe(true)
    expect(arms.claim('p1')).toEqual({ name: undefined })
    expect(arms.claim('p1')).toBeNull()
    expect(arms.isArmed('p1')).toBe(false)
  })

  it('belongs to one pane', () => {
    const { arms } = harness()
    arms.arm('p1', { timeoutMs: 5000 })
    expect(arms.claim('p2')).toBeNull()
    expect(arms.isArmed('p1')).toBe(true)
  })

  it('carries the name the agent asked for', () => {
    const { arms } = harness()
    arms.arm('p1', { name: 'mine.csv', timeoutMs: 5000 })
    expect(arms.claim('p1')).toEqual({ name: 'mine.csv' })
  })

  it('NO_DOWNLOAD_STARTED when nothing began in time', async () => {
    const { arms, fire } = harness()
    const arm = arms.arm('p1', { timeoutMs: 5000 })
    fire(0)
    expect(await arm.result).toMatchObject({ ok: false, code: 'NO_DOWNLOAD_STARTED' })
    expect(arms.isArmed('p1')).toBe(false)
  })

  it('settle resolves the waiting verb with the download result', async () => {
    const { arms } = harness()
    const arm = arms.arm('p1', { timeoutMs: 5000 })
    arms.claim('p1')
    arms.settle('p1', { ok: true, path: 'x', bytes: 1, mime: 'a/b', name: 'x' })
    expect(await arm.result).toMatchObject({ ok: true, name: 'x' })
  })

  it('a claimed download that never finishes fails after the completion bound, not the start bound', async () => {
    const { arms, timers, fire } = harness()
    const arm = arms.arm('p1', { timeoutMs: 5000 })
    arms.claim('p1')
    // The start timer was cleared by the claim; a new one covers completion.
    expect(timers[0]!.live).toBe(false)
    expect(timers[1]!.ms).toBe(DOWNLOAD_COMPLETE_TIMEOUT_MS)
    fire(0)
    fire(1)
    expect(await arm.result).toMatchObject({ ok: false, code: 'DOWNLOAD_FAILED' })
  })

  it('disarm ends it, and arming again replaces a stale allowance', async () => {
    const { arms } = harness()
    const first = arms.arm('p1', { timeoutMs: 5000 })
    const second = arms.arm('p1', { timeoutMs: 5000 })
    expect(await first.result).toMatchObject({ code: 'NO_DOWNLOAD_STARTED' })
    expect(arms.isArmed('p1')).toBe(true)
    const spy = vi.fn()
    second.result.then(spy)
    second.disarm()
    expect(await second.result).toMatchObject({ code: 'NO_DOWNLOAD_STARTED' })
    expect(arms.isArmed('p1')).toBe(false)
    second.disarm() // idempotent
  })
})

describe('isInsideReal', () => {
  it('accepts the root and its descendants, refuses siblings and parents', () => {
    expect(isInsideReal('/w/app', '/w/app')).toBe(true)
    expect(isInsideReal('/w/app', '/w/app/.harnu/out')).toBe(true)
    expect(isInsideReal('/w/app', '/w/other')).toBe(false)
    expect(isInsideReal('/w/app', '/w')).toBe(false)
    expect(isInsideReal('/w/app', '/w/app-evil')).toBe(false)
  })
})

describe('resolveDownloadTarget', () => {
  const io = (over: Partial<DownloadFsIo> = {}, taken: string[] = []): DownloadFsIo => ({
    mkdirp: () => undefined,
    realpath: (p) => p,
    exists: (p) => taken.includes(p),
    ...over
  })

  it('lands under .harnu/out/downloads with a clean name', () => {
    const r = resolveDownloadTarget('/w/app', '../../evil/report.pdf', io())
    expect(r).toEqual({
      ok: true,
      absPath: '/w/app/.harnu/out/downloads/report.pdf',
      relPath: '.harnu/out/downloads/report.pdf',
      name: 'report.pdf'
    })
  })

  it('never overwrites an existing file', () => {
    const r = resolveDownloadTarget(
      '/w/app',
      'a.txt',
      io({}, ['/w/app/.harnu/out/downloads/a.txt'])
    )
    expect(r).toMatchObject({
      ok: true,
      name: 'a (1).txt',
      relPath: '.harnu/out/downloads/a (1).txt'
    })
  })

  it('refuses a downloads directory that leaves the folder through a link', () => {
    const r = resolveDownloadTarget(
      '/w/app',
      'a.txt',
      io({ realpath: (p) => (p.endsWith('downloads') ? '/elsewhere/downloads' : p) })
    )
    expect(r).toMatchObject({ ok: false })
  })

  it('reports a directory it cannot create', () => {
    const r = resolveDownloadTarget(
      '/w/app',
      'a.txt',
      io({
        mkdirp: () => {
          throw new Error('EACCES')
        }
      })
    )
    expect(r).toEqual({ ok: false, detail: 'EACCES' })
  })
})
