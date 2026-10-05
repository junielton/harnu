import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runModStep } from '../scripts/ci/mod-step.mjs'

const recorded = readFileSync(
  new URL('./companion/fixtures/validate-skeleton.json', import.meta.url),
  'utf8'
)

type Result = { code: number; stdout: string; stderr: string }
type Exec = (cmd: string, args: string[]) => Promise<Result>

const ok = (stdout: string): Result => ({ code: 0, stdout, stderr: '' })

function fakeExec(over: { version?: Result | Error; validate?: Result; test?: Result }): {
  exec: Exec
  calls: string[][]
} {
  const calls: string[][] = []
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (args[0] === '--version') {
      if (over.version instanceof Error) throw over.version
      return over.version ?? ok('2.1.289 (Claude Code)\n')
    }
    if (args[0] === 'plugin' && args[1] === 'validate') return over.validate ?? ok(recorded)
    if (args[0] === 'plugin' && args[1] === 'test') return over.test ?? ok('1 pass\n0 fail\n')
    throw new Error(`unexpected: ${args.join(' ')}`)
  }
  return { exec, calls }
}

const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })

describe('mod step', () => {
  it('passes on a healthy skeleton and prints the CLI version', async () => {
    const { exec, calls } = fakeExec({})
    const r = await runModStep({ exec })
    expect(r.state).toBe('pass')
    expect(r.exitCode).toBe(0)
    expect(r.lines.join('\n')).toContain('claude 2.1.289 (Claude Code)')
    // validate ran against plugin.json (not the folder) with --strict --json
    const v = calls.find((c) => c[2] === 'validate')!
    expect(v[3]).toMatch(/\.claude-plugin\/plugin\.json$/)
    expect(v).toContain('--strict')
    expect(v).toContain('--json')
  })

  it('skip versus fail', async () => {
    // no claude on PATH
    const missing = await runModStep({ exec: fakeExec({ version: enoent }).exec })
    expect(missing.state).toBe('fail')
    expect(missing.exitCode).not.toBe(0)
    expect(missing.lines.join('\n')).toMatch(/claude.*not (found|on PATH)/i)

    // CLI below minCli
    const old = await runModStep({
      exec: fakeExec({ version: ok('2.1.286 (Claude Code)\n') }).exec
    })
    expect(old.state).toBe('fail')
    expect(old.lines.join('\n')).toContain('2.1.287')

    // managed policy turned hooks modules off: a distinct, failing state
    const blocked = await runModStep({
      exec: fakeExec({
        validate: { code: 1, stdout: '', stderr: 'hooks modules are turned off by policy' }
      }).exec
    })
    expect(blocked.state).toBe('blocked-by-policy')
    expect(blocked.exitCode).toBe(3)

    // --skip is the only bypass and is recorded as skipped, without running anything
    const { exec, calls } = fakeExec({})
    const skipped = await runModStep({ exec, skip: true })
    expect(skipped.state).toBe('skipped')
    expect(skipped.exitCode).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('fails when validate reports a marketplace, a non-zero exit or drift', async () => {
    const market = await runModStep({
      exec: fakeExec({ validate: ok(JSON.stringify({ success: true, contents: [] })) }).exec
    })
    expect(market.state).toBe('fail')
    expect(market.lines.join('\n')).toContain('validated as a marketplace')

    const bad = await runModStep({
      exec: fakeExec({ validate: { code: 1, stdout: '{"success":false}', stderr: 'nope' } }).exec
    })
    expect(bad.state).toBe('fail')

    const drift = JSON.parse(recorded)
    drift.contents[0].notes = [
      './register.ts hooks: session.start, session.end',
      './register.ts calls: nothing on $'
    ]
    const d = await runModStep({ exec: fakeExec({ validate: ok(JSON.stringify(drift)) }).exec })
    expect(d.state).toBe('fail')
    expect(d.lines.join('\n')).toContain('session.end')
  })

  it('fails when claude plugin test fails', async () => {
    const r = await runModStep({
      exec: fakeExec({ test: { code: 1, stdout: '(fail) x', stderr: '' } }).exec
    })
    expect(r.state).toBe('fail')
    expect(r.exitCode).toBe(1)
  })
})
