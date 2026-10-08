import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  tickArgv,
  partitionExtraReadCommands,
  OBSERVE_TOOLS,
  OBSERVE_TOOLS_DENY,
  OBSERVE_MCP_ALLOW,
  OBSERVE_MCP_DENY,
  type Worker
} from '../src/main/scheduler-core'

// BUG-164 — the `observe` allowlist granted `Bash(git log:*)` / `Bash(git diff:*)` /
// `Bash(git show:*)`. A prefix rule cannot say "no --output anywhere in the command",
// and git's `--output=<path>` writes an arbitrary file. Chain: a commit message
// written over `.git/config` sets `core.fsmonitor`, and the next `git status` runs it.
// The fix is structural: an observe tick has no shell at all. These tests pin that.

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

function valueOf(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
}

const rulesOf = (csv: string | undefined): string[] => (csv ?? '').split(',').filter(Boolean)

/**
 * A minimal model of Claude Code's permission matcher for one tool call: deny rules win,
 * a bare `Tool` rule matches every call of that tool, `Tool(prefix:*)` matches a command
 * that starts with the prefix, and `Tool(exact)` matches that exact command.
 */
function permits(argv: string[], tool: string, command: string): boolean {
  const matches = (rule: string): boolean => {
    if (rule === tool) return true
    const m = new RegExp(`^${tool}\\((.*)\\)$`).exec(rule)
    if (!m) return false
    const body = m[1]
    return body.endsWith(':*') ? command.startsWith(body.slice(0, -2)) : command === body
  }
  if (rulesOf(valueOf(argv, '--disallowedTools')).some(matches)) return false
  return rulesOf(valueOf(argv, '--allowedTools')).some(matches)
}

const ATTACKS = [
  // The proven chain: write a controlled commit message over the git config.
  'git log -1 --format=%B --output=/repo/.git/config',
  'git diff --output=/repo/README.md',
  'git show --output=/tmp/pwned HEAD',
  // The follow-up that would run the planted core.fsmonitor.
  'git status',
  // Network reads that take flags.
  'gh pr view 1',
  'gh run list'
]

describe('BUG-164 — an observe tick has no shell', () => {
  it('pins the exact native allowlist', () => {
    expect(OBSERVE_TOOLS).toEqual(['Read', 'Grep', 'Glob', 'Skill'])
  })

  it('pins the exact native deny list, with Bash on it', () => {
    expect(OBSERVE_TOOLS_DENY).toEqual([
      'Edit',
      'Write',
      'NotebookEdit',
      'Task',
      'Agent',
      'Bash',
      'Monitor',
      'EnterWorktree',
      'ExitWorktree',
      'CronCreate',
      'CronDelete',
      'Workflow',
      'RemoteTrigger',
      'PushNotification',
      'SendMessage',
      'ToolSearch'
    ])
  })

  it('emits no Bash( rule anywhere in the observe argv', () => {
    const argv = tickArgv(worker(), { mcpConfigPath: '/tmp/harnu.json' })
    expect(argv.join(' ')).not.toContain('Bash(')
    expect(rulesOf(valueOf(argv, '--allowedTools')).some((r) => r.startsWith('Bash'))).toBe(false)
  })

  it('denies the bare Bash tool', () => {
    const argv = tickArgv(worker(), {})
    expect(rulesOf(valueOf(argv, '--disallowedTools'))).toContain('Bash')
  })

  it.each(ATTACKS)('denies `%s`', (command) => {
    const argv = tickArgv(worker(), { mcpConfigPath: '/tmp/harnu.json' })
    expect(permits(argv, 'Bash', command)).toBe(false)
  })

  it('sanity: the matcher would have allowed the --output attack against the old rules', () => {
    const old = [
      '--allowedTools',
      'Read,Bash(git log:*),Bash(git diff:*),Bash(git show:*),Bash(git status:*)'
    ]
    expect(permits(old, 'Bash', ATTACKS[0])).toBe(true)
    expect(permits(old, 'Bash', ATTACKS[1])).toBe(true)
  })

  it('stays shell-free when the operator saved extra read commands (including legacy ones)', () => {
    const extra = ['Bash(git ls-files:*)', 'Bash(git status)', 'Bash(cat:*)', 'Bash(jj log:*)']
    const argv = tickArgv(worker({ extraReadCommands: extra }), {
      mcpConfigPath: '/tmp/harnu.json'
    })
    expect(argv.join(' ')).not.toContain('Bash(')
    for (const rule of extra) expect(valueOf(argv, '--allowedTools')).not.toContain(rule)
    expect(permits(argv, 'Bash', 'cat /etc/passwd')).toBe(false)
  })

  it('refuses every extra read command, so the Runs tab shows the refusal', () => {
    const extra = ['Bash(git status)', 'Bash(ls)', 'Bash(rm -rf /)']
    expect(partitionExtraReadCommands(extra)).toEqual({ accepted: [], rejected: extra })
    expect(partitionExtraReadCommands(undefined)).toEqual({ accepted: [], rejected: [] })
  })

  it('keeps the file readers observe still needs', () => {
    const allowed = rulesOf(valueOf(tickArgv(worker(), {}), '--allowedTools'))
    for (const tool of ['Read', 'Grep', 'Glob']) expect(allowed).toContain(tool)
  })
})

