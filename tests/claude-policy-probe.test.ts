import { describe, expect, it, vi } from 'vitest'
import { createPolicyProbe } from '../src/main/claude-policy-probe'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/nowhere' } }))

const off =
  'claude plugin test: hooks modules are turned off here (disableAllHooks, allowManagedHooksOnly or a policy)'

function probe(over: Partial<Parameters<typeof createPolicyProbe>[0]> = {}) {
  const run = vi.fn(async () => off)
  const p = createPolicyProbe({
    stagedDir: () => '/ud/companion/0.1.0/harnu-companion',
    binary: async () => '/bin/claude',
    versionKey: () => '2.1.290',
    run,
    ...over
  })
  return { p, run }
}

describe('createPolicyProbe', () => {
  it('runs `claude plugin test <staged dir>` once per binary and boot, and classifies', async () => {
    const { p, run } = probe()
    expect(p.result()).toBeNull()
    expect(await p.ensure()).toBe('off-here')
    expect(await p.ensure()).toBe('off-here')
    await Promise.all([p.ensure(), p.ensure()])
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith('/bin/claude', [
      'plugin',
      'test',
      '/ud/companion/0.1.0/harnu-companion'
    ])
    expect(p.runs()).toBe(1)
    expect(p.result()).toBe('off-here')
  })

  it('a different binary or version probes again', async () => {
    let v = '2.1.290'
    const { p, run } = probe({ versionKey: () => v })
    await p.ensure()
    v = '2.1.291'
    await p.ensure()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does nothing without a staged directory or a binary', async () => {
    const a = probe({ stagedDir: () => null })
    expect(await a.p.ensure()).toBeNull()
    const b = probe({ binary: async () => null })
    expect(await b.p.ensure()).toBeNull()
    expect(a.run).not.toHaveBeenCalled()
    expect(b.run).not.toHaveBeenCalled()
  })

  it('a throwing run reads unknown, and is not retried', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn failed')
    })
    const { p } = probe({ run })
    expect(await p.ensure()).toBe('unknown')
    expect(await p.ensure()).toBe('unknown')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('logs the class and never the output', async () => {
    const log = vi.fn()
    const { p } = probe({ log })
    await p.ensure()
    expect(log).toHaveBeenCalledWith('[companion] policy probe: off-here')
    expect(JSON.stringify(log.mock.calls)).not.toContain('disableAllHooks')
  })
})
