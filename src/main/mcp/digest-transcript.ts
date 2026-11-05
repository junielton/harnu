/** Pure transcript scan for the auto-digest (memory U1, S-1). Stub: implemented in the next commit. */

export interface TranscriptFacts {
  userTurns: number
  firstAt: string | null
  lastAt: string | null
  gitCalls: { startMs: number; endMs: number }[]
  asked: { question: string; answer: string }[]
  openQuestions: string[]
  lastAssistantText: string
  lastAssistantId: string | null
  lastAssistantTail: string
  pending: { id: string; kind: 'git' | 'ask'; startMs: number | null }[]
}

export function emptyFacts(): TranscriptFacts {
  throw new Error('not implemented')
}

export function isUserTurn(_entry: Record<string, unknown>): boolean {
  throw new Error('not implemented')
}

export function scanTranscriptLines(
  _lines: Iterable<string>,
  _facts?: TranscriptFacts
): TranscriptFacts {
  throw new Error('not implemented')
}

export function gitWindows(
  _facts: TranscriptFacts,
  _nowMs: number
): { startMs: number; endMs: number }[] {
  throw new Error('not implemented')
}
