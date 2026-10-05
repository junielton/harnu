/**
 * Rolling, byte-capped buffer of PTY output chunks. Holds at most ~`maxBytes`
 * of the most recent output so the main process can replay a session's recent
 * scrollback to a freshly-reloaded renderer (spec §4.2, invariant I4).
 *
 * Eviction is whole-chunk: when a push pushes the total over `maxBytes`, the
 * oldest chunks are dropped until it fits — never sliced mid-string, so we
 * never cut a UTF-8 code point or an ANSI escape in half at the *eviction*
 * boundary. (The very first replayed bytes can still begin mid-escape if a
 * sequence spanned an evicted chunk; that is acceptable — the spec asks for
 * "good enough" continuity, §2, and a TUI repaint corrects it.)
 *
 * A single chunk larger than `maxBytes` is kept as-is (we never drop the only
 * chunk), so a giant burst still replays rather than vanishing.
 *
 * Pure data structure — no node-pty / electron deps — so it is unit-testable
 * in isolation (vitest, node env). `Buffer` is a Node global, available there.
 */
export class RingBuffer {
  private chunks: string[] = []
  private total = 0

  constructor(private readonly maxBytes: number) {}

  get byteLength(): number {
    return this.total
  }

  push(chunk: string): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.total += Buffer.byteLength(chunk, 'utf8')
    // Evict oldest whole chunks until we fit — but always keep at least one.
    while (this.chunks.length > 1 && this.total > this.maxBytes) {
      const dropped = this.chunks.shift() as string
      this.total -= Buffer.byteLength(dropped, 'utf8')
    }
  }

  snapshot(): string {
    return this.chunks.join('')
  }
}
