import { describe, it, expect } from 'vitest'
import {
  EMPTY_STATE,
  applyFetched,
  unreadCount,
  hasUnread,
  markRead
} from '../src/main/claude-changelog-state'

const rel = (v: string) => ({ version: v, changes: [] })

describe('claude-changelog state', () => {
  it('first successful fetch seeds the read marker silently (no unread, no hasNew)', () => {
    const { next, hasNew } = applyFetched(EMPTY_STATE, [rel('1.2.3'), rel('1.2.2')], 1000)
    expect(hasNew).toBe(false)
    expect(next.lastReadVersion).toBe('1.2.3')
    expect(next.lastFetchedAt).toBe(1000)
    expect(hasUnread(next)).toBe(false)
  })

  it('a newly published version raises unread and reports hasNew', () => {
    const seeded = applyFetched(EMPTY_STATE, [rel('1.2.2')], 1000).next
    const { next, hasNew } = applyFetched(seeded, [rel('1.2.3'), rel('1.2.2')], 2000)
    expect(hasNew).toBe(true)
    expect(unreadCount(next)).toBe(1)
    expect(hasUnread(next)).toBe(true)
  })

  it('re-fetching the same list is idempotent (no repeated hasNew)', () => {
    const seeded = applyFetched(EMPTY_STATE, [rel('1.2.2')], 1000).next
    const once = applyFetched(seeded, [rel('1.2.3'), rel('1.2.2')], 2000).next
    const { hasNew } = applyFetched(once, [rel('1.2.3'), rel('1.2.2')], 3000)
    expect(hasNew).toBe(false)
  })

  it('an empty fetch keeps the prior state untouched', () => {
    const seeded = applyFetched(EMPTY_STATE, [rel('1.2.2')], 1000).next
    const { next, hasNew } = applyFetched(seeded, [], 2000)
    expect(hasNew).toBe(false)
    expect(next).toBe(seeded)
  })

  it('markRead advances the marker to the newest version and clears unread', () => {
    const seeded = applyFetched(EMPTY_STATE, [rel('1.2.2')], 1000).next
    const withNew = applyFetched(seeded, [rel('1.2.3'), rel('1.2.2')], 2000).next
    expect(hasUnread(withNew)).toBe(true)
    const read = markRead(withNew)
    expect(read.lastReadVersion).toBe('1.2.3')
    expect(hasUnread(read)).toBe(false)
  })

  it('treats everything as unread when the read marker rolled off the list', () => {
    const state = {
      releases: [rel('2.0.0'), rel('1.9.9')],
      lastReadVersion: '1.0.0',
      lastFetchedAt: 5
    }
    expect(unreadCount(state)).toBe(2)
  })
})
