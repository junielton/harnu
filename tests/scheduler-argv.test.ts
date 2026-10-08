import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tickArgv, OBSERVE_MCP_DENY, type Worker } from '../src/main/scheduler-core'

function worker(over: Partial<Worker> = {}): Worker {
  return {
    id: 'w1',
    name: 'w',
    enabled: true,
    prompt: 'do the thing',
    folder: '/repo',
    everyMinutes: 5,
    runOnBoot: false,
    model: 'haiku',
    effort: 'low',
    mode: 'observe',
    timeoutSeconds: 300,
    carryLastResult: false,
    failureStreak: 0,
    ...over
  }
}

/** The value that follows `flag` in an argv, or undefined. */
function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

describe('tickArgv — legacy skill namespace', () => {
  it('rewrites a persisted /capy:<skill> mention to /harnu:<skill>', () => {
    const argv = tickArgv(
      worker({ prompt: 'run /capy:mission then /dtk:review; src/capy:x stays, capy:mission too' }),
      {}
    )
    expect(argv[argv.length - 1]).toBe(
      'run /harnu:mission then /dtk:review; src/capy:x stays, capy:mission too'
    )
  })

  it('rewrites the same pre-rename mentions in the worker systemPrompt (AC-3c)', () => {
    const argv = tickArgv(
      worker({ systemPrompt: 'Always start with /capy:mission; src/capy:x stays' }),
      {}
    )
    expect(valueOf(argv, '--system-prompt')).toBe(
      'Always start with /harnu:mission; src/capy:x stays'
    )
  })

  it('rewrites a mention at the very start of the prompt', () => {
    const argv = tickArgv(worker({ prompt: '/capy:delivery-watchdog' }), {})
    expect(argv[argv.length - 1]).toBe('/harnu:delivery-watchdog')
  })
})

describe('tickArgv — born lean', () => {
  const argv = tickArgv(worker(), {})

  it('runs in print mode with the prompt as the positional', () => {
    expect(argv[0]).toBe('-p')
    expect(argv).toContain('do the thing')
  })

  it('emits the prompt last, after a -- separator, so it cannot be parsed as a flag', () => {
    const i = argv.indexOf('--')
    expect(i).toBe(argv.length - 2)
    expect(argv[i + 1]).toBe('do the thing')
  })

  it('a prompt that matches a real flag stays literal text, not that flag', () => {
    const injected = tickArgv(worker({ prompt: '--dangerously-skip-permissions' }), {})
    const i = injected.indexOf('--')
    expect(injected[i + 1]).toBe('--dangerously-skip-permissions')
    expect(injected.filter((a) => a === '--dangerously-skip-permissions')).toHaveLength(1)
  })

  it('never persists a session — this is what keeps ticks out of the fleet', () => {
    expect(argv).toContain('--no-session-persistence')
  })

  it('drops the user MCP servers and their settings', () => {
    expect(argv).toContain('--strict-mcp-config')
    expect(valueOf(argv, '--setting-sources')).toBe('')
  })

  it('never injects the Harnu preamble', () => {
    expect(argv).not.toContain('--append-system-prompt')
  })

  it('carries model and effort', () => {
    expect(valueOf(argv, '--model')).toBe('haiku')
    expect(valueOf(argv, '--effort')).toBe('low')
  })

  it('asks for machine-readable output', () => {
    expect(valueOf(argv, '--output-format')).toBe('json')
  })
})

