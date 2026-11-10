/**
 * Incremental transcript reader: complete JSONL lines from a byte offset.
 *
 * Offsets are bytes. Only lines closed by a newline are returned, so a line the CLI is
 * still writing is read whole on the next call instead of being lost or half-parsed.
 */

import { createReadStream, promises as fs } from 'node:fs'

export interface ReadResult {
  lines: Record<string, unknown>[]
  nextOffset: number
  size: number
  /** The file is shorter than the offset: it was rewritten or truncated. */
  shrunk: boolean
}

const NEWLINE = 0x0a

async function readBytes(path: string, start: number, endExclusive: number): Promise<Buffer> {
  if (endExclusive <= start) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  for await (const chunk of createReadStream(path, { start, end: endExclusive - 1 })) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function parseLines(buf: Buffer): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const raw of buf.toString('utf8').split('\n')) {
    if (raw.trim() === '') continue
    try {
      const v: unknown = JSON.parse(raw)
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        out.push(v as Record<string, unknown>)
      }
    } catch {
      /* a malformed line is skipped; the offset still passes it */
    }
  }
  return out
}

/**
 * Read from `offset`. `{ tail: n }` starts at most `n` bytes back from the end, moved
 * forward to just after a newline so the first line is whole.
 */
export async function readFrom(
  path: string,
  offset: number | { tail: number }
): Promise<ReadResult> {
  let size: number
  try {
    size = (await fs.stat(path)).size
  } catch {
    return { lines: [], nextOffset: 0, size: 0, shrunk: false }
  }
  let start: number
  if (typeof offset === 'number') {
    if (offset > size) return { lines: [], nextOffset: size, size, shrunk: true }
    start = offset
  } else {
    start = Math.max(0, size - offset.tail)
    if (start > 0) {
      const probe = await readBytes(path, start - 1, size)
      const nl = probe.indexOf(NEWLINE)
      start = nl === -1 ? size : start - 1 + nl + 1
    }
  }
  const buf = await readBytes(path, start, size)
  const lastNl = buf.lastIndexOf(NEWLINE)
  if (lastNl === -1) return { lines: [], nextOffset: start, size, shrunk: false }
  const whole = buf.subarray(0, lastNl + 1)
  return { lines: parseLines(whole), nextOffset: start + whole.length, size, shrunk: false }
}
