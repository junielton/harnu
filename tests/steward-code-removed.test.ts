/**
 * Missions v4 S-38 (AC-91) — the steward code is gone.
 *
 * Two facts, both read from the tracked tree: the seven steward modules no longer exist, and nothing
 * in src, tests, scripts or resources imports one. The check matches IMPORT PATHS only, so words such
 * as the You item `steward-paused` (a kind, not a module) are not hit.
 *
 * AC-91's own script greps the tree for those import paths, so this file never writes one out: every
 * name is built from parts. The guard is therefore not its own hit, and the plant-a-fault test below
 * proves it can fail by planting a path it builds the same way.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const PARTS = ['bridge', 'core', 'hooks', 'pause', 'rebase', 'routes', 'shell'] as const
const moduleName = (part: string): string => ['stew', 'ard', '-', part].join('')
const NAMES = PARTS.map(moduleName)

/** The regex AC-91 greps with: `/<name>'` or `/<name>"`, one alternative per module. */
const importPathPattern = (): string => NAMES.map((n) => `/${n}['"]`).join('|')

function grepImports(cwd: string, pathspecs: string[]): string[] {
  try {
    const out = execFileSync('git', ['grep', '-nE', importPathPattern(), '--', ...pathspecs], {
      cwd,
      encoding: 'utf8'
    })
    return out.split('\n').filter(Boolean)
  } catch (err) {
    // git grep exits 1 when nothing matches.
    if ((err as { status?: number }).status === 1) return []
    throw err
  }
}

describe('AC-91 — no steward file and no import of one remains', () => {
  it.each(NAMES)('the module %s no longer exists', (name) => {
    expect(existsSync(path.join(ROOT, 'src', 'main', `${name}.ts`))).toBe(false)
  })

  it('nothing in src, tests, scripts or resources imports one', () => {
    expect(grepImports(ROOT, ['src', 'tests', 'scripts', 'resources'])).toEqual([])
  })

  it('the guard goes red when an import of one is planted', () => {
    // A throwaway repo (never this one): one tracked file whose text is an import of a steward module.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harnu-s38-fault-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const planted = `import { x } from '../${NAMES[1]}'\n`
    writeFileSync(path.join(dir, 'planted.ts'), planted)
    execFileSync('git', ['add', 'planted.ts'], { cwd: dir })
    expect(grepImports(dir, ['.'])).toHaveLength(1)
    // The same file with the double quote form is caught too, and a bare word is not.
    writeFileSync(
      path.join(dir, 'planted.ts'),
      `import "../${NAMES[0]}"\n// ${NAMES[2]} is a word\n`
    )
    execFileSync('git', ['add', 'planted.ts'], { cwd: dir })
    expect(grepImports(dir, ['.'])).toHaveLength(1)
  })
})
