// What a repo's own WORKTREE.md says about shelving (autonomous cleanup U2.2): which directories
// are regenerable (left out of the snapshot, at any depth) and whether the repo delegates the
// creation or removal of its worktrees to its own scripts (C10: such a repo is not shelved, its
// allocator would reuse the number while the folder is gone).
//
// Reads the same manifest `create_worktree` and dehydrate read, so what Cleanup leaves out of a
// snapshot is what the repo declared regenerable. Fails closed: a manifest that exists but cannot
// be parsed excludes nothing (the snapshot cap then decides) and counts as delegating (not shelved).

import * as path from 'node:path'
import { resolveManifest, type ManifestSources } from '../worktree-manifest'
import { dependencyDirsFor } from './shelve-core'

export interface ShelveManifest {
  /** Worktree-relative dirs the snapshot leaves out, in the form `preserveWorktree` takes. */
  dependencyDirs: string[]
  /** The manifest sets `create:` or `remove:`. */
  delegates: boolean
}

/** The pure half: the manifest sources a shell read, judged for shelving. Never throws. */
export function shelveManifestFrom(sources: ManifestSources, repoPath: string): ShelveManifest {
  try {
    const manifest = resolveManifest(sources, { branch: 'shelve', repo: path.basename(repoPath) })
    const hadFile = sources.worktreeMd != null || sources.claudeWorktreeMd != null
    // `resolveManifest` never throws: a file whose front matter does not parse resolves to the
    // default recipe. For creation that is robust; here it would widen what is left out of the
    // snapshot and hide a delegation, so it is read as "could not tell".
    if (hadFile && manifest.source === 'default') return { dependencyDirs: [], delegates: true }
    return {
      dependencyDirs: dependencyDirsFor(manifest.ephemeral),
      delegates: manifest.create !== undefined || manifest.remove !== undefined
    }
  } catch {
    return { dependencyDirs: [], delegates: true }
  }
}

/** The shell half. `read` is injectable so a test needs no electron; the default is the real reader. */
export async function readShelveManifest(
  repoPath: string,
  read?: (repoPath: string) => Promise<ManifestSources>
): Promise<ShelveManifest> {
  try {
    const reader = read ?? (await import('../worktree-ipc')).readManifestSources
    return shelveManifestFrom(await reader(repoPath), repoPath)
  } catch {
    return { dependencyDirs: [], delegates: true }
  }
}
