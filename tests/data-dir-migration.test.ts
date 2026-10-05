import { describe, it, expect, afterEach } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  readlinkSync,
  lstatSync,
  utimesSync,
  statSync,
  readdirSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DATA_DIR } from '../src/shared/data-dir'
import { LEGACY_DATA_DIRS, mapLegacyDataPath, resetDataDirExcludeCache } from '../src/main/data-dir'
import {
  migrateDataDir,
  MIGRATED_MARKER_PREFIX,
  type DataDirOutcome
} from '../src/main/migrations/data-dir'
import {
  migrateKnownFolderDataDirs,
  flushDataDirConflictNotices
} from '../src/main/migrations/data-dir-boot'

/**
 * U8 — the first-boot `.capy/` → `.harnu/` COPY. Built inactive: while
 * `DATA_DIR` is still a legacy name every call is a no-op, so the active paths are
 * driven through the `dataDir` test seam instead of editing the constant.
 */

const roots: string[] = []
function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harnu-u8-'))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const OPTS = { dataDir: '.harnu', appVersion: '9.9.9' }

function seedLegacy(repo: string): void {
  mkdirSync(join(repo, '.capy/memory/roadmap'), { recursive: true })
  mkdirSync(join(repo, '.capy/missions'), { recursive: true })
  mkdirSync(join(repo, '.capy/out/canvas'), { recursive: true })
  writeFileSync(
    join(repo, '.capy/memory/hot.md'),
    'See .capy/out/report.md and `.capy/memory/x.md`.\n'
  )
  writeFileSync(
    join(repo, '.capy/memory/roadmap/T1-card.md'),
    '---\nspec: docs/a.md\n---\nBody mentions .capy/goals/g.md twice: .capy/goals/g.md\n'
  )
  writeFileSync(join(repo, '.capy/memory/decisions.md'), 'Decided: keep .capy/memory/roadmap/\n')
  writeFileSync(join(repo, '.capy/memory/roadmap/clean.md'), 'nothing to rewrite here\n')
  writeFileSync(join(repo, '.capy/missions/m.json'), '{"scope":[".capy/out/x.md"]}\n')
  writeFileSync(join(repo, '.capy/out/canvas/board.capycanvas.json'), '{"path":".capy/out"}')
  writeFileSync(join(repo, '.capy/out/note.txt'), 'plain .capy/ text, not markdown\n')
}

describe('migrateDataDir — armed by the flip (AC-1)', () => {
  it('DATA_DIR is .harnu and the legacy list is just .capy, so the production defaults are active', async () => {
    expect(DATA_DIR).toBe('.harnu')
    expect(LEGACY_DATA_DIRS).toEqual(['.capy'])
    expect(LEGACY_DATA_DIRS).not.toContain(DATA_DIR)
  })

  it('with NO test seam: copies .capy/ into .harnu/ (copied), then reports noop — never inactive', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    const first = await migrateDataDir(repo)
    expect(first.outcome).toBe('copied')
    expect(readdirSync(repo).sort()).toEqual(['.capy', '.harnu'])
    const second = await migrateDataDir(repo)
    expect(second).toEqual({ outcome: 'noop', reason: 'already-migrated' })
    const none = await migrateDataDir(tmpRepo())
    expect(none).toEqual({ outcome: 'noop', reason: 'no-legacy' })
    for (const res of [first, second, none]) expect(res.outcome).not.toBe('inactive')
  })

  it('is inactive when the injected target is itself a legacy name', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    expect((await migrateDataDir(repo, { dataDir: '.capy' })).outcome).toBe('inactive')
  })
})

