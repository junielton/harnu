import { describe, it, expect } from 'vitest'
import {
  mergeState,
  HOOK_AUTHORITY_TTL_MS,
  type HookSignal
} from '../src/main/detect/state-merge-core'

/**
 * T2 — `mergeState` fuses the hook FSM signal + the screen scrape into one
 * `TaskState`, encoding the two-level precedence and the per-provider method
 * gate. The invariants pinned here:
 *
 *   - `hooks`: hook is the sole authority — the screen is NEVER consulted (no
 *     Claude regression);
 *   - `screen`: the scrape is the sole authority — a missing hook is ignored;
 *   - `both`: a recent hook (< TTL) beats the screen; a stale hook yields to it;
 *   - `blocked → needs-input` mapping happens on the screen path.
 */

const NOW = 1_700_000_000_000
const hookAt = (state: HookSignal['state'], ts: number): HookSignal => ({ state, ts })

describe('mergeState — method "hooks" (Claude): hook is the sole authority', () => {
  it('uses the hook state and IGNORES the screen entirely', () => {
    // Screen says blocked, but a hooks-provider must never be screen-scraped.
    expect(mergeState(hookAt('working', NOW), 'blocked', 'hooks', NOW)).toBe('working')
  })

  it('ignores the screen even when the hook is stale (hooks tier has no TTL)', () => {
    const ancient = hookAt('needs-input', NOW - 10 * HOOK_AUTHORITY_TTL_MS)
    expect(mergeState(ancient, 'idle', 'hooks', NOW)).toBe('needs-input')
  })

  it('defaults to idle when no hook has arrived', () => {
    expect(mergeState(null, 'blocked', 'hooks', NOW)).toBe('idle')
  })
})

describe('mergeState — method "screen" (codex/aider): scrape is the sole authority', () => {
  it('maps blocked → needs-input', () => {
    expect(mergeState(null, 'blocked', 'screen', NOW)).toBe('needs-input')
  })

  it('maps working → working and idle → idle', () => {
    expect(mergeState(null, 'working', 'screen', NOW)).toBe('working')
    expect(mergeState(null, 'idle', 'screen', NOW)).toBe('idle')
  })

  it('ignores a present hook (a screen provider has none that matter)', () => {
    expect(mergeState(hookAt('completed', NOW), 'working', 'screen', NOW)).toBe('working')
  })

  it('defaults to idle when there is no screen reading yet', () => {
    expect(mergeState(null, null, 'screen', NOW)).toBe('idle')
  })
})

describe('mergeState — method "both": recent hook wins, stale hook yields', () => {
  it('a recent hook (< TTL) beats the screen', () => {
    const recent = hookAt('working', NOW - 1000)
    expect(mergeState(recent, 'idle', 'both', NOW)).toBe('working')
  })

  it('a hook exactly at the TTL boundary is considered EXPIRED → screen', () => {
    const boundary = hookAt('working', NOW - HOOK_AUTHORITY_TTL_MS)
    expect(mergeState(boundary, 'blocked', 'both', NOW)).toBe('needs-input')
  })

  it('an expired hook yields to the screen (blocked → needs-input)', () => {
    const stale = hookAt('working', NOW - HOOK_AUTHORITY_TTL_MS - 1)
    expect(mergeState(stale, 'blocked', 'both', NOW)).toBe('needs-input')
  })

  it('an expired hook with NO screen falls back to the last hook state', () => {
    const stale = hookAt('working', NOW - HOOK_AUTHORITY_TTL_MS - 1)
    expect(mergeState(stale, null, 'both', NOW)).toBe('working')
  })

  it('no hook + a screen → the screen', () => {
    expect(mergeState(null, 'working', 'both', NOW)).toBe('working')
  })

  it('neither signal → idle', () => {
    expect(mergeState(null, null, 'both', NOW)).toBe('idle')
  })

  it('honors a custom TTL override', () => {
    const hook = hookAt('working', NOW - 500)
    expect(mergeState(hook, 'idle', 'both', NOW, 100)).toBe('idle') // 500 > 100 → expired
    expect(mergeState(hook, 'idle', 'both', NOW, 1000)).toBe('working') // 500 < 1000 → recent
  })
})
