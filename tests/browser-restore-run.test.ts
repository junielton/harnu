/**
 * T574 Delta 2 — the boot-time restore is cheap: it never scans the fleet, does nothing at all when no browser pane is
 * saved, and keeps its folder rules (tracked-or-git, blocked, failed project list) without blocking the window.
 */
import { describe, expect, it, vi } from 'vitest'
import { runRestore, type RestoreDeps } from '../src/main/browser/restore-run'
import type { RestoredPane } from '../src/main/browser/restore-plan'

const WT = '/work/acme'
const stack = (panes: Array<Record<string, unknown>>, worktreePath = WT) => ({
  worktreePath,
  panes: panes as Array<{ id: unknown; type: unknown; payload?: unknown }>
})
const browser = (id: string, payload: Record<string, unknown> = {}) => ({
  id,
  type: 'browser',
  payload: { url: 'http://localhost:3000', openedBy: 'operator', ...payload }
})

function rig(over: Partial<RestoreDeps> = {}) {
  const applied: RestoredPane[] = []
  const deps: RestoreDeps = {
    readStacks: vi.fn(async () => [stack([browser('bp-1')])]),
    readProjects: vi.fn(async () => [{ path: WT, worktrees: [] }]),
    isDirectory: vi.fn(() => true),
    hasGit: vi.fn(() => false),
    isBlocked: vi.fn(() => false),
    now: () => 1,
    apply: (r) => void applied.push(r),
    ...over
  }
  return { deps, applied }
}

describe('with no browser pane saved', () => {
  it('does nothing: no project list read, no disk check, nothing applied', async () => {
    const { deps, applied } = rig({
      readStacks: vi.fn(async () => [
        stack([
          { id: 'h-1', type: 'shell' },
          { id: 'h-2', type: 'markdown' }
        ]),
        stack([], '/work/other')
      ])
    })
    expect(await runRestore(deps)).toBe(0)
    expect(deps.readProjects).not.toHaveBeenCalled()
    expect(deps.isDirectory).not.toHaveBeenCalled()
    expect(deps.hasGit).not.toHaveBeenCalled()
    expect(applied).toEqual([])
  })

  it('has no scanner to call: the dependency set holds no fleet scan at all', () => {
    const { deps } = rig()
    expect(Object.keys(deps).sort()).toEqual(
      ['apply', 'hasGit', 'isBlocked', 'isDirectory', 'now', 'readProjects', 'readStacks'].sort()
    )
  })

  it('a helpers file that cannot be read restores nothing and does not throw', async () => {
    const { deps } = rig({ readStacks: vi.fn(async () => Promise.reject(new Error('corrupt'))) })
    expect(await runRestore(deps)).toBe(0)
  })
})

describe('the folder rules', () => {
  it('restores a pane in a pinned project, or in one of its worktrees (the browser-flag folder set)', async () => {
    const { deps, applied } = rig({
      readStacks: vi.fn(async () => [
        stack([browser('bp-1')]),
        stack([browser('bp-2')], '/work/acme-wt')
      ]),
      readProjects: vi.fn(async () => [{ path: WT, worktrees: [{ path: '/work/acme-wt' }] }])
    })
    expect(await runRestore(deps)).toBe(2)
    expect(applied.map((r) => r.rec.paneId)).toEqual(['bp-1', 'bp-2'])
    // a pinned project needs no `.git` probe
    expect(deps.hasGit).not.toHaveBeenCalled()
  })

  it('restores a pane in a git checkout that is not pinned, and drops one in an arbitrary directory', async () => {
    const { deps, applied } = rig({
      readStacks: vi.fn(async () => [
        stack([browser('bp-1')], '/work/checkout'),
        stack([browser('bp-2')], '/home/victim/.ssh'),
        stack([browser('bp-3')], '/')
      ]),
      readProjects: vi.fn(async () => []),
      hasGit: vi.fn((p: string) => p === '/work/checkout')
    })
    expect(await runRestore(deps)).toBe(1)
    expect(applied.map((r) => r.rec.paneId)).toEqual(['bp-1'])
  })

  it('drops a pane whose folder is gone', async () => {
    const { deps } = rig({ isDirectory: vi.fn(() => false) })
    expect(await runRestore(deps)).toBe(0)
  })

  it('a blocked folder drops an agent-opened pane and keeps an operator-opened one', async () => {
    const { deps, applied } = rig({
      readStacks: vi.fn(async () => [
        stack([browser('bp-agent', { openedBy: 'agent', partition: 'agent' }), browser('bp-op')])
      ]),
      readProjects: vi.fn(async () => [{ path: WT, worktrees: [], agentDenied: true }]),
      isBlocked: vi.fn((folder: string, denied: readonly string[]) => denied.includes(folder))
    })
    expect(await runRestore(deps)).toBe(1)
    expect(applied.map((r) => r.rec.paneId)).toEqual(['bp-op'])
  })

  it('a project list that cannot be read does not drop every pane: the on-disk rule alone applies', async () => {
    const { deps, applied } = rig({
      readProjects: vi.fn(async () => Promise.reject(new Error('unreadable'))),
      hasGit: vi.fn(() => true)
    })
    expect(await runRestore(deps)).toBe(1)
    expect(applied[0]!.rec.paneId).toBe('bp-1')
  })

  it('applies each pane once, with its disconnect', async () => {
    const { deps, applied } = rig({
      readStacks: vi.fn(async () => [
        stack([browser('bp-1', { disconnected: true }), browser('bp-1')])
      ])
    })
    expect(await runRestore(deps)).toBe(1)
    expect(applied[0]!.disconnected).toBe(true)
  })
})