describe('migrateDataDir — copy', () => {
  it('copies a legacy-only dir into the target and leaves the legacy dir untouched', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    const res = await migrateDataDir(repo, OPTS)
    expect(res.outcome).toBe('copied')
    // The default board is renamed inside the copy so the app opens it (the original keeps its name).
    expect(readFileSync(join(repo, '.harnu/out/canvas/board.harnucanvas.json'), 'utf8')).toBe(
      '{"path":".capy/out"}'
    )
    expect(existsSync(join(repo, '.harnu/out/canvas/board.capycanvas.json'))).toBe(false)
    expect(existsSync(join(repo, '.capy/out/canvas/board.capycanvas.json'))).toBe(true)
    expect(readFileSync(join(repo, '.harnu/out/note.txt'), 'utf8')).toBe(
      'plain .capy/ text, not markdown\n'
    )
    // The legacy tree is still a real dir, with the original bytes.
    expect(lstatSync(join(repo, '.capy')).isDirectory()).toBe(true)
    expect(readFileSync(join(repo, '.capy/memory/hot.md'), 'utf8')).toContain('.capy/out/report.md')
  })

  it('writes the marker with the date and app version', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    await migrateDataDir(repo, { ...OPTS, now: () => new Date('2026-10-03T12:00:00Z') })
    const marker = readFileSync(join(repo, `.harnu/${MIGRATED_MARKER_PREFIX}capy`), 'utf8')
    expect(marker).toContain('2026-10-03')
    expect(marker).toContain('9.9.9')
  })

  it('preserves file and directory mtimes', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    const old = new Date('2024-01-02T03:04:05Z')
    utimesSync(join(repo, '.capy/out/note.txt'), old, old)
    utimesSync(join(repo, '.capy/out/canvas'), old, old)
    await migrateDataDir(repo, OPTS)
    expect(statSync(join(repo, '.harnu/out/note.txt')).mtimeMs).toBe(old.getTime())
    expect(statSync(join(repo, '.harnu/out/canvas')).mtimeMs).toBe(old.getTime())
  })

  it('keeps symlinks verbatim (a dangling or relative target is not resolved)', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    symlinkSync('../missing/target', join(repo, '.capy/out/dangling'))
    symlinkSync('note.txt', join(repo, '.capy/out/rel'))
    await migrateDataDir(repo, OPTS)
    expect(lstatSync(join(repo, '.harnu/out/dangling')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(repo, '.harnu/out/dangling'))).toBe('../missing/target')
    expect(readlinkSync(join(repo, '.harnu/out/rel'))).toBe('note.txt')
  })

  it('leaves no temp sibling behind', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    await migrateDataDir(repo, OPTS)
    expect(readdirSync(repo).sort()).toEqual(['.capy', '.harnu'])
  })

  it('clears a stale temp sibling from a crashed earlier run', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    mkdirSync(join(repo, '.harnu.migrating'))
    writeFileSync(join(repo, '.harnu.migrating/junk'), 'x')
    const res = await migrateDataDir(repo, OPTS)
    expect(res.outcome).toBe('copied')
    expect(existsSync(join(repo, '.harnu.migrating'))).toBe(false)
  })
})

