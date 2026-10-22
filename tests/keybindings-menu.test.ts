import { describe, it, expect, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'

/**
 * `menu.ts` imports `electron` at module load. It only touches `Menu` / `app` /
 * `BrowserWindow` inside functions — `buildFromTemplate` is stubbed as identity
 * so a built menu is just its template array, which is what these tests inspect.
 */
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (t: unknown) => t,
    setApplicationMenu: () => {}
  },
  app: { name: 'Harnu', quit: () => {} },
  BrowserWindow: class {}
}))

import { accel, buildAppMenu } from '../src/main/menu'
import { resolveKeybindings } from '../src/main/keybindings-core'

/**
 * T1 P3 — the native menu accelerators are resolved against `keybindings.json`.
 * The resolution itself is `accel(id, resolved)`; `buildAppMenu` only threads
 * the table through.
 */
describe('accel — override-aware menu accelerators', () => {
  it('falls back to the canonical default with no resolved table', () => {
    expect(accel('session.new')).toBe('CmdOrCtrl+N')
    expect(accel('app.search')).toBe('CmdOrCtrl+K')
  })

  it('uses the default when the resolved table has no override for the id', () => {
    const resolved = resolveKeybindings(null)
    expect(accel('session.new', resolved)).toBe('CmdOrCtrl+N')
    expect(accel('session.rename', resolved)).toBe('CmdOrCtrl+R')
  })

  it('reflects an override from keybindings.json', () => {
    const resolved = resolveKeybindings([{ key: 'Cmd+Shift+N', command: 'session.new' }])
    expect(accel('session.new', resolved)).toBe('CmdOrCtrl+Shift+N')
  })

  it('returns undefined for an unbound action so the item gets no accelerator', () => {
    const resolved = resolveKeybindings([{ key: null, command: 'session.close' }])
    expect(accel('session.close', resolved)).toBeUndefined()
  })

  it('keeps the default for a reserved id — never present in the resolved map', () => {
    const resolved = resolveKeybindings([{ key: 'Cmd+Shift+N', command: 'session.new' }])
    expect(accel('app.quit', resolved)).toBe('CmdOrCtrl+Q')
    expect(accel('app.reload', resolved)).toBe('F5')
    expect(accel('app.fullscreen', resolved)).toBe('F11')
  })

  it('binds Settings to CmdOrCtrl+, and leaves the usage dashboard unbound', () => {
    expect(accel('view.settings')).toBe('CmdOrCtrl+,')
    expect(accel('view.usageDashboard')).toBeUndefined()
    const resolved = resolveKeybindings([{ key: 'Cmd+Shift+U', command: 'view.usageDashboard' }])
    expect(accel('view.usageDashboard', resolved)).toBe('CmdOrCtrl+Shift+U')
  })

  it('resolves the T1 P5 open-keybindings accelerator', () => {
    expect(accel('app.openKeybindings')).toBe('CmdOrCtrl+Alt+K')
    // Reserved — an override in the file can never move it.
    const resolved = resolveKeybindings([{ key: 'Cmd+Alt+K', command: 'app.search' }])
    expect(accel('app.openKeybindings', resolved)).toBe('CmdOrCtrl+Alt+K')
  })
})

describe('buildAppMenu — threads the resolved table into every item', () => {
  function fileMenu(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
    const file = template.find((m) => m.label === '&File')
    return (file?.submenu as MenuItemConstructorOptions[]) ?? []
  }

  it('binds the overridden chord on the matching menu item', () => {
    const resolved = resolveKeybindings([{ key: 'Cmd+Shift+N', command: 'session.new' }])
    const template = buildAppMenu(() => null, resolved) as unknown as MenuItemConstructorOptions[]
    const newSession = fileMenu(template).find((i) => i.label === 'New Session')
    expect(newSession?.accelerator).toBe('CmdOrCtrl+Shift+N')
  })

  it('omits the accelerator entirely for an unbound menu action', () => {
    const resolved = resolveKeybindings([{ key: null, command: 'session.close' }])
    const template = buildAppMenu(() => null, resolved) as unknown as MenuItemConstructorOptions[]
    const closeSession = fileMenu(template).find((i) => i.label === 'Close Session')
    expect(closeSession).toBeDefined()
    expect(closeSession?.accelerator).toBeUndefined()
  })

  it('builds the defaults menu when no table is passed', () => {
    const template = buildAppMenu(() => null) as unknown as MenuItemConstructorOptions[]
    const newSession = fileMenu(template).find((i) => i.label === 'New Session')
    expect(newSession?.accelerator).toBe('CmdOrCtrl+N')
  })

  it('adds the View → "Open keybindings.json" item (T1 P5, relabeled in T486)', () => {
    const template = buildAppMenu(() => null) as unknown as MenuItemConstructorOptions[]
    const view = template.find((m) => m.label === '&View')
    const item = (view?.submenu as MenuItemConstructorOptions[]).find(
      (i) => i.label === 'Open keybindings.json'
    )
    expect(item?.accelerator).toBe('CmdOrCtrl+Alt+K')
  })

  it('adds the Folder menu with no accelerators until the user binds one', () => {
    function folderItem(
      template: MenuItemConstructorOptions[],
      label: string
    ): MenuItemConstructorOptions | undefined {
      const folder = template.find((m) => m.label === 'F&older')
      return (folder?.submenu as MenuItemConstructorOptions[]).find((i) => i.label === label)
    }
    const defaults = buildAppMenu(() => null) as unknown as MenuItemConstructorOptions[]
    for (const label of [
      'Roadmap Board',
      'PR Stack',
      'Browse Files',
      'New Terminal',
      'Open in File Manager',
      'Open in VS Code',
      'Pull Requests on GitHub'
    ]) {
      const item = folderItem(defaults, label)
      expect(item, label).toBeDefined()
      expect(item?.accelerator, label).toBeUndefined()
    }

    const resolved = resolveKeybindings([{ key: 'Cmd+Shift+M', command: 'view.roadmap' }])
    const bound = buildAppMenu(() => null, resolved) as unknown as MenuItemConstructorOptions[]
    expect(folderItem(bound, 'Roadmap Board')?.accelerator).toBe('CmdOrCtrl+Shift+M')
  })
})

