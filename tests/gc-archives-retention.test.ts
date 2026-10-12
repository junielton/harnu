// AC-C2: archive retention. The setting ("Keep archives for N days", default 30), who may delete
// what (the operator on a confirmed list; the autopilot only when "Expire archives automatically"
// is on), and that deleting refs never implies `git gc`.

import { describe, expect, it, vi } from 'vitest'
import {
  defaultGcPrefs,
  mergeIncomingPrefs,
  normalizeGcPrefs,
  MAX_ARCHIVE_KEEP_DAYS
} from '../src/main/gc/gc-prefs'
import { confirmedArchives, groupArchiveRefs } from '../src/main/gc/archives-core'
import { createCycleState, runGcCycle, type GcCycleDeps } from '../src/main/gc/gc-cycle'
import { createJobQueue } from '../src/main/gc/gc-jobs-core'
import type { CycleRecord } from '../src/main/gc/gc-wire'
import { NOW } from './gc-fixtures'

describe('retention prefs', () => {
  it('default to keeping archives for 30 days and NOT expiring them automatically', () => {
    const d = defaultGcPrefs()
    expect(d.archiveKeepDays).toBe(30)
    expect(d.archiveAutoExpire).toBe(false)
  })

  it('clamp the days to a sane range and ignore junk', () => {
    expect(normalizeGcPrefs({ archiveKeepDays: 0 }).archiveKeepDays).toBe(1)
    expect(normalizeGcPrefs({ archiveKeepDays: 99_999 }).archiveKeepDays).toBe(
      MAX_ARCHIVE_KEEP_DAYS
    )
    expect(normalizeGcPrefs({ archiveKeepDays: 45.6 }).archiveKeepDays).toBe(46)
    expect(normalizeGcPrefs({ archiveKeepDays: 'soon' }).archiveKeepDays).toBe(30)
    expect(normalizeGcPrefs({ archiveAutoExpire: 'yes' }).archiveAutoExpire).toBe(false)
  })

  it('a partial write from the settings form changes only what it names', () => {
    const current = { ...defaultGcPrefs(), archiveKeepDays: 14, archiveAutoExpire: true }
    const next = mergeIncomingPrefs(current, { graceDays: 3 })
    expect(next).toMatchObject({ archiveKeepDays: 14, archiveAutoExpire: true, graceDays: 3 })
    expect(mergeIncomingPrefs(current, { archiveAutoExpire: false }).archiveAutoExpire).toBe(false)
  })
})

describe('confirmedArchives: the operator deletes what they were shown, not what is there now', () => {
  const sha = (c: string): string => c.repeat(40)
  const fresh = groupArchiveRefs('/ws/repo', [
    { ref: 'refs/archive/a/20260801T000000Z/tip', sha: sha('a'), at: 0 },
    { ref: 'refs/archive/a/20260801T000000Z/wip', sha: sha('b'), at: 0 },
    { ref: 'refs/archive/b/20260802T000000Z/tip', sha: sha('c'), at: 0 }
  ])

  it('keeps an entry whose namespace and shas are exactly what was confirmed', () => {
    const r = confirmedArchives(fresh, [
      { namespace: 'refs/archive/a/20260801T000000Z', tipSha: sha('a'), wipSha: sha('b') }
    ])
    expect(r.entries.map((e) => e.namespace)).toEqual(['refs/archive/a/20260801T000000Z'])
    expect(r.changed).toEqual([])
  })

  it('refuses one whose ref moved since the list, and one that no longer exists', () => {
    const r = confirmedArchives(fresh, [
      { namespace: 'refs/archive/a/20260801T000000Z', tipSha: sha('z'), wipSha: sha('b') },
      { namespace: 'refs/archive/gone/20260101T000000Z', tipSha: sha('a'), wipSha: null }
    ])
    expect(r.entries).toEqual([])
    expect(r.changed).toEqual([
      'refs/archive/a/20260801T000000Z',
      'refs/archive/gone/20260101T000000Z'
    ])
  })

  it('a wip that appeared since the list is not confirmed (the operator never saw it)', () => {
    const r = confirmedArchives(fresh, [
      { namespace: 'refs/archive/a/20260801T000000Z', tipSha: sha('a'), wipSha: null }
    ])
    expect(r.entries).toEqual([])
  })

  it('ignores duplicates in the request', () => {
    const req = { namespace: 'refs/archive/b/20260802T000000Z', tipSha: sha('c'), wipSha: null }
    expect(confirmedArchives(fresh, [req, req]).entries).toHaveLength(1)
  })
})

describe('the autopilot expires archives only when told to', () => {
  const live = (over: Record<string, unknown> = {}) => ({
    ...defaultGcPrefs(),
    autopilot: true,
    firstReportAcknowledged: true,
    ...over
  })

  function rig(prefs: ReturnType<typeof live>, expire: GcCycleDeps['expireArchives']) {
    const cycles: CycleRecord[] = []
    const notices: string[] = []
    let n = 0
    const deps: GcCycleDeps = {
      prefs: () => prefs,
      gather: async () => ({
        bundles: [],
        housekeeping: {
          volumes: [],
          containers: [],
          dirExists: () => true,
          knownFolders: [],
          protectedProjects: new Set()
        }
      }),
      opsFor: () => {
        throw new Error('nothing to clean: no ops needed')
      },
      queue: createJobQueue({
        newId: () => `job-${++n}`,
        emitProgress: () => undefined,
        emitDone: () => undefined
      }),
      housekeeping: async () => ({ buildCacheBytes: 0, imageBytes: 0, volumeBytes: 0, errors: [] }),
      notify: (x) => notices.push(x.body),
      emitCycle: (r) => cycles.push(r),
      expireArchives: expire,
      state: createCycleState(),
      now: () => NOW
    }
    return { deps, cycles, notices }
  }

  it('does not touch archives while "Expire archives automatically" is off (the default)', async () => {
    const expire = vi.fn(async () => ({ deleted: 2, failed: 0 }))
    const r = rig(live(), expire)
    const rec = await runGcCycle(r.deps, 'timer')
    expect(expire).not.toHaveBeenCalled()
    expect(rec.archivesExpired).toBe(0)
  })

  it('expires with the retention from the prefs when it is on', async () => {
    const expire = vi.fn(async () => ({ deleted: 3, failed: 0 }))
    const r = rig(live({ archiveAutoExpire: true, archiveKeepDays: 14 }), expire)
    const rec = await runGcCycle(r.deps, 'timer')
    expect(expire).toHaveBeenCalledWith(14, NOW)
    expect(rec.archivesExpired).toBe(3)
    expect(r.notices).toEqual([
      'Deleted 3 archive refs older than 14 days. Git reclaims their space on its next gc.'
    ])
  })

  it('stays out of it before the first report is acknowledged, and with the autopilot off', async () => {
    const expire = vi.fn(async () => ({ deleted: 3, failed: 0 }))
    await runGcCycle(
      rig(live({ archiveAutoExpire: true, firstReportAcknowledged: false }), expire).deps,
      'timer'
    )
    await runGcCycle(rig(live({ archiveAutoExpire: true, autopilot: false }), expire).deps, 'timer')
    expect(expire).not.toHaveBeenCalled()
  })

  it('a failure there never fails the cycle', async () => {
    const expire = vi.fn(async () => {
      throw new Error('git: index.lock exists')
    })
    const r = rig(live({ archiveAutoExpire: true }), expire)
    const rec = await runGcCycle(r.deps, 'timer')
    expect(rec.archivesExpired).toBe(0)
    expect(r.cycles).toHaveLength(1)
  })
})