describe('migrateDataDir — markdown rewrite (AC-2)', () => {
  it('rewrites the legacy name only inside the COPIED memory/**/*.md files and counts them', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    const res = await migrateDataDir(repo, OPTS)
    expect(res).toMatchObject({ outcome: 'copied', rewrittenMd: 2 })
    expect(readFileSync(join(repo, '.harnu/memory/hot.md'), 'utf8')).toBe(
      'See .harnu/out/report.md and `.harnu/memory/x.md`.\n'
    )
    expect(readFileSync(join(repo, '.harnu/memory/decisions.md'), 'utf8')).toBe(
      'Decided: keep .harnu/memory/roadmap/\n'
    )
    // JSON and non-memory files are never rewritten.
    expect(readFileSync(join(repo, '.harnu/missions/m.json'), 'utf8')).toBe(
      '{"scope":[".capy/out/x.md"]}\n'
    )
  })

  it('copies roadmap cards byte-identical so their approval stamps survive', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    mkdirSync(join(repo, '.capy/memory/roadmap/nested'), { recursive: true })
    writeFileSync(join(repo, '.capy/memory/roadmap/nested/n.md'), 'see .capy/x\n')
    const old = new Date('2024-02-03T04:05:06Z')
    utimesSync(join(repo, '.capy/memory/roadmap/T1-card.md'), old, old)
    await migrateDataDir(repo, OPTS)
    for (const f of ['T1-card.md', 'clean.md', 'nested/n.md']) {
      expect(readFileSync(join(repo, '.harnu/memory/roadmap', f))).toEqual(
        readFileSync(join(repo, '.capy/memory/roadmap', f))
      )
    }
    expect(readFileSync(join(repo, '.harnu/memory/roadmap/T1-card.md'), 'utf8')).toContain(
      '.capy/goals/g.md'
    )
    expect(statSync(join(repo, '.harnu/memory/roadmap/T1-card.md')).mtimeMs).toBe(old.getTime())
  })

  it('does not rewrite a name embedded in a longer word (`my.capy/`)', async () => {
    const repo = tmpRepo()
    mkdirSync(join(repo, '.capy/memory'), { recursive: true })
    writeFileSync(join(repo, '.capy/memory/a.md'), 'see my.capy/x and ~/.capy/y\n')
    await migrateDataDir(repo, OPTS)
    expect(readFileSync(join(repo, '.harnu/memory/a.md'), 'utf8')).toBe(
      'see my.capy/x and ~/.harnu/y\n'
    )
  })

  it('keeps the mtime of a rewritten file', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    const old = new Date('2024-05-06T07:08:09Z')
    utimesSync(join(repo, '.capy/memory/hot.md'), old, old)
    await migrateDataDir(repo, OPTS)
    expect(statSync(join(repo, '.harnu/memory/hot.md')).mtimeMs).toBe(old.getTime())
  })

  it('never touches the legacy copy of a rewritten file', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    const before = readFileSync(join(repo, '.capy/memory/hot.md'), 'utf8')
    await migrateDataDir(repo, OPTS)
    expect(readFileSync(join(repo, '.capy/memory/hot.md'), 'utf8')).toBe(before)
  })

  it('does not follow a symlinked .md out of the copied tree', async () => {
    const repo = tmpRepo()
    const outside = join(tmpRepo(), 'outside.md')
    writeFileSync(outside, 'keep .capy/ here\n')
    mkdirSync(join(repo, '.capy/memory'), { recursive: true })
    symlinkSync(outside, join(repo, '.capy/memory/link.md'))
    const res = await migrateDataDir(repo, OPTS)
    expect(res).toMatchObject({ outcome: 'copied', rewrittenMd: 0 })
    expect(readFileSync(outside, 'utf8')).toBe('keep .capy/ here\n')
  })
})

describe('migrateDataDir — states that must not copy', () => {
  it('returns `conflict` when both exist and the target is not ours, touching neither', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    mkdirSync(join(repo, '.harnu/memory'), { recursive: true })
    writeFileSync(join(repo, '.harnu/memory/mine.md'), 'created by someone else')
    const res = await migrateDataDir(repo, OPTS)
    expect(res.outcome).toBe('conflict')
    expect(readdirSync(join(repo, '.harnu')).sort()).toEqual(['memory'])
    expect(readdirSync(join(repo, '.harnu/memory'))).toEqual(['mine.md'])
    expect(existsSync(join(repo, '.capy/memory/hot.md'))).toBe(true)
  })

  it('is a quiet no-op on every boot after a successful copy (both dirs stay, marker present)', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    await migrateDataDir(repo, OPTS)
    const again = await migrateDataDir(repo, OPTS)
    expect(again.outcome).toBe('noop')
  })

  it('is a no-op when only the target exists', async () => {
    const repo = tmpRepo()
    mkdirSync(join(repo, '.harnu'))
    expect((await migrateDataDir(repo, OPTS)).outcome).toBe('noop')
  })

  it('is a no-op when neither exists', async () => {
    const repo = tmpRepo()
    expect((await migrateDataDir(repo, OPTS)).outcome).toBe('noop')
    expect(readdirSync(repo)).toEqual([])
  })

  it('follows a symlinked legacy dir and copies its CONTENT into a real target dir (D7)', async () => {
    const repo = tmpRepo()
    const elsewhere = tmpRepo()
    mkdirSync(join(elsewhere, 'memory'), { recursive: true })
    writeFileSync(join(elsewhere, 'memory/hot.md'), 'shared: .capy/out/x.md\n')
    symlinkSync(elsewhere, join(repo, '.capy'))
    const res = await migrateDataDir(repo, OPTS)
    expect(res.outcome).toBe('copied')
    expect(lstatSync(join(repo, '.harnu')).isDirectory()).toBe(true)
    expect(lstatSync(join(repo, '.harnu')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(repo, '.harnu/memory/hot.md'), 'utf8')).toBe(
      'shared: .harnu/out/x.md\n'
    )
    // The link and its target are untouched.
    expect(lstatSync(join(repo, '.capy')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(elsewhere, 'memory/hot.md'), 'utf8')).toBe('shared: .capy/out/x.md\n')
  })

  it('reports an error (not silence) for a legacy symlink that leads nowhere (D7)', async () => {
    const repo = tmpRepo()
    symlinkSync(join(repo, 'missing'), join(repo, '.capy'))
    const res = await migrateDataDir(repo, OPTS)
    expect(res.outcome).toBe('error')
    expect(existsSync(join(repo, '.harnu'))).toBe(false)
  })

  it('treats a .capy symlink that already leads at the new dir as nothing to copy (D7)', async () => {
    const repo = tmpRepo()
    mkdirSync(join(repo, '.harnu'))
    symlinkSync(join(repo, '.harnu'), join(repo, '.capy'))
    expect(await migrateDataDir(repo, OPTS)).toEqual({
      outcome: 'noop',
      reason: 'already-migrated'
    })
  })

  it('never throws — an unreadable folder yields an `error` outcome', async () => {
    const res = await migrateDataDir(join(tmpRepo(), 'does-not-exist'), OPTS)
    expect(['noop', 'error']).toContain(res.outcome)
  })

  it('single-flights concurrent calls for the same folder', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    const [a, b] = await Promise.all([migrateDataDir(repo, OPTS), migrateDataDir(repo, OPTS)])
    expect(a).toBe(b)
    expect(a.outcome).toBe('copied')
  })
})

