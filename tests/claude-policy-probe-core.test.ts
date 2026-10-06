import { describe, expect, it } from 'vitest'
import { classifyPolicyProbe } from '../src/main/claude-policy-probe-core'

// The lines below are the CLI's own text, read from the 2.1.290 binary and from a live
// `claude plugin test` run (docs/dev/companion-mod.md); they are the only basis of the mapping.
describe('classifyPolicyProbe', () => {
  it('mods load: the staged directory has no tests to run', () => {
    expect(
      classifyPolicyProbe(
        'claude plugin test: no *.test.ts or *.test.tsx under /ud/companion/0.1.0/x'
      )
    ).toBe('loads')
    expect(classifyPolicyProbe('3 passed')).toBe('loads')
  })

  it('off here: a setting or a policy, which the line cannot tell apart', () => {
    expect(
      classifyPolicyProbe(
        'claude plugin test: hooks modules are turned off here (disableAllHooks, allowManagedHooksOnly or a policy)'
      )
    ).toBe('off-here')
    expect(classifyPolicyProbe('hooks modules are switched off in this process')).toBe('off-here')
    expect(
      classifyPolicyProbe(
        'Safe mode: installed plugins are disabled, none of their hooks or hooks modules load; built-in plugins load regardless'
      )
    ).toBe('off-here')
    expect(
      classifyPolicyProbe(
        'hooks modules are turned off for installed plugins in this process: disableAllHooks in managed settings, which governs installed plugins'
      )
    ).toBe('off-here')
  })

  it('off remotely: the rollout flag or the CLI saying so', () => {
    expect(
      classifyPolicyProbe(
        "installed plugins' hooks modules not loaded: rollout flag (tengu_plugin_hooks_modules) is off"
      )
    ).toBe('off-remote')
    expect(
      classifyPolicyProbe(
        'hooks modules are turned off in this process: x. Start `claude` once with network access, then run the tests again; if this message returns, installed mods are turned off remotely.'
      )
    ).toBe('off-remote')
  })

  it('remote beats here when both words appear', () => {
    expect(
      classifyPolicyProbe(
        'hooks modules are turned off in this process: the rollout flag is off; installed mods are turned off remotely'
      )
    ).toBe('off-remote')
  })

  it('anything else is unknown, never a guess', () => {
    expect(classifyPolicyProbe('')).toBe('unknown')
    expect(classifyPolicyProbe('spawn claude ENOENT')).toBe('unknown')
    expect(classifyPolicyProbe('Segmentation fault')).toBe('unknown')
  })

  it('a long output is judged on its tail and never throws', () => {
    const noise = 'x'.repeat(100_000)
    expect(classifyPolicyProbe(noise)).toBe('unknown')
    expect(
      classifyPolicyProbe(noise + ' hooks modules are turned off here (disableAllHooks)')
    ).toBe('off-here')
  })
})
