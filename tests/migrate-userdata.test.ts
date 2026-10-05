import { describe, it, expect, afterEach } from 'vitest'
import {
  shouldMigrate,
  isMigratableEntry,
  hasCustomUserDataDir,
  migrateUserData,
  MIGRATION_MARKER,
  LEGACY_APP_NAMES,
  type MigrationConditions
} from '../src/main/migrate-userdata'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The one-time Capy→Harnu userData migration (T417; extends the T41 om2tab→Capy
 * one). The pure decision ({@link shouldMigrate} / {@link isMigratableEntry} /
 * {@link hasCustomUserDataDir}) is exhaustively pinned; the copy routine
 * ({@link migrateUserData}) is exercised against real temp dirs so the
 * whole-dir copy + cache denylist + guard + never-overwrite + one-shot-marker
 * behavior is verified end-to-end without touching real config.
 */

const OK: MigrationConditions = {
  legacyExists: true,
  destHasLocalStorage: false,
  destHasProjectsJson: false,
  markerExists: false,
  customUserDataDir: false
}

describe('shouldMigrate (pure guard)', () => {
  it('migrates into a fresh default dir when the legacy dir exists', () => {
    expect(shouldMigrate(OK)).toBe(true)
  })
  it('never migrates for a custom --user-data-dir', () => {
    expect(shouldMigrate({ ...OK, customUserDataDir: true })).toBe(false)
  })
  it('never migrates twice (marker present)', () => {
    expect(shouldMigrate({ ...OK, markerExists: true })).toBe(false)
  })
  it('no-op when the legacy dir is absent', () => {
    expect(shouldMigrate({ ...OK, legacyExists: false })).toBe(false)
  })
  it('never clobbers a dir that already has Local Storage', () => {
    expect(shouldMigrate({ ...OK, destHasLocalStorage: true })).toBe(false)
  })
  it('never clobbers a dir that already has projects.json', () => {
    expect(shouldMigrate({ ...OK, destHasProjectsJson: true })).toBe(false)
  })
})

describe('LEGACY_APP_NAMES', () => {
  it('is ordered Capy, capy, om2tab', () => {
    expect([...LEGACY_APP_NAMES]).toEqual(['Capy', 'capy', 'om2tab'])
  })
})

describe('isMigratableEntry (cache denylist)', () => {
  it('keeps everything the app owns, not just JSON', () => {
    for (const keep of [
      'Local Storage',
      'statusline',
      'projects.json',
      'mcp-prefs.json',
      'capy-features.json',
      'scheduler-runs',
      'orchestrator-guard',
      'skills',
      'voice-kokoro',
      'reaper-checkpoints'
    ]) {
      expect(isMigratableEntry(keep)).toBe(true)
    }
  })
  it('does not carry the pre-rename MCP config document (stale port + bearer token)', () => {
    expect(isMigratableEntry('capy.mcp.json')).toBe(false)
  })
  it('skips Chromium caches, locks, and the markers', () => {
    for (const junk of [
      'Cache',
      'GPUCache',
      'Code Cache',
      'DawnCache',
      'DawnWebGPUCache',
      'blob_storage',
      'Crashpad',
      'Network',
      'SingletonLock',
      'SingletonCookie',
      'Cookies',
      MIGRATION_MARKER,
      '.migrated-from-om2tab'
    ]) {
      expect(isMigratableEntry(junk)).toBe(false)
    }
  })
})

describe('hasCustomUserDataDir', () => {
  it('detects the flag in both = and space forms', () => {
    expect(hasCustomUserDataDir(['--user-data-dir=/tmp/x'])).toBe(true)
    expect(hasCustomUserDataDir(['--user-data-dir', '/tmp/x'])).toBe(true)
  })
  it('is false without the flag', () => {
    expect(hasCustomUserDataDir([])).toBe(false)
    expect(hasCustomUserDataDir(['--no-sandbox', '--foo'])).toBe(false)
  })
})

