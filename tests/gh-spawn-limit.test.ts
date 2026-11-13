import { describe, expect, it, vi } from 'vitest'

/**
 * BUG-266: the limit now lives in the spawn runner's `gh` lane (runGh takes a slot via runFile).
 *
 * BUG-262 AC-1 — every `spawn()` blocks the main thread while the child forks, so a burst of
 * `gh` calls in one task froze typing. `runGh` now holds at most GH_SPAWN_LIMIT children in
 * flight and yields to the event loop before each spawn.
 */

const sp = vi.hoisted(() => ({
  inFlight: 0,
  maxInFlight: 0,
  started: 0,
  finishers: [] as Array<() => void>
}))

vi.mock('../src/main/appimage-env', () => ({
  spawnEnvOnce: async (): Promise<Record<string, string>> => ({ PATH: '/usr/bin' })
}))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const execFile = (_f: string, _a: string[], _o: object, cb: (...a: unknown[]) => void) => {
    sp.started++
    sp.inFlight++
    sp.maxInFlight = Math.max(sp.maxInFlight, sp.inFlight)
    sp.finishers.push(() => {
      sp.inFlight--
      cb(null, '[]', '')
    })
    return { stdin: { on: (): void => {}, end: (): void => {} } }
  }
  return { ...real, execFile }
})

import { runGh, GH_SPAWN_LIMIT } from '../src/main/gh-runner'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('runGh spawn limit (BUG-262 AC-1)', () => {
  it('never has more than GH_SPAWN_LIMIT gh children in flight, and still finishes every call', async () => {
    const calls = Array.from({ length: GH_SPAWN_LIMIT * 5 }, () =>
      runGh(['pr', 'list'], { cwd: '/repo', consumer: 'missions', resource: 'graphql' })
    )
    await tick()
    expect(sp.started).toBe(GH_SPAWN_LIMIT)
    // Drain: finishing one lets exactly one more start.
    while (sp.finishers.length > 0) {
      sp.finishers.shift()!()
      await tick()
      expect(sp.inFlight).toBeLessThanOrEqual(GH_SPAWN_LIMIT)
    }
    await Promise.all(calls)
    expect(sp.started).toBe(GH_SPAWN_LIMIT * 5)
    expect(sp.maxInFlight).toBeLessThanOrEqual(GH_SPAWN_LIMIT)
  })
})
