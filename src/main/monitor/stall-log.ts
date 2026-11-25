/**
 * The local stall log (T697): one jsonl line per stall over 50 ms, in `<userData>/stalls.jsonl`.
 *
 * Bounded twice: the live file rotates at 1 MiB (the previous generation is kept once, as
 * `stalls.1.jsonl`), and records older than 24 h are dropped when the file is read at boot. Every
 * write is asynchronous and batched, so the log can never be the stall it reports. A failing disk
 * is warned about once and never throws: the in-memory summary keeps working.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { encodeRecord, parseLog, shouldRotate, type StallRecord } from './stall-core'

export const LOG_FILE = 'stalls.jsonl'
export const LOG_FILE_PREVIOUS = 'stalls.1.jsonl'
const FLUSH_MS = 2_000

export interface StallLog {
  append(record: StallRecord): void
  /** Writes whatever is buffered now. */
  flush(): Promise<void>
  /** The last 24 h of records on disk (both generations), oldest first; rewrites the live file pruned. */
  load(nowMs: number): Promise<StallRecord[]>
  dispose(): Promise<void>
}

export function createStallLog(dir: string): StallLog {
  const file = path.join(dir, LOG_FILE)
  const previous = path.join(dir, LOG_FILE_PREVIOUS)
  let buffer: string[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let chain: Promise<unknown> = Promise.resolve()
  let warned = false

  const warn = (e: unknown): void => {
    if (warned) return
    warned = true
    console.warn(`[stall-log] disabled: ${(e as Error)?.message ?? e}`)
  }

  const writeBuffered = async (): Promise<void> => {
    if (buffer.length === 0) return
    const text = buffer.join('')
    buffer = []
    try {
      await fs.mkdir(dir, { recursive: true })
      if (shouldRotate(size, Buffer.byteLength(text))) {
        await fs.rename(file, previous).catch(() => undefined)
        size = 0
      }
      await fs.appendFile(file, text)
      size += Buffer.byteLength(text)
    } catch (e) {
      warn(e)
    }
  }

  const schedule = (): void => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      chain = chain.then(writeBuffered)
    }, FLUSH_MS)
    timer.unref()
  }

  return {
    append(record) {
      buffer.push(encodeRecord(record))
      schedule()
    },
    flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      chain = chain.then(writeBuffered)
      return chain as Promise<void>
    },
    load(nowMs) {
      // Same chain as the writes: a flush can never land between the read and the truncating
      // rewrite below, so a record appended during boot is not lost.
      const run = async (): Promise<StallRecord[]> => {
        const read = async (f: string): Promise<string> => fs.readFile(f, 'utf8').catch(() => '')
        const records = [
          ...parseLog(await read(previous), nowMs),
          ...parseLog(await read(file), nowMs)
        ]
        try {
          const kept = records.map(encodeRecord).join('')
          if (kept !== '' || size > 0) await fs.mkdir(dir, { recursive: true })
          await fs.writeFile(file, kept)
          size = Buffer.byteLength(kept)
        } catch (e) {
          warn(e)
        }
        return records
      }
      const result = chain.then(run)
      chain = result.catch(() => undefined)
      return result
    },
    async dispose() {
      await this.flush()
    }
  }
}
