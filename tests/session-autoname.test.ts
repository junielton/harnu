import { describe, it, expect, afterEach, vi } from 'vitest'
import { useSessionAutoname } from '../src/renderer/src/stores/session-autoname'
import type { Session } from '../src/renderer/src/stores/sessions'

/**
 * T25 wave 3 — Haiku auto-name extracted from the sessions god-store (T177
 * retired the live-session-pulse half this module used to share a home
 * with). Tested in isolation with injected deps + stubbed `localStorage` /
 * `window.api` — pins the composable's orchestration + its DI seam (writing
 * onto the live row, clearing `bornSyntheticIds`).
 */

function makeLocalStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    }
  } as Storage
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A minimal session row — only the fields the composable reads/writes. */
function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    synthetic: false,
    resumable: true,
    firstPrompt: 'do the thing',
    summary: '',
    ...over
  } as Session
}

function setup(
  over: { localStorage?: Record<string, string>; api?: Record<string, unknown> } = {}
) {
  vi.stubGlobal('localStorage', makeLocalStorage(over.localStorage))
  const haikuAutoname = vi.fn().mockResolvedValue({ ok: true, title: 'T', summary: 'S' })
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { haikuAutoname, ...over.api }
  }
  return { haikuAutoname }
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
  vi.unstubAllGlobals()
})

describe('useSessionAutoname — maybeAutoname', () => {
  it('names a born-synthetic row and clears its born mark on success', async () => {
    const { haikuAutoname } = setup({ localStorage: { 'om2tab.haikuAutoname': 'true' } })
    const s = session({ sessionId: 's1' })
    const sessions = [s]
    const born = new Set(['s1'])
    const p = useSessionAutoname({
      findSessionById: (id) => sessions.find((x) => x.sessionId === id) ?? null,
      bornSyntheticIds: born
    })
    p.maybeAutoname(s)
    await tick()
    expect(haikuAutoname).toHaveBeenCalledWith({ sessionId: 's1', firstUserText: 'do the thing' })
    expect(sessions[0].aiSummary).toEqual({ title: 'T', summary: 'S' })
    expect(born.has('s1')).toBe(false)
  })

  it('does nothing when the auto-name toggle is off', async () => {
    const { haikuAutoname } = setup() // toggle absent → off
    const born = new Set(['s1'])
    const p = useSessionAutoname({
      findSessionById: () => null,
      bornSyntheticIds: born
    })
    p.maybeAutoname(session())
    await tick()
    expect(haikuAutoname).not.toHaveBeenCalled()
  })

  it('only names born-synthetic rows (skips pre-existing on-disk sessions)', async () => {
    const { haikuAutoname } = setup({ localStorage: { 'om2tab.haikuAutoname': 'true' } })
    const p = useSessionAutoname({
      findSessionById: () => null,
      bornSyntheticIds: new Set() // s1 NOT born-synthetic
    })
    p.maybeAutoname(session())
    await tick()
    expect(haikuAutoname).not.toHaveBeenCalled()
  })

  it('skips a row that already has a custom summary or an aiSummary', async () => {
    const { haikuAutoname } = setup({ localStorage: { 'om2tab.haikuAutoname': 'true' } })
    const born = new Set(['s1'])
    const p = useSessionAutoname({
      findSessionById: () => null,
      bornSyntheticIds: born
    })
    p.maybeAutoname(session({ summary: 'named by /rename' }))
    p.maybeAutoname(session({ aiSummary: { title: 'x', summary: 'y' } }))
    await tick()
    expect(haikuAutoname).not.toHaveBeenCalled()
  })
})
