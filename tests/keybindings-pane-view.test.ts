// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import KeybindingsPane from '../src/renderer/src/components/KeybindingsPane.vue'
import SettingsDialog from '../src/renderer/src/components/SettingsDialog.vue'
import { useKeybindingsStore } from '../src/renderer/src/stores/keybindings'
import { useUiStore } from '../src/renderer/src/stores/ui'
import { i18n } from '@renderer/i18n'
import {
  KEYBINDING_GROUPS,
  DESCRIPTOR_BY_ID,
  canonicalizeChord,
  isUnreachableChord,
  matchesShortcutQuery,
  parseShortcutQuery,
  renderKeysString,
  resolveKeybindings,
  scopeChordKey,
  type RawOverrideEntry,
  type ResolvedBinding
} from '../src/main/keybindings-core'

/**
 * T486 U1 — the Keyboard Shortcuts pane's search (text + chord mode), group
 * headers, filter chips, empty line and recorder refusal (§5.2), plus the
 * Esc-while-recording fix (§4). jsdom's `navigator.platform` is empty, so the
 * mounted pane runs with the Linux/Windows fold (`isMac === false`); the macOS
 * branches are pinned on the pure helpers.
 */

const MAC = false

/* -------------------------------------------------------------------------- */
/*  Pure matcher                                                              */
/* -------------------------------------------------------------------------- */

describe('parseShortcutQuery', () => {
  it('reads a combo with +, a modifier, an F-key, Esc or a mac symbol as chord mode', () => {
    expect(parseShortcutQuery('Ctrl+J')).toMatchObject({ mode: 'chord', chord: 'Ctrl+J' })
    expect(parseShortcutQuery('ctrl+shift+f')).toMatchObject({
      mode: 'chord',
      chord: 'Ctrl+Shift+F'
    })
    expect(parseShortcutQuery('F6')).toMatchObject({ mode: 'chord', chord: 'F6' })
    expect(parseShortcutQuery('Esc')).toMatchObject({ mode: 'chord', chord: 'Escape' })
    expect(parseShortcutQuery('⌘K')).toMatchObject({ mode: 'chord', chord: 'Cmd+K' })
    expect(parseShortcutQuery('⌘⇧F')).toMatchObject({ mode: 'chord', chord: 'Cmd+Shift+F' })
    expect(parseShortcutQuery('⌥←')).toMatchObject({ mode: 'chord', chord: 'Alt+ArrowLeft' })
  })

  it('reads a bare named key as the union of chord and text', () => {
    expect(parseShortcutQuery('delete')).toMatchObject({ mode: 'union', chord: 'Delete' })
    expect(parseShortcutQuery('left')).toMatchObject({ mode: 'union', chord: 'ArrowLeft' })
    expect(parseShortcutQuery('Tab')).toMatchObject({ mode: 'union', chord: 'Tab' })
  })

  it('reads words, single letters and a half-typed combo as text', () => {
    expect(parseShortcutQuery('session').mode).toBe('text')
    expect(parseShortcutQuery('a').mode).toBe('text')
    expect(parseShortcutQuery(',').mode).toBe('text')
    expect(parseShortcutQuery('Ctrl+').mode).toBe('text')
    expect(parseShortcutQuery('   ').mode).toBe('text')
  })
})

describe('matchesShortcutQuery', () => {
  const unboundDelete = { id: 'session.delete', keys: null, scope: 'global' as const }
  const label = 'Delete the session…'

  it('finds "Delete the session…" for `delete` although it is unbound (union)', () => {
    expect(matchesShortcutQuery(unboundDelete, label, parseShortcutQuery('delete'), MAC)).toBe(true)
  })

  it('finds a row bound to Delete for `delete` whatever its label (union)', () => {
    const row = { id: 'x.y', keys: 'Delete', scope: 'global' as const }
    expect(matchesShortcutQuery(row, 'Something else', parseShortcutQuery('delete'), MAC)).toBe(
      true
    )
  })

  it('in chord mode ignores the label: `Ctrl+D` does not find "Delete …"', () => {
    expect(matchesShortcutQuery(unboundDelete, label, parseShortcutQuery('Ctrl+D'), MAC)).toBe(
      false
    )
  })

  it('folds Ctrl onto Cmd off macOS only', () => {
    const row = { id: 'view.toggleSidebar', keys: 'Cmd+B', scope: 'global' as const }
    const q = parseShortcutQuery('Ctrl+B')
    expect(matchesShortcutQuery(row, 'x', q, false)).toBe(true)
    expect(matchesShortcutQuery(row, 'x', q, true)).toBe(false)
    expect(matchesShortcutQuery(row, 'x', parseShortcutQuery('⌘B'), true)).toBe(true)
  })

  it('matches text case-insensitively against label, rendered chord and id', () => {
    const row = { id: 'view.fleetRail', keys: 'Cmd+Shift+B', scope: 'global' as const }
    expect(
      matchesShortcutQuery(row, 'Toggle the Fleet rail', parseShortcutQuery('FLEET'), MAC)
    ).toBe(true)
    expect(matchesShortcutQuery(row, 'x', parseShortcutQuery('fleetrail'), MAC)).toBe(true)
    // Rendered off macOS as "Ctrl+Shift+B"; `shift` alone is a word, not a chord.
    expect(matchesShortcutQuery(row, 'x', parseShortcutQuery('shift'), MAC)).toBe(true)
    expect(matchesShortcutQuery(row, 'x', parseShortcutQuery('nothing'), MAC)).toBe(false)
  })
})

