import { beforeEach, describe, expect, it, vi } from 'vitest'
import { promisify } from 'node:util'

type Cb = (err: Error | null, out?: { stdout: string; stderr: string }) => void
const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[] }[],
  existing: new Set<string>(['/fake/bin/claude']) as Set<string>,
  impl: null as
    null | ((cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>)
}))

vi.mock('child_process', () => {
  const execFile = (() => {
    throw new Error('callback form is not used')
  }) as unknown as typeof import('child_process').execFile
  ;(execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    cmd: string,
    args: string[]
  ) => {
    h.calls.push({ cmd, args })
    return h.impl!(cmd, args)
  }
  return { execFile }
})
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  return { ...real, existsSync: (p: string) => h.existing.has(p) }
})

import {
  claudeVersionSync,
  clearClaudePathCache,
  resolveClaudePath,
  resolveClaudeVersion
} from '../src/main/claude-cli'

const versionCalls = (): number => h.calls.filter((c) => c.args[0] === '--version').length

function installFake(opts: { version?: string | Error; which?: string | null } = {}): void {
  h.impl = async (cmd, args) => {
    if (cmd === 'which' || cmd === 'where.exe') {
      if (opts.which === null) throw new Error('not found')
      return { stdout: `${opts.which ?? '/fake/bin/claude'}\n`, stderr: '' }
    }
    if (args[0] === '--version') {
      if (opts.version instanceof Error) throw opts.version
      return { stdout: opts.version ?? '2.1.289 (Claude Code)\n', stderr: '' }
    }
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`)
  }
}

beforeEach(() => {
  h.calls.length = 0
  h.existing = new Set(['/fake/bin/claude'])
  clearClaudePathCache()
  vi.restoreAllMocks()
})

describe('resolveClaudeVersion', () => {
  it('spawns the CLI once for repeated and concurrent calls', async () => {
    installFake()
    const [a, b] = await Promise.all([resolveClaudeVersion(), resolveClaudeVersion()])
    const c = await resolveClaudeVersion()
    expect(a?.patch).toBe(289)
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(versionCalls()).toBe(1)
  })

  it('passes a bounded, scrubbed probe to execFile', async () => {
    installFake()
    await resolveClaudeVersion()
    const call = h.calls.find((c) => c.args[0] === '--version')
    expect(call?.cmd).toBe('/fake/bin/claude')
  })

  it('caches null and spawns nothing when the path does not resolve', async () => {
    installFake({ which: null })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.existing.clear() // no install on disk either: tryCommonPaths finds nothing
    expect(await resolveClaudePath()).toBeNull()
    expect(await resolveClaudeVersion()).toBeNull()
    expect(versionCalls()).toBe(0)
  })

  it('a failing probe caches null and warns once across three calls', async () => {
    installFake({ version: new Error('boom') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveClaudeVersion()).toBeNull()
    expect(await resolveClaudeVersion()).toBeNull()
    expect(await resolveClaudeVersion()).toBeNull()
    expect(versionCalls()).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('[claude-cli] version probe failed')
  })

  it('unparseable stdout is a failure too', async () => {
    installFake({ version: '<html>shim banner</html>' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await resolveClaudeVersion()).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('never rejects', async () => {
    h.impl = async () => {
      throw new Error('everything fails')
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(resolveClaudeVersion()).resolves.toBeNull()
  })
})

describe('claudeVersionSync and the invalidation seam', () => {
  it('is null before any probe and never spawns', () => {
    installFake()
    expect(claudeVersionSync()).toBeNull()
    expect(h.calls).toHaveLength(0)
  })

  it('returns the cached value after a probe', async () => {
    installFake()
    await resolveClaudeVersion()
    expect(claudeVersionSync()?.patch).toBe(289)
  })

  it('clearClaudePathCache re-arms the version cache and the warning', async () => {
    installFake({ version: new Error('boom') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await resolveClaudeVersion()
    clearClaudePathCache()
    expect(claudeVersionSync()).toBeNull()
    installFake({ version: '2.1.290 (Claude Code)' })
    expect((await resolveClaudeVersion())?.patch).toBe(290)
    clearClaudePathCache()
    installFake({ version: new Error('again') })
    await resolveClaudeVersion()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(versionCalls()).toBe(3)
  })
})
