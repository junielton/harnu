import { describe, it, expect, vi } from 'vitest'
import * as os from 'node:os'

// `review-viewed.ts` reaches for `app.getPath('userData')` for its own JSON
// file. Only the PURE half is exercised here; the fs/`gh` half is env-bound and
// e2e-only per ADR-0001, exactly like `review-ipc.ts`.
vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir() },
  ipcMain: { handle: (): void => {} }
}))

import {
  MAX_PENDING_PUSHES,
  parseViewedStates,
  planPendingPushes,
  pruneMarks,
  resolveViewed,
  resolveViewedFiles,
  sanitizeFolderMarks,
  type FolderMarks,
  type LocalMark,
  type RemoteViewedState
} from '../src/main/review-viewed'
import { parseUnifiedDiff } from '../src/main/review-core'

/**
 * T243 — the viewed mark's pure core.
 *
 * The two decisions this card exists to encode are both here, and both are
 * tested as rules rather than as examples:
 *
 *  - **Precedence.** It is a sync direction, not a conflict: GitHub wins
 *    whenever a PR is known, `DISMISSED` wins over a local `VIEWED`, and a
 *    local mark against a remote `UNVIEWED` is an unsynced WRITE, never a
 *    disagreement.
 *  - **Invalidation.** The local mark keys on the file's BLOB SHA, so exactly
 *    the files that changed lose their mark. Keying on the head SHA would cost
 *    the operator the whole review on any commit anywhere.
 */

const mark = (over: Partial<LocalMark> = {}): LocalMark => ({
  blob: 'aaaa111',
  at: 1_700_000_000_000,
  pending: false,
  ...over
})

describe('resolveViewed — precedence', () => {
  it('GitHub wins whenever it has an opinion', () => {
    expect(resolveViewed({ local: undefined, currentBlob: 'aaaa111', remote: 'VIEWED' })).toBe(
      'viewed'
    )
    expect(resolveViewed({ local: mark(), currentBlob: 'aaaa111', remote: 'VIEWED' })).toBe(
      'viewed'
    )
  })

  /**
   * The ONE real conflict, and the reason the rule is written this way round:
   * GitHub is carrying a fact the local side is structurally incapable of
   * knowing — that the file moved after it was read.
   */
  it('DISMISSED beats a local VIEWED, even a fresh one', () => {
    expect(resolveViewed({ local: mark(), currentBlob: 'aaaa111', remote: 'DISMISSED' })).toBe(
      'dismissed'
    )
  })

  it('local VIEWED against remote UNVIEWED is an unsynced write, not a disagreement', () => {
    expect(resolveViewed({ local: mark(), currentBlob: 'aaaa111', remote: 'UNVIEWED' })).toBe(
      'pending'
    )
    expect(resolveViewed({ local: undefined, currentBlob: 'aaaa111', remote: 'UNVIEWED' })).toBe(
      'unviewed'
    )
  })

  it('a local mark whose blob moved is NOT pushed up as viewed', () => {
    expect(resolveViewed({ local: mark(), currentBlob: 'bbbb222', remote: 'UNVIEWED' })).toBe(
      'unviewed'
    )
  })
})

describe('resolveViewed — local-only, where GitHub has no opinion', () => {
  it('a valid mark reads as viewed', () => {
    expect(resolveViewed({ local: mark(), currentBlob: 'aaaa111', remote: null })).toBe('viewed')
  })

  it('a mark that failed to push reads as pending, never as synced (AC-6)', () => {
    expect(
      resolveViewed({ local: mark({ pending: true }), currentBlob: 'aaaa111', remote: null })
    ).toBe('pending')
  })

  /**
   * `DISMISSED`'s semantics, reproduced locally — the whole reason the key is
   * the blob SHA. On the head SHA this same case would invalidate every OTHER
   * file too, and one commit would cost the operator the entire review.
   */
  it('a mark whose blob moved reads as dismissed — read, then it changed', () => {
    expect(resolveViewed({ local: mark(), currentBlob: 'bbbb222', remote: null })).toBe('dismissed')
  })

  it('no mark reads as unviewed', () => {
    expect(resolveViewed({ local: undefined, currentBlob: 'aaaa111', remote: null })).toBe(
      'unviewed'
    )
  })

  it('a file with no index line at all (a pure rename) still holds a mark', () => {
    expect(resolveViewed({ local: mark({ blob: '' }), currentBlob: null, remote: null })).toBe(
      'viewed'
    )
  })
})

