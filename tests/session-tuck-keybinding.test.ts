import { describe, it, expect } from 'vitest'
import {
  DESCRIPTOR_BY_ID,
  KEYBINDINGS,
  renderKeysString,
  resolveKeybindings
} from '../src/main/keybindings-core'

/**
 * T790 AC-4 — the keyboard way to tuck the session away and bring it back. The chord is
 * Ctrl+Shift+J (⌘⇧J on macOS): free in the default table, bound on both platforms, and listed in the
 * command palette so the same action is reachable without remembering it.
 */
describe('session.toggleTuck', () => {
  it('is bound to Ctrl+Shift+J on Linux/Windows and ⌘⇧J on macOS', () => {
    const linux = resolveKeybindings(null, { mac: false })
    const mac = resolveKeybindings(null, { mac: true })
    // One canonical chord (`Cmd` folds to Ctrl off macOS), drawn per platform.
    expect(linux.byId['session.toggleTuck']?.keys).toBe('Cmd+Shift+J')
    expect(renderKeysString('Cmd+Shift+J', { mac: false })).toEqual(['Ctrl', 'Shift', 'J'])
    expect(mac.byId['session.toggleTuck']?.keys).toBe('Cmd+Shift+J')
    expect(renderKeysString('Cmd+Shift+J', { mac: true })).toEqual(['⌘', '⇧', 'J'])
  })

  it('shares its chord with no other default binding', () => {
    const same = KEYBINDINGS.filter(
      (d) => d.defaultKeys === DESCRIPTOR_BY_ID['session.toggleTuck'].defaultKeys
    )
    expect(same.map((d) => d.id)).toEqual(['session.toggleTuck'])
  })

  it('is rebindable and appears in the command palette', () => {
    const d = DESCRIPTOR_BY_ID['session.toggleTuck']
    expect(d.reserved).toBe(false)
    expect(d.palette).not.toBe(false)
  })

  it('loads without a resolver warning', () => {
    expect(resolveKeybindings(null, { mac: false }).warnings).toEqual([])
  })
})
