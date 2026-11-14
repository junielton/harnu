/**
 * Missions v4 · S-1 · AC-2 — the rule "add the new before removing the old", as a test.
 *
 * At every slice's head, no bundled skill, awareness-doc line or user-guide page may name
 * a mission, campaign or rebase verb that the MCP catalog does not register. A slice that
 * removes a verb must first move every caller; this test is what notices a caller left
 * behind (and a doc that names a verb before the slice that registers it).
 *
 * Scanned: `resources/skills/**`, `docs/harnu-features.md`, `docs/user/**`. Specs, ADRs and
 * PRDs are history and are not scanned. The registered set is read from the catalog of
 * whichever tree runs the test, so the rule holds on any tree where the docs and the
 * catalog agree.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'

const ROOT = path.resolve(__dirname, '..')

/** What the rule scans, relative to the repo root: a file or a directory (walked). */
const SCANNED = ['resources/skills', 'docs/harnu-features.md', 'docs/user'] as const

const TEXT_EXT = new Set(['.md', '.mjs', '.json', '.ts', '.txt', '.yaml', '.yml'])

/**
 * A verb-shaped name: `mission_<word>…`, `campaign_<word>…`, `rebase_stack` or `plan_mission`.
 * The lookbehind lets `mcp__harnu__mission_get` count (an underscore before the name is part
 * of the MCP prefix) while a longer identifier such as `submission_get` does not. `mission_*`
 * and a bare `mission_` are wildcards in prose, not names: the pattern needs a letter after
 * the underscore, so they never match.
 */
const VERB_SHAPED =
  /(?<![A-Za-z0-9])(?:(?:mission|campaign)_[a-z]+(?:_[a-z]+)*|rebase_stack(?:_[a-z]+)*|plan_mission(?:_[a-z]+)*)(?![A-Za-z0-9])/g

interface Violation {
  file: string
  line: number
  verb: string
}

/** Every verb-shaped name in `text` that is not in `registered`, with its 1-based line. */
function unregisteredVerbs(
  file: string,
  text: string,
  registered: ReadonlySet<string>
): Violation[] {
  const out: Violation[] = []
  text.split('\n').forEach((lineText, i) => {
    for (const m of lineText.matchAll(VERB_SHAPED)) {
      if (!registered.has(m[0])) out.push({ file, line: i + 1, verb: m[0] })
    }
  })
  return out
}

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel)
  const st = statSync(abs)
  if (st.isFile()) return TEXT_EXT.has(path.extname(rel)) ? [rel] : []
  return readdirSync(abs)
    .filter((n) => n !== 'node_modules')
    .flatMap((n) => walk(path.posix.join(rel, n)))
}

const registeredVerbs = new Set(MCP_TOOLS.map((t) => t.name))

describe('the verb-name scanner', () => {
  it('flags a mission, campaign or rebase verb the catalog does not register', () => {
    const text =
      'call mission_frobnicate now\nand `mcp__harnu__campaign_zap`\nthen rebase_stack_all'
    expect(unregisteredVerbs('x.md', text, registeredVerbs)).toEqual([
      { file: 'x.md', line: 1, verb: 'mission_frobnicate' },
      { file: 'x.md', line: 2, verb: 'campaign_zap' },
      { file: 'x.md', line: 3, verb: 'rebase_stack_all' }
    ])
  })

  it('accepts a registered verb, a wildcard and a longer identifier that only ends alike', () => {
    const text =
      'mission_get, mcp__harnu__mission_create, mission_*, campaign_*, mission_ and submission_get'
    expect(unregisteredVerbs('x.md', text, registeredVerbs)).toEqual([])
  })
})

describe('the verbs the catalog registers', () => {
  it('include the mission, campaign and rebase verbs the scan relies on', () => {
    for (const v of ['mission_get', 'mission_create', 'campaign_get', 'rebase_stack']) {
      expect(registeredVerbs.has(v), v).toBe(true)
    }
  })

  it('scan at least the skills, the awareness doc and the user guide', () => {
    const files = SCANNED.flatMap(walk)
    expect(files).toContain('docs/harnu-features.md')
    expect(files.some((f) => f.startsWith('resources/skills/'))).toBe(true)
    expect(files.some((f) => f.startsWith('docs/user/'))).toBe(true)
  })
})

it('docs and skills name registered verbs only', () => {
  const violations = SCANNED.flatMap(walk).flatMap((file) =>
    unregisteredVerbs(file, readFileSync(path.join(ROOT, file), 'utf8'), registeredVerbs)
  )
  expect(
    violations.map(
      (v) => `${v.file}:${v.line} names ${v.verb}, which the catalog does not register`
    )
  ).toEqual([])
})
