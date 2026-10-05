import { describe, it, expect, beforeEach } from 'vitest'
import {
  useTerminalFocus,
  registerFocusedPane,
  unregisterFocusedPane,
  resetTerminalFocusForTests
} from '../src/renderer/src/composables/useTerminalFocus'

describe('useTerminalFocus multi-pane', () => {
  beforeEach(() => {
    resetTerminalFocusForTests()
  })

  it('returns false when no panes are focused', () => {
    const { terminalFocused } = useTerminalFocus()
    expect(terminalFocused.value).toBe(false)
  })

  it('returns true when at least one pane is focused', () => {
    const { terminalFocused } = useTerminalFocus()
    registerFocusedPane('pane-1')
    expect(terminalFocused.value).toBe(true)
  })

  it('stays true when one pane unregisters but another is still focused', () => {
    const { terminalFocused } = useTerminalFocus()
    registerFocusedPane('pane-1')
    registerFocusedPane('pane-2')
    unregisterFocusedPane('pane-1')
    expect(terminalFocused.value).toBe(true)
  })

  it('returns false again once all panes unregister', () => {
    const { terminalFocused } = useTerminalFocus()
    registerFocusedPane('pane-1')
    registerFocusedPane('pane-2')
    unregisterFocusedPane('pane-1')
    unregisterFocusedPane('pane-2')
    expect(terminalFocused.value).toBe(false)
  })

  it('unregistering an unknown pane is a no-op', () => {
    const { terminalFocused } = useTerminalFocus()
    registerFocusedPane('pane-1')
    unregisterFocusedPane('not-a-pane')
    expect(terminalFocused.value).toBe(true)
    // Converse check: unregister the only real pane and confirm we get false
    // back. If the bad unregister had accidentally ADDED 'not-a-pane' to the
    // Set, the size would still be 1 and this would fail.
    unregisterFocusedPane('pane-1')
    expect(terminalFocused.value).toBe(false)
  })

  it('idempotent re-registering the same pane does not duplicate it', () => {
    const { terminalFocused } = useTerminalFocus()
    registerFocusedPane('pane-1')
    registerFocusedPane('pane-1') // duplicate register
    unregisterFocusedPane('pane-1') // single unregister should be enough
    expect(terminalFocused.value).toBe(false)
  })
})
