// The two figures the Cleanup Docker card shows (T441 delta 2, item 2): how much build cache
// a prune could reclaim, and how many dangling images there are and how big they are. Read
// only: it lists, it never prunes (that is housekeeping-shell, behind the autopilot). Each
// figure is null when docker could not answer for it, so the card shows "unavailable" rather
// than a confident zero.

import { parseDockerSize } from '../containers/containers-core'

export interface GcDockerCard {
  /** Bytes `docker builder prune` could reclaim; null when docker did not say. */
  buildCacheReclaimableBytes: number | null
  /** Images with no tag and no container; null when docker did not say. */
  danglingImages: { count: number; bytes: number } | null
  /**
   * Why the orphan-volume list is empty when volumes may well exist: a compose project name
   * somewhere could not be resolved, or the scan for names hit a cap. Null when nothing is
   * hidden (and when docker is absent). `folders` are the folders that cause it; paths are
   * fine here, this goes to the renderer only.
   */
  orphanVolumesHidden: OrphanVolumesHidden | null
}

export interface OrphanVolumesHidden {
  reason: 'unresolved-compose-name' | 'scan-limit'
  folders: string[]
}

/** The card with the compose scan's verdict attached (the gather knows it, docker does not). */
export function withOrphanVolumesHidden(
  card: GcDockerCard,
  hidden: OrphanVolumesHidden | null
): GcDockerCard {
  return { ...card, orphanVolumesHidden: hidden }
}

export const NO_DOCKER_CARD: GcDockerCard = {
  buildCacheReclaimableBytes: null,
  danglingImages: null,
  orphanVolumesHidden: null
}

function rows(stdout: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const v: unknown = JSON.parse(t)
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>)
    } catch {
      // A line that is not a row (a warning, say) is not data.
    }
  }
  return out
}

/** `1.2GB (24%)` → bytes; the percentage docker appends is dropped. */
function sizeOf(v: unknown): number | null {
  return typeof v === 'string' ? parseDockerSize(v.split(' (')[0]) : null
}

/** From `docker system df --format '{{json .}}'`: the Build Cache row's reclaimable size. */
export function parseBuildCacheReclaimable(stdout: string): number | null {
  const row = rows(stdout).find((r) => r.Type === 'Build Cache')
  return row ? sizeOf(row.Reclaimable) : null
}

/** From `docker images --filter dangling=true --format '{{json .}}'`. */
export function parseDanglingImages(stdout: string): { count: number; bytes: number } {
  const images = rows(stdout).filter((r) => typeof r.ID === 'string')
  return { count: images.length, bytes: images.reduce((sum, r) => sum + (sizeOf(r.Size) ?? 0), 0) }
}

export type DockerRun = (argv: readonly string[]) => Promise<{ stdout: string }>

/** Both figures, each independently null when its command fails (docker down, a timeout). */
export async function dockerCardFacts(run: DockerRun): Promise<GcDockerCard> {
  const [df, images] = await Promise.all([
    run(['system', 'df', '--format', '{{json .}}']).then(
      (r) => parseBuildCacheReclaimable(r.stdout),
      () => null
    ),
    run(['images', '--filter', 'dangling=true', '--format', '{{json .}}']).then(
      (r) => parseDanglingImages(r.stdout),
      () => null
    )
  ])
  return { buildCacheReclaimableBytes: df, danglingImages: images, orphanVolumesHidden: null }
}