describe('isUnreachableChord', () => {
  const chord = (o: Partial<{ cmd: boolean; alt: boolean; shift: boolean; key: string }>) => ({
    cmd: false,
    ctrl: false,
    alt: false,
    shift: false,
    key: 'K',
    ...o
  })

  it('refuses Shift+punctuation for a renderer-only action on every platform', () => {
    const c = chord({ cmd: true, shift: true, key: ',' })
    expect(isUnreachableChord(c, { menu: false }, false)).toBe(true)
    expect(isUnreachableChord(c, { menu: false }, true)).toBe(true)
  })

  it('refuses Option+letter for a renderer-only action on macOS only', () => {
    const c = chord({ cmd: true, alt: true, key: 'S' })
    expect(isUnreachableChord(c, { menu: false }, true)).toBe(true)
    expect(isUnreachableChord(c, { menu: false }, false)).toBe(false)
  })

  it('never refuses for a menu-backed action, nor an ordinary chord', () => {
    expect(isUnreachableChord(chord({ shift: true, key: ',' }), { menu: true }, true)).toBe(false)
    expect(isUnreachableChord(chord({ cmd: true, shift: true }), { menu: false }, true)).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/*  Mounted pane                                                              */
/* -------------------------------------------------------------------------- */

let saved: string[]
let wrapper: VueWrapper | null = null

function installApi(): void {
  saved = []
  const overrides: Record<string, unknown> = {
    keybindingsSave: vi.fn(async (body: string) => {
      saved.push(body)
    })
  }
  ;(window as unknown as { api: unknown }).api = new Proxy(overrides, {
    get(target, key: string) {
      if (key in target) return target[key]
      if (/^on[A-Z]/.test(key)) return () => () => {}
      return () => Promise.resolve(undefined)
    }
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  installApi()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  i18n.global.locale.value = 'en'
  document.body.innerHTML = ''
})

async function mountPane(overrides: RawOverrideEntry[] | null = null): Promise<VueWrapper> {
  useKeybindingsStore().resolved = resolveKeybindings(overrides, { mac: MAC })
  wrapper = mount(KeybindingsPane, { global: { plugins: [i18n] }, attachTo: document.body })
  await flushPromises()
  return wrapper
}

const rowIds = (w: VueWrapper): string[] =>
  w.findAll('[data-kb-row]').map((r) => r.attributes('data-kb-row') as string)
const groupIds = (w: VueWrapper): string[] =>
  w.findAll('[data-kb-group]').map((g) => g.attributes('data-kb-group') as string)
const list = (): ResolvedBinding[] => useKeybindingsStore().resolved.list

async function searchFor(w: VueWrapper, q: string): Promise<void> {
  await w.find('[data-kb-search]').setValue(q)
}

/** Table order of a set of ids, the order the pane renders rows in within a group. */
function inGroupOrder(ids: string[]): string[] {
  const order = list().map((b) => b.id as string)
  return [...ids].sort((a, b) => {
    const ga = KEYBINDING_GROUPS.indexOf(DESCRIPTOR_BY_ID[a as never].group)
    const gb = KEYBINDING_GROUPS.indexOf(DESCRIPTOR_BY_ID[b as never].group)
    return ga - gb || order.indexOf(a) - order.indexOf(b)
  })
}

describe('search (AC-4, AC-5)', () => {
  it('text mode keeps rows whose label, rendered chord or id contains the query', async () => {
    const w = await mountPane()
    for (const q of ['session', 'PALETTE', 'cursor', 'ctrl', 'fleetRail']) {
      await searchFor(w, q)
      const needle = q.toLowerCase()
      const expected = list()
        .filter((b) =>
          [i18n.global.t(b.labelKey), renderKeysString(b.keys, { mac: MAC }).join('+'), b.id].some(
            (s) => s.toLowerCase().includes(needle)
          )
        )
        .map((b) => b.id as string)
      expect(expected.length, q).toBeGreaterThan(0)
      expect(rowIds(w), q).toEqual(inGroupOrder(expected))
    }
  })

  it('text mode reads the label in the active locale', async () => {
    i18n.global.locale.value = 'pt-BR'
    const w = await mountPane()
    await searchFor(w, 'nova sessão')
    expect(rowIds(w)).toEqual(['session.new'])
  })

  it('chord mode keeps exactly the rows on that chord under the platform fold', async () => {
    const w = await mountPane([
      { command: 'view.roadmap', key: 'Cmd+Shift+F' },
      { command: 'view.review', key: 'F6' }
    ])
    const cases: Array<[string, string[]]> = [
      ['Ctrl+K', ['app.search']],
      ['⌘K', ['app.search']],
      ['ctrl+shift+f', ['view.roadmap']],
      ['F6', ['view.review']],
      ['Ctrl+B', ['view.toggleSidebar']],
      ['Ctrl+J', []]
    ]
    for (const [q, ids] of cases) {
      await searchFor(w, q)
      const exact = list()
        .filter(
          (b) =>
            b.keys &&
            scopeChordKey(b.scope, canonicalizeChord(b.keys) as string, MAC) ===
              scopeChordKey(b.scope, canonicalizeChord(q.replace('⌘', 'Cmd+')) as string, MAC)
        )
        .map((b) => b.id as string)
      expect(exact, q).toEqual(ids)
      expect(rowIds(w), q).toEqual(ids)
    }
  })

  it('a bare named key returns the union of chord and text matches', async () => {
    const w = await mountPane()
    await searchFor(w, 'left')
    // `sidebar.cursor.left` holds ArrowLeft; "Toggle the left sidebar" matches as text.
    expect(rowIds(w)).toEqual(['sidebar.cursor.left', 'view.toggleSidebar'])
  })
})

describe('groups (AC-6)', () => {
  it('lists the groups in the fixed order and hides an empty one', async () => {
    const w = await mountPane()
    const present = KEYBINDING_GROUPS.filter((g) =>
      list().some((b) => DESCRIPTOR_BY_ID[b.id].group === g)
    )
    // No action is in Panes yet (U5b adds them): its header must not render.
    expect(present).not.toContain('panes')
    expect(groupIds(w)).toEqual(present)
    expect(groupIds(w)).toEqual(['sessions', 'sidebar', 'folders', 'views', 'takeovers', 'app'])
    expect(w.find('[data-kb-group="sessions"]').text()).toContain('Sessions')
  })

  it('keeps table order inside a group', async () => {
    const w = await mountPane()
    expect(rowIds(w)).toEqual(inGroupOrder(list().map((b) => b.id)))
  })

  it('hides groups the search empties', async () => {
    const w = await mountPane()
    await searchFor(w, 'sidebar cursor')
    expect(groupIds(w)).toEqual(['sidebar'])
  })
})

describe('chips (AC-7)', () => {
  const OVERRIDES: RawOverrideEntry[] = [
    { command: 'session.new', key: null },
    { command: 'view.review', key: 'Cmd+Shift+B' },
    { command: 'folder.browseFiles', key: 'Cmd+Shift+O' }
  ]

  const chip = (w: VueWrapper, id: string) => w.find(`[data-kb-chip="${id}"]`)

  it('shows each count over the whole table, filtered or not', async () => {
    const w = await mountPane(OVERRIDES)
    const unbound = list().filter((b) => b.keys === null).length
    const conflicts = list().filter((b) => b.conflictsWith.length > 0).length
    const customized = list().filter((b) => b.source !== 'default').length
    expect([unbound, conflicts, customized]).toEqual([8, 2, 3])
    await searchFor(w, 'zzz')
    expect(chip(w, 'unbound').text()).toBe('Unbound 8')
    expect(chip(w, 'conflicts').text()).toBe('Conflicts 2')
    expect(chip(w, 'customized').text()).toBe('Customized 3')
  })

  it('filters by each rule', async () => {
    const w = await mountPane(OVERRIDES)
    await chip(w, 'unbound').trigger('click')
    expect(chip(w, 'unbound').attributes('aria-pressed')).toBe('true')
    expect(new Set(rowIds(w))).toEqual(
      new Set(
        list()
          .filter((b) => b.keys === null)
          .map((b) => b.id)
      )
    )
    await chip(w, 'unbound').trigger('click')

    await chip(w, 'conflicts').trigger('click')
    expect(new Set(rowIds(w))).toEqual(new Set(['view.fleetRail', 'view.review']))
    await chip(w, 'conflicts').trigger('click')

    await chip(w, 'customized').trigger('click')
    expect(new Set(rowIds(w))).toEqual(
      new Set(['session.new', 'view.review', 'folder.browseFiles'])
    )
  })

  it('ANDs active chips with each other and with the search', async () => {
    const w = await mountPane(OVERRIDES)
    await chip(w, 'unbound').trigger('click')
    await chip(w, 'customized').trigger('click')
    expect(rowIds(w)).toEqual(['session.new'])

    await chip(w, 'customized').trigger('click')
    await searchFor(w, 'folder')
    expect(rowIds(w)).toEqual([
      'folder.openInFileManager',
      'folder.openInVSCode',
      'folder.openGithubPulls',
      'folder.newTerminal'
    ])
  })
})

describe('empty result (AC-8)', () => {
  it('shows "No shortcut matches." and no group', async () => {
    const w = await mountPane()
    expect(w.find('[data-kb-no-match]').exists()).toBe(false)
    await searchFor(w, 'no such shortcut anywhere')
    expect(groupIds(w)).toEqual([])
    expect(w.find('[data-kb-no-match]').text()).toBe('No shortcut matches.')
  })
})

/* -------------------------------------------------------------------------- */
/*  Recorder                                                                  */
/* -------------------------------------------------------------------------- */

function press(init: KeyboardEventInit): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  )
}

describe('recorder refuses unreachable chords (AC-50)', () => {
  it('keeps the previous chord on a renderer-only action and shows the refusal line', async () => {
    const w = await mountPane()
    const store = useKeybindingsStore()
    expect(DESCRIPTOR_BY_ID['inbox.toggle'].menu).toBe(false)
    await w.find('[data-kb-capture="inbox.toggle"]').trigger('click')
    press({ code: 'Comma', key: '<', ctrlKey: true, shiftKey: true })
    await flushPromises()

    expect(store.recordingId).toBeNull()
    expect(saved).toEqual([])
    expect(store.resolved.byId['inbox.toggle']?.keys).toBe('Cmd+Shift+A')
    const line = w.find('[data-kb-row="inbox.toggle"] [data-kb-refusal]')
    expect(line.text()).toBe("Ctrl+Shift+, can't fire for this action. Pick another shortcut.")

    // The next recording clears it.
    await w.find('[data-kb-capture="inbox.toggle"]').trigger('click')
    expect(w.find('[data-kb-refusal]').exists()).toBe(false)
  })

  it('accepts the same chord on a menu-backed action', async () => {
    const w = await mountPane()
    await w.find('[data-kb-capture="session.rename"]').trigger('click')
    press({ code: 'Comma', key: '<', ctrlKey: true, shiftKey: true })
    await flushPromises()
    expect(w.find('[data-kb-refusal]').exists()).toBe(false)
    expect(useKeybindingsStore().resolved.byId['session.rename']?.keys).toBe('Cmd+Shift+,')
    expect(saved).toHaveLength(1)
  })

  it('accepts an ordinary chord on a renderer-only action', async () => {
    const w = await mountPane()
    await w.find('[data-kb-capture="inbox.toggle"]').trigger('click')
    press({ code: 'KeyI', key: 'I', ctrlKey: true, shiftKey: true })
    await flushPromises()
    expect(useKeybindingsStore().resolved.byId['inbox.toggle']?.keys).toBe('Cmd+Shift+I')
  })
})

describe('Esc while recording (AC-3)', () => {
  async function mountSettings(): Promise<ReturnType<typeof useUiStore>> {
    const ui = useUiStore()
    wrapper = mount(SettingsDialog, { attachTo: document.body, global: { plugins: [i18n] } })
    ui.openSettings('keybindings')
    await flushPromises()
    await flushPromises()
    expect(ui.dialog).toBe('settings')
    return ui
  }

  it('cancels the recording and leaves Settings open', async () => {
    const ui = await mountSettings()
    const store = useKeybindingsStore()
    const capture = document.querySelector<HTMLElement>('[data-kb-capture="session.new"]')
    expect(capture).not.toBeNull()
    capture?.click()
    expect(store.recordingId).toBe('session.new')

    press({ key: 'Escape', code: 'Escape' })
    await flushPromises()

    expect(store.recordingId).toBeNull()
    expect(ui.dialog).toBe('settings')
    expect(saved).toEqual([])
    expect(store.resolved.byId['session.new']?.keys).toBe('Cmd+N')
  })

  it('still closes Settings on Esc when nothing is recording', async () => {
    const ui = await mountSettings()
    press({ key: 'Escape', code: 'Escape' })
    await flushPromises()
    expect(ui.dialog).toBeNull()
  })
})
