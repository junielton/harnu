/**
 * BUG-266 AC-2 — one spawn runner. `child_process.spawn()` is a `fork()` of the calling process, so
 * every child Harnu starts for git, gh, docker or `claude -p` is handed to the spawn helper by
 * `spawn-runner.ts`, never forked by the main thread. A grep-style gate: nothing in `src/main` may import
 * `child_process` except the runner and the helper script it talks to. A new direct `execFile`/`spawn` fails
 * here with its file:line. (node-pty, the PTY path, is not `child_process` and is out of scope: T696.)
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'src/main')
const ALLOWED = new Set(['spawn-runner.ts', 'spawn-helper.ts'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

/** Strip block and `//` comments so prose about `child_process` is not a finding. */
function code(src: string): string[] {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
}

const IMPORTS_CHILD_PROCESS =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"`](?:node:)?child_process['"`]/

describe('no direct child_process outside the spawn runner (AC-2)', () => {
  it('imports child_process nowhere in src/main except the runner and its helper script', () => {
    const offenders: string[] = []
    for (const f of walk(SRC)) {
      if (ALLOWED.has(path.relative(SRC, f))) continue
      code(readFileSync(f, 'utf8')).forEach((line, i) => {
        if (IMPORTS_CHILD_PROCESS.test(line)) {
          offenders.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`)
        }
      })
    }
    expect(
      offenders,
      `run these through runFile()/spawnChild() in spawn-runner.ts:\n${offenders.join('\n')}`
    ).toEqual([])
  })

  it('the detector catches every import form (so the gate cannot rot into a no-op)', () => {
    for (const bad of [
      "import { execFile } from 'node:child_process'",
      "import { spawn } from 'child_process'",
      "const { execFile } = await import('node:child_process')",
      "const cp = require('child_process')"
    ]) {
      expect(
        code(bad).some((l) => IMPORTS_CHILD_PROCESS.test(l)),
        bad
      ).toBe(true)
    }
    expect(
      code("// import { spawn } from 'node:child_process'\n/* child_process */").some((l) =>
        IMPORTS_CHILD_PROCESS.test(l)
      )
    ).toBe(false)
  })

  it('the helper stays one self-contained script: only type imports from its own folder', () => {
    const helper = readFileSync(path.join(SRC, 'spawn-helper.ts'), 'utf8')
    const local = code(helper).filter((l) => /^\s*import\s/.test(l) && /from\s+['"]\./.test(l))
    expect(local.length).toBeGreaterThan(0)
    for (const l of local)
      expect(l, 'a runtime import would split the helper into chunks').toMatch(/^\s*import type /)
  })

  it('electron-vite builds the helper as its own main entry, and the app starts the runner at boot', () => {
    expect(readFileSync(path.join(ROOT, 'electron.vite.config.ts'), 'utf8')).toMatch(
      /'spawn-helper':\s*resolve\('src\/main\/spawn-helper\.ts'\)/
    )
    const index = readFileSync(path.join(SRC, 'index.ts'), 'utf8')
    expect(index).toMatch(/startSpawnRunner\(/)
    expect(index).toMatch(/utilityProcess\.fork\(join\(__dirname, 'spawn-helper\.js'\)/)
  })
})
