import { describe, expect, it } from 'vitest'
import { partitionShelved, type ShelvedSource } from '../src/renderer/src/lib/shelved-sidebar'

/**
 * BUG-262 AC-3 — `partitionShelved` normalized every folder path against every shelved entry
 * (O(folders x entries) regex passes, 325-408 ms in a live profile). Each path is now
 * normalized once; the result is identical.
 */

const NOW = Date.parse('2026-11-12T12:00:00.000Z')
const REPO = '/home/u/org/api-gateway'

function counted(path: string, hits: { n: number }): string {
  // A String subclass whose `replace` (the first step of normalizePath) is counted.
  const s = new String(path) as unknown as { replace: typeof String.prototype.replace }
  s.replace = function (...a: Parameters<typeof String.prototype.replace>) {
    hits.n++
    return String.prototype.replace.apply(path, a)
  } as typeof String.prototype.replace
  return s as unknown as string
}

describe('partitionShelved normalization cost (BUG-262 AC-3)', () => {
  it('normalizes each folder path and each shelved path once, not once per pair', () => {
    const hits = { n: 0 }
    const F = 60
    const E = 20
    const folders = Array.from({ length: F }, (_, i) => ({
      path: counted(`${REPO}-wt-${i}`, hits),
      repoId: `${REPO}/.git`,
      sessions: []
    }))
    const entries: ShelvedSource[] = Array.from({ length: E }, (_, i) => ({
      id: `sh-${i}`,
      repoPath: REPO,
      worktreePath: counted(`${REPO}-shelved-${i}`, hits),
      branch: `b${i}`,
      shelvedAt: NOW - i * 1000
    }))
    const out = partitionShelved(folders, entries, NOW)
    expect(out.live).toHaveLength(F)
    // Linear in folders + entries (small constant per path), never F x E.
    expect(hits.n).toBeLessThanOrEqual((F + E) * 2)
  })

  it('still pulls a folder inside a shelved worktree out of the live list', () => {
    const folders = [
      { path: `${REPO}-wt/api`, repoId: `${REPO}/.git`, sessions: [] },
      { path: `${REPO}-other`, repoId: `${REPO}/.git`, sessions: [] },
      { path: REPO, repoId: `${REPO}/.git`, isMainWorktree: true, sessions: [] }
    ]
    const entries: ShelvedSource[] = [
      { id: 'a', repoPath: REPO, worktreePath: `${REPO}-wt/`, branch: 'x', shelvedAt: NOW }
    ]
    const out = partitionShelved(folders, entries, NOW)
    expect(out.live.map((f) => f.path)).toEqual([`${REPO}-other`, REPO])
    expect(out.byRepo.get(`${REPO}/.git`)?.[0].id).toBe('a')
  })
})
