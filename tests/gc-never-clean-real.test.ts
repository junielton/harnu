// A never-clean path added AFTER the scan must hide Remove at once, and it must mean what main means by
// it: main compares real locations (an entry spelled through a symlink is the same folder as the worktree
// reached by its real spelling). The renderer cannot resolve symlinks, so main hands the snapshot bundles
// whose `neverClean` already reflects the CURRENT prefs on real paths.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { withCurrentNeverClean, isNeverClean } from '../src/main/gc/autopilot-core'
import { resolveRealPaths } from '../src/main/gc/gc-shell'
import { defaultGcPrefs } from '../src/main/gc/gc-prefs'
import { buildGcModel } from '../src/renderer/src/lib/gc-model'
import { removability } from '../src/renderer/src/lib/gc-removability'
import { bundle, NOW, reapItem } from './gc-fixtures'
import type { GcSnapshot } from '../src/main/gc/gc-wire'

let root: string
let real: string
let link: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'harnu-gc-nc-')))
  real = path.join(root, 'real', 'wt')
  link = path.join(root, 'link')
  mkdirSync(real, { recursive: true })
  symlinkSync(path.join(root, 'real'), link)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const review = (): ReturnType<typeof bundle> => ({
  ...bundle(real, 'review', { reason: { code: 'dirty', detail: 'x' } }),
  item: reapItem(real, { repoPath: path.join(root, 'repo') })
})

async function canonicalFor(paths: string[]) {
  return resolveRealPaths(paths, (p) => fs.realpath(p))
}

describe('withCurrentNeverClean', () => {
  it('an entry spelled through a symlink protects the worktree reached by its real path', async () => {
    const b = review()
    const prefs = { ...defaultGcPrefs(), neverClean: [path.join(link, 'wt')] }
    const canonical = await canonicalFor([real, ...prefs.neverClean, b.item.repoPath])
    // what a plain string comparison says, and what main says
    expect(isNeverClean(b, prefs)).toBe(false)
    expect(isNeverClean(b, prefs, canonical)).toBe(true)
    const [out] = withCurrentNeverClean([b], prefs, canonical)
    expect(out.neverClean).toBe(true)
  })

  it('leaves everything else exactly as it was (same objects)', async () => {
    const b = review()
    const prefs = { ...defaultGcPrefs(), neverClean: [path.join(root, 'elsewhere')] }
    const canonical = await canonicalFor([real, ...prefs.neverClean])
    expect(withCurrentNeverClean([b], prefs, canonical)[0]).toBe(b)
    expect(withCurrentNeverClean([b], defaultGcPrefs(), canonical)[0]).toBe(b)
  })

  it('end to end: the renderer model hides Remove for the symlinked entry', async () => {
    const b = review()
    const prefs = { ...defaultGcPrefs(), neverClean: [path.join(link, 'wt')] }
    const canonical = await canonicalFor([real, ...prefs.neverClean, b.item.repoPath])
    const snap: GcSnapshot = {
      scannedAt: NOW,
      bundles: withCurrentNeverClean([b], prefs, canonical),
      orphanVolumes: [],
      docker: { buildCacheReclaimableBytes: null, danglingImages: null },
      prefs,
      lastCycle: null,
      nextCycleAt: null
    }
    const block = buildGcModel(snap).byId.get(b.item.id)!
    expect(removability(block, NOW)).toEqual({ ok: false, reason: 'never-clean' })
  })
})
