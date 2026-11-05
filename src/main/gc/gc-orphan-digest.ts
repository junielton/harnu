// Digests the sessions of orphaned transcripts into their owning repo's memory before Cleanup can
// trash them (memory U1 S-5; spec `docs/specs/2026-11-04-memory-u1-capture/spec.md`, S-5). A
// worktree that was removed takes its folder, never its `~/.claude/projects/<slug>/` transcripts;
// those transcripts are the only record of what the sessions did. This file holds the pure
// decisions (the owning repo, which sessions to digest, how many per gather) over injected I/O;
// `gc-orphan-shell.ts` supplies the real ones.

import type { OrphanTranscriptItem } from './gc-orphan-transcripts'

/** The existence checks `ownerRepoFor` needs. */
export interface OwnerProbe {
  exists(p: string): Promise<boolean>
  /** Whether `p` is a git checkout (`git rev-parse --git-common-dir` succeeds there). */
  isCheckout(p: string): Promise<boolean>
}

export async function ownerRepoFor(
  _folder: string,
  _repoPaths: readonly string[],
  _probe: OwnerProbe
): Promise<string | null> {
  throw new Error('not implemented')
}

/** A top-level transcript of an orphaned project. */
export interface OrphanSessionFile {
  sessionId: string
  transcriptPath: string
  mtimeMs: number
}

export interface OrphanDigestDeps {
  repoPaths: readonly string[]
  probe: OwnerProbe
  sessionsOf(item: OrphanTranscriptItem): Promise<OrphanSessionFile[]>
  inspect(file: OrphanSessionFile): Promise<{ userTurns: number; gitBranch: string | null }>
  hasDigest(home: string, sessionId: string): Promise<boolean>
  digest(args: {
    sessionId: string
    transcriptPath: string
    memoryFolder: string
    branch: string | null
  }): Promise<void>
  minUserTurns?: number
  maxPerGather?: number
}

export async function digestOrphans(
  _items: readonly OrphanTranscriptItem[],
  _deps: OrphanDigestDeps
): Promise<OrphanTranscriptItem[]> {
  throw new Error('not implemented')
}

/** The real session lister: the top-level transcripts of `<projectsRoot>/<slug>/`. */
export function fsOrphanSessions(
  _projectsRoot: string
): (item: OrphanTranscriptItem) => Promise<OrphanSessionFile[]> {
  throw new Error('not implemented')
}

/** The real inspector: a transcript's user turns (full read) and its `gitBranch`. */
export async function inspectOrphanTranscript(
  _file: OrphanSessionFile
): Promise<{ userTurns: number; gitBranch: string | null }> {
  throw new Error('not implemented')
}
