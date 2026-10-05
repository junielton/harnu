import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderCoords as renderCoordsMjs } from '../../scripts/ci/render-coords.mjs'
import {
  STAGE_ALLOW,
  devModeDecision,
  gcVictims,
  insertCompanionPluginDir,
  renderCoords,
  stageFileList,
  stageKeyFor,
  stageManifest
} from '../../src/main/companion/staging-core'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/nowhere', getPath: () => '/nowhere' }
}))

import { createStager } from '../../src/main/companion/staging'

const REPO_COMPANION = resolve(import.meta.dirname, '..', '..', 'resources', 'companion')

async function walk(dir: string, base = dir): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(p, base)))
    else out.push(relative(base, p).split('\\').join('/'))
  }
  return out.sort()
}

describe('insertCompanionPluginDir', () => {
  it('companion is the first plugin dir, before the separator', () => {
    const argv = ['--model', 'x', '--plugin-dir', '/user/p', '--', 'prompt']
    expect(insertCompanionPluginDir(argv, '/c')).toEqual([
      '--model',
      'x',
      '--plugin-dir',
      '/c',
      '--plugin-dir',
      '/user/p',
      '--',
      'prompt'
    ])
  })

  it('lands at the end of the option portion, before "--", when there is no plugin dir', () => {
    expect(insertCompanionPluginDir(['--model', 'x', '--', 'p'], '/c')).toEqual([
      '--model',
      'x',
      '--plugin-dir',
      '/c',
      '--',
      'p'
    ])
    expect(insertCompanionPluginDir([], '/c')).toEqual(['--plugin-dir', '/c'])
  })

  it('also goes before a "--plugin-dir=<dir>" spelling', () => {
    expect(insertCompanionPluginDir(['--plugin-dir=/u'], '/c')).toEqual([
      '--plugin-dir',
      '/c',
      '--plugin-dir=/u'
    ])
  })

  it('idempotent injection', () => {
    const argv = ['--plugin-dir', '/c', '--plugin-dir', '/u', '--', 'p']
    expect(insertCompanionPluginDir(argv, '/c')).toEqual(argv)
    // A prompt that merely quotes the flag does not count as already present.
    expect(insertCompanionPluginDir(['--', '--plugin-dir', '/c'], '/c')).toEqual([
      '--plugin-dir',
      '/c',
      '--',
      '--plugin-dir',
      '/c'
    ])
  })
})

describe('renderCoords', () => {
  const evalCoords = (src: string): Record<string, unknown> =>
    new Function(
      `${src.replace(/export const/g, 'const')}; return { RENDEZVOUS_PATH, MOD_VERSION, STAGED_AT }`
    )()

  it('coords are JSON-escaped', () => {
    const hostile = '/tmp/a"b\\c\'d`${1}\n/endpoint.json'
    const src = renderCoords({ RENDEZVOUS_PATH: hostile, MOD_VERSION: '0.1.0', STAGED_AT: 7 })
    expect(evalCoords(src)).toEqual({
      RENDEZVOUS_PATH: hostile,
      MOD_VERSION: '0.1.0',
      STAGED_AT: 7
    })
  })

  it('the mjs twin equals the renderer', () => {
    const fields = { RENDEZVOUS_PATH: '/x"y\\z', MOD_VERSION: '1.2.3', STAGED_AT: 1790000000000 }
    expect(renderCoordsMjs(fields)).toBe(renderCoords(fields))
  })
})

