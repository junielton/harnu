import { describe, it, expect } from 'vitest'
import {
  decideNotice,
  freshNoticeMemory,
  remember,
  windowOf
} from '../src/renderer/src/lib/github-budget-notice'
import { exhausted, healthy, low, unavailable } from './helpers/github-budget-snapshot'

describe('decideNotice (spec U2 AC-4)', () => {
  it('toasts once on entering low', () => {
    const n = decideNotice('normal', low(), freshNoticeMemory())
    expect(n?.kind).toBe('low')
  })

  it('stays silent on the first snapshot: opening the app while low is not entering it', () => {
    expect(decideNotice(null, low(), freshNoticeMemory())).toBeNull()
    expect(decideNotice(null, exhausted(), freshNoticeMemory())).toBeNull()
  })

  it('does not repeat in the same window when the budget flaps around the threshold', () => {
    const first = decideNotice('normal', low(), freshNoticeMemory())!
    const memory = remember(freshNoticeMemory(), first)
    // low → normal → low inside one GitHub window: one toast only.
    expect(decideNotice('normal', low(), memory)).toBeNull()
  })

  it('announces again in the next window', () => {
    const first = decideNotice('normal', low(), freshNoticeMemory())!
    const memory = remember(freshNoticeMemory(), first)
    const nextWindow = low()
    nextWindow.rest!.bucket.reset += 3600
    expect(decideNotice('normal', nextWindow, memory)?.kind).toBe('low')
  })

  it('raises an OS notification on reaching exhausted, once per window', () => {
    const n = decideNotice('low', exhausted(), freshNoticeMemory())!
    expect(n.kind).toBe('exhausted')
    const memory = remember(freshNoticeMemory(), n)
    expect(decideNotice('low', exhausted(), memory)).toBeNull()
  })

  it('goes straight from normal to exhausted when the limit is hit in one step', () => {
    expect(decideNotice('normal', exhausted(), freshNoticeMemory())?.kind).toBe('exhausted')
  })

  it('says nothing when the operator turned "Tell me when it happens" off', () => {
    expect(decideNotice('normal', low({ notify: false }), freshNoticeMemory())).toBeNull()
    expect(decideNotice('low', exhausted({ notify: false }), freshNoticeMemory())).toBeNull()
  })

  it('says nothing while healthy or unavailable', () => {
    expect(decideNotice('normal', healthy(), freshNoticeMemory())).toBeNull()
    expect(decideNotice('normal', unavailable(), freshNoticeMemory())).toBeNull()
    expect(windowOf(unavailable())).toBeNull()
  })
})
