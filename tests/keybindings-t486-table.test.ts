import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  KEYBINDINGS,
  DESCRIPTOR_BY_ID,
  resolveKeybindings,
  canonicalizeChord,
  scopeChordKey,
  type KeybindingGroup
} from '../src/main/keybindings-core'

/**
 * T486 — the keybindings table grows by one row per user-invokable action
 * (`docs/specs/T486-keybindings-coverage-pass.md` §3). Pure (node env).
 *
 *  - AC-11: every §3 id exists with its §3 group, default, `menu` and `shield`.
 *  - AC-12: every non-reserved table id has exactly one `'global'` registration
 *    in `App.vue` — enumerated from the source, so a row without a handler (or a
 *    handler registered twice) fails here instead of shipping dead.
 *  - AC-13: the defaults resolve with no conflict and never land on a reserved
 *    chord, on both platform folds.
 *
 * Each later unit appends its own §3 rows to `SPEC_ROWS`.
 */

interface SpecRow {
  group: KeybindingGroup
  defaultKeys: string | null
  menu: boolean
  shield: boolean
}

const unbound = (group: KeybindingGroup): SpecRow => ({
  group,
  defaultKeys: null,
  menu: false,
  shield: false
})

/** §3.2 Sessions and §3.3 Sidebar — the ids U2 adds. */
const SPEC_ROWS: Record<string, SpecRow> = {
  'session.newInFolder': unbound('sessions'),
  // Operator decision 2026-10-14: ships unbound.
  'session.fork': unbound('sessions'),
  'session.openToSide': { group: 'sessions', defaultKeys: 'Cmd+Enter', menu: false, shield: false },
  'session.contextMenu': {
    group: 'sessions',
    defaultKeys: 'Shift+F10',
    menu: false,
    shield: false
  },
  'session.restart': unbound('sessions'),
  'session.copyId': unbound('sessions'),
  'session.copyTranscriptPath': unbound('sessions'),
  'session.copyResumeCommand': unbound('sessions'),
  'session.copyContextDigest': unbound('sessions'),
  'session.toggleNoFlicker': unbound('sessions'),
  'session.toggleArchived': unbound('sessions'),
  'session.delete': unbound('sessions'),
  'session.retryBoot': unbound('sessions'),
  'session.dismiss': unbound('sessions'),
  'session.closeTerminal': unbound('sessions'),
  'sidebar.jump': { group: 'sidebar', defaultKeys: 'Cmd+Shift+F', menu: false, shield: false },
  'sidebar.rescan': unbound('sidebar'),
  'sidebar.cycleDrillDepth': unbound('sidebar'),
  'sidebar.toggleCollapseAll': unbound('sidebar'),
  'sidebar.hiddenFolders': unbound('sidebar')
}

describe('AC-11 — the §3 ids exist with their §3 values', () => {
  for (const [id, row] of Object.entries(SPEC_ROWS)) {
    it(id, () => {
      const d = DESCRIPTOR_BY_ID[id as keyof typeof DESCRIPTOR_BY_ID]
      expect(d, `${id} is missing from KEYBINDINGS`).toBeDefined()
      expect(d.group).toBe(row.group)
      expect(d.defaultKeys).toBe(row.defaultKeys)
      expect(d.menu).toBe(row.menu)
      // `shield` arrives as a descriptor field in U5a; until then it is absent.
      expect((d as { shield?: boolean }).shield ?? false).toBe(row.shield)
      expect(d.reserved).toBe(false)
      expect(d.scope).toBe('global')
    })
  }

  it('adds exactly the 20 §3.2 + §3.3 ids', () => {
    expect(Object.keys(SPEC_ROWS)).toHaveLength(20)
  })
})

/**
 * The `useShortcuts([...])` registrations in `App.vue`, as `{ id, scope }`. Each
 * registration object is the text between one `id: '…'` and the next; its scope
 * is the first `scope: '…'` inside it.
 */
function appRegistrations(): Array<{ id: string; scope: string | null }> {
  const src = readFileSync(resolve(__dirname, '../src/renderer/src/App.vue'), 'utf8')
  const start = src.indexOf('useShortcuts(')
  expect(start, 'App.vue calls useShortcuts').toBeGreaterThan(-1)
  const block = src.slice(start, src.indexOf('() => keybindings.resolved', start))
  const chunks = block.split(/\bid: '/).slice(1)
  return chunks.map((chunk) => {
    const id = chunk.slice(0, chunk.indexOf("'"))
    const scope = /\bscope: '([a-z]+)'/.exec(chunk)?.[1] ?? null
    return { id, scope }
  })
}

describe('AC-12 — one global registration per non-reserved id', () => {
  const regs = appRegistrations()

  for (const d of KEYBINDINGS.filter((x) => !x.reserved)) {
    it(d.id, () => {
      const mine = regs.filter((r) => r.id === d.id)
      expect(mine, `${d.id} registrations in App.vue`).toHaveLength(1)
      expect(mine[0].scope).toBe('global')
    })
  }
})

describe('AC-13 — defaults resolve cleanly on both platform folds', () => {
  for (const mac of [true, false]) {
    it(mac ? 'macOS' : 'Linux / Windows', () => {
      const resolved = resolveKeybindings(null, { mac })
      expect(resolved.warnings).toEqual([])
      for (const b of resolved.list) expect(b.conflictsWith, b.id).toEqual([])

      const reserved = new Set(
        KEYBINDINGS.filter((d) => d.reserved && d.defaultKeys).map((d) =>
          scopeChordKey(d.scope, canonicalizeChord(d.defaultKeys!)!, mac)
        )
      )
      for (const d of KEYBINDINGS) {
        if (d.reserved || !d.defaultKeys) continue
        const key = scopeChordKey(d.scope, canonicalizeChord(d.defaultKeys)!, mac)
        expect(reserved.has(key), `${d.id} lands on a reserved chord`).toBe(false)
      }
    })
  }
})

describe('§9.1 — sidebar.cursor.* moved their text-entry check into keysGuard', () => {
  it('App.vue no longer gates any enabled() on isTextEntryTarget', () => {
    const src = readFileSync(resolve(__dirname, '../src/renderer/src/App.vue'), 'utf8')
    expect(src).not.toMatch(/enabled:[^\n]*isTextEntryTarget/)
    expect(src).not.toMatch(/function isTextEntryTarget/)
    const cursorGuards = src.match(
      /id: 'sidebar\.cursor\.[a-z]+',[\s\S]*?keysGuard: notInTextEntry/g
    )
    expect(cursorGuards).toHaveLength(5)
  })
})