// Delta 1: a deny/allow list only gates tools the CLI has loaded. Without `--tools` the CLI
// still loaded Monitor (a shell by another name), EnterWorktree (`git worktree add`, which
// fires post-checkout hooks), the Cron*/Workflow/RemoteTrigger family, SendMessage and
// ToolSearch, all outside the `Bash` deny. `--tools` makes the built-in set an allowlist.
describe('BUG-164 delta 1 — the built-in tool set is an allowlist (--tools)', () => {
  const BUILTINS_WE_REFUSE = [
    'Bash',
    'Monitor',
    'EnterWorktree',
    'ExitWorktree',
    'CronCreate',
    'CronDelete',
    'CronList',
    'ScheduleWakeup',
    'Workflow',
    'RemoteTrigger',
    'PushNotification',
    'SendMessage',
    'ListAgents',
    'DesignSync',
    'TaskStop',
    'ToolSearch',
    'Edit',
    'Write',
    'NotebookEdit',
    'Task',
    'Agent',
    'WebSearch'
  ]

  it('passes --tools with exactly the observe built-ins', () => {
    const argv = tickArgv(worker(), { mcpConfigPath: '/tmp/harnu.json' })
    expect(valueOf(argv, '--tools')).toBe(OBSERVE_TOOLS.join(','))
  })

  it('--tools is set whether or not the control server is up, and before the -- separator', () => {
    const argv = tickArgv(worker(), {})
    expect(argv).toContain('--tools')
    expect(argv.indexOf('--tools')).toBeLessThan(argv.indexOf('--'))
  })

  it.each(BUILTINS_WE_REFUSE)('does not make %s available', (tool) => {
    const argv = tickArgv(worker(), { mcpConfigPath: '/tmp/harnu.json' })
    expect(rulesOf(valueOf(argv, '--tools'))).not.toContain(tool)
    expect(rulesOf(valueOf(argv, '--allowedTools'))).not.toContain(tool)
  })

  // `--tools` is the control; the deny list is the second net. It names the tools found loaded
  // and callable in a tick (Monitor, EnterWorktree) and the families around them, not every
  // built-in: the rest are absent because `--tools` never loads them.
  it('also denies the dangerous ones by name (defence in depth)', () => {
    const denied = rulesOf(valueOf(tickArgv(worker(), {}), '--disallowedTools'))
    for (const tool of [
      'Bash',
      'Monitor',
      'EnterWorktree',
      'ExitWorktree',
      'CronCreate',
      'CronDelete',
      'Workflow',
      'RemoteTrigger',
      'PushNotification',
      'SendMessage',
      'ToolSearch',
      'Task',
      'Agent',
      'NotebookEdit',
      'Edit',
      'Write'
    ])
      expect(denied).toContain(tool)
  })

  it('every native allow rule is also in --tools, so an allow rule never names an absent tool', () => {
    const argv = tickArgv(worker(), { mcpConfigPath: '/tmp/harnu.json' })
    const native = rulesOf(valueOf(argv, '--allowedTools')).filter((r) => !r.startsWith('mcp__'))
    expect(native.sort()).toEqual(rulesOf(valueOf(argv, '--tools')).sort())
  })

  // The CLI lists every verb of the connected server in its roster, allowed or not; a verb that
  // is merely not allowed is refused only when called. Denying them by name takes them out of
  // the roster, so the roster an observe tick sees is the allowed verbs and nothing else.
  it('denies every non-allowed Harnu verb by name when the control server is up', () => {
    const argv = tickArgv(worker(), { mcpConfigPath: '/tmp/harnu.json' })
    const denied = rulesOf(valueOf(argv, '--disallowedTools'))
    for (const verb of OBSERVE_MCP_DENY) expect(denied).toContain(verb)
    for (const verb of OBSERVE_MCP_ALLOW) expect(denied).not.toContain(verb)
  })

  it('adds no MCP deny rule when the control server is down', () => {
    expect(valueOf(tickArgv(worker(), {}), '--disallowedTools')).not.toContain('mcp__')
  })

  it('leaves act mode alone: no --tools restriction', () => {
    expect(tickArgv(worker({ mode: 'act' }), { mcpConfigPath: '/tmp/harnu.json' })).not.toContain(
      '--tools'
    )
  })
})

describe('BUG-164 — nothing observe-reachable tells a tick to run git or gh', () => {
  const watchdog = readFileSync(
    resolve(__dirname, '../resources/skills/skills/delivery-watchdog/SKILL.md'),
    'utf8'
  )

  it('the delivery-watchdog skill (an observe-mode skill) names no git or gh command', () => {
    expect(watchdog).not.toMatch(/`git (log|status|diff|show|rev-list)/)
    expect(watchdog).not.toMatch(/`gh (pr|run)/)
    expect(watchdog).not.toContain('read-only shell')
  })

  it('points the watchdog at the MCP reads it already has', () => {
    for (const verb of ['mission_get', 'list_worktrees']) expect(watchdog).toContain(verb)
  })
})
