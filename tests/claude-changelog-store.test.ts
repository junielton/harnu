import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useClaudeChangelogStore } from '../src/renderer/src/stores/claudeChangelog'

const rel = (v: string) => ({ version: v, changes: [] })

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('claudeChangelog store', () => {
  it('derives unread/hasUnread from releases above lastReadVersion', () => {
    const s = useClaudeChangelogStore()
    s.apply({ releases: [rel('1.2.3'), rel('1.2.2')], lastReadVersion: '1.2.2', lastFetchedAt: 1 })
    expect(s.unreadCount).toBe(1)
    expect(s.hasUnread).toBe(true)
  })

  it('markRead optimistically clears the dot before the IPC resolves', async () => {
    const markReadSpy = vi.fn().mockResolvedValue(undefined)
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { claudeChangelogMarkRead: markReadSpy }
    }
    const s = useClaudeChangelogStore()
    s.apply({ releases: [rel('1.2.3'), rel('1.2.2')], lastReadVersion: '1.2.2', lastFetchedAt: 1 })
    await s.markRead()
    expect(s.hasUnread).toBe(false)
    expect(s.lastReadVersion).toBe('1.2.3')
    expect(markReadSpy).toHaveBeenCalledOnce()
  })
})
