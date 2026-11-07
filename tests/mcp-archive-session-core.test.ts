import { describe, it, expect } from 'vitest'
import { planArchiveSession, type ArchivePlanDeps } from '../src/main/mcp/archive-session-core'

/**
 * T655 — the pure planner behind `archive_session`: one outcome row per session id.
 * No fs, no electron: the deps are plain lookups, so every branch is reachable here.
 */

function deps(over: Partial<ArchivePlanDeps> = {}): ArchivePlanDeps {
  return {
    archived: new Set<string>(),
    folderOf: (id) => (id.startsWith('ghost') ? undefined : '/repos/alpha'),
    isDenied: () => false,
    taskStateOf: () => 'idle',
    hasPendingApproval: () => false,
    ...over
  }
}

describe('planArchiveSession', () => {
  it('outcomes: archived / alreadyArchived / notFound when archiving', () => {
    const plan = planArchiveSession(
      ['s-new', 's-old', 'ghost-1'],
      false,
      deps({ archived: new Set(['s-old']) })
    )
    expect(plan.rows).toEqual([
      { sessionId: 's-new', outcome: 'archived' },
      { sessionId: 's-old', outcome: 'alreadyArchived' },
      { sessionId: 'ghost-1', outcome: 'notFound' }
    ])
    expect(plan.toArchive).toEqual(['s-new'])
    expect(plan.toRestore).toEqual([])
  })

  it('outcomes: restored / alreadyActive when unarchiving', () => {
    const plan = planArchiveSession(
      ['s-old', 's-new'],
      true,
      deps({ archived: new Set(['s-old']) })
    )
    expect(plan.rows).toEqual([
      { sessionId: 's-old', outcome: 'restored' },
      { sessionId: 's-new', outcome: 'alreadyActive' }
    ])
    expect(plan.toRestore).toEqual(['s-old'])
    expect(plan.toArchive).toEqual([])
  })

  it('refusals: a blocked folder is refused FOLDER_NOT_ALLOWED, archiving or restoring', () => {
    const d = deps({ isDenied: (f) => f === '/repos/alpha', archived: new Set(['s-1']) })
    expect(planArchiveSession(['s-1'], false, d).rows).toEqual([
      { sessionId: 's-1', outcome: 'refused', reason: 'FOLDER_NOT_ALLOWED' }
    ])
    expect(planArchiveSession(['s-1'], true, d).rows).toEqual([
      { sessionId: 's-1', outcome: 'refused', reason: 'FOLDER_NOT_ALLOWED' }
    ])
    expect(planArchiveSession(['s-1'], false, d).toArchive).toEqual([])
  })

  it('refusals: a working session is refused SESSION_WORKING, but only when archiving', () => {
    const d = deps({ taskStateOf: () => 'working', archived: new Set(['s-1']) })
    expect(planArchiveSession(['s-2'], false, d).rows).toEqual([
      { sessionId: 's-2', outcome: 'refused', reason: 'SESSION_WORKING' }
    ])
    expect(planArchiveSession(['s-1'], true, d).rows).toEqual([
      { sessionId: 's-1', outcome: 'restored' }
    ])
  })

  it('refusals: a session with a pending approval is refused PENDING_APPROVAL when archiving', () => {
    const d = deps({ hasPendingApproval: (id) => id === 's-1' })
    expect(planArchiveSession(['s-1', 's-2'], false, d).rows).toEqual([
      { sessionId: 's-1', outcome: 'refused', reason: 'PENDING_APPROVAL' },
      { sessionId: 's-2', outcome: 'archived' }
    ])
  })

  it('refusals: precedence is notFound, then blocked folder, then working, then approval', () => {
    const d = deps({
      isDenied: () => true,
      taskStateOf: () => 'working',
      hasPendingApproval: () => true
    })
    expect(planArchiveSession(['ghost-1', 's-1'], false, d).rows).toEqual([
      { sessionId: 'ghost-1', outcome: 'notFound' },
      { sessionId: 's-1', outcome: 'refused', reason: 'FOLDER_NOT_ALLOWED' }
    ])
    const busy = deps({ taskStateOf: () => 'working', hasPendingApproval: () => true })
    expect(planArchiveSession(['s-1'], false, busy).rows[0]?.reason).toBe('SESSION_WORKING')
  })

  it('an already archived session that is still working reads alreadyArchived, not refused', () => {
    const d = deps({ taskStateOf: () => 'working', archived: new Set(['s-1']) })
    expect(planArchiveSession(['s-1'], false, d).rows).toEqual([
      { sessionId: 's-1', outcome: 'alreadyArchived' }
    ])
  })

  it('duplicates collapse to the first occurrence and row order follows the input', () => {
    const plan = planArchiveSession(['b', 'a', 'b'], false, deps())
    expect(plan.rows.map((r) => r.sessionId)).toEqual(['b', 'a'])
    expect(plan.toArchive).toEqual(['b', 'a'])
  })
})
