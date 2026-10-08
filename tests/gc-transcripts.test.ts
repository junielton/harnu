import { describe, it, expect } from 'vitest'
import {
  cwdFromTranscriptHead,
  mergeActivityFolders,
  transcriptFolders,
  type TranscriptProbe
} from '../src/main/gc/gc-transcripts'
import { sessionsFromFleet } from '../src/main/gc/gc-sessions'
import { AS_GIVEN, buildBundles } from '../src/main/gc/bundle-core'
import { NOW, WT, collect, scanInput } from './gc-scan-fixtures'

const HOUR = 3_600_000
const DAY = 86_400_000

/** A fake ~/.claude/projects: slug → { index?, files: name → { mtimeMs, cwd } }. */
function fakeProbe(
  tree: Record<
    string,
    {
      index?: Array<{ projectPath?: string; fileMtime?: number; modified?: string }> | null
      files?: Record<string, { mtimeMs: number; cwd: string | null }>
    }
  >
): TranscriptProbe {
  return {
    listProjectDirs: async () => Object.keys(tree),
    readIndex: async (slug) => tree[slug]?.index ?? null,
    listJsonl: async (slug) =>
      Object.entries(tree[slug]?.files ?? {}).map(([name, f]) => ({ name, mtimeMs: f.mtimeMs })),
    cwdOf: async (slug, name) => tree[slug]?.files?.[name]?.cwd ?? null
  }
}

const idle = { live: new Set<string>(), inUse: new Set<string>() }

const bundleFor = (folders: ReturnType<typeof sessionsFromFleet>) => {
  const { items, fateInputs } = collect(scanInput())
  return buildBundles({
    items,
    fateInputs,
    stacks: [],
    stackPaths: new Map(),
    containers: [],
    sessions: folders,
    keep: new Set(),
    neverClean: new Set(),
    now: NOW,
    graceDays: 2,
    volumes: new Map(),
    knownFolders: [],
    protectedProjects: new Set(),
    canonical: AS_GIVEN,
    foreignCheckouts: new Map(items.map((i) => [i.id, []]))
  })[0]!
}

describe('cwdFromTranscriptHead: the folder a transcript belongs to, whatever wrote it', () => {
  it('reads the first cwd, from an interactive transcript', () => {
    const head = '{"type":"summary"}\n{"cwd":"/ws/wt/api","entrypoint":"cli","type":"user"}\n'
    expect(cwdFromTranscriptHead(head)).toBe('/ws/wt/api')
  })

  it('reads it from a headless one too: sdk-cli, sdk-py and the rest', () => {
    for (const entrypoint of ['sdk-cli', 'sdk-py', 'mcp', 'something-new']) {
      expect(cwdFromTranscriptHead(`{"cwd":"/ws/wt","entrypoint":"${entrypoint}"}\n`)).toBe(
        '/ws/wt'
      )
    }
  })

  it('skips a line that is not JSON, and is null when no line has a cwd', () => {
    expect(cwdFromTranscriptHead('garbage\n{"cwd":"/ws/x"}\n')).toBe('/ws/x')
    expect(cwdFromTranscriptHead('{"type":"summary"}\n')).toBeNull()
    expect(cwdFromTranscriptHead('')).toBeNull()
  })

  it('ignores a cwd that is not a non-empty string', () => {
    expect(cwdFromTranscriptHead('{"cwd":5}\n{"cwd":""}\n{"cwd":"/ws/ok"}\n')).toBe('/ws/ok')
  })
})

