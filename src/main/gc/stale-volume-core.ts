// U3.7: the stale-volume detector (pure). When Harnu removes an orphan stack on its own it keeps the
// stack's volumes and journals who they belonged to (`keptVolumeOwner`, U3.3). If a LIVE compose
// project later mounts one of those volumes it inherits a removed worktree's data, and Activity says
// so: once per (volume, removed worktree, mounting worktree), so the same volume warns again only
// when a different worktree starts mounting it.

import type { StackRow, Tombstone } from '../containers/containers-wire'

/** One live project mounting a volume that belonged to a removed worktree. */
export interface StaleVolumeFinding {
  /** The ledger key: volume, removed worktree and mounting worktree. */
  key: string
  volume: string
  /** The live compose project that mounts the volume. */
  project: string
  /** The removed worktree's folder name (the owner project when the path was not recorded). */
  worktree: string
}

interface Owner {
  project: string | null
  worktreePath: string | null
}

/** The last path segment of a folder path, either separator; empty for an empty path. */
function folderName(p: string): string {
  return (
    p
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  )
}

/**
 * Who each kept volume belonged to, from the journal (newest first, as `readJournal` returns it).
 * A later line that removed the volume voids the claim: compose recreating it is fresh data.
 */
function ownersFrom(journal: readonly Tombstone[]): Map<string, Owner> {
  const owners = new Map<string, Owner>()
  for (const line of [...journal].reverse()) {
    for (const s of line.stacks) {
      for (const v of s.freed.volumes) owners.delete(v)
      if (!s.keptVolumeOwner) continue
      for (const v of s.keptVolumes ?? []) {
        owners.set(v, {
          project: s.keptVolumeOwner.project,
          worktreePath: s.keptVolumeOwner.worktreePath
        })
      }
    }
  }
  return owners
}

/** A stack whose folder still exists: orphans and unattributed stacks are not live projects. */
const isLive = (s: StackRow): boolean =>
  s.kind === 'compose' && s.verdict !== 'orphan' && s.verdict !== 'unknown'

export function findStaleVolumes(input: {
  journal: readonly Tombstone[]
  stacks: readonly StackRow[]
  seen: ReadonlySet<string>
}): { fresh: StaleVolumeFinding[]; seen: Set<string> } {
  const owners = ownersFrom(input.journal)
  const seen = new Set(input.seen)
  const fresh: StaleVolumeFinding[] = []
  if (owners.size === 0) return { fresh, seen }
  for (const stack of input.stacks) {
    if (!isLive(stack)) continue
    for (const vol of stack.volumes) {
      const owner = owners.get(vol.name)
      if (!owner) continue
      const key = [
        vol.name,
        owner.worktreePath ?? owner.project ?? '',
        stack.attribution.path ?? stack.id
      ].join('\u0000')
      if (seen.has(key)) continue
      seen.add(key)
      fresh.push({
        key,
        volume: vol.name,
        project: stack.project ?? stack.name,
        worktree: owner.worktreePath ? folderName(owner.worktreePath) : (owner.project ?? '')
      })
    }
  }
  return { fresh, seen }
}