/**
 * T486 §10 / AC-36 — "Keyboard Shortcuts…" opens Settings on its tab
 * (`view.settings.keybindings`, ⌘⌥S / Ctrl+Alt+S); the item that opens the raw
 * file is relabeled "Open keybindings.json". On macOS the new item sits right
 * after Settings… in the app menu (where Mac users look for preferences); View
 * elsewhere. Never both: one accelerator, one owner.
 */
describe('buildAppMenu — Keyboard Shortcuts… and Open keybindings.json (T486 U4b)', () => {
  type Item = MenuItemConstructorOptions
  const items = (template: Item[], label: string): Item[] =>
    (template.find((m) => m.label === label)?.submenu as Item[]) ?? []
  const labels = (list: Item[]): Array<string | undefined> => list.map((i) => i.label)

  function build(): { template: Item[]; sent: string[] } {
    const sent: string[] = []
    const win = { webContents: { send: (_ch: string, id: string) => sent.push(id) } }
    const template = buildAppMenu(() => win as never) as unknown as Item[]
    return { template, sent }
  }

  it('resolves ⌘⌥S / Ctrl+Alt+S for view.settings.keybindings', () => {
    expect(accel('view.settings.keybindings')).toBe('CmdOrCtrl+Alt+S')
  })

  it('Linux / Windows: View holds Keyboard Shortcuts… then Open keybindings.json', () => {
    const { template, sent } = build()
    const view = items(template, '&View')
    const shortcuts = view.find((i) => i.label === 'Keyboard Shortcuts…')
    const json = view.find((i) => i.label === 'Open keybindings.json')
    expect(shortcuts?.accelerator).toBe('CmdOrCtrl+Alt+S')
    expect(json?.accelerator).toBe('CmdOrCtrl+Alt+K')
    expect(labels(view).indexOf('Open keybindings.json')).toBe(
      labels(view).indexOf('Keyboard Shortcuts…') + 1
    )
    ;(shortcuts?.click as unknown as () => void)()
    ;(json?.click as unknown as () => void)()
    expect(sent).toEqual(['view.settings.keybindings', 'app.openKeybindings'])
  })

  it('macOS: right after Settings… in the app menu, and not under View', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    vi.resetModules()
    try {
      const mac = await import('../src/main/menu')
      const sent: string[] = []
      const win = { webContents: { send: (_ch: string, id: string) => sent.push(id) } }
      const template = mac.buildAppMenu(() => win as never) as unknown as Item[]
      const appMenu = items(template, 'Harnu')
      const at = labels(appMenu).indexOf('Settings…')
      expect(at).toBeGreaterThan(-1)
      const shortcuts = appMenu[at + 1]
      expect(shortcuts.label).toBe('Keyboard Shortcuts…')
      expect(shortcuts.accelerator).toBe('CmdOrCtrl+Alt+S')
      ;(shortcuts.click as unknown as () => void)()
      expect(sent).toEqual(['view.settings.keybindings'])

      const view = items(template, '&View')
      expect(labels(view)).not.toContain('Keyboard Shortcuts…')
      expect(labels(view)).toContain('Open keybindings.json')
    } finally {
      Object.defineProperty(process, 'platform', platform)
      vi.resetModules()
    }
  })
})
