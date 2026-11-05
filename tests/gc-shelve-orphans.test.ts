// A shelved worktree's folder is missing on purpose. Its transcripts are NOT orphans, even when
// everything else says "gone" (U2.2 AC-5, design C3).

import { describe, expect, it } from 'vitest'
import {
  planOrphanTranscripts,
  type OrphanProbe,
  type SlugFacts
} from '../src/main/gc/gc-orphan-transcripts'
import { slugOfPath } from '../src/main/gc/gc-transcripts'
import { NOW } from './gc-fixtures'

const SHELVED = '/nonexistent/u22/org/proj/www-trees/feat-x'
const GONE = '/nonexistent/u22/org/proj/www-trees/really-gone'

function facts(slug: string, cwds: Array<string | null>): SlugFacts {
  return {
    slug,
    files: cwds.map((cwd, i) => ({
      name: `s${i}.jsonl`,
      sessionId: `s${i}-${slug}`,
      bytes: 1_000,
      mtimeMs: NOW - (i + 3) * 86_400_000,
      cwd
    })),
    extraBytes: 0,
    hasMemory: false
  }
}

const probeOf = (...slugs: SlugFacts[]): OrphanProbe => ({
  listSlugs: async () => slugs.map((s) => s.slug),
  readSlug: async (slug) => slugs.find((s) => s.slug === slug)!
})

const base = {
  exists: async (): Promise<'missing'> => 'missing',
  protectedSessionIds: new Set<string>(),
  protectedFolders: [] as string[],
  repoPaths: ['/nonexistent/u22/org/proj/www'],
  // Everything that is missing is "proven gone": the worst case for a shelved folder.
  proof: () => true,
  now: NOW
}

describe('orphan transcripts and shelved folders', () => {
  it('control: without the shelved entry the missing, proven-gone folder IS an orphan', async () => {
    const items = await planOrphanTranscripts({
      ...base,
      probe: probeOf(facts(slugOfPath(SHELVED), [SHELVED]))
    })
    expect(items.map((i) => i.slug)).toEqual([slugOfPath(SHELVED)])
    expect(items[0]!.proof).toBe('proven')
  })

  it('the transcripts of a shelved worktree are not orphans', async () => {
    const items = await planOrphanTranscripts({
      ...base,
      probe: probeOf(facts(slugOfPath(SHELVED), [SHELVED])),
      shelvedFolders: [SHELVED]
    })
    expect(items).toEqual([])
  })

  it('nor are those of a subfolder session started inside it', async () => {
    const sub = `${SHELVED}/api`
    const items = await planOrphanTranscripts({
      ...base,
      probe: probeOf(facts(slugOfPath(sub), [sub])),
      shelvedFolders: [SHELVED]
    })
    expect(items).toEqual([])
  })

  it('a transcript filed elsewhere whose cwd is the shelved folder is not an orphan either', async () => {
    const items = await planOrphanTranscripts({
      ...base,
      probe: probeOf(facts('-filed-under-the-repo', [SHELVED])),
      shelvedFolders: [SHELVED]
    })
    expect(items).toEqual([])
  })

  it('a different, really gone folder next to it is still listed', async () => {
    const items = await planOrphanTranscripts({
      ...base,
      probe: probeOf(facts(slugOfPath(SHELVED), [SHELVED]), facts(slugOfPath(GONE), [GONE])),
      shelvedFolders: [SHELVED]
    })
    expect(items.map((i) => i.slug)).toEqual([slugOfPath(GONE)])
  })

  it('slugs are lossy: a sibling whose slug continues a shelved one is kept too (the safe side)', async () => {
    const sibling = `${SHELVED}-2`
    const items = await planOrphanTranscripts({
      ...base,
      probe: probeOf(facts(slugOfPath(sibling), [sibling])),
      shelvedFolders: [SHELVED]
    })
    expect(items).toEqual([])
  })
})
