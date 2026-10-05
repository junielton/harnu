import { describe, it, expect, beforeEach } from 'vitest'
import {
  activeScope,
  pushScope,
  popScope,
  resetScopesForTests
} from '../src/renderer/src/composables/useShortcuts'

/**
 * Locks the previously-DEAD scope-stack contract that T22 activated: the topmost
 * non-global scope shadows global bindings in `dispatch()`. Pure (node env) —
 * mirrors `use-terminal-focus.test.ts`'s module-singleton + reset-hook pattern.
 */
describe('useShortcuts scope stack (T22)', () => {
  beforeEach(() => resetScopesForTests())

  it('defaults to global', () => {
    expect(activeScope()).toBe('global')
  })

  it('push/pop modal toggles the active scope', () => {
    pushScope('modal')
    expect(activeScope()).toBe('modal')
    popScope('modal')
    expect(activeScope()).toBe('global')
  })

  it('never pops the global base, and popping an absent scope is a no-op', () => {
    popScope('global')
    expect(activeScope()).toBe('global')
    popScope('modal') // not on the stack
    expect(activeScope()).toBe('global')
  })

  it('pops the topmost occurrence, leaving lower scopes intact', () => {
    pushScope('sidebar')
    pushScope('modal')
    expect(activeScope()).toBe('modal')
    popScope('modal')
    expect(activeScope()).toBe('sidebar')
  })

  it('one aggregate push then pop returns to global (Edit-1 balance invariant)', () => {
    pushScope('modal') // anyOverlayOpen → true
    expect(activeScope()).toBe('modal')
    popScope('modal') // anyOverlayOpen → false
    expect(activeScope()).toBe('global')
  })
})
