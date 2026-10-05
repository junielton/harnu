import { describe, it, expect } from 'vitest'
import {
  buildHarnuMcpConfig,
  mcpConfigArgs,
  allowedToolsArgs,
  appManagedMcpArgs,
  orderMcpArgs,
  shouldInjectMcpConfig,
  ALLOWED_TOOLS_RULES,
  MCP_SERVER_NAME,
  LEGACY_MCP_SERVER_NAME,
  MCP_SERVER_NAMES,
  mcpToolName
} from '../src/main/mcp/config-file'

/**
 * T12 — the argv decision for wiring Capy's own MCP HTTP server into a spawned
 * `claude`. Pure builders extracted out of `pty.ts`. Two invariants are
 * load-bearing: (1) the app-managed `--mcp-config` MUST lead the user's
 * resolved Boot args so the user can never clobber it, and (2) we NEVER emit
 * `--strict-mcp-config` — a stray strict flag makes `claude` ignore the user's
 * own `.mcp.json` / `--mcp-config` servers, which we must not do.
 */
describe('buildHarnuMcpConfig', () => {
  it('builds the http server descriptor with a loopback url + bearer header', () => {
    expect(buildHarnuMcpConfig({ port: 51789, token: 'sek' })).toEqual({
      mcpServers: {
        harnu: {
          type: 'http',
          url: 'http://127.0.0.1:51789/mcp',
          headers: { Authorization: 'Bearer sek' }
        }
      }
    })
  })

  it('interpolates the given port + token verbatim', () => {
    const cfg = buildHarnuMcpConfig({ port: 1234, token: 'abc-DEF.123' })
    expect(cfg.mcpServers.harnu.url).toBe('http://127.0.0.1:1234/mcp')
    expect(cfg.mcpServers.harnu.headers.Authorization).toBe('Bearer abc-DEF.123')
    expect(cfg.mcpServers.harnu.type).toBe('http')
  })
})

describe('server name constants', () => {
  it('registers as harnu; capy is only the recognized legacy name', () => {
    expect(MCP_SERVER_NAME).toBe('harnu')
    expect(LEGACY_MCP_SERVER_NAME).toBe('capy')
    expect(MCP_SERVER_NAMES).toEqual(['harnu', 'capy'])
  })

  it('builds mcp__<server>__<verb> tool names, defaulting to the current server', () => {
    expect(mcpToolName('get_fleet')).toBe('mcp__harnu__get_fleet')
    expect(mcpToolName('get_fleet', 'capy')).toBe('mcp__capy__get_fleet')
  })

  it('never registers the legacy name in the generated config', () => {
    const cfg = buildHarnuMcpConfig({ port: 1, token: 't' })
    expect(Object.keys(cfg.mcpServers)).toEqual(['harnu'])
  })
})

describe('mcpConfigArgs', () => {
  it('returns the --mcp-config flag + path pair', () => {
    expect(mcpConfigArgs('/tmp/harnu-mcp.json')).toEqual(['--mcp-config', '/tmp/harnu-mcp.json'])
  })
})

describe('allowedToolsArgs', () => {
  it('returns the --allowedTools server-level allow rules, BOTH prefixes in one value', () => {
    // One comma-joined value: the option is variadic, a second bare value could
    // swallow a following positional.
    expect(allowedToolsArgs()).toEqual(['--allowedTools', 'mcp__harnu,mcp__capy'])
  })

  it('uses the bare server prefix (matches every verb), not a per-verb rule', () => {
    // `mcp__harnu` (no `__<verb>` suffix) is the whole-server allow rule; the
    // pre-rename `mcp__capy` rides along so old sessions keep auto-allowing.
    expect(ALLOWED_TOOLS_RULES).toEqual(['mcp__harnu', 'mcp__capy'])
    for (const rule of allowedToolsArgs()[1].split(',')) expect(rule).not.toMatch(/__.+__/)
  })
})