describe('stage key and digest', () => {
  it('keeps modVersion for a fresh or identical stage, otherwise a sibling key', () => {
    expect(stageKeyFor('0.1.0', 'abcdef1234567890', null)).toBe('0.1.0')
    expect(stageKeyFor('0.1.0', 'abcdef1234567890', 'abcdef1234567890')).toBe('0.1.0')
    expect(stageKeyFor('0.1.0', 'abcdef1234567890', 'ffffffffffffffff')).toBe('0.1.0.abcdef12')
  })

  it('digest covers the files and the coordinates, not their order', () => {
    const a = { rel: 'hooks/a.ts', sha256: '1' }
    const b = { rel: 'hooks/b.ts', sha256: '2' }
    const base = stageManifest([a, b], 'coords')
    expect(stageManifest([b, a], 'coords')).toBe(base)
    expect(stageManifest([a, b], 'coords2')).not.toBe(base)
    expect(stageManifest([a, { ...b, sha256: '3' }], 'coords')).not.toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('only the allowlist is staged (MOD-9)', () => {
  it('filters the real source tree', async () => {
    const all = await walk(REPO_COMPANION)
    const staged = stageFileList(all)
    expect(staged.length).toBeGreaterThan(3)
    for (const rel of staged) {
      expect(STAGE_ALLOW.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a))).toBe(true)
    }
    expect(staged.some((r) => r.startsWith('tests/'))).toBe(false)
    expect(staged).not.toContain('api-surface.json')
    expect(staged).not.toContain('tsconfig.json')
    expect(staged).not.toContain('.gitignore')
    expect(staged.some((r) => r.startsWith('.claude-plugin/types/'))).toBe(false)
    // generated coordinates are written by staging, never copied from the source tree
    expect(staged).not.toContain('hooks/coords.gen.ts')
  })

  it('drops every hostile or engine-written path', () => {
    expect(
      stageFileList([
        '.claude-plugin/plugin.json',
        '.claude-plugin/types/claude-code/index.d.ts',
        'tests/fixtures/x.ts',
        'hooks/../../etc/passwd',
        'hooks/register.ts',
        'types/index.d.ts'
      ])
    ).toEqual(['.claude-plugin/plugin.json', 'hooks/register.ts', 'types/index.d.ts'])
  })
})

describe('garbage collection pins by directory', () => {
  const DAY = 86_400_000
  const now = 100 * DAY
  const root = '/ud/companion'
  const entries = [
    { key: '0.1.0', dir: `${root}/0.1.0/harnu-companion`, stampMs: now - 30 * DAY },
    {
      key: '0.1.0.abcdef12',
      dir: `${root}/0.1.0.abcdef12/harnu-companion`,
      stampMs: now - 30 * DAY
    },
    { key: '0.0.9', dir: `${root}/0.0.9/harnu-companion`, stampMs: now - 30 * DAY },
    { key: '0.0.8', dir: `${root}/0.0.8/harnu-companion`, stampMs: now - 2 * DAY }
  ]

  it('keeps an old stage that a spawn record or a pin names; removes it with neither', () => {
    const victims = (pinned: string[]): string[] =>
      gcVictims({
        entries,
        currentDir: `${root}/0.1.0/harnu-companion`,
        pinnedDirs: pinned,
        nowMs: now
      })
    // sibling keys are pinned by directory, not by version
    expect(victims([`${root}/0.1.0.abcdef12/harnu-companion`])).toEqual(['0.0.9'])
    expect(victims([])).toEqual(['0.1.0.abcdef12', '0.0.9'])
    // a pin may name a file inside the stage directory
    expect(victims([`${root}/0.0.9/harnu-companion/hooks/register.ts`])).toEqual(['0.1.0.abcdef12'])
  })

  it('never removes the current stage or a recent one', () => {
    const v = gcVictims({
      entries,
      currentDir: `${root}/0.0.9/harnu-companion`,
      pinnedDirs: [],
      nowMs: now
    })
    expect(v).not.toContain('0.0.9')
    expect(v).not.toContain('0.0.8')
  })
})

describe('devModeDecision', () => {
  const base = { flag: true, packaged: false, lock: null, selfPid: 10, pidAlive: () => false }

  it('is the repository folder only for an unpackaged build that asked for it', () => {
    expect(devModeDecision(base).mode).toBe('repo')
    expect(devModeDecision({ ...base, flag: false }).mode).toBe('stage')
    expect(devModeDecision({ ...base, packaged: true }).mode).toBe('stage')
  })

  it('a live lock held by another pid forces normal staging with a warning', () => {
    const d = devModeDecision({ ...base, lock: { pid: 99 }, pidAlive: () => true })
    expect(d.mode).toBe('stage')
    expect(d.warn).toContain('99')
  })

  it('a dead or own lock does not block', () => {
    expect(devModeDecision({ ...base, lock: { pid: 99 }, pidAlive: () => false }).mode).toBe('repo')
    expect(devModeDecision({ ...base, lock: { pid: 10 }, pidAlive: () => true }).mode).toBe('repo')
  })
})

describe('the stager (real fs, temp dirs)', () => {
  let work: string
  let userData: string
  let source: string

  const stager = (over: Partial<Parameters<typeof createStager>[0]> = {}) =>
    createStager({
      userData,
      resourceDir: source,
      isPackaged: false,
      devFlag: false,
      now: () => 1_790_000_000_000,
      pid: 4242,
      isPidAlive: () => false,
      log: () => {},
      ...over
    })

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'harnu-stage-'))
    userData = join(work, 'userData')
    source = join(work, 'resources-companion')
    await mkdir(userData, { recursive: true })
    await cp(REPO_COMPANION, source, {
      recursive: true,
      filter: (p) => !/\.claude-plugin[\\/]types|coords\.gen\.ts|\.dev-lock/.test(p)
    })
  })
  afterEach(async () => {
    await rm(work, { recursive: true, force: true })
  })

  it('stages the allowlist under <modVersion>/harnu-companion with private modes', async () => {
    const dir = await stager().ensureStaged()
    expect(dir).toBe(join(userData, 'companion', '0.1.0', 'harnu-companion'))
    const files = await walk(dir!)
    expect(files).toContain('.stamp')
    expect(files).toContain('hooks/coords.gen.ts')
    expect(files.filter((f) => f !== '.stamp' && f !== 'hooks/coords.gen.ts')).toEqual(
      stageFileList(await walk(source))
    )
    expect(files.some((f) => f.startsWith('tests/'))).toBe(false)
    expect((await stat(dir!)).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir!, 'hooks', 'register.ts'))).mode & 0o777).toBe(0o600)
    const coords = await readFile(join(dir!, 'hooks', 'coords.gen.ts'), 'utf8')
    expect(coords).toContain(JSON.stringify(join(userData, 'companion', 'endpoint.json')))
  })

  it('is idempotent: a second call, even from a new stager, returns the same tree untouched', async () => {
    const first = await stager().ensureStaged()
    const before = (await stat(join(first!, '.stamp'))).mtimeMs
    const second = await stager().ensureStaged()
    expect(second).toBe(first)
    expect((await stat(join(second!, '.stamp'))).mtimeMs).toBe(before)
  })

  it('a stale or tampered stage is never overwritten', async () => {
    const first = (await stager().ensureStaged())!
    const hooks = join(first, 'hooks', 'register.ts')
    await writeFile(hooks, '// tampered\n')

    const second = (await stager().ensureStaged())!
    expect(second).not.toBe(first)
    expect(second.startsWith(join(userData, 'companion', '0.1.0.'))).toBe(true)
    // the tampered tree is exactly as the other process left it, and the new one is clean
    expect(await readFile(hooks, 'utf8')).toBe('// tampered\n')
    expect(await readFile(join(second, 'hooks', 'register.ts'), 'utf8')).not.toContain('tampered')
    // a third call picks the clean sibling again instead of building a fourth tree
    expect(await stager().ensureStaged()).toBe(second)
  })

  it('a source change that keeps modVersion stages a sibling and leaves the old tree alone', async () => {
    const first = (await stager().ensureStaged())!
    const oldBytes = await readFile(join(first, 'hooks', 'register.ts'), 'utf8')
    await writeFile(join(source, 'hooks', 'register.ts'), `${oldBytes}\n// next build\n`)
    const second = (await stager().ensureStaged())!
    expect(second).not.toBe(first)
    expect(await readFile(join(first, 'hooks', 'register.ts'), 'utf8')).toBe(oldBytes)
  })

  it('ignores the typings the engine writes into a loaded stage', async () => {
    const first = (await stager().ensureStaged())!
    await mkdir(join(first, '.claude-plugin', 'types', 'claude-code'), { recursive: true })
    await writeFile(join(first, '.claude-plugin', 'types', 'claude-code', 'index.d.ts'), 'x')
    expect(await stager().ensureStaged()).toBe(first)
  })

  it('a changed rendezvous path (data directory) stages a new directory', async () => {
    const first = (await stager().ensureStaged())!
    const moved = join(work, 'other-userData')
    await mkdir(moved, { recursive: true })
    const second = (await stager({ userData: moved }).ensureStaged())!
    expect(second.startsWith(moved)).toBe(true)
    expect(await readFile(join(second, 'hooks', 'coords.gen.ts'), 'utf8')).toContain(
      JSON.stringify(join(moved, 'companion', 'endpoint.json'))
    )
    expect(first).not.toBe(second)
  })

  it('returns null, once-logged, when staging cannot work', async () => {
    const log = vi.fn()
    const s = stager({ resourceDir: join(work, 'does-not-exist'), log })
    expect(await s.ensureStaged()).toBeNull()
    expect(await s.ensureStaged()).toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('dev mode is single-owner', async () => {
    // another live process holds the lock: stage normally, write nothing into the repository folder
    await writeFile(join(source, '.dev-lock'), '99999')
    const blocked = await stager({ devFlag: true, isPidAlive: (p) => p === 99999 }).ensureStaged()
    expect(blocked!.startsWith(join(userData, 'companion'))).toBe(true)
    expect((await walk(source)).includes('hooks/coords.gen.ts')).toBe(false)

    // no live lock: the repository folder itself, with coordinates written once
    await rm(join(source, '.dev-lock'))
    const owned = await stager({ devFlag: true }).ensureStaged()
    expect(owned).toBe(source)
    expect(await readFile(join(source, '.dev-lock'), 'utf8')).toBe('4242')
    const coords = await readFile(join(source, 'hooks', 'coords.gen.ts'), 'utf8')
    expect(coords).toContain(JSON.stringify(join(userData, 'companion', 'endpoint.json')))

    // a packaged build ignores the flag
    const packaged = await stager({ devFlag: true, isPackaged: true }).ensureStaged()
    expect(packaged).not.toBe(source)
  })

  it('garbage collection removes only old, unpinned, non-current stages', async () => {
    const s = stager()
    const current = (await s.ensureStaged())!
    // an old sibling stage, backdated beyond 14 days
    const oldKey = join(userData, 'companion', '0.0.9')
    await mkdir(join(oldKey, 'harnu-companion'), { recursive: true })
    const stamp = join(oldKey, 'harnu-companion', '.stamp')
    await writeFile(stamp, 'x\ny\n')
    const old = new Date(Date.now() - 30 * 86_400_000)
    const { utimes } = await import('node:fs/promises')
    await utimes(stamp, old, old)

    s.pinStagedDir(() => [join(oldKey, 'harnu-companion')])
    await s.gc()
    expect((await readdir(join(userData, 'companion'))).includes('0.0.9')).toBe(true)

    const s2 = stager()
    await s2.gc()
    expect((await readdir(join(userData, 'companion'))).includes('0.0.9')).toBe(false)
    expect((await readdir(join(userData, 'companion'))).includes('0.1.0')).toBe(true)
    expect(current).toBeTruthy()
  })
})
