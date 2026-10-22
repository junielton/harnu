/**
 * Which key presses can make a user activation (T564 U7 Delta 2): the guest preload tags the last trusted
 * `keydown` / `pointerdown` and main measures an agent input run against that moment, so a key that does not activate
 * the page (Escape, a modifier on its own) must not move it. Dependency-free: the sandboxed guest preload bundles it.
 */
const NON_ACTIVATING_KEYS: ReadonlySet<string> = new Set([
  'Escape',
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'FnLock',
  'OS',
  'ContextMenu',
  'Unidentified',
  'Process',
  'Dead'
])

export function isActivatingKey(key: string): boolean {
  return !NON_ACTIVATING_KEYS.has(key)
}
