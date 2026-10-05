// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { i18n } from '@renderer/i18n'
import FleetBoardCard from '../src/renderer/src/components/FleetBoardCard.vue'
import type { Session } from '../src/renderer/src/stores/sessions'

/**
 * Regression for BUG-48: the card `<button>` had `margin: 0 8px 4px` but no
 * `width`, so buttons resolve `width: auto` as fit-content — short titles
 * shrank to their text, long titles overflowed the rail uncontained. The
 * approved mockup (`docs/specs/2026-07-17-fleet-rail/spec.html`) pins
 * `width: calc(100% - 16px)`; this asserts the real component carries the
 * same inline style regardless of title length, so the fix can't silently
 * regress again.
 */

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    fullPath: '/repos/alpha/s1.jsonl',
    fileMtime: 1,
    firstPrompt: '',
    summary: 'one',
    messageCount: 1,
    created: '2026-01-01T00:00:00.000Z',
    modified: '2026-01-01T00:00:00.000Z',
    gitBranch: '',
    projectPath: '/repos/alpha',
    isSidechain: false,
    status: 'idle',
    resumable: true,
    bridged: false,
    ...over
  } as Session
}

let mounted: VueWrapper[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  const api = { ptyReplayForSession: vi.fn(async () => null) }
  // Proxy stub (same pattern as tests/new-worktree-dialog-escape.test.ts): any
  // `window.api.*` call this test doesn't care about is a harmless no-op.
  ;(window as unknown as { api: unknown }).api = new Proxy(api, {
    get(t: Record<string, unknown>, k: string) {
      return k in t ? t[k as keyof typeof t] : () => () => {}
    }
  })
})

afterEach(() => {
  mounted.forEach((w) => w.unmount())
  mounted = []
})

function mountCard(summary: string): VueWrapper {
  const w = mount(FleetBoardCard, {
    global: { plugins: [i18n] },
    props: { session: session({ summary }), state: 'working', folderAlias: 'alpha' }
  })
  mounted.push(w)
  return w
}

describe('FleetBoardCard width', () => {
  it('pins the mockup-specified width regardless of title length', () => {
    const short = mountCard('x')
    const long = mountCard('a'.repeat(120))
    const shortStyle = short.get('[data-dsqa="fleet-card"]').attributes('style')
    const longStyle = long.get('[data-dsqa="fleet-card"]').attributes('style')
    expect(shortStyle).toContain('width: calc(100% - 16px)')
    expect(longStyle).toContain('width: calc(100% - 16px)')
  })

  it('keeps the title inside a truncating span so overflow ellipsises', () => {
    const w = mountCard('a'.repeat(120))
    const title = w.findAll('span').find((s) => s.text() === 'a'.repeat(120))
    expect(title?.classes()).toContain('truncate')
  })
})
