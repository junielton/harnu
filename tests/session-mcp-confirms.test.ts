import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useMcpConfirmQueue } from '../src/renderer/src/stores/session-mcp-confirms'
import type { McpConfirmPending } from '../src/preload'

/**
 * BUG-32: the parked-confirm queue is the Approval Inbox's "Needs you" source
 * for a confirm that arrived while the window was unfocused. `confirm-core.ts`
 * now promotes a still-pending parked confirm to `mode: 'modal'` on focus
 * regain and re-sends it over the SAME `mcp:confirm:pending` channel this
 * queue listens to (`confirm-resolver.ts`). `addParkedConfirm` used to
 * early-return on any non-`parked` mode (`p.mode !== 'parked'`), which would
 * strand the row forever — this covers the fix: a promotion removes the row
 * from the parked queue WITHOUT replaying the chime (AC5 — the sound already
 * fired once, at the original park time).
 */

const pending = (over: Partial<McpConfirmPending> = {}): McpConfirmPending => ({
  id: over.id ?? 'confirm-1',
  prompt: over.prompt ?? 'Allow agent to boot with elevated flags?',
  permissionMode: over.permissionMode ?? 'default',
  nonDefaultFlags: over.nonDefaultFlags ?? [],
  commands: over.commands ?? [],
  deadline: over.deadline ?? Date.now() + 30 * 60_000,
  mode: over.mode ?? 'parked'
})

vi.mock('../src/renderer/src/lib/notification-sound', () => ({
  playNotificationSound: vi.fn()
}))

describe('useMcpConfirmQueue — parked -> modal promotion (BUG-32)', () => {
  let notify: ReturnType<typeof vi.fn>
  let pushSend: ReturnType<typeof vi.fn>
  let requestAttention: ReturnType<typeof vi.fn>
  let playNotificationSound: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    notify = vi.fn()
    pushSend = vi.fn()
    requestAttention = vi.fn()
    ;(globalThis as unknown as { window: unknown }).window = {
      api: { notify, pushSend, requestAttention }
    }
    const soundModule = await import('../src/renderer/src/lib/notification-sound')
    playNotificationSound = soundModule.playNotificationSound as ReturnType<typeof vi.fn>
    playNotificationSound.mockClear()
  })

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('a genuinely new parked confirm is added to the queue and chimes once', () => {
    const queue = useMcpConfirmQueue()
    queue.addParkedConfirm(pending({ mode: 'parked' }))

    expect(queue.parkedConfirmCount.value).toBe(1)
    expect(playNotificationSound).toHaveBeenCalledTimes(1)
    expect(requestAttention).toHaveBeenCalledTimes(1)
  })

  it('promotion (same id arriving with mode: modal) removes it from the queue without a sound replay', () => {
    const queue = useMcpConfirmQueue()
    queue.addParkedConfirm(pending({ id: 'confirm-7', mode: 'parked' }))
    expect(queue.parkedConfirmCount.value).toBe(1)
    playNotificationSound.mockClear()

    queue.addParkedConfirm(pending({ id: 'confirm-7', mode: 'modal' }))

    expect(queue.parkedConfirmCount.value).toBe(0)
    expect(playNotificationSound).not.toHaveBeenCalled()
  })

  it('an ordinary modal confirm (never parked) is a no-op for the queue', () => {
    const queue = useMcpConfirmQueue()
    queue.addParkedConfirm(pending({ id: 'confirm-9', mode: 'modal' }))

    expect(queue.parkedConfirmCount.value).toBe(0)
    expect(playNotificationSound).not.toHaveBeenCalled()
  })

  it('a dismissal re-arrival (mode: parked again, same id previously seen) does not re-chime', () => {
    const queue = useMcpConfirmQueue()
    queue.addParkedConfirm(pending({ id: 'confirm-3', mode: 'parked' }))
    queue.addParkedConfirm(pending({ id: 'confirm-3', mode: 'modal' })) // promoted
    playNotificationSound.mockClear()

    queue.addParkedConfirm(pending({ id: 'confirm-3', mode: 'parked' })) // dismissed

    expect(queue.parkedConfirmCount.value).toBe(1)
    expect(playNotificationSound).not.toHaveBeenCalled()
  })
})