describe('resolveViewedFiles — invalidation is PER FILE, never wholesale (AC-5)', () => {
  const files = [
    { path: 'src/a.ts', blobSha: 'aaaa111' },
    { path: 'src/b.ts', blobSha: 'bbbb222' },
    { path: 'src/c.ts', blobSha: 'cccc333' }
  ]
  const marks: FolderMarks = {
    'src/a.ts': mark({ blob: 'aaaa111' }),
    'src/b.ts': mark({ blob: 'bbbb222' }),
    'src/c.ts': mark({ blob: 'cccc333' })
  }

  it('one file changing invalidates that file and nothing else', () => {
    const moved = files.map((f) => (f.path === 'src/b.ts' ? { ...f, blobSha: 'ffff999' } : f))
    expect(resolveViewedFiles(moved, marks, null)).toEqual({
      'src/a.ts': 'viewed',
      'src/b.ts': 'dismissed',
      'src/c.ts': 'viewed'
    })
  })

  it('a mixed remote answer is applied per file', () => {
    const remote: Record<string, RemoteViewedState> = {
      'src/a.ts': 'DISMISSED',
      'src/b.ts': 'VIEWED',
      'src/c.ts': 'UNVIEWED'
    }
    expect(resolveViewedFiles(files, marks, remote)).toEqual({
      'src/a.ts': 'dismissed',
      'src/b.ts': 'viewed',
      'src/c.ts': 'pending'
    })
  })
})

