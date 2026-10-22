import { describe, expect, it } from 'vitest'
import { isActivatingKey } from '../src/shared/browser-activation'

describe('which keys move the activation anchor (Delta 2)', () => {
  it('Escape and a modifier on its own do not', () => {
    for (const key of [
      'Escape',
      'Shift',
      'Control',
      'Alt',
      'Meta',
      'CapsLock',
      'Process',
      'Dead'
    ]) {
      expect(isActivatingKey(key), key).toBe(false)
    }
  })

  it('a key that types or acts does', () => {
    for (const key of ['a', 'A', '1', ' ', 'Enter', 'Tab', 'Backspace', 'ArrowDown', 'F5']) {
      expect(isActivatingKey(key), key).toBe(true)
    }
  })
})
