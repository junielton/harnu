import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { MenuItemConstructorOptions } from 'electron'

/**
 * T486 U5a — `nav.back` / `nav.forward` become table rows (§10), and the core
 * grows the two fields the shield needs: `shield` and `defaultKeysMac`, read
 * through `defaultKeysFor` and `isNotInTerminal` (§7.4, AC-44, AC-53).
 *
 * The suite runs on Linux, so `menu.ts`'s module-level `isMac` is false: its
 * accelerators are the Linux / Windows ones.
 */
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (t: unknown) => t, setApplicationMenu: () => {} },
  app: { name: 'Harnu', quit: () => {} },
  BrowserWindow: class {}
}))

import { accel, buildAppMenu } from '../src/main/menu'
import {
  KEYBINDINGS,
  DESCRIPTOR_BY_ID,
  defaultKeysFor,
  isNotInTerminal,
  isUnreachableChord,
  resolveKeybindings
} from '../src/main/keybindings-core'

describe('nav.back / nav.forward rows (§10, AC-44)', () => {
  it.each([
    ['nav.back', 'Alt+ArrowLeft', 'Cmd+['],
    ['nav.forward', 'Alt+ArrowRight', 'Cmd+]']
  ] as const)(
    '%s is a menu-backed, shielded App row with a platform-split default',
    (id, other, mac) => {
      const d = DESCRIPTOR_BY_ID[id]
      expect(d).toBeDefined()
      expect(d.group).toBe('app')
      expect(d.scope).toBe('global')
      expect(d.menu).toBe(true)
      expect(d.shield).toBe(true)
      expect(d.reserved).toBe(false)
      expect(d.defaultKeys).toBe(other)
      expect(d.defaultKeysMac).toBe(mac)
      expect(defaultKeysFor(d, false)).toBe(other)
      expect(defaultKeysFor(d, true)).toBe(mac)
    }
  )

  it('the shielded rows are nav.*, pane focus and terminal.toggle (§7.4)', () => {
    expect(KEYBINDINGS.filter((d) => d.shield).map((d) => d.id)).toEqual([
      'nav.back',
      'nav.forward',
      'pane.focusNext',
      'pane.focusPrev',
      'terminal.toggle'
    ])
  })

  it('defaultKeysFor falls back to defaultKeys when a row has no mac default', () => {
    const d = DESCRIPTOR_BY_ID['session.new']
    expect(d.defaultKeysMac).toBeUndefined()
    expect(defaultKeysFor(d, true)).toBe('Cmd+N')
    expect(defaultKeysFor(d, false)).toBe('Cmd+N')
  })

  it('resolves each platform to its own default, and ResolvedBinding.defaultKeys follows', () => {
    const mac = resolveKeybindings(null, { mac: true })
    expect(mac.byId['nav.back']).toMatchObject({ keys: 'Cmd+[', defaultKeys: 'Cmd+[' })
    expect(mac.byId['nav.forward']).toMatchObject({ keys: 'Cmd+]', defaultKeys: 'Cmd+]' })
    const other = resolveKeybindings(null, { mac: false })
    expect(other.byId['nav.back']).toMatchObject({
      keys: 'Alt+ArrowLeft',
      defaultKeys: 'Alt+ArrowLeft',
      source: 'default'
    })
    expect(other.byId['nav.forward']?.keys).toBe('Alt+ArrowRight')
    expect(other.warnings).toEqual([])
    expect(mac.warnings).toEqual([])
  })

  it('loads a mac-written override unchanged on Linux', () => {
    const r = resolveKeybindings([{ command: 'nav.back', key: 'Cmd+[' }], { mac: false })
    expect(r.warnings).toEqual([])
    expect(r.byId['nav.back']).toMatchObject({ keys: 'Cmd+[', source: 'override' })
  })

  it('re-recording the platform default returns the row to its default', () => {
    // The pane compares a recorded chord with the PLATFORM default, so on Linux
    // `Alt+ArrowLeft` is the default, not an override.
    const r = resolveKeybindings(null, { mac: false })
    expect(r.byId['nav.back']?.defaultKeys).toBe(r.byId['nav.back']?.keys)
  })
})

describe('isNotInTerminal (§3.1, AC-53)', () => {
  it('is !menu && !shield', () => {
    expect(isNotInTerminal({ menu: false, shield: false })).toBe(true)
    expect(isNotInTerminal({ menu: false })).toBe(true)
    expect(isNotInTerminal({ menu: true })).toBe(false)
    expect(isNotInTerminal({ menu: false, shield: true })).toBe(false)
    expect(isNotInTerminal({ menu: true, shield: true })).toBe(false)
  })

  it('marks nav.* as reaching the terminal and a renderer-only row as not', () => {
    expect(isNotInTerminal(DESCRIPTOR_BY_ID['nav.back'])).toBe(false)
    expect(isNotInTerminal(DESCRIPTOR_BY_ID['inbox.toggle'])).toBe(true)
  })
})

describe('recorder rule widens to !menu && !shield (§5.2)', () => {
  const shiftComma = { cmd: true, ctrl: false, alt: false, shift: true, key: ',' }
  it('never refuses a chord for a shielded action — the shield reads e.code', () => {
    expect(isUnreachableChord(shiftComma, { menu: false, shield: true }, false)).toBe(false)
    expect(
      isUnreachableChord(
        { ...shiftComma, shift: false, alt: true, key: 'S' },
        { menu: false, shield: true },
        true
      )
    ).toBe(false)
  })
  it('still refuses it for a renderer-only action', () => {
    expect(isUnreachableChord(shiftComma, { menu: false, shield: false }, false)).toBe(true)
  })
})

describe('native accelerators follow the table (§10, AC-44)', () => {
  function sessionMenu(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
    const m = template.find((x) => x.label === '&Session')
    return (m?.submenu as MenuItemConstructorOptions[]) ?? []
  }

  it('defaults to Alt+Left / Alt+Right off macOS', () => {
    expect(accel('nav.back')).toBe('Alt+Left')
    expect(accel('nav.forward')).toBe('Alt+Right')
  })

  it('a rebind moves the Back / Forward accelerators', () => {
    const resolved = resolveKeybindings(
      [
        { command: 'nav.back', key: 'Alt+H' },
        { command: 'nav.forward', key: null }
      ],
      { mac: false }
    )
    expect(accel('nav.back', resolved)).toBe('Alt+H')
    expect(accel('nav.forward', resolved)).toBeUndefined()
    const items = sessionMenu(
      buildAppMenu(() => null, resolved) as unknown as MenuItemConstructorOptions[]
    )
    expect(items.find((i) => i.label === 'Back')?.accelerator).toBe('Alt+H')
    expect(items.find((i) => i.label === 'Forward')?.accelerator).toBeUndefined()
  })

  it('menu.ts reads the table and no longer widens the action id union', () => {
    const src = readFileSync(resolve(__dirname, '../src/main/menu.ts'), 'utf8')
    expect(src).toContain("a('nav.back')")
    expect(src).toContain("a('nav.forward')")
    expect(src).not.toMatch(/\|\s*'nav\.back'\s*\|\s*'nav\.forward'/)
    expect(src).not.toMatch(/isMac \? 'Cmd\+\[' : 'Alt\+Left'/)
  })
})
