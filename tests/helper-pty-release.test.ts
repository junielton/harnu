/**
 * T479 (agent terminals B2) — AC-B2-8, the renderer half: an unload (or an explicit removal)
 * must not destroy a PTY main owns. An operator-opened shell is still destroyed, as before.
 */
import { describe, it, expect, vi } from 'vitest'
import { releaseHelperPty } from '../src/renderer/src/lib/helper-pty-release'

describe('releaseHelperPty', () => {
  it('an agent terminal: tells main its xterm is gone and does NOT destroy the PTY', () => {
    const api = { ptyDestroy: vi.fn(), terminalXtermGone: vi.fn() }
    releaseHelperPty({ ptyId: 'pty-1', terminalId: 'h-a' }, api)
    expect(api.ptyDestroy).not.toHaveBeenCalled()
    expect(api.terminalXtermGone).toHaveBeenCalledWith('h-a')
  })

  it('an operator-opened shell: destroyed on unload, as today', () => {
    const api = { ptyDestroy: vi.fn(), terminalXtermGone: vi.fn() }
    releaseHelperPty({ ptyId: 'pty-2' }, api)
    expect(api.ptyDestroy).toHaveBeenCalledWith('pty-2')
    expect(api.terminalXtermGone).not.toHaveBeenCalled()
  })
})
