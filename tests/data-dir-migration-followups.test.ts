import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  chmodSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { migrateDataDir } from '../src/main/migrations/data-dir'
import {
  dataDirAt,
  dataDirReady,
  mkdirDataDir,
  resetDataDirExcludeCache,
  setLazyDataDirMigration
} from '../src/main/data-dir'
import { readMemoryForFolder } from '../src/main/mcp/memory-store'
import {
  BOOT_MIGRATION_CEILING_MS,
  flushDataDirConflictNotices,
  migrateFolderDataDirLazily,
  migrateKnownFolderDataDirs,
  setDataDirNoticeSink,
  type NoticeDeps
} from '../src/main/migrations/data-dir-boot'
import type { DataDirOutcome } from '../src/main/migrations/data-dir'

/**
 * U9 / AC-4 — the follow-ups to the first-boot copy:
 *  (a) a folder that becomes known after boot is copied lazily,
 *  (b) the boot copy has a time ceiling and finishes in the background,
 *  (c) a read-only markdown page no longer aborts the whole copy.
 * Everything runs against the production defaults (`DATA_DIR` = `.harnu`).
 */

const h = vi.hoisted(() => ({
  userDataDir: '',
  failWriteOf: '',
  cpDelayMs: 0,
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
  sent: [] as Array<{ channel: string; payload: unknown }>
}))
// The copy's rewrite writes through `node:fs/promises`; let one test make a single page unwritable.
vi.mock('node:fs/promises', async (orig) => {
  const actual = await orig<typeof import('node:fs/promises')>()
  return {
    ...actual,
    cp: async (...args: Parameters<typeof actual.cp>) => {
      // Copy first, then dawdle: the temp dir exists while the copy is "still running".
      await actual.cp(...args)
      if (h.cpDelayMs) await new Promise((r) => setTimeout(r, h.cpDelayMs))
    },
    writeFile: (file: Parameters<typeof actual.writeFile>[0], ...rest: unknown[]) =>
      h.failWriteOf && String(file).endsWith(h.failWriteOf)
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : (actual.writeFile as (...a: unknown[]) => Promise<void>)(file, ...rest)
  }
})
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown): void => {
      h.handlers.set(channel, fn)
    },
    on: (): void => {}
  }
}))

const roots: string[] = []
function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harnu-u9-'))
  roots.push(dir)
  return dir
}
function seedLegacy(repo: string): void {
  mkdirSync(join(repo, '.capy/memory'), { recursive: true })
  writeFileSync(join(repo, '.capy/memory/hot.md'), 'See .capy/out/report.md\n')
}
beforeEach(() => {
  h.userDataDir = tmpRepo()
  setDataDirNoticeSink(null)
})
afterEach(() => {
  setDataDirNoticeSink(null)
  for (const r of roots.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

describe('AC-4(a) — lazy migration for a folder that becomes known later', () => {
  it('migrateFolderDataDirLazily copies the folder’s .capy/ into .harnu/', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    const res = await migrateFolderDataDirLazily(repo)
    expect(res.outcome).toBe('copied')
    expect(readFileSync(join(repo, '.harnu/memory/hot.md'), 'utf8')).toBe(
      'See .harnu/out/report.md\n'
    )
    expect(existsSync(join(repo, '.capy/memory/hot.md'))).toBe(true) // original kept
  })

  it('addUserProject (the path adoptFolder takes) runs it for the new folder', async () => {
    const { addUserProject } = await import('../src/main/user-projects')
    const repo = tmpRepo()
    seedLegacy(repo)
    await addUserProject({ path: repo, alias: 'r', addedAt: '2026-10-03', worktrees: [] })
    expect(existsSync(join(repo, '.harnu/memory/hot.md'))).toBe(true)
    expect(existsSync(join(repo, '.harnu/.migrated-from-capy'))).toBe(true)
  })

  it('addUserProject never fails when the folder has nothing to copy or does not exist', async () => {
    const { addUserProject, readUserProjects } = await import('../src/main/user-projects')
    await addUserProject({
      path: join(tmpRepo(), 'gone'),
      alias: 'gone',
      addedAt: '2026-10-03',
      worktrees: []
    })
    expect((await readUserProjects()).projects).toHaveLength(1)
  })

  it('a conflict found lazily raises the Activity notice through the registered sink', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    mkdirSync(join(repo, '.harnu')) // not our copy
    const sent: Array<{ command: string; payload: Record<string, unknown> }> = []
    const sink: NoticeDeps = {
      dispatch: async (command, payload) => {
        sent.push({ command, payload: payload as Record<string, unknown> })
      }
    }
    setDataDirNoticeSink(sink)
    const res = await migrateFolderDataDirLazily(repo)
    expect(res.outcome).toBe('conflict')
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].command).toBe('notify.push')
    expect(sent[0].payload).toMatchObject({ folderPath: repo, kind: 'warning' })
  })

  it('is inactive only when the target is itself a legacy name', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    expect((await migrateFolderDataDirLazily(repo, { dataDir: '.capy' })).outcome).toBe('inactive')
    expect(existsSync(join(repo, '.harnu'))).toBe(false)
  })
})

