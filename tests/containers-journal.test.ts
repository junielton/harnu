import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  appendTombstone,
  isTombstone,
  journalFile,
  parseJournal,
  readJournal,
  restoreHintForRemove,
  restoreHintForStop,
  serializeTombstone,
  shellQuote
} from '../src/main/containers/containers-journal'
import type { Tombstone } from '../src/main/containers/containers-wire'

function tomb(at: number, over: Partial<Tombstone> = {}): Tombstone {
  return {
    at,
    actor: 'operator',
    verb: 'stop',
    stacks: [
      {
        stack: 'proj-82',
        name: 'proj-82',
        path: '/home/dev/org/proj/www',
        containerIds: ['a'.repeat(64)],
        freed: { ramBytes: 10, ports: [8082], volumes: [], volumeBytes: 0 }
      }
    ],
    restoreHint: 'docker start aaaaaaaaaaaa',
    ...over
  }
}

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

describe('tombstone (de)serialization', () => {
  it('writes one JSON line and parses it back unchanged', () => {
    const t = tomb(1)
    const line = serializeTombstone(t)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(parseJournal(line)).toEqual([t])
  })

  it("round-trips a removal's kept volumes, and drops a line whose keptVolumes is malformed (T331)", () => {
    const base = tomb(7, { verb: 'remove', restoreHint: null })
    const kept: Tombstone = {
      ...base,
      stacks: [{ ...base.stacks[0]!, keptVolumes: ['proj-82_mysql'], keptVolumeBytes: 249_200_000 }]
    }
    expect(parseJournal(serializeTombstone(kept))).toEqual([kept])
    const bad = { ...base, stacks: [{ ...base.stacks[0]!, keptVolumes: 'proj-82_mysql' }] }
    expect(isTombstone(bad)).toBe(false)
    const badBytes = {
      ...base,
      stacks: [{ ...base.stacks[0]!, keptVolumes: [], keptVolumeBytes: '1' }]
    }
    expect(isTombstone(badBytes)).toBe(false)
  })

  it('returns newest first, skips malformed lines, and honors the limit', () => {
    const content = [
      serializeTombstone(tomb(1)),
      'not json\n',
      JSON.stringify({ at: 5, actor: 'robot', verb: 'stop', stacks: [], restoreHint: null }) + '\n',
      JSON.stringify({ ...tomb(6), stacks: [{ stack: 'x' }] }) + '\n',
      serializeTombstone(tomb(3, { actor: 'agent' })),
      serializeTombstone(tomb(2, { verb: 'remove', restoreHint: null }))
    ].join('')
    expect(parseJournal(content).map((t) => t.at)).toEqual([3, 2, 1])
    expect(parseJournal(content, 1).map((t) => t.at)).toEqual([3])
  })

  it('validates every field', () => {
    expect(isTombstone(tomb(1))).toBe(true)
    expect(isTombstone(null)).toBe(false)
    expect(isTombstone({ ...tomb(1), verb: 'kill' })).toBe(false)
    expect(isTombstone({ ...tomb(1), restoreHint: 3 })).toBe(false)
    const badFreed = { ...tomb(1).stacks[0]!, freed: { ...tomb(1).stacks[0]!.freed, ports: ['x'] } }
    expect(isTombstone({ ...tomb(1), stacks: [badFreed] })).toBe(false)
  })
})

describe('restore hints (PRD §3.5)', () => {
  it('after a stop: docker start with every stopped container', () => {
    expect(restoreHintForStop(['a'.repeat(64), 'b'.repeat(12)])).toBe(
      `docker start ${'a'.repeat(12)} ${'b'.repeat(12)}`
    )
    expect(restoreHintForStop([])).toBeNull()
  })

  it('after a removal whose worktree still exists: the compose recreate command', () => {
    expect(
      restoreHintForRemove({
        kind: 'compose',
        project: 'proj-231',
        worktreePath: '/home/dev/org/proj/www',
        worktreeExists: true
      })
    ).toBe('docker compose -p proj-231 --project-directory /home/dev/org/proj/www up -d')
  })

  it('names the project, so a -p or COMPOSE_PROJECT_NAME stack comes back with its volumes', () => {
    expect(
      restoreHintForRemove({
        kind: 'compose',
        project: 'custom name',
        worktreePath: '/w',
        worktreeExists: true
      })
    ).toBe(`docker compose -p 'custom name' --project-directory /w up -d`)
    expect(
      restoreHintForRemove({
        kind: 'compose',
        project: null,
        worktreePath: '/w',
        worktreeExists: true
      })
    ).toBe('docker compose --project-directory /w up -d')
  })

  it('after a removal whose worktree is gone, or of a standalone container: nothing', () => {
    expect(
      restoreHintForRemove({
        kind: 'compose',
        project: 'p',
        worktreePath: '/gone',
        worktreeExists: false
      })
    ).toBeNull()
    expect(
      restoreHintForRemove({
        kind: 'container',
        project: null,
        worktreePath: '/x',
        worktreeExists: true
      })
    ).toBeNull()
    expect(
      restoreHintForRemove({
        kind: 'compose',
        project: 'p',
        worktreePath: null,
        worktreeExists: true
      })
    ).toBeNull()
  })

  it('quotes a hostile path so a pasted hint stays literal', () => {
    expect(shellQuote('/a/b')).toBe('/a/b')
    expect(shellQuote("/tmp/x;rm -rf ~/it's")).toBe(`'/tmp/x;rm -rf ~/it'\\''s'`)
    expect(
      restoreHintForRemove({
        kind: 'compose',
        project: 'x;id',
        worktreePath: '/tmp/$(id)',
        worktreeExists: true
      })
    ).toBe(`docker compose -p 'x;id' --project-directory '/tmp/$(id)' up -d`)
  })
})

describe('journal file', () => {
  it('lives at <userData>/containers-log.jsonl and appends one line per tombstone', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-containers-journal-'))
    dirs.push(dir)
    const file = journalFile(path.join(dir, 'nested'))
    expect(path.basename(file)).toBe('containers-log.jsonl')
    await appendTombstone(file, tomb(1))
    await appendTombstone(file, tomb(2))
    const raw = await fs.readFile(file, 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(2)
    expect((await readJournal(file)).map((t) => t.at)).toEqual([2, 1])
    expect(await readJournal(file, 1)).toHaveLength(1)
  })

  it('reads a missing journal as empty', async () => {
    expect(await readJournal('/nonexistent/containers-log.jsonl')).toEqual([])
  })
})