describe('migrateUserData (copy routine, temp dirs)', () => {
  const dirs: string[] = []
  function scratch(): string {
    const d = mkdtempSync(join(tmpdir(), 'harnu-mig-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  /** Build a legacy `<appData>/<name>` dir with prefs, app data dirs and volatile junk. */
  function seedLegacy(appData: string, name: string): string {
    const legacy = join(appData, name)
    mkdirSync(join(legacy, 'Local Storage', 'leveldb'), { recursive: true })
    writeFileSync(join(legacy, 'Local Storage', 'leveldb', '000003.log'), `LEVELDB-${name}`)
    writeFileSync(join(legacy, 'projects.json'), '{"version":1,"projects":[]}')
    writeFileSync(join(legacy, 'helpers.json'), '{}')
    writeFileSync(join(legacy, 'capy.mcp.json'), '{"port":1}')
    writeFileSync(join(legacy, 'capy-features.json'), '{"x":true}')
    for (const dir of [
      'statusline',
      'scheduler-runs',
      'orchestrator-guard',
      'skills',
      'voice-kokoro'
    ]) {
      mkdirSync(join(legacy, dir), { recursive: true })
      writeFileSync(join(legacy, dir, 'a.dat'), dir)
    }
    // volatile junk that must NOT be copied
    for (const junk of [
      'Cache',
      'Code Cache',
      'GPUCache',
      'DawnCache',
      'Crashpad',
      'blob_storage'
    ]) {
      mkdirSync(join(legacy, junk), { recursive: true })
      writeFileSync(join(legacy, junk, 'big.bin'), 'x'.repeat(1000))
    }
    writeFileSync(join(legacy, 'SingletonLock'), '')
    return legacy
  }

  function expectWholeCopy(dest: string, name: string): void {
    // preserved — including the non-JSON dirs the old allowlist dropped
    expect(readFileSync(join(dest, 'Local Storage', 'leveldb', '000003.log'), 'utf8')).toBe(
      `LEVELDB-${name}`
    )
    expect(readFileSync(join(dest, 'projects.json'), 'utf8')).toContain('"version":1')
    expect(existsSync(join(dest, 'helpers.json'))).toBe(true)
    // un-renamed files are copied as they are (renames are another unit's job)
    expect(existsSync(join(dest, 'capy.mcp.json'))).toBe(false)
    expect(existsSync(join(dest, 'capy-features.json'))).toBe(true)
    for (const dir of [
      'statusline',
      'scheduler-runs',
      'orchestrator-guard',
      'skills',
      'voice-kokoro'
    ]) {
      expect(readFileSync(join(dest, dir, 'a.dat'), 'utf8')).toBe(dir)
    }
    // skipped
    for (const junk of [
      'Cache',
      'Code Cache',
      'GPUCache',
      'DawnCache',
      'Crashpad',
      'blob_storage',
      'SingletonLock'
    ]) {
      expect(existsSync(join(dest, junk))).toBe(false)
    }
    // marker + no leftover temp
    expect(existsSync(join(dest, MIGRATION_MARKER))).toBe(true)
    expect(existsSync(join(dest, 'Local Storage.migrating.tmp'))).toBe(false)
  }

  it('migrates Capy → Harnu (packaged): whole dir, minus caches, plus the marker', () => {
    const appData = scratch()
    seedLegacy(appData, 'Capy')
    const dest = join(appData, 'Harnu')

    expect(migrateUserData({ appData, userData: dest, argv: [] })).toBe('migrated')
    expectWholeCopy(dest, 'Capy')
    expect(MIGRATION_MARKER).toBe('.migrated-from-capy')
  })

  it('migrates capy → harnu (dev)', () => {
    const appData = scratch()
    seedLegacy(appData, 'capy')
    const dest = join(appData, 'harnu')

    expect(migrateUserData({ appData, userData: dest, argv: [] })).toBe('migrated')
    expectWholeCopy(dest, 'capy')
  })

  it('still migrates om2tab → Harnu (the om2tab path keeps working)', () => {
    const appData = scratch()
    seedLegacy(appData, 'om2tab')
    const dest = join(appData, 'Harnu')

    expect(migrateUserData({ appData, userData: dest, argv: [] })).toBe('migrated')
    expectWholeCopy(dest, 'om2tab')
  })

  it('takes the first legacy dir in order (Capy beats capy beats om2tab)', () => {
    const appData = scratch()
    seedLegacy(appData, 'om2tab')
    seedLegacy(appData, 'capy')
    const dest = join(appData, 'Harnu')

    expect(migrateUserData({ appData, userData: dest, argv: [] })).toBe('migrated')
    expect(readFileSync(join(dest, 'Local Storage', 'leveldb', '000003.log'), 'utf8')).toBe(
      'LEVELDB-capy'
    )
  })

  it('does not carry over a legacy marker', () => {
    const appData = scratch()
    const legacy = seedLegacy(appData, 'Capy')
    writeFileSync(join(legacy, '.migrated-from-om2tab'), 'old')
    const dest = join(appData, 'Harnu')

    migrateUserData({ appData, userData: dest, argv: [] })
    expect(existsSync(join(dest, '.migrated-from-om2tab'))).toBe(false)
  })

  it('is a one-shot: a second run skips (marker present)', () => {
    const appData = scratch()
    seedLegacy(appData, 'Capy')
    const dest = join(appData, 'Harnu')
    expect(migrateUserData({ appData, userData: dest, argv: [] })).toBe('migrated')
    expect(migrateUserData({ appData, userData: dest, argv: [] })).toBe('skipped')
  })

  it('skips entirely for a custom --user-data-dir (no copy, no marker)', () => {
    const appData = scratch()
    seedLegacy(appData, 'Capy')
    const dest = join(appData, 'Harnu')
    expect(migrateUserData({ appData, userData: dest, argv: ['--user-data-dir=/tmp/x'] })).toBe(
      'skipped'
    )
    expect(existsSync(join(dest, 'projects.json'))).toBe(false)
    expect(existsSync(join(dest, MIGRATION_MARKER))).toBe(false)
  })

  it('refuses a destination that already has data (Local Storage / projects.json)', () => {
    for (const seed of ['Local Storage', 'projects.json']) {
      const appData = scratch()
      seedLegacy(appData, 'Capy')
      const dest = join(appData, 'Harnu')
      mkdirSync(dest, { recursive: true })
      if (seed === 'Local Storage') mkdirSync(join(dest, seed))
      else writeFileSync(join(dest, seed), 'MINE')

      expect(migrateUserData({ appData, userData: dest, argv: [] })).toBe('skipped')
      expect(existsSync(join(dest, MIGRATION_MARKER))).toBe(false)
      expect(existsSync(join(dest, 'helpers.json'))).toBe(false)
    }
  })

  it('refuses when the marker already exists in the destination', () => {
    const appData = scratch()
    seedLegacy(appData, 'Capy')
    const dest = join(appData, 'Harnu')
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, MIGRATION_MARKER), 'done')

    expect(migrateUserData({ appData, userData: dest, argv: [] })).toBe('skipped')
    expect(existsSync(join(dest, 'projects.json'))).toBe(false)
  })

  it('never overwrites an entry the dest already has', () => {
    const appData = scratch()
    seedLegacy(appData, 'Capy')
    const dest = join(appData, 'Harnu')
    // dest has helpers.json already (but no Local Storage / projects.json → guard passes)
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'helpers.json'), 'KEEP-ME')

    expect(migrateUserData({ appData, userData: dest, argv: [] })).toBe('migrated')
    expect(readFileSync(join(dest, 'helpers.json'), 'utf8')).toBe('KEEP-ME') // preserved
    expect(existsSync(join(dest, 'projects.json'))).toBe(true) // still migrated the rest
  })

  it('no-ops when there is no legacy dir', () => {
    const appData = scratch()
    const dest = join(appData, 'Harnu')
    expect(migrateUserData({ appData, userData: dest, argv: [] })).toBe('skipped')
    expect(existsSync(dest)).toBe(false)
  })

  it('keeps relative symlinks relative, so they survive removing the legacy dir', () => {
    const appData = scratch()
    const legacy = seedLegacy(appData, 'Capy')
    symlinkSync(join('skills', 'a.dat'), join(legacy, 'link-to-skill'))
    const dest = join(appData, 'Harnu')

    expect(migrateUserData({ appData, userData: dest, argv: [] })).toBe('migrated')
    expect(readlinkSync(join(dest, 'link-to-skill'))).toBe(join('skills', 'a.dat'))
    rmSync(legacy, { recursive: true, force: true })
    expect(readFileSync(join(dest, 'link-to-skill'), 'utf8')).toBe('skills')
  })

  it.skipIf(process.platform === 'win32')(
    'one uncopyable entry does not drop the rest, and still writes the marker',
    () => {
      const appData = scratch()
      const legacy = seedLegacy(appData, 'Capy')
      // cpSync refuses FIFOs; "0-" sorts first so it would abort a naive loop early.
      execFileSync('mkfifo', [join(legacy, '0-broken-fifo')])
      const dest = join(appData, 'Harnu')

      expect(migrateUserData({ appData, userData: dest, argv: [] })).toBe('error')
      expectWholeCopy(dest, 'Capy')
      expect(existsSync(join(dest, '0-broken-fifo'))).toBe(false)
    }
  )
})