describe('appManagedMcpArgs', () => {
  it('returns nothing when disabled', () => {
    expect(appManagedMcpArgs(false, '/tmp/harnu-mcp.json')).toEqual([])
  })

  it('returns the --mcp-config pair PLUS the --allowedTools allow rule when enabled', () => {
    expect(appManagedMcpArgs(true, '/tmp/harnu-mcp.json')).toEqual([
      '--mcp-config',
      '/tmp/harnu-mcp.json',
      '--allowedTools',
      'mcp__harnu,mcp__capy'
    ])
  })

  it('NEVER emits --strict-mcp-config (would nuke the user own MCP servers)', () => {
    expect(appManagedMcpArgs(true, '/tmp/harnu-mcp.json')).not.toContain('--strict-mcp-config')
    expect(appManagedMcpArgs(false, '/tmp/harnu-mcp.json')).not.toContain('--strict-mcp-config')
  })
})

describe('orderMcpArgs', () => {
  it('places the app-managed mcp args BEFORE the user resolveClaudeBootArgs args', () => {
    const app = appManagedMcpArgs(true, '/tmp/harnu-mcp.json')
    // a realistic resolveClaudeBootArgs output: app base + user Boot flags
    const userArgs = ['--resume', 'u1', '--model', 'opus', '--mcp-config', '/home/u/.mcp.json']
    const ordered = orderMcpArgs(app, userArgs)

    expect(ordered).toEqual([
      '--mcp-config',
      '/tmp/harnu-mcp.json',
      '--allowedTools',
      'mcp__harnu,mcp__capy',
      '--resume',
      'u1',
      '--model',
      'opus',
      '--mcp-config',
      '/home/u/.mcp.json'
    ])
    // app --mcp-config leads the user's --mcp-config (can never be buried)
    expect(ordered.indexOf('/tmp/harnu-mcp.json')).toBeLessThan(
      ordered.indexOf('/home/u/.mcp.json')
    )
  })

  it('composes ADDITIVELY with a user --allowedTools (a distinct occurrence, never a replace)', () => {
    // `claude`'s variadic `--allowedTools` unions all occurrences, so the argv must
    // keep BOTH Harnu's `mcp__harnu,mcp__capy` rule and the user's own tools present.
    const app = appManagedMcpArgs(true, '/tmp/harnu-mcp.json')
    const userArgs = ['--allowedTools', 'Bash(git *)', 'Edit', '--model', 'opus']
    const ordered = orderMcpArgs(app, userArgs)
    // Two distinct --allowedTools occurrences survive (Capy's + the user's).
    expect(ordered.filter((a) => a === '--allowedTools')).toHaveLength(2)
    expect(ordered).toContain('mcp__harnu,mcp__capy')
    expect(ordered).toContain('Bash(git *)')
    expect(ordered).toContain('Edit')
  })

  it('is a no-op prefix when the app arg is empty (disabled)', () => {
    const userArgs = ['--resume', 'u1']
    expect(orderMcpArgs(appManagedMcpArgs(false, '/x'), userArgs)).toEqual(['--resume', 'u1'])
  })

  it('never introduces --strict-mcp-config into the merged argv', () => {
    const ordered = orderMcpArgs(appManagedMcpArgs(true, '/x'), ['--mcp-config', '/y'])
    expect(ordered).not.toContain('--strict-mcp-config')
  })
})

/**
 * BUG-32 / T123 §3.1 AC14 — the spawn-time gate that decides whether
 * `appManagedMcpArgs` is even called with `enabled: true`. All three inputs
 * must hold; any single `false` withholds the injection so a spawn/resume in
 * the control-server-off (or config-file-absent) gap never gets a
 * `--mcp-config` pointing at nothing.
 */
describe('shouldInjectMcpConfig', () => {
  it('is true only when the server is running, auto-register is on, AND the file exists', () => {
    expect(shouldInjectMcpConfig(true, true, true)).toBe(true)
  })

  it('is false when the server is not running (control server off)', () => {
    expect(shouldInjectMcpConfig(false, true, true)).toBe(false)
  })

  it('is false when auto-register is opted out (T93)', () => {
    expect(shouldInjectMcpConfig(true, false, true)).toBe(false)
  })

  it('is false when the config file is absent at spawn time (BUG-32 toggle race)', () => {
    expect(shouldInjectMcpConfig(true, true, false)).toBe(false)
  })

  it('is false when every input is false', () => {
    expect(shouldInjectMcpConfig(false, false, false)).toBe(false)
  })

  it('composes with appManagedMcpArgs to omit the flag entirely when the file is missing', () => {
    const enabled = shouldInjectMcpConfig(true, true, false)
    expect(appManagedMcpArgs(enabled, '/tmp/harnu-mcp.json')).toEqual([])
  })
})
