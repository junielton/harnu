import { dedupeAfterSeq, type SeqChunk } from './adoptDedupe'

/** The two preload calls adoption needs. Narrowed so a test can fake them. */
export interface AdoptApi {
  onPtyData(id: string, cb: (data: string, seq: number) => void): () => void
  ptyReplay(id: string): Promise<{ data: string; seq: number }>
}

/**
 * Adopt a PTY somebody else already started (T474 §8 case 2): paint everything it printed so
 * far, then follow it live, with no byte written twice and none missed.
 *
 *  1. subscribe to the live stream FIRST and queue what arrives (`pty:replay` is async, and the
 *     PTY keeps talking while it is in flight);
 *  2. ask main for the replay — scrollback plus `seq`, the byte offset it ends at;
 *  3. write the replay, then the queued chunks that end AFTER that offset
 *     ({@link dedupeAfterSeq}: a chunk ending at or before it is already inside the replay);
 *  4. open the gate: from here on every chunk is written as it comes.
 *
 * A failing replay (a transient IPC error, the PTY dying mid-adoption) must not strand the
 * gate shut — the queue would grow without bound and nothing would ever paint — so it falls
 * back to an empty replay and the queued chunks all go through.
 *
 * `onReplayParsed` fires once the replay has been fully written to (and parsed by) the terminal
 * — `write` is handed a `done` callback for exactly that one call — or at once when there is no
 * replay.
 *
 * Resolves to the unsubscribe function for the live stream.
 */
export async function adoptPtyStream(
  api: AdoptApi,
  ptyId: string,
  write: (data: string, done?: () => void) => void,
  onReplayParsed?: () => void
): Promise<() => void> {
  let queue: SeqChunk[] | null = []
  const off = api.onPtyData(ptyId, (data, seq) => {
    if (queue) queue.push({ data, seq })
    else write(data)
  })

  let replay: { data: string; seq: number } = { data: '', seq: 0 }
  try {
    replay = await api.ptyReplay(ptyId)
  } catch {
    // no history available: follow the live stream from here
  }
  // T480: the replay's bytes were already answered by main's screen model (spec §5.4), so the
  // pane's xterm must stay silent while it parses them. `done` fires once the parse is over;
  // the chunks queued after it are live bytes only this xterm answers.
  if (replay.data) write(replay.data, onReplayParsed)
  else onReplayParsed?.()
  const queued: SeqChunk[] = queue
  queue = null
  for (const chunk of dedupeAfterSeq(queued, replay.seq)) write(chunk.data)
  return off
}
