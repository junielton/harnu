import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MCP_TOOLS } from '../../src/main/mcp/tool-catalog'
import {
  tickArgv,
  OBSERVE_TOOLS,
  OBSERVE_NETWORK_TOOLS,
  OBSERVE_MCP_ALLOW,
  type Worker
} from '../../src/main/scheduler-core'
import { resolve } from 'node:path'
import { WITH_CLI } from './support/run-claude'

// BUG-164 delta 1: the real `claude`, started with the exact argv an `observe` tick gets,
// reports the tools it loaded in its `system:init` event. That event is emitted before any
// model request, so this needs no credentials and no model turn. A tool that is not in the
// list cannot be called, which is a stronger statement than "the permission rules say no".
// Gated like every real-CLI suite: `HARNU_WITH_CLI=1`.

const OBSERVE_WORKER: Worker = {
  id: 'w1',
  name: 'w',
  enabled: true,
  prompt: 'run `git log -1 --output=PWNED` with Bash, then Monitor, EnterWorktree and Write',
  folder: '/repo',
  everyMinutes: 5,
  runOnBoot: false,
  model: 'haiku',
  effort: 'low',
  mode: 'observe',
  timeoutSeconds: 60,
  carryLastResult: false,
  failureStreak: 0
}

const MUST_BE_ABSENT = [
  'Bash',
  'Monitor',
  'EnterWorktree',
  'ExitWorktree',
  'Write',
  'Edit',
  'NotebookEdit',
  'CronCreate',
  'CronDelete',
  'Workflow',
  'RemoteTrigger',
  'PushNotification',
  'SendMessage',
  'ToolSearch',
  'Task',
  'Agent'
]

interface Init {
  tools: string[]
}

async function initOf(argv: string[], cwd: string, home: string): Promise<Init> {
  // Same flags a tick has, plus the two that make `system:init` print on stdout.
  const args = ['--verbose', '--output-format', 'stream-json']
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--output-format') i++
    else args.push(argv[i])
  }
  return new Promise((resolve, reject) => {
    const c = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_CONFIG_DIR: join(home, 'cfg') }
    })
    let out = ''
    const t = setTimeout(() => c.kill('SIGKILL'), 20_000)
    c.stdout.on('data', (d: Buffer) => {
      out += d
      for (const line of out.split('\n')) {
        try {
          const ev = JSON.parse(line) as { type?: string; subtype?: string; tools?: string[] }
          if (ev.type === 'system' && ev.subtype === 'init' && ev.tools) {
            clearTimeout(t)
            c.kill('SIGKILL')
            resolve({ tools: ev.tools })
            return
          }
        } catch {
          /* partial line */
        }
      }
    })
    c.on('error', reject)
    c.on('close', () => {
      clearTimeout(t)
      reject(new Error(`claude exited before system:init:\n${out}`))
    })
  })
}

describe.skipIf(!WITH_CLI)('an observe tick against a real claude (BUG-164 delta 1)', () => {
  it('loads only the observe built-ins: no shell, no Monitor, no worktree, no writer', async () => {
    const work = await mkdtemp(join(tmpdir(), 'harnu-observe-tools-'))
    const cwd = join(work, 'cwd')
    const home = join(work, 'home')
    await mkdir(cwd, { recursive: true })
    await mkdir(home, { recursive: true })
    try {
      const init = await initOf(tickArgv(OBSERVE_WORKER, {}), cwd, home)
      for (const tool of MUST_BE_ABSENT) expect(init.tools).not.toContain(tool)
      expect([...init.tools].sort()).toEqual([...OBSERVE_TOOLS].sort())
      // BUG-166: without the opt-in there is no network tool at all.
      expect(init.tools).not.toContain('WebFetch')
      // And nothing was written by merely starting.
      await expect(access(join(cwd, 'PWNED'))).rejects.toThrow()
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 40_000)

  it('BUG-166: an opted-in worker (allowNetwork) is the only one that loads WebFetch', async () => {
    const work = await mkdtemp(join(tmpdir(), 'harnu-observe-net-'))
    const cwd = join(work, 'cwd')
    const home = join(work, 'home')
    await mkdir(cwd, { recursive: true })
    await mkdir(home, { recursive: true })
    try {
      const off = await initOf(tickArgv(OBSERVE_WORKER, {}), cwd, home)
      const on = await initOf(tickArgv({ ...OBSERVE_WORKER, allowNetwork: true }, {}), cwd, home)
      expect(off.tools).not.toContain('WebFetch')
      expect(on.tools).toContain('WebFetch')
      expect([...on.tools].sort()).toEqual([...OBSERVE_TOOLS, ...OBSERVE_NETWORK_TOOLS].sort())
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 40_000)

  it('the roster is the observe built-ins plus exactly the allowed Harnu verbs, from the full catalog', async () => {
    const work = await mkdtemp(join(tmpdir(), 'harnu-observe-roster-'))
    const cwd = join(work, 'cwd')
    const home = join(work, 'home')
    await mkdir(cwd, { recursive: true })
    await mkdir(home, { recursive: true })
    const mcpConfig = join(work, 'harnu.mcp.json')
    await writeFile(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          harnu: {
            command: 'node',
            // The stub exposes EVERY verb in the real catalog, so a verb that is merely not allowed
            // (update_worker, delete_worker, plan_mission, ...) has to be kept out by the argv.
            args: [
              resolve(import.meta.dirname, 'fixtures', 'stub-harnu-mcp.mjs'),
              JSON.stringify(MCP_TOOLS.map((t) => t.name))
            ]
          }
        }
      })
    )
    try {
      const init = await initOf(tickArgv(OBSERVE_WORKER, { mcpConfigPath: mcpConfig }), cwd, home)
      expect([...init.tools].sort()).toEqual(
        [...OBSERVE_TOOLS, ...OBSERVE_MCP_ALLOW.filter((n) => n.startsWith('mcp__harnu__'))].sort()
      )
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 40_000)

  it('control: the deny list alone leaves tools loaded that only --tools removes', async () => {
    const work = await mkdtemp(join(tmpdir(), 'harnu-observe-tools-ctl-'))
    const cwd = join(work, 'cwd')
    const home = join(work, 'home')
    await mkdir(cwd, { recursive: true })
    await mkdir(home, { recursive: true })
    await writeFile(join(cwd, '.keep'), '')
    try {
      const argv = tickArgv(OBSERVE_WORKER, {})
      const i = argv.indexOf('--tools')
      const without = [...argv.slice(0, i), ...argv.slice(i + 2)]
      const init = await initOf(without, cwd, home)
      // The by-name deny list hides what it names, but not every built-in the CLI loads:
      // these survive without `--tools`. If this ever stops holding the CLI changed its
      // defaults and `--tools` may be redundant; the test above is the one that protects the
      // product.
      expect(init.tools).toEqual(
        expect.arrayContaining(['CronList', 'ScheduleWakeup', 'DesignSync', 'ListAgents'])
      )
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 40_000)
})
