import { describe, it, expect } from 'vitest'

/**
 * Guard suite for the `claudeSettings:patch` write allowlist (OSS-readiness
 * hardening). The renderer is sandboxed but untrusted; `~/.claude/settings.json`
 * holds command-executing (`hooks.*`, `statusLine.command`) and permission
 * subtrees that must never be writable from the GUI. These pin the predicate:
 * legitimate catalog fields pass, command/permission-bearing paths are rejected.
 */

import { ALLOWED_SETTINGS_PATHS, isAllowedSettingsPath } from '../src/main/claude-settings'

describe('isAllowedSettingsPath', () => {
  it('allows every field the GUI catalog manages', () => {
    for (const dotPath of [
      'model',
      'cleanupPeriodDays',
      'includeCoAuthoredBy',
      'permissions.defaultMode',
      'tui'
    ]) {
      expect(isAllowedSettingsPath(dotPath)).toBe(true)
    }
  })

  it('rejects command-bearing hooks paths', () => {
    expect(isAllowedSettingsPath('hooks.PreToolUse')).toBe(false)
    expect(isAllowedSettingsPath('hooks')).toBe(false)
    expect(isAllowedSettingsPath('hooks.PostToolUse.0.hooks.0.command')).toBe(false)
  })

  it('rejects statusLine command paths', () => {
    expect(isAllowedSettingsPath('statusLine')).toBe(false)
    expect(isAllowedSettingsPath('statusLine.command')).toBe(false)
  })

  it('rejects permission subtrees that are not the allowed nested field', () => {
    expect(isAllowedSettingsPath('permissions')).toBe(false)
    expect(isAllowedSettingsPath('permissions.allow')).toBe(false)
    expect(isAllowedSettingsPath('permissions.deny')).toBe(false)
    expect(isAllowedSettingsPath('permissions.ask')).toBe(false)
  })

  it('rejects arbitrary unknown paths (exact-match, no prefix matching)', () => {
    expect(isAllowedSettingsPath('model.command')).toBe(false)
    expect(isAllowedSettingsPath('env')).toBe(false)
    expect(isAllowedSettingsPath('')).toBe(false)
  })

  it('exposes the allowlist as a frozen-in-spirit set matching the catalog', () => {
    expect([...ALLOWED_SETTINGS_PATHS].sort()).toEqual(
      ['cleanupPeriodDays', 'includeCoAuthoredBy', 'model', 'permissions.defaultMode', 'tui'].sort()
    )
  })
})
