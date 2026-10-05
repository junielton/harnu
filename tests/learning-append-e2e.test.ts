import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { appendMemoryEntry } from '../src/main/mcp/memory-store'

/**
 * End-to-end proof for the T123 Critical: the `memory_append` WRITE PATH — not just the
 * page parser — accepts the `learning/*` pages the teacher contract instructs the tutor to
 * write. Before the fix every one of these returned BAD_PAGE ("unknown page directory
 * learning"), so the teaching cycle had no persistence at all: no mission, no path, no
 * records, and therefore no calibration.
 *
 * This drives the real `appendMemoryEntry` against a temp memory dir and asserts the bytes
 * land on disk, which is the part a parser unit test cannot prove.
 */
describe('memory_append write path — learning/* pages (T123)', () => {
  const PAGES = [
    'learning/mission',
    'learning/path',
    'learning/resources',
    'learning/record-0001-agents'
  ]

  it('writes every page the teacher contract prescribes', async () => {
    const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-learn-'))
    try {
      for (const page of PAGES) {
        const res = await appendMemoryEntry({
          memoryDir,
          page,
          entry: `entry for ${page}`,
          author: 'agent',
          now: 1_783_000_000_000
        })
        expect(res.ok, `${page} must be appendable: ${JSON.stringify(res)}`).toBe(true)

        // The bytes actually landed, at the flat one-segment path the gate allows.
        const file = path.join(memoryDir, `${page}.md`)
        expect(await fs.readFile(file, 'utf8')).toContain(`entry for ${page}`)
      }
    } finally {
      await fs.rm(memoryDir, { recursive: true, force: true })
    }
  })

  it('still refuses traversal and a nested record path', async () => {
    const memoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-learn-'))
    try {
      for (const bad of ['learning/../../etc/passwd', 'learning/records/0001-x']) {
        const res = await appendMemoryEntry({
          memoryDir,
          page: bad,
          entry: 'nope',
          author: 'agent',
          now: 1_783_000_000_000
        })
        expect(res.ok, `${bad} must be refused`).toBe(false)
      }
      // Nothing escaped the memory dir.
      await expect(fs.readFile('/tmp/../etc/passwd.md', 'utf8')).rejects.toThrow()
    } finally {
      await fs.rm(memoryDir, { recursive: true, force: true })
    }
  })
})
