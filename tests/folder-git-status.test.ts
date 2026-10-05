import { describe, it, expect, vi } from 'vitest'

// `folder-git-status.ts` imports `ipcMain` at module load.
vi.mock('electron', () => ({ ipcMain: { handle: (): void => {} } }))

import { countPorcelain, parseAheadBehind } from '../src/main/folder-git-status'

/**
 * T52 Slice 3 — the two pure parsers behind the hover card's expensive fields.
 * These are the only interpreted git output; the probe itself never throws.
 */

describe('countPorcelain', () => {
  it('counts one entry per non-empty porcelain line', () => {
    expect(countPorcelain(' M src/a.ts\n?? b.ts\nA  c.ts\n')).toBe(3)
  })
  it('is zero for a clean tree', () => {
    expect(countPorcelain('')).toBe(0)
    expect(countPorcelain('\n\n')).toBe(0)
  })
})

describe('parseAheadBehind', () => {
  it('parses "<behind>\\t<ahead>" (left = behind, right = ahead)', () => {
    expect(parseAheadBehind('2\t5\n')).toEqual({ behind: 2, ahead: 5 })
    expect(parseAheadBehind('0\t0')).toEqual({ behind: 0, ahead: 0 })
  })
  it('returns null on a malformed / short line', () => {
    expect(parseAheadBehind('')).toBeNull()
    expect(parseAheadBehind('3')).toBeNull()
    expect(parseAheadBehind('x\ty')).toBeNull()
  })
})