describe('AC-4(b) — the boot copy has a time ceiling', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }

  it('the default ceiling is a finite, sane number of seconds', () => {
    expect(BOOT_MIGRATION_CEILING_MS).toBeGreaterThan(1_000)
    expect(BOOT_MIGRATION_CEILING_MS).toBeLessThanOrEqual(60_000)
  })

  it('returns timedOut past the ceiling while the slow folder keeps copying, then settles', async () => {
    const slow = deferred<DataDirOutcome>()
    const res = await migrateKnownFolderDataDirs({
      pinnedFolders: async () => ['/r/fast', '/r/slow'],
      worktreesOf: async () => [],
      migrate: async (folder) =>
        folder === '/r/slow' ? slow.promise : { outcome: 'copied', from: '.capy', rewrittenMd: 0 },
      ceilingMs: 20
    })
    expect(res.timedOut).toBe(true)
    expect(res.copied).toEqual(['/r/fast'])
    expect(res.settled).toBeInstanceOf(Promise)

    slow.resolve({ outcome: 'copied', from: '.capy', rewrittenMd: 3 })
    const final = await res.settled!
    expect(final.copied.sort()).toEqual(['/r/fast', '/r/slow'])
    expect(final.folders).toBe(2)
  })

  it('keeps the conflict / error semantics for a folder that finishes after the ceiling', async () => {
    const slowConflict = deferred<DataDirOutcome>()
    const slowError = deferred<DataDirOutcome>()
    const res = await migrateKnownFolderDataDirs({
      pinnedFolders: async () => ['/r/c', '/r/e'],
      worktreesOf: async () => [],
      migrate: async (folder) => (folder === '/r/c' ? slowConflict.promise : slowError.promise),
      ceilingMs: 10
    })
    expect(res.timedOut).toBe(true)
    expect(res.conflicts).toEqual([])
    slowConflict.resolve({ outcome: 'conflict', from: '.capy' })
    slowError.resolve({ outcome: 'error', message: 'disk full' })
    const final = await res.settled!
    expect(final.conflicts).toEqual(['/r/c'])
    expect(final.errors).toEqual([{ folder: '/r/e', message: 'disk full' }])

    // The late conflict is still delivered as a notice.
    const sent: string[] = []
    await flushDataDirConflictNotices({
      dispatch: async (_c, payload) => {
        sent.push((payload as { folderPath: string }).folderPath)
      }
    })
    expect(sent).toEqual(['/r/c'])
  })

  it('does not time out (and has no settled promise) when everything finishes inside the ceiling', async () => {
    const res = await migrateKnownFolderDataDirs({
      pinnedFolders: async () => ['/r/a'],
      worktreesOf: async () => [],
      migrate: async () => ({ outcome: 'copied', from: '.capy', rewrittenMd: 0 }),
      ceilingMs: 5_000
    })
    expect(res.timedOut).toBeUndefined()
    expect(res.settled).toBeUndefined()
    expect(res.copied).toEqual(['/r/a'])
  })

  it('migrateFolderDataDirLazily also stops waiting at the ceiling but lets the copy finish', async () => {
    const slow = deferred<DataDirOutcome>()
    const res = await migrateFolderDataDirLazily('/r/slow', {
      ceilingMs: 10,
      migrate: () => slow.promise
    })
    expect(res).toEqual({ outcome: 'timeout' })
    slow.resolve({ outcome: 'copied', from: '.capy', rewrittenMd: 0 })
  })
})

