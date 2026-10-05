// tests/claude-reader-subagent-cache.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanFolders,
  __resetHeaderCacheForTests,
  __resetSubagentHeaderCacheForTests,
  __subagentHeaderReadsForTests
} from '../src/main/claude-reader'

const SID = 'aaaa0000-0000-4000-8000-000000000001'
const user = (content: string): string =>
  JSON.stringify({
    type: 'user',
    sessionId: SID,
    cwd: '/w/Sub',
    entrypoint: 'cli',
    isSidechain: false,
    message: { role: 'user', content },
    uuid: 'u'
  })
const sub = (id: string, n: number): string =>
  JSON.stringify(
    n === 0
      ? {
          type: 'user',
          agentId: id,
          attributionAgent: 'general-purpose',
          isSidechain: true,
          message: { role: 'user', content: 'task ' + id }
        }
      : {
          type: 'assistant',
          agentId: id,
          isSidechain: true,
          message: { role: 'assistant', model: 'm', content: [{ type: 'text', text: 'x' }] }
        }
  )

describe('claude-reader — subagent header cache (AC-15)', () => {
  let root: string
  let subDir: string
  beforeEach(async () => {
    __resetHeaderCacheForTests()
    __resetSubagentHeaderCacheForTests()
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-subcache-'))
    const slug = join(root, '-w-Sub')
    subDir = join(slug, SID, 'subagents')
    await fs.mkdir(subDir, { recursive: true })
    await fs.writeFile(join(slug, `${SID}.jsonl`), user('hi') + '\n')
    for (let i = 0; i < 40; i++) {
      await fs.writeFile(
        join(subDir, `agent-a${i}.jsonl`),
        [sub(`a${i}`, 0), sub(`a${i}`, 1)].join('\n') + '\n'
      )
    }
  })
  afterEach(async () => fs.rm(root, { recursive: true, force: true }))

  it('a second pass after one append reads at most 2 subagent headers', async () => {
    await scanFolders({ rootDir: root, slugsFilter: ['-w-Sub'] })
    const afterFirst = __subagentHeaderReadsForTests()
    expect(afterFirst).toBe(40)
    await fs.appendFile(join(subDir, 'agent-a0.jsonl'), sub('a0', 2) + '\n')
    const folders = await scanFolders({ rootDir: root, slugsFilter: ['-w-Sub'] })
    expect(__subagentHeaderReadsForTests() - afterFirst).toBeLessThanOrEqual(2)
    const agents = folders[0].sessions[0].agents
    expect(agents).toHaveLength(40)
    expect(agents.find((a) => a.agentId === 'a0')?.agentType).toBe('general-purpose')
  })

  it('re-reads a header when the file was replaced (inode change) or shrank', async () => {
    await scanFolders({ rootDir: root, slugsFilter: ['-w-Sub'] })
    const n = __subagentHeaderReadsForTests()
    const p = join(subDir, 'agent-a1.jsonl')
    await fs.rm(p)
    await fs.writeFile(p, sub('a1', 0) + '\n')
    await scanFolders({ rootDir: root, slugsFilter: ['-w-Sub'] })
    expect(__subagentHeaderReadsForTests() - n).toBe(1)
  })

  it('re-reads an incomplete header (no model yet) once the file grew', async () => {
    const p = join(subDir, 'agent-a2.jsonl')
    await fs.writeFile(p, sub('a2', 0) + '\n') // user line only: model unresolved
    await scanFolders({ rootDir: root, slugsFilter: ['-w-Sub'] })
    const n = __subagentHeaderReadsForTests()
    // Unchanged and incomplete: still served from the cache.
    await scanFolders({ rootDir: root, slugsFilter: ['-w-Sub'] })
    expect(__subagentHeaderReadsForTests() - n).toBe(0)
    await fs.appendFile(p, sub('a2', 1) + '\n')
    const folders = await scanFolders({ rootDir: root, slugsFilter: ['-w-Sub'] })
    expect(__subagentHeaderReadsForTests() - n).toBe(1)
    expect(folders[0].sessions[0].agents.find((a) => a.agentId === 'a2')?.model).toBe('m')
    // Now complete: a further append is not re-read.
    await fs.appendFile(p, sub('a2', 2) + '\n')
    await scanFolders({ rootDir: root, slugsFilter: ['-w-Sub'] })
    expect(__subagentHeaderReadsForTests() - n).toBe(1)
  })

  it('reads a new subagent file exactly once', async () => {
    await scanFolders({ rootDir: root, slugsFilter: ['-w-Sub'] })
    const n = __subagentHeaderReadsForTests()
    await fs.writeFile(
      join(subDir, 'agent-a99.jsonl'),
      [sub('a99', 0), sub('a99', 1)].join('\n') + '\n'
    )
    const folders = await scanFolders({ rootDir: root, slugsFilter: ['-w-Sub'] })
    expect(__subagentHeaderReadsForTests() - n).toBe(1)
    expect(folders[0].sessions[0].agents).toHaveLength(41)
    await scanFolders({ rootDir: root, slugsFilter: ['-w-Sub'] })
    expect(__subagentHeaderReadsForTests() - n).toBe(1)
  })
})
