/**
 * The digest engine (memory U1 S-2). Stub: the implementation lands in the green commit.
 */
import type { HookTaskEvent } from '../detect/task-state-hub'
import type { deriveTranscriptTruth } from '../transcript-truth'
import type { DigestReason, GitEvidence } from './digest-core'
import type { TranscriptFacts } from './digest-transcript'

export const LONG_IDLE_MS = 5 * 60 * 1000

export interface EngineSession {
  transcriptPath: string
  folder: string
  branch?: string
  created?: string
  summary?: string
  whatsHappening?: string
  firstPrompt?: string
}

export interface DigestEngineDeps {
  resolveSession(id: string): Promise<EngineSession | null>
  readFacts(
    path: string,
    from?: { offset: number; facts: TranscriptFacts }
  ): Promise<{ facts: TranscriptFacts; offset: number }>
  readTruth(path: string): Promise<ReturnType<typeof deriveTranscriptTruth>>
  gatherGit(folder: string, sinceUnixSec: number, baselineHead: string | null): Promise<GitEvidence>
  writeDigest(
    folder: string,
    page: string,
    entry: string,
    sessionId: string
  ): Promise<{ ok: boolean; error?: string; detail?: string }>
  writeHot(
    folder: string,
    sessionId: string,
    branch: string | undefined,
    title: string,
    hot: string
  ): Promise<void>
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
}

export interface DigestEngine {
  onTaskEdge(ev: HookTaskEvent): Promise<void> | undefined
  digestNow(sessionId: string, reason: DigestReason): Promise<void>
  close(): void
}

export function createDigestEngine(_deps: DigestEngineDeps): DigestEngine {
  throw new Error('not implemented')
}
