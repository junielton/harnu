// View helpers for the leftovers Cleanup cleans for itself (unit D): the transcript folders of
// folders that are gone. No DOM, no Vue, no i18n. The renderer never imports main code at runtime,
// so `transcriptExpectedFor` restates `orphanExpectedOf` (src/main/gc/gc-orphan-transcripts.ts);
// tests/cleanup-orphan-transcripts.test.ts pins the two against each other.

import type { GcCleanOptions, GcExpected, OrphanTranscriptItem } from '../../../main/gc/gc-wire'
import type { CleanRequest } from './gc-model'

export interface OrphanGroup {
  repoLabel: string
  bytes: number
  items: OrphanTranscriptItem[]
}

/** Items grouped by repo, the biggest group first and the biggest item first inside each. */
export function groupOrphanTranscripts(items: readonly OrphanTranscriptItem[]): OrphanGroup[] {
  const byRepo = new Map<string, OrphanTranscriptItem[]>()
  for (const i of items) {
    const list = byRepo.get(i.repoLabel)
    if (list) list.push(i)
    else byRepo.set(i.repoLabel, [i])
  }
  return [...byRepo]
    .map(([repoLabel, list]) => {
      const sorted = [...list].sort((a, b) => b.bytes - a.bytes || (a.slug < b.slug ? -1 : 1))
      return { repoLabel, bytes: sorted.reduce((a, i) => a + i.bytes, 0), items: sorted }
    })
    .sort((a, b) => b.bytes - a.bytes || (a.repoLabel < b.repoLabel ? -1 : 1))
}

/** The facts a row showed, in the shape `gc:clean` compares with a fresh gather. */
export function transcriptExpectedFor(item: OrphanTranscriptItem): GcExpected {
  return {
    bucket: 'orphan-transcripts',
    reasonCode: null,
    headSha: null,
    stackIds: [],
    ownedVolumes: [],
    bytes: item.bytes,
    path: item.folder,
    project: item.slug
  }
}

/** The `gc:clean` payload for these items: every id confirmed on its own, each with the facts shown. */
export function transcriptCleanRequest(items: readonly OrphanTranscriptItem[]): CleanRequest {
  const expected: Record<string, GcExpected> = {}
  for (const i of items) expected[i.id] = transcriptExpectedFor(i)
  const ids = items.map((i) => i.id)
  const options: GcCleanOptions & { expected: Record<string, GcExpected> } = {
    expected,
    confirmed: [...ids]
  }
  return { ids, options }
}