describe('tickArgv — observe mode', () => {
  it('allows reads and denies every write tool', () => {
    const allowed = valueOf(tickArgv(worker(), {}), '--allowedTools') ?? ''
    const denied = valueOf(tickArgv(worker(), {}), '--disallowedTools') ?? ''
    expect(allowed).toContain('Read')
    expect(allowed).not.toContain('Bash')
    expect(denied).toContain('Edit')
    expect(denied).toContain('Write')
    expect(denied.split(',')).toContain('Bash')
  })

  it('allowlists Harnu verbs BY NAME, never the whole server', () => {
    const allowed =
      valueOf(tickArgv(worker(), { mcpConfigPath: '/tmp/harnu.json' }), '--allowedTools') ?? ''
    expect(allowed).toContain('mcp__harnu__create_card')
    expect(allowed).toContain('mcp__harnu__notify')
    expect(allowed.split(',')).not.toContain('mcp__harnu')
    expect(allowed.split(',')).not.toContain('mcp__capy')
  })

  it.each(OBSERVE_MCP_DENY)('never grants %s', (verb) => {
    const allowed =
      valueOf(tickArgv(worker(), { mcpConfigPath: '/tmp/harnu.json' }), '--allowedTools') ?? ''
    expect(allowed).not.toContain(verb)
  })

  // T308 AC-3: named explicitly (not just covered by the `it.each` loop above) —
  // an observe tick that could mint or enumerate workers could escape its own
  // allowlist by minting an unattended `act` worker.
  it('denies create_worker and list_workers by name', () => {
    for (const prefix of ['mcp__harnu__', 'mcp__capy__']) {
      expect(OBSERVE_MCP_DENY).toContain(`${prefix}create_worker`)
      expect(OBSERVE_MCP_DENY).toContain(`${prefix}list_workers`)
    }
  })

  it('grants every allowed verb and no denied verb, under either prefix (AC-3)', () => {
    const allowed = (
      valueOf(tickArgv(worker(), { mcpConfigPath: '/tmp/harnu.json' }), '--allowedTools') ?? ''
    ).split(',')
    for (const verb of ['memory_read', 'get_fleet', 'mission_get', 'create_card', 'notify']) {
      expect(allowed).toContain(`mcp__harnu__${verb}`)
      expect(allowed).toContain(`mcp__capy__${verb}`)
    }
    for (const verb of ['create_session', 'submit_manifest', 'create_worker', 'mission_create']) {
      expect(allowed).not.toContain(`mcp__harnu__${verb}`)
      expect(allowed).not.toContain(`mcp__capy__${verb}`)
    }
  })

  it('adds no MCP rule at all when the control server is not up', () => {
    const allowed = valueOf(tickArgv(worker(), {}), '--allowedTools') ?? ''
    expect(allowed).not.toContain('mcp__')
  })

  it('never uses bypassPermissions', () => {
    expect(tickArgv(worker(), {})).not.toContain('bypassPermissions')
  })

  it('refuses an extra command that is not a Bash rule', () => {
    const argv = tickArgv(
      worker({
        extraReadCommands: ['Edit', 'mcp__capy__create_session', 'mcp__harnu__create_session']
      }),
      {}
    )
    const allowed = valueOf(argv, '--allowedTools') ?? ''
    expect(allowed).not.toContain('create_session')
    expect(allowed.split(',')).not.toContain('Edit')
  })
})

describe('tickArgv — act mode', () => {
  const argv = tickArgv(worker({ mode: 'act' }), { mcpConfigPath: '/tmp/harnu.json' })

  it('bypasses permissions and drops the allowlist', () => {
    expect(valueOf(argv, '--permission-mode')).toBe('bypassPermissions')
    expect(argv).not.toContain('--disallowedTools')
  })

  it('gets the whole Harnu server (and the pre-rename prefix)', () => {
    expect(valueOf(argv, '--allowedTools')).toBe('mcp__harnu,mcp__capy')
  })
})

