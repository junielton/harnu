// Docker autonomy prefs (U3.1 AC-2, AC-3): its own switch, its own acknowledgement, independent of
// the autopilot and of shelving; ON by default but report-only until acknowledged; plus the global
// "pause autonomous cleanup" flag.

import { describe, expect, it } from 'vitest'
import {
  defaultGcPrefs,
  mergeIncomingPrefs,
  normalizeGcPrefs,
  withAcknowledged,
  withDockerAcknowledged,
  withDockerDisabled,
  withShelveAcknowledged,
  type GcPrefs
} from '../src/main/gc/gc-prefs'

const on = (over: Partial<GcPrefs['docker']> = {}): GcPrefs => {
  const p = defaultGcPrefs()
  return { ...p, docker: { ...p.docker, enabled: true, ...over } }
}

describe('docker autonomy prefs (AC-2)', () => {
  it('ships ON, unacknowledged, with the 2026-11-05 defaults', () => {
    expect(defaultGcPrefs().docker).toEqual({
      enabled: true,
      firstReportAcknowledged: false,
      idleHours: 2,
      lowWaterSlots: 3,
      maxParksPerHour: 6,
      minAgeMinutes: 30,
      maxPerCycle: 5,
      failureLimit: 3
    })
  })

  it('reads an old prefs file with no docker key as the defaults, even when shelve is set', () => {
    const old = {
      version: 1,
      autopilot: true,
      firstReportAcknowledged: true,
      shelve: { enabled: true, firstReportAcknowledged: true }
    }
    const read = normalizeGcPrefs(old)
    expect(read.docker).toEqual(defaultGcPrefs().docker)
    // The old acknowledgements do not leak into the new switch.
    expect(read.docker.firstReportAcknowledged).toBe(false)
    expect(read.shelve.firstReportAcknowledged).toBe(true)
  })

  it('a prefs file that never set the switch reads ON and cannot act before the acknowledgement', () => {
    const read = normalizeGcPrefs({ docker: { idleHours: 5 } }).docker
    expect(read.enabled).toBe(true)
    expect(read.firstReportAcknowledged).toBe(false)
    expect(read.idleHours).toBe(5)
  })

  it('a prefs file that explicitly turned it off keeps it off', () => {
    expect(normalizeGcPrefs({ docker: { enabled: false } }).docker.enabled).toBe(false)
    const written = JSON.parse(JSON.stringify(withDockerDisabled(defaultGcPrefs())))
    expect(normalizeGcPrefs(written).docker.enabled).toBe(false)
  })

  it('a missing or corrupt file reads the defaults: ON, report-only, not paused', () => {
    for (const junk of [null, undefined, 'junk', 42, []]) {
      const p = normalizeGcPrefs(junk)
      expect(p.docker.enabled).toBe(true)
      expect(p.docker.firstReportAcknowledged).toBe(false)
      expect(p.pauseAutonomous).toBe(false)
    }
  })

  it('clamps junk and out-of-range values', () => {
    const p = normalizeGcPrefs({
      docker: {
        enabled: 'yes',
        idleHours: 0,
        lowWaterSlots: 500,
        maxParksPerHour: 999,
        minAgeMinutes: -3,
        maxPerCycle: 999,
        failureLimit: -4
      }
    })
    expect(p.docker).toEqual({
      enabled: true, // 'yes' is not a boolean: the default (ON) stands
      firstReportAcknowledged: false,
      idleHours: 1,
      lowWaterSlots: 30,
      maxParksPerHour: 60,
      minAgeMinutes: 1,
      maxPerCycle: 20,
      failureLimit: 1
    })
    expect(normalizeGcPrefs({ docker: 'junk' }).docker).toEqual(defaultGcPrefs().docker)
  })

  it('is independent of the autopilot and of shelving, in both directions', () => {
    const base = defaultGcPrefs()
    expect(withAcknowledged({ ...base, autopilot: true }).docker).toEqual(base.docker)
    expect(withShelveAcknowledged(base).docker).toEqual(base.docker)
    const acked = withDockerAcknowledged(on())
    expect(acked.docker.firstReportAcknowledged).toBe(true)
    expect(acked.firstReportAcknowledged).toBe(false)
    expect(acked.shelve).toEqual(base.shelve)
    expect(acked.autopilot).toBe(false)
  })

  it('turning the switch on starts a new promise: the acknowledgement is taken away', () => {
    const acked = withDockerAcknowledged(on())
    const off = mergeIncomingPrefs(acked, { docker: { enabled: false } })
    expect(off.docker.firstReportAcknowledged).toBe(true) // turning off keeps it
    const next = mergeIncomingPrefs(off, { docker: { enabled: true } })
    expect(next.docker.enabled).toBe(true)
    expect(next.docker.firstReportAcknowledged).toBe(false)
  })

  it('after the kill switch, a stale form saving enabled:false changes nothing; a real toggle resets the ack', () => {
    const tripped = withDockerDisabled(withDockerAcknowledged(on()))
    const stale = mergeIncomingPrefs(tripped, { docker: { enabled: false, idleHours: 4 } })
    expect(stale.docker.enabled).toBe(false)
    expect(stale.docker.firstReportAcknowledged).toBe(true)
    const toggled = mergeIncomingPrefs(stale, { docker: { enabled: true } })
    expect(toggled.docker.firstReportAcknowledged).toBe(false)
  })

  it('a settings write can never acknowledge the Docker report', () => {
    const next = mergeIncomingPrefs(on(), { docker: { firstReportAcknowledged: true } })
    expect(next.docker.firstReportAcknowledged).toBe(false)
  })

  it('keeps an acknowledgement that a write did not touch', () => {
    const current = withDockerAcknowledged(on())
    const next = mergeIncomingPrefs(current, { docker: { idleHours: 6 } })
    expect(next.docker).toEqual({ ...current.docker, idleHours: 6 })
  })

  it('an invalid incoming Docker value falls back to the current one, not the default', () => {
    const current = on({ idleHours: 7 })
    expect(mergeIncomingPrefs(current, { docker: { idleHours: 'soon' } }).docker.idleHours).toBe(7)
  })

  it('a write about shelving or the autopilot leaves the Docker acknowledgement alone', () => {
    const current = withDockerAcknowledged(on())
    const next = mergeIncomingPrefs(current, { autopilot: true, shelve: { enabled: false } })
    expect(next.docker).toEqual(current.docker)
  })

  it('the kill switch turns Docker autonomy off and keeps everything else', () => {
    const current = withDockerAcknowledged(on({ idleHours: 4 }))
    expect(withDockerDisabled(current).docker).toEqual({ ...current.docker, enabled: false })
    expect(withDockerDisabled(current).shelve).toEqual(current.shelve)
  })
})

describe('global pause (AC-3)', () => {
  it('is off by default and survives a round trip', () => {
    expect(defaultGcPrefs().pauseAutonomous).toBe(false)
    const written = JSON.parse(JSON.stringify({ ...defaultGcPrefs(), pauseAutonomous: true }))
    expect(normalizeGcPrefs(written).pauseAutonomous).toBe(true)
  })

  it('reads a non-boolean as not paused', () => {
    expect(normalizeGcPrefs({ pauseAutonomous: 'yes' }).pauseAutonomous).toBe(false)
  })

  it('is writable from settings and touches no acknowledgement', () => {
    const current = withDockerAcknowledged(withShelveAcknowledged(on()))
    const paused = mergeIncomingPrefs(current, { pauseAutonomous: true })
    expect(paused.pauseAutonomous).toBe(true)
    expect(paused.docker.firstReportAcknowledged).toBe(true)
    expect(paused.shelve.firstReportAcknowledged).toBe(true)
    const resumed = mergeIncomingPrefs(paused, { pauseAutonomous: false })
    expect(resumed.pauseAutonomous).toBe(false)
    expect(resumed.docker.firstReportAcknowledged).toBe(true)
  })
})
