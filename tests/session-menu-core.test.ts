import { describe, it, expect } from 'vitest'
import { shouldShowRestart } from '../src/renderer/src/components/session-menu-core'

describe('shouldShowRestart', () => {
  it('is false for a synthetic session regardless of live/task state', () => {
    expect(shouldShowRestart({ isSynthetic: true, isLive: true, taskState: undefined })).toBe(false)
    expect(shouldShowRestart({ isSynthetic: true, isLive: false, taskState: 'failed' })).toBe(false)
  })

  it('is true for a real session that is currently live', () => {
    expect(shouldShowRestart({ isSynthetic: false, isLive: true, taskState: undefined })).toBe(true)
    expect(shouldShowRestart({ isSynthetic: false, isLive: true, taskState: 'working' })).toBe(true)
  })

  it('is true for a real session that has ended (failed or completed)', () => {
    expect(shouldShowRestart({ isSynthetic: false, isLive: false, taskState: 'failed' })).toBe(true)
    expect(shouldShowRestart({ isSynthetic: false, isLive: false, taskState: 'completed' })).toBe(
      true
    )
  })

  it('is false for a real, non-live session that has not ended', () => {
    expect(shouldShowRestart({ isSynthetic: false, isLive: false, taskState: undefined })).toBe(
      false
    )
    expect(shouldShowRestart({ isSynthetic: false, isLive: false, taskState: 'idle' })).toBe(false)
    expect(shouldShowRestart({ isSynthetic: false, isLive: false, taskState: 'working' })).toBe(
      false
    )
    expect(shouldShowRestart({ isSynthetic: false, isLive: false, taskState: 'needs-input' })).toBe(
      false
    )
    expect(shouldShowRestart({ isSynthetic: false, isLive: false, taskState: 'stopped' })).toBe(
      false
    )
  })
})
