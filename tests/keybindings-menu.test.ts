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

  it('adds the View → "Keyboard Shortcuts…" item (T1 P5)', () => {
    const template = buildAppMenu(() => null) as unknown as MenuItemConstructorOptions[]
    const view = template.find((m) => m.label === '&View')
    const item = (view?.submenu as MenuItemConstructorOptions[]).find(
      (i) => i.label === 'Keyboard Shortcuts…'
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
