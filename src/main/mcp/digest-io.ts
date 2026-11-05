/**
 * Node-only I/O of the digest engine (memory U1 S-2). Stub: the implementation lands in the
 * green commit.
 */
import type { deriveTranscriptTruth } from '../transcript-truth'
import type { GitEvidence } from './digest-core'
import type { TranscriptFacts } from './digest-transcript'

/** A transcript line longer than this many UTF-8 bytes is dropped unread. */
export const LINE_MAX_BYTES = 1_048_576

export async function readTranscriptFacts(
  _path: string,
  _from?: { offset: number; facts: TranscriptFacts }
): Promise<{ facts: TranscriptFacts; offset: number }> {
  throw new Error('not implemented')
}

export async function readTranscriptTruth(
  _fullPath: string
): Promise<ReturnType<typeof deriveTranscriptTruth>> {
  throw new Error('not implemented')
}

export async function gatherGitEvidence(
  _folder: string,
  _sinceUnixSec: number,
  _baselineHead: string | null,
  _rev = 'HEAD'
): Promise<GitEvidence> {
  throw new Error('not implemented')
}