describe('mapLegacyDataPath (AC-4)', () => {
  it('maps a stored repo-relative legacy path onto the target dir', () => {
    expect(mapLegacyDataPath('.capy/out/x.md', '.harnu')).toBe('.harnu/out/x.md')
    expect(mapLegacyDataPath('.capy', '.harnu')).toBe('.harnu')
  })
  it('leaves other paths alone', () => {
    expect(mapLegacyDataPath('docs/.capy/x.md', '.harnu')).toBe('docs/.capy/x.md')
    expect(mapLegacyDataPath('.capybara/x.md', '.harnu')).toBe('.capybara/x.md')
    expect(mapLegacyDataPath('/abs/.capy/x.md', '.harnu')).toBe('/abs/.capy/x.md')
    expect(mapLegacyDataPath('.harnu/x.md', '.harnu')).toBe('.harnu/x.md')
  })
  it('maps onto the current data dir by default (the flip is live)', () => {
    expect(mapLegacyDataPath('.capy/out/x.md')).toBe('.harnu/out/x.md')
    expect(mapLegacyDataPath('.harnu/out/x.md')).toBe('.harnu/out/x.md')
  })
})

describe('boot runner (AC-3)', () => {
  const fakeMigrate =
    (log: string[], outcomes: Record<string, DataDirOutcome> = {}) =>
    async (folder: string): Promise<DataDirOutcome> => {
      log.push(folder)
      return outcomes[folder] ?? { outcome: 'noop', reason: 'no-legacy' }
    }

  it('does not even enumerate folders when the target is itself a legacy name', async () => {
    let enumerated = false
    const res = await migrateKnownFolderDataDirs({
      dataDir: '.capy',
      pinnedFolders: async () => {
        enumerated = true
        return ['/a']
      },
      worktreesOf: async () => [],
      migrate: async () => ({ outcome: 'noop', reason: 'no-legacy' })
    })
    expect(enumerated).toBe(false)
    expect(res.folders).toBe(0)
  })

  it('runs for every pinned folder and every worktree of it, once each', async () => {
    const log: string[] = []
    const res = await migrateKnownFolderDataDirs({
      dataDir: '.harnu',
      pinnedFolders: async () => ['/r/main', '/r/wt-a'],
      // Pinning a worktree lists the whole repo, so /r/main shows up twice.
      worktreesOf: async () => ['/r/main', '/r/wt-a', '/r/wt-b'],
      migrate: fakeMigrate(log, { '/r/wt-b': { outcome: 'copied', from: '.capy', rewrittenMd: 0 } })
    })
    expect(log.sort()).toEqual(['/r/main', '/r/wt-a', '/r/wt-b'])
    expect(res).toMatchObject({ folders: 3, copied: ['/r/wt-b'], conflicts: [], errors: [] })
  })

  it('survives a repo whose worktree listing fails and still migrates the pinned folder', async () => {
    const log: string[] = []
    await migrateKnownFolderDataDirs({
      dataDir: '.harnu',
      pinnedFolders: async () => ['/r/main'],
      worktreesOf: async () => {
        throw new Error('not a git repo')
      },
      migrate: fakeMigrate(log)
    })
    expect(log).toEqual(['/r/main'])
  })

  it('collects conflicts and delivers one warning notice per folder', async () => {
    const res = await migrateKnownFolderDataDirs({
      dataDir: '.harnu',
      pinnedFolders: async () => ['/r/main'],
      worktreesOf: async () => [],
      migrate: fakeMigrate([], { '/r/main': { outcome: 'conflict', from: '.capy' } })
    })
    expect(res.conflicts).toEqual(['/r/main'])
    const sent: Array<{ command: string; payload: Record<string, unknown> }> = []
    await flushDataDirConflictNotices({
      dispatch: async (command, payload) => {
        sent.push({ command, payload: payload as Record<string, unknown> })
      }
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].command).toBe('notify.push')
    expect(sent[0].payload).toMatchObject({ folderPath: '/r/main', kind: 'warning' })
    expect(String(sent[0].payload.title)).toContain('main')
    // Delivered once: a second flush has nothing left.
    await flushDataDirConflictNotices({ dispatch: async () => Promise.reject(new Error('x')) })
  })

  it('retries a notice until the renderer is ready, then stops', async () => {
    await migrateKnownFolderDataDirs({
      dataDir: '.harnu',
      pinnedFolders: async () => ['/r/late'],
      worktreesOf: async () => [],
      migrate: fakeMigrate([], { '/r/late': { outcome: 'conflict', from: '.capy' } })
    })
    let calls = 0
    await flushDataDirConflictNotices({
      wait: async () => {},
      dispatch: async () => {
        calls++
        if (calls < 3) throw new Error('NO_WINDOW')
      }
    })
    expect(calls).toBe(3)
  })
})

