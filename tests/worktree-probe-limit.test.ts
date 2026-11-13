import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BUG-262 AC-1 — `collectWorktreeListing` probed every worktree with `git status` at once
 * (56 spawns in one task, 1.2 s of blocked main thread). The probes now run through a
 * concurrency limit that yields to the event loop between spawns.
 */

const st = vi.hoisted(() => ({ inFlight: 0, maxInFlight: 0, statusCalls: 0, N: 40 }))

vi.mock('node:child_process', () => {
  const CUSTOM = Symbol.for('nodejs.util.promisify.custom')
  const run = async (
    _file: string,
    args: string[]
  ): Promise<{ stdout: string; stderr: string }> => {
    if (args.includes('worktree')) {
      const out = Array.from(
        { length: st.N },
        (_, i) => `worktree /repo/wt-${i}\nHEAD abc${i}\nbranch refs/heads/b${i}\n`
      ).join('\n')
      return { stdout: out + '\n', stderr: '' }
    }
    st.statusCalls++
    st.inFlight++
    st.maxInFlight = Math.max(st.maxInFlight, st.inFlight)
    await new Promise((r) => setTimeout(r, 2))
    st.inFlight--
    return { stdout: '', stderr: '' }
  }
  const execFile: unknown = () => {
    throw new Error('callback form not stubbed')
  }
  ;(execFile as Record<symbol, unknown>)[CUSTOM] = run
  return { execFile }
})
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { collectWorktreeListing, GIT_PROBE_CONCURRENCY } from '../src/main/worktree-ipc'

beforeEach(() => {
  st.inFlight = st.maxInFlight = st.statusCalls = 0
})

describe('collectWorktreeListing probe limit (BUG-262 AC-1)', () => {
  it('probes every worktree but never more than GIT_PROBE_CONCURRENCY at once', async () => {
    const { entries, dirtyByPath } = await collectWorktreeListing(['/repo'])
    expect(entries).toHaveLength(st.N)
    expect(Object.keys(dirtyByPath)).toHaveLength(st.N)
    expect(st.statusCalls).toBe(st.N)
    expect(st.maxInFlight).toBeLessThanOrEqual(GIT_PROBE_CONCURRENCY)
    expect(st.maxInFlight).toBeGreaterThan(1) // bounded, not serialized
  })
})
