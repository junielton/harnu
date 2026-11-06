// C4: a session that drifted into a folder other than the one its transcript is filed under makes
// that folder ineligible to shelve. The scan reports the folders whose transcripts are filed under
// a project slug that is not their own.

import { describe, expect, it } from 'vitest'
import { scanTranscripts, slugOfPath, type TranscriptProbe } from '../src/main/gc/gc-transcripts'

const NOW = Date.parse('2026-11-05T10:00:00Z')

const probeOf = (
  tree: Record<
    string,
    {
      index?: Array<{ projectPath?: string }> | null
      files?: Record<string, { mtimeMs: number; cwd: string | null }>
    }
  >
): TranscriptProbe => ({
  listProjectDirs: async () => Object.keys(tree),
  readIndex: async (slug) => tree[slug]?.index ?? null,
  listJsonl: async (slug) =>
    Object.entries(tree[slug]?.files ?? {}).map(([name, f]) => ({ name, mtimeMs: f.mtimeMs })),
  cwdOf: async (slug, name) => tree[slug]?.files?.[name]?.cwd ?? null
})

describe('scanTranscripts — drifted folders (C4)', () => {
  const repo = '/ws/org/proj/www'
  const wt = '/ws/org/proj/www-trees/feat-x'

  it('a transcript filed under the repo whose cwd is the worktree is a drift into the worktree', async () => {
    const scan = await scanTranscripts(
      probeOf({ [slugOfPath(repo)]: { files: { 'a.jsonl': { mtimeMs: 1, cwd: wt } } } }),
      NOW
    )
    expect(scan.drifted).toEqual([wt])
  })

  it('a transcript filed under its own folder is not a drift', async () => {
    const scan = await scanTranscripts(
      probeOf({ [slugOfPath(wt)]: { files: { 'a.jsonl': { mtimeMs: 1, cwd: wt } } } }),
      NOW
    )
    expect(scan.drifted).toEqual([])
  })

  it('a session started in a subfolder, filed under the subfolder, is not a drift', async () => {
    const scan = await scanTranscripts(
      probeOf({
        [slugOfPath(`${wt}/api`)]: { files: { 'a.jsonl': { mtimeMs: 1, cwd: `${wt}/api` } } }
      }),
      NOW
    )
    expect(scan.drifted).toEqual([])
  })

  it('an index entry whose project path belongs to another slug is a drift too', async () => {
    const scan = await scanTranscripts(
      probeOf({ [slugOfPath(repo)]: { index: [{ projectPath: wt }] } }),
      NOW
    )
    expect(scan.drifted).toEqual([wt])
  })

  it('a transcript with no readable cwd cannot be judged: it is not reported as a drift', async () => {
    const scan = await scanTranscripts(
      probeOf({ [slugOfPath(repo)]: { files: { 'a.jsonl': { mtimeMs: 1, cwd: null } } } }),
      NOW
    )
    expect(scan.drifted).toEqual([])
    expect(scan.bySlug).toHaveLength(1)
  })

  it('lists each drifted folder once', async () => {
    const scan = await scanTranscripts(
      probeOf({
        [slugOfPath(repo)]: {
          files: { 'a.jsonl': { mtimeMs: 1, cwd: wt }, 'b.jsonl': { mtimeMs: 2, cwd: wt } }
        }
      }),
      NOW
    )
    expect(scan.drifted).toEqual([wt])
  })
})
