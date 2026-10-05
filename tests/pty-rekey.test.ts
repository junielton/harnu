import { describe, it, expect } from 'vitest'
import { applyRekeyToRecord, type PtyKind } from '../src/main/pty'

/**
 * BUG-65: `pty:rekey` moved the `PtySessionIndex` binding to the real uuid but left the
 * `PtyRec` itself — `sessionKey` and `kind` — pointing at the stale synthetic identity and
 * the frozen spawn-time kind. Every enumeration path (`fleetSnapshot`, `pty:list`,
 * `livePtyDescriptors`) reads those two fields off the record, so a migrated session was
 * permanently invisible to hibernation and permanently mislabeled in the System Monitor.
 *
 * `applyRekeyToRecord` is the pure record-side fix, exercised directly here — no
 * electron/node-pty mocking needed, same posture as `PtySessionIndex` and
 * `buildPosixMissingDirNotice`.
 */
describe('applyRekeyToRecord', () => {
  it('moves sessionKey to the real uuid', () => {
    const rec = { sessionKey: 'synthetic-abc', kind: 'claude-new' as PtyKind }
    applyRekeyToRecord(rec, 'real-uuid-123')
    expect(rec.sessionKey).toBe('real-uuid-123')
  })

  it('promotes a plain-new synthetic to claude-resume — the transcript now exists on disk', () => {
    const rec = { sessionKey: 'synthetic-abc', kind: 'claude-new' as PtyKind }
    applyRekeyToRecord(rec, 'real-uuid-123')
    expect(rec.kind).toBe('claude-resume')
  })

  it('promotes a fork synthetic to claude-resume the same way', () => {
    const rec = { sessionKey: 'synthetic-fork', kind: 'claude-fork' as PtyKind }
    applyRekeyToRecord(rec, 'real-uuid-456')
    expect(rec.kind).toBe('claude-resume')
  })

  it('leaves an already-resume kind untouched (idempotent on a second rekey)', () => {
    const rec = { sessionKey: 'real-uuid-123', kind: 'claude-resume' as PtyKind }
    applyRekeyToRecord(rec, 'real-uuid-123')
    expect(rec.kind).toBe('claude-resume')
  })

  it('never promotes a shell or teammate kind — they have nothing to resume from', () => {
    const shell = { sessionKey: 's', kind: 'shell' as PtyKind }
    applyRekeyToRecord(shell, 'still-s')
    expect(shell.kind).toBe('shell')

    const teammate = { sessionKey: 't', kind: 'teammate' as PtyKind }
    applyRekeyToRecord(teammate, 'still-t')
    expect(teammate.kind).toBe('teammate')
  })
})