describe.skipIf(process.getuid?.() === 0)(
  'AC-4(c) — a read-only page no longer aborts the copy',
  () => {
    it('rewrites a read-only .md in the COPY and gives it its read-only mode back', async () => {
      const repo = tmpRepo()
      mkdirSync(join(repo, '.capy/memory'), { recursive: true })
      const ro = join(repo, '.capy/memory/locked.md')
      writeFileSync(ro, 'Locked page: see .capy/out/a.md\n')
      chmodSync(ro, 0o444)
      writeFileSync(join(repo, '.capy/memory/other.md'), 'Other: .capy/out/b.md\n')

      const res = await migrateDataDir(repo, { appVersion: 't' })
      expect(res.outcome).toBe('copied')
      if (res.outcome === 'copied') expect(res.rewrittenMd).toBe(2)

      const copy = join(repo, '.harnu/memory/locked.md')
      expect(readFileSync(copy, 'utf8')).toBe('Locked page: see .harnu/out/a.md\n')
      expect(statSync(copy).mode & 0o777).toBe(0o444)
      expect(readFileSync(join(repo, '.harnu/memory/other.md'), 'utf8')).toBe(
        'Other: .harnu/out/b.md\n'
      )
      // The original is untouched, text and mode.
      expect(readFileSync(ro, 'utf8')).toBe('Locked page: see .capy/out/a.md\n')
      expect(statSync(ro).mode & 0o777).toBe(0o444)
      chmodSync(ro, 0o644)
      chmodSync(copy, 0o644)
    })

    it('skips (and logs) a page it cannot rewrite instead of failing the whole copy', async () => {
      const repo = tmpRepo()
      mkdirSync(join(repo, '.capy/memory/sub'), { recursive: true })
      writeFileSync(join(repo, '.capy/memory/sub/stuck.md'), 'stuck: .capy/x.md\n')
      writeFileSync(join(repo, '.capy/memory/fine.md'), 'fine: .capy/y.md\n')
      h.failWriteOf = 'stuck.md'
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const res = await migrateDataDir(repo, { appVersion: 't' })
        expect(res.outcome).toBe('copied')
        expect(readFileSync(join(repo, '.harnu/memory/fine.md'), 'utf8')).toBe(
          'fine: .harnu/y.md\n'
        )
        // Left as copied: present, old text, and the marker proves the copy completed.
        expect(readFileSync(join(repo, '.harnu/memory/sub/stuck.md'), 'utf8')).toBe(
          'stuck: .capy/x.md\n'
        )
        expect(existsSync(join(repo, '.harnu/.migrated-from-capy'))).toBe(true)
        expect(warn).toHaveBeenCalled()
      } finally {
        h.failWriteOf = ''
        warn.mockRestore()
      }
    })
  }
)