describe('mission worktree-link resolution (AC-4 call site)', () => {
  it('resolves a stored `.capy/…` ref under the current data dir', async () => {
    const { linkPath } = await import('../src/main/mcp/tool-handlers')
    expect(linkPath('/repo', '.capy/out/x.md')).toBe('/repo/.harnu/out/x.md')
    expect(linkPath('/repo', 'docs/a.md')).toBe('/repo/docs/a.md')
    expect(linkPath('/repo', '/abs/.capy/x.md')).toBe('/abs/.capy/x.md')
  })
})

describe('git exclude after a copy', () => {
  const excludeFile = (repo: string): string => join(repo, '.git/info/exclude')
  const excludeText = (repo: string): string =>
    existsSync(excludeFile(repo)) ? readFileSync(excludeFile(repo), 'utf8') : ''

  it('excludes the new data dir from git when the copy succeeds', async () => {
    resetDataDirExcludeCache()
    const repo = tmpRepo()
    execFileSync('git', ['init', '-q', repo])
    seedLegacy(repo)
    expect((await migrateDataDir(repo, OPTS)).outcome).toBe('copied')
    expect(excludeText(repo)).toContain('/.harnu/')
    expect(execFileSync('git', ['-C', repo, 'status', '--porcelain']).toString()).toBe('')
  })

  it('leaves the exclude file alone when nothing was copied (conflict)', async () => {
    resetDataDirExcludeCache()
    const repo = tmpRepo()
    execFileSync('git', ['init', '-q', repo])
    seedLegacy(repo)
    mkdirSync(join(repo, '.harnu'))
    const before = excludeText(repo)
    expect((await migrateDataDir(repo, OPTS)).outcome).toBe('conflict')
    expect(excludeText(repo)).toBe(before)
  })
})
