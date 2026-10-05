/**
 * Bundled-skills namespace rename (`capy:` → `harnu:`).
 *
 * The shipped files under `resources/skills/` are model-facing text with no
 * compiler in front of them: a stray `mcp__capy__*` verb name would tell a session
 * to call a tool that no longer exists, and a stale `capy:` cross-link would send it
 * to a skill the CLI can no longer resolve. This reads the real tree off disk.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILLS_ROOT = path.join(REPO_ROOT, 'resources', 'skills')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

describe('bundled skills namespace', () => {
  it('the plugin manifest is named harnu and points at harnu.dev', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(SKILLS_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')
    )
    expect(manifest.name).toBe('harnu')
    expect(manifest.author.url).toContain('harnu.dev')
    expect(JSON.stringify(manifest)).not.toMatch(/capy/i)
  })

  it('no shipped skill text names the old MCP server, namespace, domain or URI scheme', () => {
    const offenders: string[] = []
    for (const file of walk(SKILLS_ROOT)) {
      const text = readFileSync(file, 'utf8')
      for (const needle of ['mcp__capy__', 'capy:', 'capy.run', 'capy://']) {
        if (text.includes(needle)) offenders.push(`${path.relative(REPO_ROOT, file)}: ${needle}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
