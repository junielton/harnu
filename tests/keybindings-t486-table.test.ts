import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { SETTINGS_TAB_IDS } from '../src/renderer/src/stores/ui'
import {
  KEYBINDINGS,
  DESCRIPTOR_BY_ID,
  resolveKeybindings,
  canonicalizeChord,
  defaultKeysFor,
  scopeChordKey,
  type KeybindingGroup
} from '../src/main/keybindings-core'

/**
 * T486 — the keybindings table grows by one row per user-invokable action
 * (`docs/specs/T486-keybindings-coverage-pass.md` §3). Pure (node env).
 *
 *  - AC-11: every §3 id exists with its §3 group, default, `menu` and `shield`.
 *  - AC-12: every non-reserved table id has exactly one registration in its own
 *    scope (`'global'`, or `'browser'` for the T564 rows) in `App.vue` — enumerated from the source, so a row without a handler (or a
 *    handler registered twice) fails here instead of shipping dead.
 *  - AC-13: the defaults resolve with no conflict and never land on a reserved
 *    chord, on both platform folds.
 *
 * Each later unit appends its own §3 rows to `SPEC_ROWS`.
 * U2 added §3.2 + §3.3, U3 §3.4, U4a §3.5's inbox and popover ids, U4b §3.6
 * and the §3.5 Settings-tab ids, U5b §3.7.
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
  'sidebar.hiddenFolders': unbound('sidebar'),

  // §3.4 Folders and repo groups — the ids U3 adds. Only F2 has a default.
  'folder.rename': { group: 'folders', defaultKeys: 'F2', menu: false, shield: false },
  'folder.newFolderTerminal': unbound('folders'),
  'folder.toggleBranchAlias': unbound('folders'),
  'folder.bootOptions': unbound('folders'),
  'folder.projectMemory': unbound('folders'),
  'folder.memoryLocation': unbound('folders'),
  'folder.newSubfolder': unbound('folders'),
  'folder.openSubfolder': unbound('folders'),
  'folder.newWorktree': unbound('folders'),
  'folder.worktreeMd': unbound('folders'),
  'folder.askAgentWorktreeMd': unbound('folders'),
  'folder.toggleIntercept': unbound('folders'),
  'folder.toggleAutoOrganize': unbound('folders'),
  'folder.toggleOrchestratorDefault': unbound('folders'),
  'folder.toggleHidden': unbound('folders'),
  'folder.removeWorktree': unbound('folders'),
  'folder.toggleOlder': unbound('folders'),
  'folder.toggleArchived': unbound('folders'),
  'repoGroup.rename': unbound('folders'),
  'repoGroup.resetName': unbound('folders'),
  'repoGroup.cleanup': unbound('folders'),

  // §3.5 Views — the inbox and popover ids U4a adds. All unbound.
  'inbox.open': unbound('views'),
  'inbox.toggleOrder': unbound('views'),
  'inbox.filter': unbound('views'),
  'inbox.showAll': unbound('views'),
  'view.activity': unbound('views'),
  'view.missionProgress': unbound('views'),
  'view.pastedImages': unbound('views'),
  'view.claudeStatus': unbound('views'),
  'view.usagePanel': unbound('views'),

  // §3.6 Takeovers — the ids U4b adds. Only Esc has a default.
  'view.closeTakeover': {
    group: 'takeovers',
    defaultKeys: 'Escape',
    menu: false,
    shield: false
  },
  'view.cleanup': unbound('takeovers'),
  'view.scheduler': unbound('takeovers'),
  'view.systemMonitor': unbound('takeovers'),
  'view.containers': unbound('takeovers'),

  // §3.5 Settings tabs — U4b. Only Keyboard Shortcuts is bound, menu-backed.
  'view.settings.keybindings': {
    group: 'views',
    defaultKeys: 'Cmd+Alt+S',
    menu: true,
    shield: false
  },
  ...Object.fromEntries(
    SETTINGS_TAB_IDS.filter((tab) => tab !== 'keybindings').map((tab) => [
      `view.settings.${tab}`,
      unbound('views')
    ])
  ),

  // §3.7 Panes — U5b. F6 / Shift+F6 and the terminal toggle are shielded so they
  // work while a terminal holds focus; the toggle ships unbound (AC-28).
  'pane.focusNext': { group: 'panes', defaultKeys: 'F6', menu: false, shield: true },
  'pane.focusPrev': { group: 'panes', defaultKeys: 'Shift+F6', menu: false, shield: true },
  'pane.toggleMaximize': {
    group: 'panes',
    defaultKeys: 'Cmd+Shift+M',
    menu: false,
    shield: false
  },
  'pane.close': unbound('panes'),
  'terminal.toggle': { group: 'panes', defaultKeys: null, menu: false, shield: true }
}

/** How many rows each unit adds (§11) — a row dropped from `SPEC_ROWS` fails here. */
const U2_IDS = 20
const U3_IDS = 21
const U4A_IDS = 9
const U4B_IDS = 5 + 20
const U5B_IDS = 5

