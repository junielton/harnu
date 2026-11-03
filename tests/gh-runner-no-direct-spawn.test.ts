/**
 * T611 U1 AC-1 — one shared `gh` runner. A grep-style gate: nothing in `src/main` may spawn `gh`
 * except `gh-runner.ts`, and the six known call sites must keep routing through it with a consumer
 * and a resource tag. A new direct `execFile('gh', …)` (or `run('gh', …)`, `spawn('gh', …)`) fails
 * here with its file:line, so the budget can never silently grow a blind spot.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'

const SRC = path.resolve(__dirname, '../src/main')
const RUNNER = path.join(SRC, 'gh-runner.ts')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

/** Strip `//` line comments and block comments so prose about `gh` is not a finding. */
function code(src: string): string[] {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
}

describe('no direct gh spawn outside the shared runner (AC-1)', () => {
  const files = walk(SRC).filter((f) => f !== RUNNER)

  it('finds no `gh` string literal handed to a spawner anywhere else in src/main', () => {
    const offenders: string[] = []
    for (const f of files) {
      code(readFileSync(f, 'utf8')).forEach((line, i) => {
        // 'gh' / "gh" / `gh` as an argument: execFile('gh', …), run('gh', …), spawn("gh", …), runFile('gh', …)
        if (/\(\s*['"`]gh['"`]\s*[,)]/.test(line)) {
          offenders.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(
      offenders,
      `route these through runGh() in gh-runner.ts:\n${offenders.join('\n')}`
    ).toEqual([])
  })

  it('each of the six known call sites imports runGh and tags consumer + resource', () => {
    const sites: Array<[string, RegExp]> = [
      ['pr-stack.ts', /consumer: 'pr-stack'|consumer,|consumer: 'missions'/],
      ['reaper/scanner-shell.ts', /consumer: 'cleanup'/],
      ['review-ipc.ts', /consumer: 'review'/],
      ['review-viewed-store.ts', /consumer: 'review'/],
      ['gc/gc-remote-shell.ts', /consumer: 'cleanup'/],
      ['merge-batch-ipc.ts', /consumer: 'merge-batch'/]
    ]
    for (const [rel, tag] of sites) {
      const src = readFileSync(path.join(SRC, rel), 'utf8')
      expect(src, `${rel} must import runGh`).toMatch(/\brunGh\b[\s\S]*gh-runner'/)
      expect(src, `${rel} must tag its consumer`).toMatch(tag)
      expect(src, `${rel} must tag its resource`).toMatch(/resource: /)
    }
  })

  it('the steward and the merge batch re-attribute the shared mission derive', () => {
    expect(readFileSync(path.join(SRC, 'steward-bridge.ts'), 'utf8')).toMatch(
      /withGhConsumer\('steward'/
    )
    expect(readFileSync(path.join(SRC, 'merge-batch-ipc.ts'), 'utf8')).toMatch(
      /withGhConsumer\('merge-batch'/
    )
  })

  it('the detector itself catches a direct spawn (so the gate cannot rot into a no-op)', () => {
    const bad = code("const out = await execFileAsync('gh', ['pr', 'list'])")
    expect(bad.some((l) => /\(\s*['"`]gh['"`]\s*[,)]/.test(l))).toBe(true)
    const prose = code("// 'gh' is the binary\n/* run('gh', x) */\nconst a = 1")
    expect(prose.some((l) => /\(\s*['"`]gh['"`]\s*[,)]/.test(l))).toBe(false)
  })
})