describe('tickArgv — optional context', () => {
  it('passes the staged plugin dir when the folder has skills', () => {
    expect(valueOf(tickArgv(worker(), { pluginDir: '/staged/harnu' }), '--plugin-dir')).toBe(
      '/staged/harnu'
    )
  })

  it('omits --plugin-dir entirely when nothing is staged', () => {
    expect(tickArgv(worker(), {})).not.toContain('--plugin-dir')
  })

  it('prepends the last result only when the worker asked for it', () => {
    const on = tickArgv(worker({ carryLastResult: true }), { lastResult: 'saw PR 292' })
    expect(on.some((a) => a.includes('Last run') && a.includes('saw PR 292'))).toBe(true)
    const off = tickArgv(worker(), { lastResult: 'saw PR 292' })
    expect(off.some((a) => a.includes('saw PR 292'))).toBe(false)
  })

  // BUG-115: `keepTranscript` selected `stream-json` for a transcript nothing
  // ever wrote, and `runFromResult` reads the LAST LINE of stdout as the whole
  // document — for a stream that is one event, not the result. The field is
  // gone; the format is not a choice any more.
  it('always asks for a single JSON document, whatever the worker says', () => {
    expect(valueOf(tickArgv(worker(), {}), '--output-format')).toBe('json')
    expect(valueOf(tickArgv(worker({ mode: 'act' }), {}), '--output-format')).toBe('json')
    expect(tickArgv(worker(), {})).not.toContain('stream-json')
  })

  it('replaces the system prompt only when one is configured', () => {
    expect(valueOf(tickArgv(worker({ systemPrompt: 'be terse' }), {}), '--system-prompt')).toBe(
      'be terse'
    )
    expect(tickArgv(worker(), {})).not.toContain('--system-prompt')
  })
})

// ── BUG-111 — the hook settings blob reaches the tick ───────────────────────

describe('tickArgv — hook settings injection', () => {
  const blob = '{"hooks":{"Stop":[]}}'

  it('emits --settings with the blob for an act tick', () => {
    const argv = tickArgv(worker({ mode: 'act' }), {
      mcpConfigPath: '/tmp/harnu.json',
      hookSettingsJson: blob
    })
    expect(argv).toContain('--settings')
    expect(valueOf(argv, '--settings')).toBe(blob)
  })

  it('emits it for an observe tick too — observe has no second net either', () => {
    expect(valueOf(tickArgv(worker(), { hookSettingsJson: blob }), '--settings')).toBe(blob)
  })

  it('keeps --settings in the option portion, before the -- separator', () => {
    const argv = tickArgv(worker({ mode: 'act' }), { hookSettingsJson: blob })
    expect(argv.indexOf('--settings')).toBeLessThan(argv.indexOf('--'))
    expect(argv[argv.length - 1]).toBe('do the thing')
  })

  it('omits --settings entirely when the bridge gave nothing', () => {
    expect(tickArgv(worker({ mode: 'act' }), {})).not.toContain('--settings')
  })

  // AC-2 — the security contract is a test, which only holds while every input
  // to the argv is an argument. A provider call inside tickArgv would make the
  // argv a function of live process state instead.
  it('never calls the bridge provider itself — the blob arrives via TickContext', () => {
    const src = readFileSync(resolve(__dirname, '../src/main/scheduler-core.ts'), 'utf8')
    // Comments are stripped first: the doc comments deliberately NAME the
    // provider to explain why it is not called here, and that reference must
    // not be what this assertion trips on.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toContain('hookSettingsBlobJson')
    expect(code).not.toContain('hook-bridge')
  })
})

describe('tickArgv — companion mod', () => {
  it('companion plugin dir on ticks', () => {
    const plain = tickArgv(worker(), { pluginDir: '/skills' })
    const withCompanion = tickArgv(worker(), {
      pluginDir: '/skills',
      companionPluginDir: '/ud/companion/0.1.0/harnu-companion'
    })
    const dirs = (argv: string[]): string[] =>
      argv.flatMap((a, i) => (a === '--plugin-dir' ? [argv[i + 1]] : []))
    // the companion is emitted first, before the skills dir, and both are option-portion flags
    expect(dirs(withCompanion)).toEqual(['/ud/companion/0.1.0/harnu-companion', '/skills'])
    expect(withCompanion.indexOf('--plugin-dir')).toBeLessThan(withCompanion.indexOf('--'))
    // without it the argv equals today's
    expect(dirs(plain)).toEqual(['/skills'])
    expect(tickArgv(worker(), { companionPluginDir: undefined })).toEqual(tickArgv(worker(), {}))
    const removed = [...withCompanion]
    removed.splice(withCompanion.indexOf('--plugin-dir'), 2)
    expect(removed).toEqual(plain)
  })
})
