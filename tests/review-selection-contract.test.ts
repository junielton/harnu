// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { useHelpersStore } from '../src/renderer/src/stores/helpers'
import { useSessionsStore } from '../src/renderer/src/stores/sessions'

/**
 * T257 U2b — what the delivery surfaces may reach, and where the new IPC names live.
 *
 * U2b-AC-6 (spec §11 G-5): the bar and the store read no companion content. They know the
 * companion's minted session id through ONE getter and nothing else of the pane.
 * U2b-AC-7 (PRD P8): `stores/review.ts` is left alone; the three new `window.api` names are
 * called from `stores/review-selection.ts` and nowhere else in the renderer.
 *
 * The pins that must keep passing UNTOUCHED are in `review-companion.test.ts` (the pane reads no
 * helper state) and `review-pane-contract.test.ts` (`stores/review.ts`'s window.api surface).
 */

const read = (p: string): string => readFileSync(p, 'utf8')

/** Source without comments, so a pin reads what the code does and not what it explains. */
const codeOnly = (src: string): string =>
  src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

const BAR = 'src/renderer/src/components/ReviewSelectionBar.vue'
const STORE = 'src/renderer/src/stores/review-selection.ts'
const LIB = 'src/renderer/src/lib/review-selection-delivery.ts'

const NEW_API = ['reviewSelectionSend', 'reviewSelectionCompose', 'onReviewSelectionState']

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

describe('U2b-AC-6 — the new surfaces read no companion content', () => {
  it('references none of the pane, the stack, the live terminals or the PTY stream', () => {
    for (const file of [BAR, STORE, LIB]) {
      const code = codeOnly(read(file))
      for (const forbidden of [
        'HelperPane',
        'HelperStack',
        'liveHelpers',
        'onPtyData',
        'pane-components',
        'panesForCurrentWorktree',
        'ptyWrite'
      ]) {
        expect(code, `${file} reaches for ${forbidden}`).not.toContain(forbidden)
      }
    }
  })

  it('reaches into the helpers store for exactly one getter', () => {
    const store = codeOnly(read(STORE))
    const reads = [...store.matchAll(/useHelpersStore\(\)\.(\w+)/g)].map((m) => m[1])
    expect(reads).toEqual(['reviewCompanionSessionId'])
    // …and for nothing in any other shape (a destructure or a held reference).
    expect([...store.matchAll(/useHelpersStore\(/g)]).toHaveLength(1)
    expect(codeOnly(read(BAR))).not.toMatch(/helpers/i)
    expect(codeOnly(read(LIB))).not.toMatch(/helpers/i)
  })

  it('the delivery model takes codes in and hands closed keys out — no text path from main', () => {
    const lib = codeOnly(read(LIB))
    // It never reads a message-like field off a result or event.
    expect(lib).not.toMatch(/\.message\b|\.detail\b|\.text\b|\.title\b/)
  })

  it("the getter returns the open companion's minted id, or null — nothing else", () => {
    setActivePinia(createPinia())
    const helpers = useHelpersStore()
    const sessions = useSessionsStore()
    sessions.selectFolder('/repos/harnu')
    expect(helpers.reviewCompanionSessionId).toBeNull()

    const id = helpers.addReviewCompanionHelper('/repos/harnu', '/repos/harnu')
    const pane = helpers.panesForCurrentWorktree.find((p) => p.id === id)
    expect(pane?.type).toBe('review-companion')
    expect(typeof helpers.reviewCompanionSessionId).toBe('string')
    expect(helpers.reviewCompanionSessionId).toBe((pane as { sessionId: string }).sessionId)

    // Another folder's stack is not this review's companion.
    sessions.selectFolder('/repos/other')
    expect(helpers.reviewCompanionSessionId).toBeNull()
  })
})

describe('U2b-AC-7 — the IPC names live in one store', () => {
  it('stores/review-selection.ts calls exactly the three new window.api names', () => {
    const calls = new Set(
      [...codeOnly(read(STORE)).matchAll(/window\.api\.(\w+)/g)].map((m) => m[1])
    )
    expect(calls).toEqual(new Set(NEW_API))
  })

  it('no other renderer file names them', () => {
    const offenders = walk('src/renderer/src')
      .filter((f) => /\.(ts|vue)$/.test(f))
      .filter((f) => f.replace(/\\/g, '/') !== STORE)
      .filter((f) => NEW_API.some((n) => codeOnly(read(f)).includes(n)))
    expect(offenders).toEqual([])
  })

  it('stores/review.ts still knows nothing of the selection or its IPC', () => {
    const src = read('src/renderer/src/stores/review.ts')
    expect(src).not.toMatch(/selection/i)
    for (const n of NEW_API) expect(src).not.toContain(n)
  })

  it('the preload exposes exactly those names for the selection, and no MCP verb reaches them', () => {
    const preload = read('src/preload/index.ts')
    const exposed = new Set(
      [...preload.matchAll(/^\s{2}(\w*[Ss]election\w*|onReviewSelection\w*):/gm)]
        .map((m) => m[1])
        .filter((n) => n.startsWith('reviewSelection') || n === 'onReviewSelectionState')
    )
    expect(exposed).toEqual(new Set(NEW_API))
    expect(preload).toContain("'review:selection:send'")
    expect(preload).toContain("'review:selection:compose'")
    expect(preload).toContain("'review:selection:state'")

    const mcp = walk('src/main/mcp').filter((f) => f.endsWith('.ts'))
    for (const f of mcp) expect(read(f), f).not.toContain('review:selection')
  })
})
