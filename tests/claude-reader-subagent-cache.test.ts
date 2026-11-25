// tests/claude-reader-subagent-cache.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanFolders,
  __resetHeaderCacheForTests,
  __resetSubagentHeaderCacheForTests,
  __subagentHeaderReadsForTests,
  __subagentMetaReadsForTests
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

describe('claude-reader — subagent meta.json sidecar (AC-1, AC-2, AC-5)', () => {
  let root: string
  let subDir: string
  const metaPath = (id: string): string => join(subDir, `agent-${id}.meta.json`)
  const scan = (): ReturnType<typeof scanFolders> =>
    scanFolders({ rootDir: root, slugsFilter: ['-w-Sub'] })

  beforeEach(async () => {
    __resetHeaderCacheForTests()
    __resetSubagentHeaderCacheForTests()
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-submeta-'))
    const slug = join(root, '-w-Sub')
    subDir = join(slug, SID, 'subagents')
    await fs.mkdir(subDir, { recursive: true })
    await fs.writeFile(join(slug, `${SID}.jsonl`), user('hi') + '\n')
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(
        join(subDir, `agent-a${i}.jsonl`),
        [sub(`a${i}`, 0), sub(`a${i}`, 1)].join('\n') + '\n'
      )
    }
    await fs.writeFile(
      metaPath('a0'),
      JSON.stringify({ agentType: 'Explore', description: 'Verify U2d ACs', finished: true })
    )
  })
  afterEach(async () => fs.rm(root, { recursive: true, force: true }))

  it('surfaces the description and prefers the meta agentType', async () => {
    const folders = await scan()
    const a0 = folders[0].sessions[0].agents.find((a) => a.agentId === 'a0')
    expect(a0?.description).toBe('Verify U2d ACs')
    expect(a0?.agentType).toBe('Explore')
  })

  it('falls back to attributionAgent and an empty description without a sidecar', async () => {
    const folders = await scan()
    const a1 = folders[0].sessions[0].agents.find((a) => a.agentId === 'a1')
    expect(a1?.description).toBe('')
    expect(a1?.agentType).toBe('general-purpose')
  })

  it('survives a malformed sidecar', async () => {
    await fs.writeFile(metaPath('a2'), '{not json')
    const folders = await scan()
    const a2 = folders[0].sessions[0].agents.find((a) => a.agentId === 'a2')
    expect(a2?.description).toBe('')
    expect(a2?.agentType).toBe('general-purpose')
  })

  it('reads each sidecar once and not again while it is unchanged', async () => {
    await scan()
    expect(__subagentMetaReadsForTests()).toBe(1) // only a0 has a sidecar
    await scan()
    await scan()
    expect(__subagentMetaReadsForTests()).toBe(1)
  })

  it('does not re-read the sidecar when only the transcript grows', async () => {
    await scan()
    await fs.appendFile(join(subDir, 'agent-a0.jsonl'), sub('a0', 2) + '\n')
    await scan()
    expect(__subagentMetaReadsForTests()).toBe(1)
  })

  it('re-reads once when the sidecar changes, and picks up a late sidecar', async () => {
    await scan()
    await fs.writeFile(
      metaPath('a0'),
      JSON.stringify({ agentType: 'Explore', description: 'A different, longer description' })
    )
    const folders = await scan()
    expect(__subagentMetaReadsForTests()).toBe(2)
    expect(folders[0].sessions[0].agents.find((a) => a.agentId === 'a0')?.description).toBe(
      'A different, longer description'
    )
    await fs.writeFile(metaPath('a3'), JSON.stringify({ description: 'Late sidecar' }))
    const again = await scan()
    expect(__subagentMetaReadsForTests()).toBe(3)
    expect(again[0].sessions[0].agents.find((a) => a.agentId === 'a3')?.description).toBe(
      'Late sidecar'
    )
  })
})