describe('D1 — a repo the boot pass never saw is copied the first time its data dir is used', () => {
  beforeEach(() => setLazyDataDirMigration(true))
  afterEach(() => setLazyDataDirMigration(false))

  it('an UNPINNED repo with .capy/ is copied on the first memory read', async () => {
    const repo = tmpRepo() // never added to projects.json
    seedLegacy(repo)
    const data = await readMemoryForFolder(repo)
    expect(existsSync(join(repo, '.harnu/memory/hot.md'))).toBe(true)
    expect(readFileSync(join(repo, '.harnu/memory/hot.md'), 'utf8')).toBe(
      'See .harnu/out/report.md\n'
    )
    expect(JSON.stringify(data)).toContain('report.md') // the read saw the copied page, not an empty dir
    expect(existsSync(join(repo, '.capy/memory/hot.md'))).toBe(true)
  })

  it('resolving a data dir path (dataDirAt) starts the copy, and dataDirReady awaits it', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    expect(dataDirAt(repo)).toBe(join(repo, '.harnu'))
    await dataDirReady(repo)
    expect(existsSync(join(repo, '.harnu/memory/hot.md'))).toBe(true)
  })

  it('is single-flight per root and never re-copies', async () => {
    const repo = tmpRepo()
    seedLegacy(repo)
    await Promise.all([dataDirReady(repo), dataDirReady(repo), dataDirReady(repo)])
    writeFileSync(join(repo, '.harnu/mine.md'), 'edited after the copy')
    await dataDirReady(repo)
    expect(readFileSync(join(repo, '.harnu/mine.md'), 'utf8')).toBe('edited after the copy')
  })

  it('does nothing — and does not throw — for a root with no legacy dir', async () => {
    const repo = tmpRepo()
    await dataDirReady(repo)
    expect(existsSync(join(repo, '.harnu'))).toBe(false)
  })
})

describe('D2 — a writer never creates the target while the copy is filling it', () => {
  afterEach(() => {
    h.cpDelayMs = 0
    setLazyDataDirMigration(false)
  })

  it('a real concurrent writer during a slow copy ends `copied`, and its file survives', async () => {
    setLazyDataDirMigration(true)
    h.cpDelayMs = 150
    const repo = tmpRepo()
    seedLegacy(repo)
    const migration = migrateDataDir(repo, { appVersion: 't' })
    // Let the copy get going, then write like memory-store / roadmap-ipc do.
    await new Promise((r) => setTimeout(r, 30))
    await mkdirDataDir(join(repo, '.harnu', 'memory'))
    writeFileSync(join(repo, '.harnu/memory/new.md'), 'written during the copy')

    const res = await migration
    expect(res.outcome).toBe('copied')
    expect(readFileSync(join(repo, '.harnu/memory/new.md'), 'utf8')).toBe('written during the copy')
    expect(readFileSync(join(repo, '.harnu/memory/hot.md'), 'utf8')).toContain(
      '.harnu/out/report.md'
    )
  })

  it('control: a writer that does NOT wait makes the copy report a conflict', async () => {
    setLazyDataDirMigration(false) // writers no longer await the copy
    h.cpDelayMs = 150
    const repo = tmpRepo()
    seedLegacy(repo)
    const migration = migrateDataDir(repo, { appVersion: 't' })
    await new Promise((r) => setTimeout(r, 30))
    await mkdirDataDir(join(repo, '.harnu', 'memory'))
    expect((await migration).outcome).toBe('conflict')
  })
})

