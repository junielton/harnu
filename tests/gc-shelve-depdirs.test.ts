import { describe, expect, it } from 'vitest'
import {
  dependencyDirsFor,
  isDependencyPath,
  normalizeDependencyDir
} from '../src/main/gc/shelve-core'
import { shelveManifestFrom } from '../src/main/gc/shelve-manifest-shell'

describe('dependencyDirsFor — the repo manifest list at any depth (AC-3)', () => {
  it('adds an any-depth twin of every single-segment entry', () => {
    expect(dependencyDirsFor(['node_modules', 'packages/x/dist'])).toEqual([
      'node_modules',
      '**/node_modules',
      'packages/x/dist'
    ])
  })

  it('drops entries that do not normalise (absolute, escaping, globs, .git, empty)', () => {
    expect(dependencyDirsFor(['/abs', '../up', 'a/*', '.git', '', 'ok/'])).toEqual(['ok'])
  })

  it('keeps an empty list empty: nothing is excluded', () => {
    expect(dependencyDirsFor([])).toEqual([])
  })

  it('normalizeDependencyDir accepts only a single-segment name after the any-depth prefix', () => {
    expect(normalizeDependencyDir('**/node_modules')).toBe('**/node_modules')
    expect(normalizeDependencyDir('**/a/b')).toBeNull()
    expect(normalizeDependencyDir('**/')).toBeNull()
    expect(normalizeDependencyDir('**/..')).toBeNull()
    expect(normalizeDependencyDir('**/.git')).toBeNull()
    expect(normalizeDependencyDir('vendor/')).toBe('vendor')
  })
})

describe('isDependencyPath with an any-depth entry', () => {
  const dirs = ['**/node_modules']

  it('matches the name at any depth, whole segments only', () => {
    expect(isDependencyPath('node_modules', dirs)).toBe(true)
    expect(isDependencyPath('packages/a/node_modules', dirs)).toBe(true)
    expect(isDependencyPath('packages/a/node_modules/', dirs)).toBe(true)
    expect(isDependencyPath('packages/a/node_modules/b/index.js', dirs)).toBe(true)
    expect(isDependencyPath('packages/a/my_node_modules/x', dirs)).toBe(false)
    expect(isDependencyPath('node_modules_x/a', dirs)).toBe(false)
    expect(isDependencyPath('src/app.ts', dirs)).toBe(false)
  })

  it('keeps the root-only rule for a plain entry', () => {
    expect(isDependencyPath('packages/a/node_modules/x', ['node_modules'])).toBe(false)
    expect(isDependencyPath('node_modules/x', ['node_modules'])).toBe(true)
  })
})

describe('shelveManifestFrom — what a repo manifest says about shelving (AC-3, C10)', () => {
  const md = (front: string): string => `---\n${front}\n---\nbody\n`

  it('reads the ephemeral list verbatim, expanded to any depth', () => {
    const m = shelveManifestFrom({ worktreeMd: md('ephemeral:\n  - .cache-x') }, '/r')
    expect(m).toEqual({ dependencyDirs: ['.cache-x', '**/.cache-x'], delegates: false })
  })

  it('no manifest file means the default ephemeral list and no delegation', () => {
    const m = shelveManifestFrom({}, '/r')
    expect(m.delegates).toBe(false)
    expect(m.dependencyDirs).toEqual(
      expect.arrayContaining(['node_modules', '**/node_modules', 'vendor', '.venv', 'venv'])
    )
  })

  it('a manifest that delegates create or remove is flagged', () => {
    expect(
      shelveManifestFrom({ worktreeMd: md('create: ./bin/new {branch}') }, '/r').delegates
    ).toBe(true)
    expect(
      shelveManifestFrom({ worktreeMd: md('remove: ./bin/rm {branch}') }, '/r').delegates
    ).toBe(true)
  })

  it('a manifest file that does not parse fails closed: nothing excluded, treated as delegating', () => {
    const m = shelveManifestFrom({ worktreeMd: '---\nephemeral: [unterminated\n---\n' }, '/r')
    expect(m).toEqual({ dependencyDirs: [], delegates: true })
  })
})
