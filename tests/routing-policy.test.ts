import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * T97 — per-repo model routing policy. `resolveRouting` is the pure
 * precedence (kind → table row → hardcoded default) the confirm UI, the
 * manifest drain, and the folder-settings editor all share; the persistence
 * tests pin the glue (JSON file + deterministic folder key) the same way
 * `claude-config.test.ts` does for the sibling Claude Boot store.
 */

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: (): string => h.userDataDir },
  ipcMain: { handle: (): void => {} }
}))

import {
  resolveRouting,
  formatDispatchedWith,
  getFolderRoutingTable,
  setFolderRoutingTable,
  resolveFolderRouting,
  HARDCODED_ROUTING_DEFAULTS,
  type RoutingTable
} from '../src/main/routing-policy'

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

beforeEach(async () => {
  h.userDataDir = await tmpDir('harnu-routing-')
})

describe('resolveRouting (pure precedence: kind → table → hardcoded default)', () => {
  it('kind hit: a byKind entry for the card kind wins', () => {
    const table: RoutingTable = { byKind: { bug: { model: 'opus', effort: 'max' } } }
    expect(resolveRouting(table, 'bug')).toEqual({ model: 'opus', effort: 'max' })
  })

  it('no kind: folds back to the "feature" preset', () => {
    expect(resolveRouting({}, undefined)).toEqual(HARDCODED_ROUTING_DEFAULTS.feature)
    expect(resolveRouting(undefined, undefined)).toEqual(HARDCODED_ROUTING_DEFAULTS.feature)
  })

  it('empty table: every kind falls through to its hardcoded default', () => {
    expect(resolveRouting({}, 'scout')).toEqual(HARDCODED_ROUTING_DEFAULTS.scout)
    expect(resolveRouting({}, 'review')).toEqual(HARDCODED_ROUTING_DEFAULTS.review)
    expect(resolveRouting({}, 'chore')).toEqual(HARDCODED_ROUTING_DEFAULTS.chore)
  })

  it('an unrecognized kind string folds back to "feature", same as absent', () => {
    expect(resolveRouting({}, 'not-a-real-kind')).toEqual(HARDCODED_ROUTING_DEFAULTS.feature)
  })

  it('table.default covers a kind with no byKind row, before the hardcoded fallback', () => {
    const table: RoutingTable = { default: { model: 'fable', effort: 'medium' } }
    expect(resolveRouting(table, 'chore')).toEqual({ model: 'fable', effort: 'medium' })
  })

  it('a partial entry (only model, no effort) is incomplete and falls through', () => {
    const table: RoutingTable = { byKind: { review: { model: 'haiku' } } }
    expect(resolveRouting(table, 'review')).toEqual(HARDCODED_ROUTING_DEFAULTS.review)
  })

  it('byKind wins over table.default when both are set for the same kind', () => {
    const table: RoutingTable = {
      byKind: { bug: { model: 'haiku', effort: 'low' } },
      default: { model: 'opus', effort: 'max' }
    }
    expect(resolveRouting(table, 'bug')).toEqual({ model: 'haiku', effort: 'low' })
  })
})

describe('formatDispatchedWith (the audit line — "override recorded")', () => {
  it('formats the resolved default', () => {
    expect(formatDispatchedWith(HARDCODED_ROUTING_DEFAULTS.scout)).toBe(
      'dispatched-with: haiku·low'
    )
  })

  it('formats whatever value it is given, not a re-resolved default — an operator override at dispatch time is recorded VERBATIM', () => {
    // A value that matches no kind's hardcoded default at all — proves the audit
    // line reflects the actual override, never silently substituting the table.
    expect(formatDispatchedWith({ model: 'fable', effort: 'xhigh' })).toBe(
      'dispatched-with: fable·xhigh'
    )
  })
})

describe('folder routing-table persistence (mirrors claude-config.test.ts)', () => {
  it('no table on disk → empty object', async () => {
    expect(await getFolderRoutingTable('/some/dir')).toEqual({})
  })

  it('round-trips a saved table, keyed by the deterministic folder path', async () => {
    const folder = await tmpDir('harnu-routing-proj-')
    const table: RoutingTable = {
      byKind: { scout: { model: 'haiku', effort: 'low' }, review: { model: 'opus', effort: 'max' } }
    }
    await setFolderRoutingTable(folder, table)
    expect(await getFolderRoutingTable(folder)).toEqual(table)
    // A different folder never sees another folder's table.
    expect(await getFolderRoutingTable('/other/dir')).toEqual({})
  })

  it('saving an empty table prunes the folder entry back to nothing', async () => {
    const folder = await tmpDir('harnu-routing-proj-')
    await setFolderRoutingTable(folder, { byKind: { bug: { model: 'sonnet', effort: 'high' } } })
    expect(await getFolderRoutingTable(folder)).not.toEqual({})
    await setFolderRoutingTable(folder, {})
    expect(await getFolderRoutingTable(folder)).toEqual({})
  })

  it('sanitizes a partial/garbage row rather than persisting it as complete', async () => {
    const folder = await tmpDir('harnu-routing-proj-')
    await setFolderRoutingTable(folder, {
      byKind: {
        // @ts-expect-error — deliberately malformed input, mirrors an on-disk edit
        bug: { model: 42, effort: 'high' }
      }
    })
    // The non-string `model` is dropped; only `effort` survives on the row.
    expect(await getFolderRoutingTable(folder)).toEqual({ byKind: { bug: { effort: 'high' } } })
  })
})

describe('resolveFolderRouting (the function BOTH dispatch paths call)', () => {
  it('reads the folder table fresh and applies the same precedence as resolveRouting', async () => {
    const folder = await tmpDir('harnu-routing-proj-')
    await setFolderRoutingTable(folder, { byKind: { feature: { model: 'opus', effort: 'high' } } })

    expect(await resolveFolderRouting(folder, 'feature')).toEqual({ model: 'opus', effort: 'high' })
    // No kind on the card folds to the feature preset — same row applies here too.
    expect(await resolveFolderRouting(folder, undefined)).toEqual({ model: 'opus', effort: 'high' })
    // A kind with no row in this folder's table falls to the hardcoded default.
    expect(await resolveFolderRouting(folder, 'scout')).toEqual(HARDCODED_ROUTING_DEFAULTS.scout)
  })
})
