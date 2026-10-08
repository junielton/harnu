import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { opinionArgv } from '../../src/main/gc/opinion-core'
import { WITH_CLI } from './support/run-claude'

// The advisor's session against the real CLI (T444 delta 3): the tool roster the model is offered is
// exactly Glob, Grep and Read. `--allowedTools`/`--disallowedTools` alone leave the built-ins
// (CronCreate, EnterWorktree, RemoteTrigger, SendMessage, ScheduleWakeup, …) in the roster; only
// `--tools` removes them. Hermetic like the other real-CLI suites: a temp HOME and config dir with no
// credentials, so no model request can succeed and no account-reaching tool is ever called. The
// roster is read from the `system/init` line, which the CLI prints before any model turn.
// Gated like every real-CLI suite: `HARNU_WITH_CLI=1`.

async function initTools(argv: string[]): Promise<string[]> {
  const work = await mkdtemp(join(tmpdir(), 'harnu-advisor-tools-'))
  try {
    for (const d of ['home', 'cfg', 'cwd']) await mkdir(join(work, d))
    const flags = argv.map((a) => (a === 'json' ? 'stream-json' : a))
    flags.push('--verbose')
    const out = await new Promise<string>((resolve) => {
      const child = spawn('claude', flags, {
        cwd: join(work, 'cwd'),
        env: {
          PATH: process.env.PATH ?? '',
          HOME: join(work, 'home'),
          CLAUDE_CONFIG_DIR: join(work, 'cfg')
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 25_000
      })
      let buf = ''
      child.stdout.on('data', (d: Buffer) => (buf += d.toString()))
      child.stdin.on('error', () => {})
      child.stdin.end('Reply OK.')
      child.on('close', () => resolve(buf))
      child.on('error', () => resolve(buf))
    })
    const line = out.split('\n').find((l) => l.includes('"subtype":"init"'))
    expect(line, 'the CLI printed no system/init line').toBeTruthy()
    return (JSON.parse(line as string) as { tools: string[] }).tools.slice().sort()
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

describe.skipIf(!WITH_CLI)('the advisor session against the real CLI', () => {
  it('is offered exactly Glob, Grep and Read', async () => {
    const tools = await initTools(opinionArgv({ model: 'haiku', effort: 'low' }))
    expect(tools).toEqual(['Glob', 'Grep', 'Read'])
  }, 40_000)

  it('without --tools the same permission rules leave the built-ins in the roster (why --tools exists)', async () => {
    const argv = opinionArgv({ model: 'haiku', effort: 'low' })
    const i = argv.indexOf('--tools')
    const without = [...argv.slice(0, i), ...argv.slice(i + 2)]
    const tools = await initTools(without)
    expect(tools).toContain('EnterWorktree')
    expect(tools.length).toBeGreaterThan(3)
  }, 40_000)
})
