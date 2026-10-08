import { afterEach, describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attributeBySlug,
  cwdFromTranscriptHead,
  fsTranscriptProbe,
  mergeActivityFolders,
  scanTranscripts,
  slugOfPath,
  transcriptFolders,
  withGraceUnknown,
  type TranscriptProbe
} from '../src/main/gc/gc-transcripts'
import { bundle } from './gc-fixtures'
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

describe('slugOfPath: the folder name Claude gives a project directory (delta 5, item 3)', () => {
  it('turns every non-alphanumeric character into a dash', () => {
    expect(slugOfPath('/home/dev/Workspace/org/app')).toBe('-home-dev-Workspace-org-app')
    expect(slugOfPath('/ws/app/.claude/worktrees/card-T1_x')).toBe(
      '-ws-app--claude-worktrees-card-T1-x'
    )
  })

  it('ignores a trailing slash', () => {
    expect(slugOfPath('/ws/app/')).toBe(slugOfPath('/ws/app'))
  })
})

describe('transcript activity fails closed (delta 5, item 3)', () => {
  const slug = slugOfPath(WT)

  it('a transcript whose folder cannot be told is attributed by its project slug', async () => {
    const scan = await scanTranscripts(
      fakeProbe({ [slug]: { files: { 'a.jsonl': { mtimeMs: NOW - HOUR, cwd: null } } } }),
      NOW
    )
    expect(scan.folders).toEqual([])
    expect(scan.bySlug).toEqual([{ slug, mtimeMs: NOW - HOUR }])
    expect(scan.rootUnreadable).toBe(false)
  })

  it('so does one that cannot be read at all', async () => {
    const probe = fakeProbe({
      [slug]: { files: { 'a.jsonl': { mtimeMs: NOW - HOUR, cwd: '/x' } } }
    })
    const unreadable: TranscriptProbe = {
      ...probe,
      cwdOf: async () => {
        throw new Error('EACCES')
      }
    }
    expect((await scanTranscripts(unreadable, NOW)).bySlug).toEqual([{ slug, mtimeMs: NOW - HOUR }])
  })

  it('a project folder that cannot be listed counts as active right now', async () => {
    const probe = fakeProbe({ [slug]: {} })
    const broken: TranscriptProbe = {
      ...probe,
      listJsonl: async () => {
        throw new Error('EACCES')
      }
    }
    expect((await scanTranscripts(broken, NOW)).bySlug).toEqual([{ slug, mtimeMs: NOW }])
  })

  it('an unreadable projects root is reported, with nothing attributed', async () => {
    const probe: TranscriptProbe = {
      ...fakeProbe({}),
      listProjectDirs: async () => {
        throw new Error('EACCES')
      }
    }
    expect(await scanTranscripts(probe, NOW)).toEqual({
      folders: [],
      bySlug: [],
      rootUnreadable: true
    })
  })

  it('attributes a slug to the worktree it encodes, and to its subfolders', () => {
    const out = attributeBySlug(
      [
        { slug, mtimeMs: 5 },
        { slug: `${slug}-api`, mtimeMs: 7 },
        { slug: '-ws-elsewhere', mtimeMs: 9 }
      ],
      [WT, '/ws/org/other']
    )
    expect(out).toEqual([{ path: WT, sessions: [{ fileMtime: 5 }, { fileMtime: 7 }] }])
  })

  it('over-attributes rather than miss: a sibling whose name starts the same counts too', () => {
    const out = attributeBySlug([{ slug: '-ws-app-two', mtimeMs: 3 }], ['/ws/app'])
    expect(out).toEqual([{ path: '/ws/app', sessions: [{ fileMtime: 3 }] }])
  })

  it('a transcript with no readable cwd keeps its worktree out of ready', async () => {
    const scan = await scanTranscripts(
      fakeProbe({ [slug]: { files: { 'a.jsonl': { mtimeMs: NOW - HOUR, cwd: null } } } }),
      NOW
    )
    const activity = mergeActivityFolders(scan.folders, attributeBySlug(scan.bySlug, [WT]))
    const b = bundleFor(sessionsFromFleet(activity, idle, AS_GIVEN))
    expect(b.bucket).toBe('in-use')
    expect(b.lastSignOfLifeAt).toBe(NOW - HOUR)
  })

  it('withGraceUnknown turns every ready bundle into review, and touches nothing else', () => {
    const out = withGraceUnknown([
      bundle('/ws/wt/a', 'ready'),
      bundle('/ws/wt/b', 'in-use', { reason: null }),
      bundle('/ws/wt/c', 'review', { reason: { code: 'dirty', detail: 'x' } })
    ])
    expect(out.map((b) => b.bucket)).toEqual(['review', 'in-use', 'review'])
    expect(out[0]!.reason!.detail).toMatch(/transcripts/)
    expect(out[2]!.reason).toEqual({ code: 'dirty', detail: 'x' })
  })

  describe('on the real filesystem', () => {
    const dirs: string[] = []
    const tmp = (): string => {
      const d = mkdtempSync(join(tmpdir(), 'gc-tx-'))
      dirs.push(d)
      return d
    }
    afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

    it('a missing root while ~/.claude does not exist is an empty root: Claude was never used', async () => {
      const scan = await scanTranscripts(fsTranscriptProbe(join(tmp(), '.claude', 'projects')), NOW)
      expect(scan.rootUnreadable).toBe(false)
      expect(scan.folders).toEqual([])
    })

    it('a missing root while ~/.claude exists is unreadable: transcripts may have moved or vanished', async () => {
      const home = tmp()
      mkdirSync(join(home, '.claude'))
      const scan = await scanTranscripts(fsTranscriptProbe(join(home, '.claude', 'projects')), NOW)
      expect(scan.rootUnreadable).toBe(true)
    })

    it('a root that is not a folder cannot be read: nothing may be ready', async () => {
      const file = join(tmp(), 'projects')
      writeFileSync(file, 'x')
      expect((await scanTranscripts(fsTranscriptProbe(file), NOW)).rootUnreadable).toBe(true)
    })

    it('a cwd past the first 64 KB falls back to the slug', async () => {
      const root = tmp()
      mkdirSync(join(root, slug))
      const filler = JSON.stringify({ type: 'user', text: 'x'.repeat(70 * 1024) })
      writeFileSync(join(root, slug, 's.jsonl'), `${filler}\n{"cwd":"${WT}"}\n`)
      const scan = await scanTranscripts(fsTranscriptProbe(root), NOW)
      expect(scan.folders).toEqual([])
      expect(scan.bySlug).toHaveLength(1)
      expect(scan.bySlug[0]!.slug).toBe(slug)
    })
  })
})