describe('D5 — the default canvas board is not orphaned', () => {
  it('renames board.capycanvas.json to board.harnucanvas.json inside the copy only', async () => {
    const repo = tmpRepo()
    mkdirSync(join(repo, '.capy/out/canvas'), { recursive: true })
    writeFileSync(join(repo, '.capy/out/canvas/board.capycanvas.json'), '{"old":true}')
    writeFileSync(join(repo, '.capy/out/canvas/other.capycanvas.json'), '{"other":true}')
    expect((await migrateDataDir(repo)).outcome).toBe('copied')
    expect(readFileSync(join(repo, '.harnu/out/canvas/board.harnucanvas.json'), 'utf8')).toBe(
      '{"old":true}'
    )
    expect(existsSync(join(repo, '.harnu/out/canvas/board.capycanvas.json'))).toBe(false)
    // Boards opened by explicit path keep their names; the original dir is untouched.
    expect(existsSync(join(repo, '.harnu/out/canvas/other.capycanvas.json'))).toBe(true)
    expect(existsSync(join(repo, '.capy/out/canvas/board.capycanvas.json'))).toBe(true)
  })

  it('never overwrites a board that already has the new name', async () => {
    const repo = tmpRepo()
    mkdirSync(join(repo, '.capy/out/canvas'), { recursive: true })
    writeFileSync(join(repo, '.capy/out/canvas/board.capycanvas.json'), '{"old":true}')
    writeFileSync(join(repo, '.capy/out/canvas/board.harnucanvas.json'), '{"new":true}')
    await migrateDataDir(repo)
    expect(readFileSync(join(repo, '.harnu/out/canvas/board.harnucanvas.json'), 'utf8')).toBe(
      '{"new":true}'
    )
    expect(existsSync(join(repo, '.harnu/out/canvas/board.capycanvas.json'))).toBe(true)
  })
})

describe('D6 — the temp copy dir never shows up as untracked', () => {
  afterEach(() => {
    h.cpDelayMs = 0
  })

  it('/.harnu.migrating/ is excluded before the copy starts, so status stays clean mid-copy', async () => {
    resetDataDirExcludeCache()
    h.cpDelayMs = 300
    const repo = tmpRepo()
    execFileSync('git', ['init', '-q', repo])
    seedLegacy(repo)
    const migration = migrateDataDir(repo)
    const git = (...a: string[]): string => execFileSync('git', ['-C', repo, ...a]).toString()
    await vi.waitFor(() => expect(existsSync(join(repo, '.harnu.migrating'))).toBe(true), {
      timeout: 3000
    })
    expect(git('status', '--porcelain')).toBe('')
    expect((await migration).outcome).toBe('copied')
    expect(readFileSync(join(repo, '.git/info/exclude'), 'utf8')).toContain('/.harnu.migrating/')
    expect(git('status', '--porcelain')).toBe('')
  })
})

describe('D3 — a late copy refreshes the open board', () => {
  it('re-points the roadmap watcher and pushes the cards once the copy lands', async () => {
    const { registerRoadmapHandlers, closeRoadmapWatcher } = await import('../src/main/roadmap-ipc')
    h.sent.length = 0
    registerRoadmapHandlers(
      () =>
        ({
          isDestroyed: () => false,
          webContents: {
            send: (channel: string, payload: unknown) => h.sent.push({ channel, payload })
          }
        }) as never
    )
    const repo = tmpRepo()
    try {
      // The board opens against a repo whose legacy dir has not been copied yet.
      const load = h.handlers.get('roadmap:load')!
      const first = (await load({}, { folder: repo })) as { cards: unknown[]; repoKey: string }
      expect(first.cards).toEqual([])
      mkdirSync(join(repo, '.capy/memory/roadmap'), { recursive: true })
      writeFileSync(
        join(repo, '.capy/memory/roadmap/T1-late.md'),
        '---\nid: T1\ntitle: Late card\nstatus: backlog\nkind: chore\ncomplexity: simple\n---\nBody\n'
      )

      expect((await migrateDataDir(repo)).outcome).toBe('copied')
      await vi.waitFor(() =>
        expect(h.sent.some((m) => m.channel === 'roadmap:card:added')).toBe(true)
      )
      const added = h.sent.find((m) => m.channel === 'roadmap:card:added')!.payload as {
        repoKey: string
        card: { slug: string }
      }
      expect(added.repoKey).toBe(first.repoKey)
      expect(added.card.slug).toBe('T1-late')
    } finally {
      await closeRoadmapWatcher()
    }
  })
})
