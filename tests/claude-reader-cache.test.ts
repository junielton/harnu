import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanFolders,
  __resetHeaderCacheForTests,
  __scrapeMissesForTests,
  __headerCacheSizeForTests
} from '../src/main/claude-reader'

/**
 * Unit net for the mtime-keyed JSONL header cache (perf spec 2026-06-22 §5.2a /
 * §7). Asserts: an unchanged file is NOT re-parsed across scans; a changed file
 * IS; and a deleted file is evicted (cache stays bounded).
 */
function userLine(sessionId: string, cwd: string, content: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    cwd,
    gitBranch: '',
    isSidechain: false,
    message: { role: 'user', content },
    uuid: `${sessionId}-u1`,
    timestamp: '2026-06-01T00:00:00.000Z'
  })
}

describe('claude-reader — header cache (perf §5.2a)', () => {
  let root: string
  let slugDir: string
  const CWD = '/work/Cache'
  const SID = 'cccc1111-0000-0000-0000-000000000001'
  let file: string

  beforeEach(async () => {
    __resetHeaderCacheForTests()
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-cache-'))
    slugDir = join(root, '-work-Cache')
    await fs.mkdir(slugDir, { recursive: true })
    file = join(slugDir, `${SID}.jsonl`)
    await fs.writeFile(file, userLine(SID, CWD, 'first prompt') + '\n')
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('parses on the first scan, reuses the cache on an unchanged re-scan', async () => {
    await scanFolders({ rootDir: root })
    expect(__scrapeMissesForTests()).toBe(1)

    // Nothing changed → cache hit, no re-parse.
    await scanFolders({ rootDir: root })
    expect(__scrapeMissesForTests()).toBe(1)
  })

  it('re-parses a file whose contents changed (append bumps mtime+size)', async () => {
    await scanFolders({ rootDir: root })
    expect(__scrapeMissesForTests()).toBe(1)

    // Append a line — size (and mtime) move, so the cache key invalidates.
    await fs.appendFile(file, userLine(SID, CWD, 'second turn') + '\n')
    await scanFolders({ rootDir: root })
    expect(__scrapeMissesForTests()).toBe(2)
  })

  it('reflects a renamed title after re-parse (correctness, not just count)', async () => {
    let folders = await scanFolders({ rootDir: root })
    expect(folders[0].sessions[0].summary).toBe('')

    await fs.appendFile(
      file,
      JSON.stringify({ type: 'custom-title', sessionId: SID, customTitle: 'Renamed' }) + '\n'
    )
    folders = await scanFolders({ rootDir: root })
    expect(folders[0].sessions[0].summary).toBe('Renamed')
  })

  it('evicts a deleted file from the cache (bounded growth)', async () => {
    await scanFolders({ rootDir: root })
    expect(__headerCacheSizeForTests()).toBe(1)

    await fs.rm(file)
    await scanFolders({ rootDir: root })
    expect(__headerCacheSizeForTests()).toBe(0)
  })
})
