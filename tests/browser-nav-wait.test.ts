/**
 * T568 (browser pane U1, AC-7) — `browser_navigate` waiting: milestones, timeout-is-not-an-error and net errors.
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { normalizeNetError, waitForNavigation, type NavTimers } from '../src/main/browser/nav-wait'

function fakeTimers() {
  const pending: { fn: () => void; ms: number; id: number }[] = []
  let id = 0
  const timers: NavTimers = {
    setTimeout: (fn, ms) => {
      pending.push({ fn, ms, id: ++id })
      return id
    },
    clearTimeout: (h) => {
      const i = pending.findIndex((p) => p.id === h)
      if (i >= 0) pending.splice(i, 1)
    }
  }
  return { timers, pending, fire: () => pending.shift()?.fn() }
}

function wait(waitUntil: 'commit' | 'domcontentloaded' | 'load') {
  const em = new EventEmitter()
  const t = fakeTimers()
  const w = waitForNavigation(em, {
    waitUntil,
    timeoutMs: 5000,
    navigationId: 'nav-1',
    timers: t.timers,
    title: () => 'Page'
  })
  return { em, t, w }
}

describe('waitForNavigation', () => {
  it('resolves at load with the status of the committed document', async () => {
    const { em, w } = wait('load')
    em.emit('did-navigate', {}, 'http://localhost/', 200)
    em.emit('dom-ready')
    em.emit('did-stop-loading')
    expect(await w.settled).toEqual({
      title: 'Page',
      status: 200,
      navigationId: 'nav-1',
      reason: 'load'
    })
  })

  it('resolves at commit and at domcontentloaded when asked to', async () => {
    const a = wait('commit')
    a.em.emit('did-navigate', {}, 'http://x/', 204)
    expect((await a.w.settled).status).toBe(204)
    const b = wait('domcontentloaded')
    b.em.emit('did-navigate', {}, 'http://x/', 200)
    b.em.emit('dom-ready')
    expect((await b.w.settled).reason).toBe('load')
  })

  it('does not settle early at commit when waiting for load', async () => {
    const { em, w } = wait('load')
    let settled = false
    void w.settled.then(() => (settled = true))
    em.emit('did-navigate', {}, 'http://x/', 200)
    await Promise.resolve()
    expect(settled).toBe(false)
    em.emit('did-stop-loading')
    await w.settled
    expect(settled).toBe(true)
  })

  it('treats the timeout as reason "timeout", not an error', async () => {
    const { t, w } = wait('load')
    t.fire()
    expect(await w.settled).toMatchObject({ reason: 'timeout', status: null })
  })

  it('returns a net error as ok data and ignores subframe failures and aborted loads', async () => {
    const { em, w } = wait('load')
    em.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://sub/', false)
    em.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://x/', true)
    em.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'http://nope.invalid/', true)
    expect(await w.settled).toMatchObject({ netError: 'ERR_NAME_NOT_RESOLVED', reason: 'load' })
  })

  it('removes its listeners once settled and settles only once', async () => {
    const { em, w } = wait('load')
    em.emit('did-stop-loading')
    await w.settled
    expect(em.listenerCount('did-stop-loading')).toBe(0)
    expect(em.listenerCount('did-fail-load')).toBe(0)
    w.cancel()
  })
})

describe('normalizeNetError', () => {
  it('keeps ERR_ names and shapes anything else', () => {
    expect(normalizeNetError('ERR_CONNECTION_REFUSED')).toBe('ERR_CONNECTION_REFUSED')
    expect(normalizeNetError('')).toBe('ERR_FAILED')
    expect(normalizeNetError('timed out')).toBe('ERR_TIMED_OUT')
  })
})
