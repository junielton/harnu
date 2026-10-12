// View helpers for the leftovers Cleanup cleans for itself (unit D): the transcript folders of
// folders that are gone. No DOM, no Vue, no i18n. The renderer never imports main code at runtime,
// so `transcriptExpectedFor` restates `orphanExpectedOf` (src/main/gc/gc-orphan-transcripts.ts);
// tests/cleanup-orphan-transcripts.test.ts pins the two against each other.

import type {
  GcCleanOptions,
  GcExpected,
  OrphanTranscriptItem,
  StackLeftoverItem
} from '../../../main/gc/gc-wire'
import { cleanRequestFor, type CleanRequest, type GcModel } from './gc-model'

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

/** The items whose folder is proven gone, and those that are only missing ("Folder not found"). */
export function splitByProof(items: readonly OrphanTranscriptItem[]): {
  proven: OrphanTranscriptItem[]
  notFound: OrphanTranscriptItem[]
} {
  const bySize = (a: OrphanTranscriptItem, b: OrphanTranscriptItem): number =>
    b.bytes - a.bytes || (a.slug < b.slug ? -1 : 1)
  return {
    proven: items.filter((i) => i.proof !== 'not-found'),
    notFound: items.filter((i) => i.proof === 'not-found').sort(bySize)
  }
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
    project: item.slug,
    proof: item.proof
  }
}

/**
 * The `gc:clean` payload for these items: every id confirmed on its own, each with the facts shown.
 * A not-found folder also carries the stronger confirm, but only when the operator ticked "I checked".
 */
export function transcriptCleanRequest(
  items: readonly OrphanTranscriptItem[],
  notFoundAck = false
): CleanRequest {
  const expected: Record<string, GcExpected> = {}
  for (const i of items) expected[i.id] = transcriptExpectedFor(i)
  const ids = items.map((i) => i.id)
  const notFoundIds = items.filter((i) => i.proof === 'not-found').map((i) => i.id)
  const options: GcCleanOptions & { expected: Record<string, GcExpected> } = {
    expected,
    confirmed: [...ids],
    ...(notFoundAck && notFoundIds.length > 0 ? { confirmedNotFound: notFoundIds } : {})
  }
  return { ids, options }
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort()

/** The facts a stack leftover showed: its containers and networks (volumes have their own confirm). */
export function stackExpectedFor(item: StackLeftoverItem): GcExpected {
  return {
    bucket: 'stack-leftover',
    reasonCode: null,
    headSha: null,
    stackIds: sorted(item.containers.map((c) => c.id)),
    ownedVolumes: [],
    networkIds: sorted(item.networks.map((n) => n.id)),
    bytes: null,
    path: null,
    project: item.project
  }
}

/** The `gc:clean` payload for these leftovers: each project confirmed on its own, never a volume. */
export function stackCleanRequest(items: readonly StackLeftoverItem[]): CleanRequest {
  const expected: Record<string, GcExpected> = {}
  for (const i of items) expected[i.id] = stackExpectedFor(i)
  const ids = items.map((i) => i.id)
  const options: GcCleanOptions & { expected: Record<string, GcExpected> } = {
    expected,
    confirmed: [...ids]
  }
  return { ids, options }
}

/**
 * The ordinary orphan-volume request for these volume ids (`volume:<name>`): every id confirmed, each
 * with the facts its row showed. Volumes are removed only through here, one explicit confirm.
 */
export function leftoverVolumeRequest(model: GcModel, ids: readonly string[]): CleanRequest {
  return cleanRequestFor(model, ids, 'review')
}
