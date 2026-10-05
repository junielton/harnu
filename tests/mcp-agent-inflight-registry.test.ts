import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  tryReserveInFlight,
  attachSyntheticId,
  releaseInFlight,
  releaseIfCurrentHolder,
  isInFlight,
  inFlightSyntheticIdFor,
  inFlightFolderFor,
  _resetInFlightRegistry
} from '../src/main/mcp/agent-inflight-registry'

const HOME = '/home/u'

describe('agent-inflight-registry — single occupancy (AC3)', () => {
  beforeEach(() => _resetInFlightRegistry())
  afterEach(() => _resetInFlightRegistry())

  it('reserves a fresh folder', () => {
    expect(tryReserveInFlight('/home/u/repo', HOME)).toBe(true)
    expect(isInFlight('/home/u/repo', HOME)).toBe(true)
  })

  it('refuses a second reserve for a folder already occupied', () => {
    expect(tryReserveInFlight('/home/u/repo', HOME)).toBe(true)
    expect(tryReserveInFlight('/home/u/repo', HOME)).toBe(false)
  })

  it('release frees the folder for a fresh reserve', () => {
    tryReserveInFlight('/home/u/repo', HOME)
    releaseInFlight('/home/u/repo', HOME)
    expect(isInFlight('/home/u/repo', HOME)).toBe(false)
    expect(tryReserveInFlight('/home/u/repo', HOME)).toBe(true)
  })

  it('release is idempotent on an unreserved folder', () => {
    expect(() => releaseInFlight('/home/u/never-reserved', HOME)).not.toThrow()
  })

  it('normalizes folder paths the same way on reserve/release/query', () => {
    expect(tryReserveInFlight('/home/u/repo/', HOME)).toBe(true)
    expect(isInFlight('/home/u/repo', HOME)).toBe(true)
    releaseInFlight('/home/u/repo', HOME)
    expect(isInFlight('/home/u/repo/', HOME)).toBe(false)
  })

  it('two different folders do not contend', () => {
    expect(tryReserveInFlight('/home/u/repo-a', HOME)).toBe(true)
    expect(tryReserveInFlight('/home/u/repo-b', HOME)).toBe(true)
  })
})

describe('agent-inflight-registry — syntheticId lookup (AC5 wiring)', () => {
  beforeEach(() => _resetInFlightRegistry())
  afterEach(() => _resetInFlightRegistry())

  it('has no syntheticId until attached', () => {
    tryReserveInFlight('/home/u/repo', HOME)
    expect(inFlightSyntheticIdFor('/home/u/repo', HOME)).toBeUndefined()
  })

  it('exposes the attached syntheticId both by folder and reverse', () => {
    tryReserveInFlight('/home/u/repo', HOME)
    attachSyntheticId('/home/u/repo', 'synthetic-1', HOME)
    expect(inFlightSyntheticIdFor('/home/u/repo', HOME)).toBe('synthetic-1')
    expect(inFlightFolderFor('synthetic-1')).toBe('/home/u/repo')
  })

  it('attaching to an unreserved folder is a no-op (never fabricates occupancy)', () => {
    attachSyntheticId('/home/u/never-reserved', 'synthetic-x', HOME)
    expect(isInFlight('/home/u/never-reserved', HOME)).toBe(false)
    expect(inFlightFolderFor('synthetic-x')).toBeUndefined()
  })

  it('release clears the reverse syntheticId lookup too', () => {
    tryReserveInFlight('/home/u/repo', HOME)
    attachSyntheticId('/home/u/repo', 'synthetic-1', HOME)
    releaseInFlight('/home/u/repo', HOME)
    expect(inFlightFolderFor('synthetic-1')).toBeUndefined()
  })
})

describe('agent-inflight-registry — releaseIfCurrentHolder (BUG-58)', () => {
  beforeEach(() => _resetInFlightRegistry())
  afterEach(() => _resetInFlightRegistry())

  it('releases the reservation when the syntheticId is still the current holder', () => {
    tryReserveInFlight('/home/u/repo', HOME)
    attachSyntheticId('/home/u/repo', 'synthetic-1', HOME)
    releaseIfCurrentHolder('/home/u/repo', 'synthetic-1', HOME)
    expect(isInFlight('/home/u/repo', HOME)).toBe(false)
    expect(tryReserveInFlight('/home/u/repo', HOME)).toBe(true)
  })

  it('is a no-op when the reservation was already released (ordinary materialize-in-time path)', () => {
    tryReserveInFlight('/home/u/repo', HOME)
    attachSyntheticId('/home/u/repo', 'synthetic-1', HOME)
    releaseInFlight('/home/u/repo', HOME)
    expect(() => releaseIfCurrentHolder('/home/u/repo', 'synthetic-1', HOME)).not.toThrow()
    expect(isInFlight('/home/u/repo', HOME)).toBe(false)
  })

  it('does NOT release a reservation now held by a different (newer) syntheticId', () => {
    tryReserveInFlight('/home/u/repo', HOME)
    attachSyntheticId('/home/u/repo', 'synthetic-stale', HOME)
    releaseInFlight('/home/u/repo', HOME)
    // A new spawn claims the same folder before the stale one's eviction runs.
    tryReserveInFlight('/home/u/repo', HOME)
    attachSyntheticId('/home/u/repo', 'synthetic-new', HOME)

    releaseIfCurrentHolder('/home/u/repo', 'synthetic-stale', HOME)

    expect(isInFlight('/home/u/repo', HOME)).toBe(true)
    expect(inFlightSyntheticIdFor('/home/u/repo', HOME)).toBe('synthetic-new')
  })

  it('is a no-op on a folder with no syntheticId attached yet', () => {
    tryReserveInFlight('/home/u/repo', HOME)
    releaseIfCurrentHolder('/home/u/repo', 'synthetic-1', HOME)
    expect(isInFlight('/home/u/repo', HOME)).toBe(true)
  })
})