describe('AC-11 — the §3 ids exist with their §3 values', () => {
  for (const [id, row] of Object.entries(SPEC_ROWS)) {
    it(id, () => {
      const d = DESCRIPTOR_BY_ID[id as keyof typeof DESCRIPTOR_BY_ID]
      expect(d, `${id} is missing from KEYBINDINGS`).toBeDefined()
      expect(d.group).toBe(row.group)
      expect(d.defaultKeys).toBe(row.defaultKeys)
      expect(d.menu).toBe(row.menu)
      expect(d.shield ?? false).toBe(row.shield)
      expect(d.reserved).toBe(false)
      expect(d.scope).toBe('global')
    })
  }

  it('adds the 20 §3.2 + §3.3 ids, 21 §3.4, 9 §3.5 popover, 5 §3.6, 20 Settings-tab and 5 §3.7 ids', () => {
    expect(Object.keys(SPEC_ROWS)).toHaveLength(U2_IDS + U3_IDS + U4A_IDS + U4B_IDS + U5B_IDS)
  })

  // §9.1: the four focus-dependent pane ids are never listed in the palette (its
  // focus trap moves focus, so "the focused pane" is unknowable at activation).
  it('the focus-dependent pane ids stay out of the palette; terminal.toggle is in it', () => {
    for (const id of ['pane.focusNext', 'pane.focusPrev', 'pane.toggleMaximize', 'pane.close']) {
      expect(DESCRIPTOR_BY_ID[id as keyof typeof DESCRIPTOR_BY_ID].palette, id).toBe(false)
    }
    expect(DESCRIPTOR_BY_ID['terminal.toggle'].palette).toBe(true)
  })

  // §9.1: the palette's empty query keeps today's set, which includes "Open approvals".
  it('inbox.open is featured in the empty palette', () => {
    expect(DESCRIPTOR_BY_ID['inbox.open'].paletteFeatured).toBe(true)
  })
})

/**
 * §3.4's six T1 rows keep their T1 values (menu-backed, so they fire over a
 * focused terminal); only `folder.add` has a default.
 */
describe('AC-11 — the §3.4 rows T1 already shipped', () => {
  const T1_FOLDER_ROWS: Record<string, string | null> = {
    'folder.add': 'Cmd+O',
    'folder.browseFiles': null,
    'folder.newTerminal': null,
    'folder.openInFileManager': null,
    'folder.openInVSCode': null,
    'folder.openGithubPulls': null
  }
  for (const [id, defaultKeys] of Object.entries(T1_FOLDER_ROWS)) {
    it(id, () => {
      const d = DESCRIPTOR_BY_ID[id as keyof typeof DESCRIPTOR_BY_ID]
      expect(d.group).toBe('folders')
      expect(d.defaultKeys).toBe(defaultKeys)
      expect(d.menu).toBe(true)
    })
  }
})

/**
 * The `useShortcuts([...])` registrations in `App.vue`, as `{ id, scope }`. Each
 * registration object is the text between one `id: '…'` and the next; its scope
 * is the first `scope: '…'` inside it. The Settings-tab ids are one registration
 * generated from `SETTINGS_TAB_IDS` (§3.5): it counts once per tab.
 */
function appRegistrations(): Array<{ id: string; scope: string | null }> {
  const src = readFileSync(resolve(__dirname, '../src/renderer/src/App.vue'), 'utf8')
  const start = src.indexOf('useShortcuts(')
  expect(start, 'App.vue calls useShortcuts').toBeGreaterThan(-1)
  let block = src.slice(start, src.indexOf('() => keybindings.resolved', start))

  const generated: Array<{ id: string; scope: string | null }> = []
  const gen = /\.\.\.SETTINGS_TAB_IDS\.map\([\s\S]*?\}\)\s*\),?/.exec(block)
  if (gen) {
    expect(gen[0]).toContain('id: `view.settings.${tab}`')
    expect(gen[0]).toContain('ui.openSettings(tab)')
    const scope = /\bscope: '([a-z]+)'/.exec(gen[0])?.[1] ?? null
    for (const tab of SETTINGS_TAB_IDS) generated.push({ id: `view.settings.${tab}`, scope })
    block = block.replace(gen[0], '')
  }

  const chunks = block.split(/\bid: '/).slice(1)
  return [
    ...chunks.map((chunk) => {
      const id = chunk.slice(0, chunk.indexOf("'"))
      const scope = /\bscope: '([a-z]+)'/.exec(chunk)?.[1] ?? null
      return { id, scope }
    }),
    ...generated
  ]
}

describe('AC-12 — one registration per non-reserved id, in its own scope', () => {
  const regs = appRegistrations()

  for (const d of KEYBINDINGS.filter((x) => !x.reserved)) {
    it(d.id, () => {
      const mine = regs.filter((r) => r.id === d.id)
      expect(mine, `${d.id} registrations in App.vue`).toHaveLength(1)
      // `global` for every app row; the browser pane's rows (T564) register under `browser`.
      expect(mine[0].scope).toBe(d.scope)
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
        KEYBINDINGS.filter((d) => d.reserved && defaultKeysFor(d, mac)).map((d) =>
          scopeChordKey(d.scope, canonicalizeChord(defaultKeysFor(d, mac)!)!, mac)
        )
      )
      for (const d of KEYBINDINGS) {
        const keys = defaultKeysFor(d, mac)
        if (d.reserved || !keys) continue
        const key = scopeChordKey(d.scope, canonicalizeChord(keys)!, mac)
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
