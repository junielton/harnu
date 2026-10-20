import { describe, it, expect } from 'vitest'
import { isCloudStub, isSpawnRefused } from '../src/renderer/src/lib/cloud-session'

/**
 * BUG-198 G1 — the cloud-panel predicate. Disk truth about turn count is
 * irrelevant while the process that will write the turns is alive.
 */
describe('isCloudStub (BUG-198 G1)', () => {
  it('AC-1: a resumable:false row WITH a live terminal is never a cloud stub', () => {
    expect(isCloudStub({ resumable: false }, true)).toBe(false)
  })

  it('a resumable:false row with no live terminal is a cloud stub', () => {
    expect(isCloudStub({ resumable: false }, false)).toBe(true)
  })

  it('a resumable row is never a cloud stub', () => {
    expect(isCloudStub({ resumable: true }, false)).toBe(false)
    expect(isCloudStub({ resumable: true }, true)).toBe(false)
  })

  it('a folder terminal is never a cloud stub, even if resumable ever flips', () => {
    expect(isCloudStub({ resumable: false, isShellTerminal: true }, false)).toBe(false)
  })

  it('AC-4: a row the operator chose to "Resume anyway" is not a cloud stub', () => {
    expect(isCloudStub({ resumable: false, resumeAnyway: true }, false)).toBe(false)
  })

  it('no selected session is not a cloud stub', () => {
    expect(isCloudStub(null, false)).toBe(false)
    expect(isCloudStub(undefined, true)).toBe(false)
  })
})

/**
 * `TerminalPane` refuses to spawn a doomed `claude --resume` for a cloud stub
 * (defence in depth behind `App.vue`) — unless the operator chose "Resume
 * anyway". The same predicate gates the re-activation watcher (G5), so a row
 * that heals (or is overridden) mounts / re-attaches its terminal.
 */
describe('isSpawnRefused (BUG-198 G4/G5)', () => {
  it('refuses a resumable:false row', () => {
    expect(isSpawnRefused({ resumable: false })).toBe(true)
  })

  it('AC-4: does not refuse a row the operator chose to "Resume anyway"', () => {
    expect(isSpawnRefused({ resumable: false, resumeAnyway: true })).toBe(false)
  })

  it('AC-6: does not refuse a row that healed to resumable:true', () => {
    expect(isSpawnRefused({ resumable: true })).toBe(false)
  })

  it('does not refuse an unknown row (TerminalPane falls back to a shell)', () => {
    expect(isSpawnRefused(undefined)).toBe(false)
  })
})
