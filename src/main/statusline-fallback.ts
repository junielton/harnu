import { homedir } from 'node:os'
import { basename, join, relative, resolve, isAbsolute } from 'node:path'
import { open, stat } from 'node:fs/promises'
import { deriveTranscriptFallback, parseJsonlTail } from './statusline-fallback-core'

/**
 * File-reading shell for the footer's transcript fallback (BUG-196 AC-1). Reads only the tail of a
 * session's own transcript under `~/.claude/projects` and hands it to the pure derivation. Read-only,
 * never throws: any problem is a `null` (the footer then shows the title and a reason).
 */

/** Enough to hold the last assistant turn and its usage, small enough to read on a session switch. */
const TAIL_BYTES = 256 * 1024

export interface TranscriptFallbackResult {
  modelId: string
  contextPercent: number | null
  /** Epoch ms of the last assistant turn (the file mtime when the turn had no timestamp). */
  atMs: number
}

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')

/**
 * The renderer names a transcript by session id + path. Only a `<sessionId>.jsonl` inside the
 * projects root is read, so this channel can never be pointed at an arbitrary file.
 */
export function isReadableTranscriptPath(
  sessionId: string,
  fullPath: string,
  root: string = PROJECTS_ROOT
): boolean {
  if (typeof sessionId !== 'string' || typeof fullPath !== 'string') return false
  if (!sessionId || !fullPath || !isAbsolute(fullPath)) return false
  if (basename(fullPath) !== `${sessionId}.jsonl`) return false
  const rel = relative(resolve(root), resolve(fullPath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export async function readTranscriptFallback(
  sessionId: string,
  fullPath: string,
  root?: string
): Promise<TranscriptFallbackResult | null> {
  if (!isReadableTranscriptPath(sessionId, fullPath, root)) return null
  try {
    const st = await stat(fullPath)
    const start = Math.max(0, st.size - TAIL_BYTES)
    const fh = await open(fullPath, 'r')
    try {
      const buf = Buffer.alloc(st.size - start)
      await fh.read(buf, 0, buf.length, start)
      const reading = deriveTranscriptFallback(parseJsonlTail(buf.toString('utf8'), start > 0))
      if (!reading) return null
      return {
        modelId: reading.modelId,
        contextPercent: reading.contextPercent,
        atMs: reading.atMs ?? st.mtimeMs
      }
    } finally {
      await fh.close()
    }
  } catch {
    return null
  }
}
