#!/usr/bin/env node
// The `mod` step of local-pipeline.sh (P1W2 §7.9): validate and test the companion plugin with
// the installed `claude`, offline, in a temp copy. Exit codes: 0 pass or skipped, 1 fail,
// 3 blocked-by-policy (a failing step with its own state name, never a pass).

import { execFile } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  compareToManifest,
  compareToVersion,
  parseCliVersion,
  parseValidateNotes
} from './mod-step-core.mjs'
import { renderCoords } from './render-coords.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const EXIT = { pass: 0, skipped: 0, fail: 1, 'blocked-by-policy': 3 }
const POLICY = /hooks modules are turned off/i

function realExec(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 1 << 24, timeout: 120_000, ...opts },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') return rej(err)
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        res({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}

/**
 * @param {{ exec?: typeof realExec, skip?: boolean, root?: string }} [deps]
 * @returns {Promise<{ state: 'pass'|'fail'|'skipped'|'blocked-by-policy', exitCode: number, lines: string[] }>}
 */
export async function runModStep({ exec = realExec, skip = false, root = REPO } = {}) {
  const lines = []
  const done = (state) => ({ state, exitCode: EXIT[state], lines })
  const fail = (msg) => {
    lines.push(`mod: FAIL: ${msg}`)
    return done('fail')
  }
  if (skip) {
    lines.push('mod: skipped (--skip mod)')
    return done('skipped')
  }

  const src = join(root, 'resources', 'companion')
  const manifest = JSON.parse(await readFile(join(src, 'api-surface.json'), 'utf8'))
  const plugin = JSON.parse(await readFile(join(src, '.claude-plugin', 'plugin.json'), 'utf8'))

  // 1. the CLI: present, and not below the minimum
  let ver
  try {
    const r = await exec('claude', ['--version'])
    ver = parseCliVersion(r.stdout)
  } catch {
    return fail('`claude` not found on PATH (install Claude Code, or run with --skip mod)')
  }
  if (!ver) return fail('`claude --version` printed no version')
  lines.push(`mod: claude ${ver.raw}`)
  if (compareToVersion(ver.parts, manifest.minCli) < 0) {
    return fail(`claude ${ver.raw} is below the minimum ${manifest.minCli}`)
  }

  // 2. a temp copy with generated coordinates; hermetic HOME and config dir
  const work = await mkdtemp(join(tmpdir(), 'harnu-mod-'))
  try {
    const copy = join(work, 'harnu-companion')
    await cp(src, copy, {
      recursive: true,
      filter: (p) => !p.includes(`${join('.claude-plugin', 'types')}`)
    })
    await writeFile(
      join(copy, 'hooks', 'coords.gen.ts'),
      renderCoords({
        RENDEZVOUS_PATH: join(work, 'endpoint.json'),
        MOD_VERSION: plugin.version,
        STAGED_AT: 0
      })
    )
    const home = join(work, 'home')
    await mkdir(home, { recursive: true })
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude') }

    // 3. validate, passing the plugin.json path (a folder with a marketplace.json is read as one)
    const v = await exec(
      'claude',
      ['plugin', 'validate', join(copy, '.claude-plugin', 'plugin.json'), '--strict', '--json'],
      { env, cwd: work }
    )
    const text = `${v.stdout}\n${v.stderr}`
    if (POLICY.test(text)) {
      lines.push(`mod: blocked-by-policy: ${text.trim().split('\n').slice(0, 3).join(' | ')}`)
      return done('blocked-by-policy')
    }
    if (v.code !== 0)
      return fail(`claude plugin validate exited ${v.code}: ${text.trim().slice(0, 600)}`)
    let parsed
    try {
      parsed = parseValidateNotes(JSON.parse(v.stdout))
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }

    // 4. drift way 2: the validate notes against the checked-in manifest
    const drift = compareToManifest(parsed, manifest)
    if (drift.length) return fail(`api-surface.json drift:\n  ${drift.join('\n  ')}`)

    // 5. the plugin's own tests
    const t = await exec('claude', ['plugin', 'test', copy], { env, cwd: work })
    lines.push(t.stdout.trim())
    if (t.code !== 0)
      return fail(`claude plugin test exited ${t.code}: ${t.stderr.trim().slice(0, 600)}`)

    lines.push('mod: validate and test passed')
    return done('pass')
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runModStep({ skip: process.argv.includes('--skip') })
  console.log(result.lines.join('\n'))
  console.log(`mod: state=${result.state}`)
  process.exit(result.exitCode)
}
