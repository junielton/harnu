/**
 * Missions v4 S-39 (AC-92) — the campaign code and the campaign verbs are gone.
 *
 * Four facts, all read from the tree of whichever checkout runs the test:
 *  1. the two campaign modules no longer exist;
 *  2. the strings AC-92 greps for (the two module names and a catalog entry's `name:` of a campaign verb)
 *     appear nowhere under src, tests, scripts or resources;
 *  3. the MCP catalog registers none of the six campaign verbs, and the handler table has no entry for one;
 *  4. a throwaway repo with each string planted makes the same grep find it (the guard can fail).
 *
 * AC-92's own script greps for those strings, so this file never writes one out: every name is built
 * from parts, so the guard is not its own hit.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import { WIRED_TOOLS } from '../src/main/mcp/tool-handlers'

const ROOT = path.resolve(__dirname, '..')

const MODULES = ['core', 'progress'].map((part) => ['campaign', part].join('-'))
const VERBS = ['create', 'add_chapter', 'get', 'list', 'request_close', 'transfer_owner'].map(
  (tail) => ['campaign', tail].join('_')
)
/** The catalog line shape AC-92 greps: the key, a colon, a quote, then the verb prefix. */
const catalogNameStart = (): string => 'name: ' + "'" + ['campaign', ''].join('_')

/** What AC-92 greps with: each string is one `-e`, so the union of the three. */
const grepArgs = (): string[] => [...MODULES.flatMap((m) => ['-e', m]), '-e', catalogNameStart()]

function grep(cwd: string, pathspecs: string[]): string[] {
  try {
    const out = execFileSync('git', ['grep', '-nF', ...grepArgs(), '--', ...pathspecs], {
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

describe('AC-92 — no campaign module, no campaign verb, no name of either remains', () => {
  it.each(MODULES)('the module %s no longer exists', (name) => {
    expect(existsSync(path.join(ROOT, 'src', 'main', `${name}.ts`))).toBe(false)
  })

  it('nothing under src, tests, scripts or resources names a campaign module or a catalog entry of a campaign verb', () => {
    expect(grep(ROOT, ['src', 'tests', 'scripts', 'resources'])).toEqual([])
  })

  it.each(VERBS)('the catalog does not list %s', (verb) => {
    expect(MCP_TOOLS.map((t) => t.name)).not.toContain(verb)
    expect(MCP_TOOLS.map((t) => t.op as string)).not.toContain(verb)
  })

  it('the wired tools (catalog plus handler) carry no campaign verb', () => {
    const names = WIRED_TOOLS.map((t) => t.name as string)
    expect(names.filter((n) => n.startsWith(['campaign', ''].join('_')))).toEqual([])
    for (const t of WIRED_TOOLS) expect(typeof t.handler).toBe('function')
  })

  it('the guard goes red when each string is planted in a throwaway repo', () => {
    // A throwaway repo (never this one): one tracked file per planted string.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'harnu-s39-fault-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    const planted: Record<string, string> = {
      'a.ts': `import { x } from '../${MODULES[0]}'\n`,
      'b.ts': `import { y } from '../${MODULES[1]}'\n`,
      'c.ts': `  {\n    ${catalogNameStart()}create',\n  }\n`,
      'd.ts': `// nothing to see here\nconst word = 'campaign'\n`
    }
    for (const [file, text] of Object.entries(planted)) writeFileSync(path.join(dir, file), text)
    execFileSync('git', ['add', '.'], { cwd: dir })
    const hits = grep(dir, ['.'])
    expect(hits).toHaveLength(3)
    expect(hits.some((h) => h.startsWith('a.ts'))).toBe(true)
    expect(hits.some((h) => h.startsWith('b.ts'))).toBe(true)
    expect(hits.some((h) => h.startsWith('c.ts'))).toBe(true)
  })
})
