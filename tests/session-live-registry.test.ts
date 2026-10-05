import { describe, it, expect } from 'vitest'
import { useLiveRegistry } from '../src/renderer/src/stores/session-live-registry'

/**
 * T25 wave 2 — the live-PTY registry extracted from the sessions god-store. A
 * dependency-free composable, so it's tested directly (no Pinia / window.api).
 * Pins the register/unregister/isSessionLive behaviour + the reassign-on-mutate
 * discipline the zone computeds rely on.
 */
describe('useLiveRegistry', () => {
  it('registers a session live and reflects it via isSessionLive', () => {
    const r = useLiveRegistry()
    expect(r.isSessionLive('s1')).toBe(false)
    r.registerLiveSession('s1')
    expect(r.isSessionLive('s1')).toBe(true)
    expect(r.livePtySessionIds.value.has('s1')).toBe(true)
  })

  it('unregisters a session', () => {
    const r = useLiveRegistry()
    r.registerLiveSession('s1')
    r.unregisterLiveSession('s1')
    expect(r.isSessionLive('s1')).toBe(false)
  })

  it('is idempotent: re-register / absent-unregister leave the Set identity stable', () => {
    const r = useLiveRegistry()
    r.registerLiveSession('s1')
    const afterAdd = r.livePtySessionIds.value
    r.registerLiveSession('s1') // already present → no reassign
    expect(r.livePtySessionIds.value).toBe(afterAdd)
    r.unregisterLiveSession('ghost') // absent → no reassign
    expect(r.livePtySessionIds.value).toBe(afterAdd)
  })

  it('reassigns the Set identity on a real mutation (so zone computeds fire)', () => {
    const r = useLiveRegistry()
    const before = r.livePtySessionIds.value
    r.registerLiveSession('s1')
    expect(r.livePtySessionIds.value).not.toBe(before)
    const afterAdd = r.livePtySessionIds.value
    r.unregisterLiveSession('s1')
    expect(r.livePtySessionIds.value).not.toBe(afterAdd)
  })

  it('tracks multiple sessions independently', () => {
    const r = useLiveRegistry()
    r.registerLiveSession('a')
    r.registerLiveSession('b')
    r.unregisterLiveSession('a')
    expect(r.isSessionLive('a')).toBe(false)
    expect(r.isSessionLive('b')).toBe(true)
    expect(r.livePtySessionIds.value.size).toBe(1)
  })
})
