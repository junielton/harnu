import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseRegistryEntry,
  registryStatusToTaskState,
  startSessionRegistryWatcher,
  type SessionRegistryWire
} from '../src/main/session-registry-watch'

/**
 * T92 PID session-registry overlay (`~/.claude/sessions/<pid>.json`). The pure
 * parse/map core is the tested value; the chokidar effect is exercised via a temp
 * dir seeded BEFORE the watcher starts (deterministic initial scan) plus the
 * feature gate (absent dir → silent no-op).
 */

// A real registry file shape observed on the shipped CLI (v2.1.202, BG_SESSIONS on).
const SAMPLE = {
  pid: 1033129,
  sessionId: 'b1c3ee19-16ca-422d-8e65-3a8ec320fad1',
  cwd: '/home/u/proj',
  status: 'idle',
  statusUpdatedAt: 1783435387653,
  kind: 'interactive'
}

describe('parseRegistryEntry', () => {
  it('extracts sessionId/status/updatedAt from a real entry', () => {
    const e = parseRegistryEntry(JSON.stringify(SAMPLE))
    expect(e).toEqual({
      sessionId: 'b1c3ee19-16ca-422d-8e65-3a8ec320fad1',
      status: 'idle',
      waitingFor: undefined,
      updatedAt: 1783435387653
    })
  })

  it('captures waitingFor when the session is waiting', () => {
    const e = parseRegistryEntry(
      JSON.stringify({ ...SAMPLE, status: 'waiting', waitingFor: 'approve Bash' })
    )
    expect(e?.status).toBe('waiting')
    expect(e?.waitingFor).toBe('approve Bash')
  })

  it('falls back to updatedAt when statusUpdatedAt is absent', () => {
    const { statusUpdatedAt: _drop, ...rest } = SAMPLE
    const e = parseRegistryEntry(JSON.stringify({ ...rest, updatedAt: 42 }))
    expect(e?.updatedAt).toBe(42)
  })

  it('returns null for missing sessionId / invalid JSON / non-object', () => {
    expect(parseRegistryEntry(JSON.stringify({ pid: 1, status: 'idle' }))).toBeNull()
    expect(parseRegistryEntry('{not json')).toBeNull()
    expect(parseRegistryEntry(JSON.stringify([1, 2]))).toBeNull()
  })
})

describe('registryStatusToTaskState', () => {
  it('maps the three known statuses', () => {
    expect(registryStatusToTaskState('busy')).toBe('working')
    expect(registryStatusToTaskState('waiting')).toBe('needs-input')
    expect(registryStatusToTaskState('idle')).toBe('idle')
  })

  it('maps absent / unknown status to undefined (no override)', () => {
    expect(registryStatusToTaskState(undefined)).toBeUndefined()
    expect(registryStatusToTaskState('mystery')).toBeUndefined()
  })
})

describe('startSessionRegistryWatcher (effect)', () => {
  let cleanup: (() => void) | null = null
  afterEach(() => {
    cleanup?.()
    cleanup = null
  })

  it('feature gate: an absent sessions dir → silent no-op handle, never emits', () => {
    const sent: SessionRegistryWire[] = []
    const handle = startSessionRegistryWatcher((_c, p) => sent.push(p), {
      dir: join(tmpdir(), 'harnu-no-such-dir-xyz-t92')
    })
    cleanup = () => void handle.close()
    expect(sent).toHaveLength(0)
  })

  it('emits the mapped task-state for a file present at startup (initial scan)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'harnu-sessions-'))
    writeFileSync(join(dir, '1033129.json'), JSON.stringify({ ...SAMPLE, status: 'busy' }))

    const events: SessionRegistryWire[] = []
    const done = new Promise<void>((resolve) => {
      const handle = startSessionRegistryWatcher(
        (_c, p) => {
          events.push(p)
          resolve()
        },
        { dir }
      )
      cleanup = () => {
        void handle.close()
        rmSync(dir, { recursive: true, force: true })
      }
    })
    await Promise.race([done, new Promise((r) => setTimeout(r, 3000))])

    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]).toMatchObject({
      sessionId: SAMPLE.sessionId,
      taskState: 'working',
      updatedAt: SAMPLE.statusUpdatedAt
    })
  })
})
