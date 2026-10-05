import { describe, it, expect } from 'vitest'
import { shouldShowNotification, buildNotificationOptions } from '../src/main/notifications'

/**
 * Pure guards for the main-process notifier (os-notifications spec §5). The IPC
 * wiring + `new Notification` live in the imperative shell and are exercised by
 * the live E2E (spec §11); here we cover the two decisions that protect against
 * an empty toast or an unsupported platform.
 */

describe('shouldShowNotification', () => {
  it('shows when supported and a title is present', () => {
    expect(shouldShowNotification({ title: 'Needs your input' }, true)).toBe(true)
  })

  it('never shows when the platform does not support notifications', () => {
    expect(shouldShowNotification({ title: 'Needs your input' }, false)).toBe(false)
  })

  it('never shows with an empty or whitespace-only title', () => {
    expect(shouldShowNotification({ title: '' }, true)).toBe(false)
    expect(shouldShowNotification({ title: '   ' }, true)).toBe(false)
  })

  it('is total over malformed payloads (never throws on bad IPC input)', () => {
    // `notify:show` is a fire-and-forget channel any renderer code can reach;
    // a malformed payload must no-op, not crash the main process.
    expect(shouldShowNotification(undefined, true)).toBe(false)
    expect(shouldShowNotification(null, true)).toBe(false)
    expect(shouldShowNotification({}, true)).toBe(false)
    expect(shouldShowNotification({ title: 42 }, true)).toBe(false)
    expect(shouldShowNotification('Needs input', true)).toBe(false)
  })
})

describe('buildNotificationOptions', () => {
  it('includes title, body and the app icon', () => {
    expect(
      buildNotificationOptions({ title: 'Session failed', body: 'alpha · build' }, '/i.png')
    ).toEqual({ title: 'Session failed', body: 'alpha · build', icon: '/i.png' })
  })

  it('tolerates a missing body (empty string)', () => {
    expect(buildNotificationOptions({ title: 'Session completed' }, '/i.png')).toEqual({
      title: 'Session completed',
      body: '',
      icon: '/i.png'
    })
  })
})