describe('planPendingPushes', () => {
  const files = [
    { path: 'src/a.ts', blobSha: 'aaaa111' },
    { path: 'src/b.ts', blobSha: 'bbbb222' },
    { path: 'src/c.ts', blobSha: 'cccc333' }
  ]

  it('pushes only the pending, still-valid marks GitHub calls UNVIEWED', () => {
    const marks: FolderMarks = {
      'src/a.ts': mark({ blob: 'aaaa111', pending: true }),
      'src/b.ts': mark({ blob: 'STALE', pending: true }),
      'src/c.ts': mark({ blob: 'cccc333', pending: false })
    }
    const remote: Record<string, RemoteViewedState> = {
      'src/a.ts': 'UNVIEWED',
      'src/b.ts': 'UNVIEWED',
      'src/c.ts': 'UNVIEWED'
    }
    expect(planPendingPushes(files, marks, remote)).toEqual(['src/a.ts'])
  })

  it('never asserts a read of bytes the operator did not read', () => {
    const marks: FolderMarks = { 'src/a.ts': mark({ blob: 'OLD', pending: true }) }
    expect(planPendingPushes(files, marks, { 'src/a.ts': 'UNVIEWED' })).toEqual([])
  })

  it('plans nothing when GitHub was never read', () => {
    const marks: FolderMarks = { 'src/a.ts': mark({ pending: true }) }
    expect(planPendingPushes(files, marks, null)).toEqual([])
  })

  it('is capped, so one refresh cannot become a hundred round-trips', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.ts`, blobSha: 'x' }))
    const marks: FolderMarks = Object.fromEntries(
      many.map((f) => [f.path, mark({ blob: 'x', pending: true })])
    )
    const remote = Object.fromEntries(many.map((f) => [f.path, 'UNVIEWED' as RemoteViewedState]))
    expect(planPendingPushes(many, marks, remote)).toHaveLength(MAX_PENDING_PUSHES)
  })
})

describe('pruneMarks + sanitizeFolderMarks', () => {
  const now = 1_800_000_000_000

  it('drops marks older than the TTL', () => {
    const marks: FolderMarks = {
      fresh: mark({ at: now - 1000 }),
      ancient: mark({ at: now - 400 * 24 * 60 * 60 * 1000 })
    }
    expect(Object.keys(pruneMarks(marks, now))).toEqual(['fresh'])
  })

  it('keeps the newest marks when a folder grows past the cap', () => {
    const marks: FolderMarks = Object.fromEntries(
      Array.from({ length: 2100 }, (_, i) => [`f${i}.ts`, mark({ at: now - i })])
    )
    const pruned = pruneMarks(marks, now)
    expect(Object.keys(pruned)).toHaveLength(2000)
    expect(pruned['f0.ts']).toBeDefined()
    expect(pruned['f2099.ts']).toBeUndefined()
  })

  it('a corrupt entry drops rather than throwing', () => {
    expect(
      sanitizeFolderMarks({ ok: { blob: 'a', at: 1, pending: true }, bad: 7, worse: null })
    ).toEqual({ ok: { blob: 'a', at: 1, pending: true } })
    expect(sanitizeFolderMarks('nonsense')).toEqual({})
    expect(sanitizeFolderMarks(null)).toEqual({})
  })
})

describe('parseViewedStates', () => {
  const payload = (
    nodes: unknown[],
    hasNextPage = false,
    endCursor: string | null = null
  ): string =>
    JSON.stringify({
      data: { node: { files: { pageInfo: { hasNextPage, endCursor }, nodes } } }
    })

  it('reads path → viewerViewedState', () => {
    const out = parseViewedStates(
      payload([
        { path: 'src/a.ts', viewerViewedState: 'VIEWED' },
        { path: 'src/b.ts', viewerViewedState: 'DISMISSED' },
        { path: 'src/c.ts', viewerViewedState: 'UNVIEWED' }
      ])
    )
    expect(out?.states).toEqual({
      'src/a.ts': 'VIEWED',
      'src/b.ts': 'DISMISSED',
      'src/c.ts': 'UNVIEWED'
    })
    expect(out?.endCursor).toBeNull()
  })

  it('reports the next cursor only when there IS a next page', () => {
    expect(parseViewedStates(payload([], true, 'CUR'))?.endCursor).toBe('CUR')
    expect(parseViewedStates(payload([], false, 'CUR'))?.endCursor).toBeNull()
  })

  it('skips an unrecognised state rather than inventing one', () => {
    const out = parseViewedStates(payload([{ path: 'a', viewerViewedState: 'WAT' }]))
    expect(out?.states).toEqual({})
  })

  /** `null` means "GitHub has no opinion we can trust" — the local-only path. */
  it('degrades to null on garbage instead of throwing', () => {
    expect(parseViewedStates('not json')).toBeNull()
    expect(parseViewedStates('{"data":{"node":null}}')).toBeNull()
    expect(
      parseViewedStates(JSON.stringify({ errors: [{ message: 'Bad credentials' }] }))
    ).toBeNull()
  })
})

describe('the blob SHA is captured from the diff git already prints (AC-5)', () => {
  it('reads the POST-image blob off the `index` line', () => {
    const files = parseUnifiedDiff(
      'diff --git a/src/a.ts b/src/a.ts\n' +
        'index 72e4c0d..09c0600 100644\n' +
        '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n one\n+two\n'
    )
    expect(files[0].blobSha).toBe('09c0600')
  })

  it('a pure rename with no content change carries no blob, and that is not an error', () => {
    const files = parseUnifiedDiff(
      'diff --git a/src/a.ts b/src/b.ts\n' +
        'similarity index 100%\n' +
        'rename from src/a.ts\n' +
        'rename to src/b.ts\n'
    )
    expect(files[0].blobSha).toBeNull()
    expect(files[0].status).toBe('renamed')
  })

  it('does not mistake `similarity index 100%` for the index line', () => {
    const files = parseUnifiedDiff(
      'diff --git a/src/a.ts b/src/b.ts\n' +
        'similarity index 87%\n' +
        'rename from src/a.ts\n' +
        'rename to src/b.ts\n' +
        'index 1111111..2222222 100644\n' +
        '--- a/src/a.ts\n+++ b/src/b.ts\n@@ -1,1 +1,1 @@\n-one\n+two\n'
    )
    expect(files[0].blobSha).toBe('2222222')
  })

  it('a deleted file still gets a stable key', () => {
    const files = parseUnifiedDiff(
      'diff --git a/src/a.ts b/src/a.ts\n' +
        'deleted file mode 100644\n' +
        'index 1111111..0000000\n' +
        '--- a/src/a.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-one\n'
    )
    expect(files[0].blobSha).toBe('0000000')
  })
})
