import { describe, it, expect } from 'vitest'
import { resolveManifest, DEFAULT_EPHEMERAL } from '../src/main/worktree-manifest'

/**
 * T250 — the additive `ephemeral:` manifest key: which directories Cleanup may
 * dehydrate. The default is package-manager install targets only; build outputs
 * opt in per project because `setup` is an install recipe, not a build.
 */
const resolve = (worktreeMd?: string, localMd?: string) =>
  resolveManifest({ worktreeMd, localMd }, { branch: 'feat/x', repo: 'acme' })

describe('resolveManifest — ephemeral', () => {
  it('defaults to install targets only when no source sets it', () => {
    expect(resolve().ephemeral).toEqual(['node_modules', 'vendor', '.venv', 'venv'])
    expect([...DEFAULT_EPHEMERAL]).toEqual(['node_modules', 'vendor', '.venv', 'venv'])
  })

  it('never defaults a build output or cache', () => {
    for (const build of ['dist', 'build', '.next', '.nuxt', 'target', '.turbo', '.gradle']) {
      expect(resolve().ephemeral).not.toContain(build)
    }
  })

  it('takes an explicit list verbatim, replacing the default (a project can opt in to target/)', () => {
    const md = ['---', 'ephemeral:', '  - node_modules', '  - target', '---'].join('\n')
    const m = resolve(md)
    expect(m.ephemeral).toEqual(['node_modules', 'target'])
    expect(m.warnings).toEqual([])
  })

  it('an explicit empty list disables dehydration for the repo', () => {
    expect(resolve(['---', 'ephemeral: []', '---'].join('\n')).ephemeral).toEqual([])
  })

  it('WORKTREE.local.md overrides the list like every other array key', () => {
    const md = ['---', 'ephemeral: [node_modules, vendor]', '---'].join('\n')
    const local = ['---', 'ephemeral: [node_modules]', '---'].join('\n')
    expect(resolve(md, local).ephemeral).toEqual(['node_modules'])
  })

  it('a non-list value warns and falls back to the default — never fatal', () => {
    const m = resolve(['---', 'ephemeral: node_modules', '---'].join('\n'))
    expect(m.ephemeral).toEqual([...DEFAULT_EPHEMERAL])
    expect(m.warnings.some((w) => w.includes('ephemeral: expected a list'))).toBe(true)
  })

  it('is a known key — no "unknown key" warning', () => {
    const m = resolve(['---', 'ephemeral: [node_modules]', '---'].join('\n'))
    expect(m.warnings.some((w) => w.includes('unknown key'))).toBe(false)
  })
})
