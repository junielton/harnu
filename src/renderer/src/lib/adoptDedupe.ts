/**
 * One coalesced PTY output chunk tagged with the cumulative byte offset at its
 * end (`seq` = total bytes the PTY had emitted after this chunk was flushed).
 */
export interface SeqChunk {
  data: string
  seq: number
}

/**
 * Filter the live chunks queued during adoption down to those NOT already
 * contained in the replay snapshot. `replaySeq` is the end offset of the
 * snapshot returned by `pty:replay`; because `seq` is always a flush boundary
 * and the replay handler drains the pending flush before snapshotting, every
 * queued chunk is either entirely inside the snapshot (`seq <= replaySeq`) or
 * entirely after it (`seq > replaySeq`) — never straddling. So a simple
 * `seq > replaySeq` keep-filter is an exact dedup (spec §4.1/§4.2, I4).
 */
export function dedupeAfterSeq(chunks: SeqChunk[], replaySeq: number): SeqChunk[] {
  return chunks.filter((c) => c.seq > replaySeq)
}