describe('transcriptFolders: every transcript counts, whoever started it (delta 4, N2)', () => {
  it('a recent sdk-cli transcript in the worktree keeps it in use', async () => {
    // `claude -p` (and Harnu\'s own Scheduler workers) write entrypoint "sdk-cli".
    const folders = await transcriptFolders(
      fakeProbe({ 'slug-a': { files: { 's1.jsonl': { mtimeMs: NOW - HOUR, cwd: `${WT}/api` } } } })
    )
    const sessions = sessionsFromFleet(folders, idle, AS_GIVEN)
    const b = bundleFor(sessions)
    expect(b.lastSignOfLifeAt).toBe(NOW - HOUR)
    expect(b.bucket).toBe('in-use')
  })

  it('takes the newest of several transcripts of a folder', async () => {
    const folders = await transcriptFolders(
      fakeProbe({
        s: {
          files: {
            'a.jsonl': { mtimeMs: NOW - 5 * DAY, cwd: WT },
            'b.jsonl': { mtimeMs: NOW - 2 * HOUR, cwd: WT }
          }
        }
      })
    )
    expect(folders).toHaveLength(1)
    expect(sessionsFromFleet(folders, idle, AS_GIVEN).get(WT)!.lastActivityAt).toBe(NOW - 2 * HOUR)
  })

  it('skips a transcript whose folder cannot be read, without failing the rest', async () => {
    const folders = await transcriptFolders(
      fakeProbe({
        s: {
          files: {
            'a.jsonl': { mtimeMs: NOW, cwd: null },
            'b.jsonl': { mtimeMs: NOW - HOUR, cwd: '/ws/other' }
          }
        }
      })
    )
    expect(folders.map((f) => f.path)).toEqual(['/ws/other'])
  })

  it('survives a project folder that cannot be listed', async () => {
    const probe = fakeProbe({ ok: { files: { 'a.jsonl': { mtimeMs: 1, cwd: '/ws/a' } } }, bad: {} })
    const broken: TranscriptProbe = {
      ...probe,
      listJsonl: async (slug) => {
        if (slug === 'bad') throw new Error('EACCES')
        return probe.listJsonl(slug)
      }
    }
    expect((await transcriptFolders(broken)).map((f) => f.path)).toEqual(['/ws/a'])
  })
})

describe('a stale legacy sessions-index.json (delta 4, N3)', () => {
  it('reads the JSONL mtimes as well when the index is older than the newest transcript', async () => {
    const folders = await transcriptFolders(
      fakeProbe({
        s: {
          index: [{ projectPath: WT, fileMtime: NOW - 30 * DAY }],
          files: { 'new.jsonl': { mtimeMs: NOW - HOUR, cwd: WT } }
        }
      })
    )
    const sessions = sessionsFromFleet(folders, idle, AS_GIVEN)
    expect(sessions.get(WT)!.lastActivityAt).toBe(NOW - HOUR)
    expect(bundleFor(sessions).bucket).toBe('in-use')
  })

  it('still counts an index entry whose transcript is gone', async () => {
    const folders = await transcriptFolders(
      fakeProbe({
        s: { index: [{ projectPath: WT, modified: new Date(NOW - HOUR).toISOString() }] }
      })
    )
    expect(sessionsFromFleet(folders, idle, AS_GIVEN).get(WT)!.lastActivityAt).toBe(NOW - HOUR)
  })

  it('does not let an index entry without a folder count for anything', async () => {
    const folders = await transcriptFolders(fakeProbe({ s: { index: [{ fileMtime: NOW }] } }))
    expect(folders).toEqual([])
  })
})

describe('mergeActivityFolders', () => {
  it('joins the fleet and the transcripts folder by folder', () => {
    const merged = mergeActivityFolders(
      [{ path: '/ws/a', sessions: [{ fileMtime: 1 }] }],
      [
        { path: '/ws/a', sessions: [{ fileMtime: 9 }] },
        { path: '/ws/b', sessions: [{ fileMtime: 5 }] }
      ]
    )
    expect(merged.map((f) => f.path).sort()).toEqual(['/ws/a', '/ws/b'])
    expect(merged.find((f) => f.path === '/ws/a')!.sessions).toEqual([
      { fileMtime: 1 },
      { fileMtime: 9 }
    ])
  })
})
