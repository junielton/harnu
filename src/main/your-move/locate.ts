/**
 * Finds `~/.claude/projects/<slug>/<id>.jsonl` by session id: the renderer and the hooks never
 * name a path the main process can trust, and a companion event may carry none.
 */

import * as path from 'node:path'

/** The two fs calls the locator needs: a directory listing and an existence probe. */
export interface LocatorFs {
  readdir(dir: string): Promise<string[]>
  access(file: string): Promise<void>
}

export interface TranscriptLocator {
  /** The transcript of a session, or null when none is on disk. */
  locate(sessionId: string): Promise<string | null>
  /** A path a hook payload carried: remembered, so no directory is touched for this session. */
  note(sessionId: string, transcriptPath: string | undefined): void
}

export interface LocatorDeps {
  /** `~/.claude/projects`. */
  root: string
  fs: LocatorFs
  now(): number
}

export function createTranscriptLocator(deps: LocatorDeps): TranscriptLocator {
  return {
    async locate(sessionId) {
      let slugs: string[]
      try {
        slugs = await deps.fs.readdir(deps.root)
      } catch {
        return null
      }
      for (const slug of slugs) {
        const candidate = path.join(deps.root, slug, `${sessionId}.jsonl`)
        try {
          await deps.fs.access(candidate)
          return candidate
        } catch {
          /* not in this slug */
        }
      }
      return null
    },
    note() {
      /* nothing is remembered yet */
    }
  }
}
