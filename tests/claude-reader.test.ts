import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanFolders } from '../src/main/claude-reader'
import type { FolderEntry } from '../src/main/folder-model'

/**
 * Regression net for the JSONL fallback reader (spec §7.1), migrated to the
 * folder-first `scanFolders` API. Writes anonymized line shapes to a temp
 * `~/.claude/projects`-like dir and asserts the rendered folder model: name
 * cascade (N1/N2), per-session branch (G2), sidechain ignored, SDK filtering,
 * late `/rename`, bridge/cloud flags, and subagent seeding. `scanFolders`
 * regroups every session by its own cwd (`projectPath`), so a worktree session
 * lands in its OWN folder rather than nested under a root project's worktree.
 *
 * The temp dirs are NOT git repos, so folders carry NO git fields — we never
 * assert `gitBranch`/`repoId`/`isMainWorktree` at the folder level.
 */
function userLine(opts: {
  sessionId: string
  cwd: string
  gitBranch: string
  content: string
  isSidechain?: boolean
}): string {
  return JSON.stringify({
    type: 'user',
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    gitBranch: opts.gitBranch,
    isSidechain: opts.isSidechain ?? false,
    message: { role: 'user', content: opts.content },
    uuid: `${opts.sessionId}-u1`,
    timestamp: '2026-06-01T00:00:00.000Z'
  })
}
function titleLine(sessionId: string, customTitle: string): string {
  return JSON.stringify({ type: 'custom-title', sessionId, customTitle })
}

/** Find the folder for an exact cwd; fails loudly (non-null) if absent. */
function folderFor(folders: FolderEntry[], path: string): FolderEntry {
  const f = folders.find((x) => x.path === path)
  if (!f)
    throw new Error(`no folder for cwd ${path} (got ${folders.map((x) => x.path).join(', ')})`)
  return f
}

describe('scanFolders — JSONL fallback', () => {
  let root: string
  let slugDir: string
  const ROOT_CWD = '/work/DemoApp'
  const WT_CWD = '/work/DemoApp/.claude/worktrees/funny-bohr-cfce08'

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-reader-'))
    // Slug folder name is lossy/irrelevant here — the reader derives path from cwd.
    slugDir = join(root, '-work-DemoApp')
    await fs.mkdir(slugDir, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('names a session from its first real prompt when there is no /rename', async () => {
    await fs.writeFile(
      join(slugDir, 'aaaa1111-0000-0000-0000-000000000001.jsonl'),
      userLine({
        sessionId: 'aaaa1111-0000-0000-0000-000000000001',
        cwd: ROOT_CWD,
        gitBranch: 'master',
        content: '<system-reminder>session context</system-reminder>Refactor the PTY index'
      }) + '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    const sessions = folderFor(folders, ROOT_CWD).sessions
    const s = sessions.find((x) => x.sessionId.endsWith('0001'))!
    expect(s.summary).toBe('') // no custom-title
    expect(s.firstPrompt).toBe('Refactor the PTY index') // <- was '' before the fix
  })

  it('uses customTitle as summary when a /rename happened', async () => {
    await fs.writeFile(
      join(slugDir, 'aaaa1111-0000-0000-0000-000000000002.jsonl'),
      userLine({
        sessionId: 'aaaa1111-0000-0000-0000-000000000002',
        cwd: ROOT_CWD,
        gitBranch: 'master',
        content: 'whatever prompt'
      }) +
        '\n' +
        titleLine('aaaa1111-0000-0000-0000-000000000002', 'My renamed session') +
        '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    const s = folderFor(folders, ROOT_CWD).sessions[0]
    expect(s.summary).toBe('My renamed session')
  })

  it('groups each session under its own cwd folder (root vs worktree)', async () => {
    // 1 root session + 1 worktree session in the same slug. In the folder model
    // they split into SEPARATE folders keyed by their own cwd — no merge.
    await fs.writeFile(
      join(slugDir, 'bbbb2222-0000-0000-0000-000000000001.jsonl'),
      userLine({
        sessionId: 'bbbb2222-0000-0000-0000-000000000001',
        cwd: ROOT_CWD,
        gitBranch: 'master',
        content: 'root session prompt'
      }) + '\n'
    )
    await fs.writeFile(
      join(slugDir, 'cccc3333-0000-0000-0000-000000000001.jsonl'),
      userLine({
        sessionId: 'cccc3333-0000-0000-0000-000000000001',
        cwd: WT_CWD,
        gitBranch: 'claude/funny-bohr-cfce08',
        content: 'worktree session prompt'
      }) + '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    expect(folders).toHaveLength(2)
    const rootFolder = folderFor(folders, ROOT_CWD)
    expect(rootFolder.alias).toBe('DemoApp')
    expect(rootFolder.sessions.map((s) => s.sessionId)).toEqual([
      'bbbb2222-0000-0000-0000-000000000001'
    ])
    const wtFolder = folderFor(folders, WT_CWD)
    expect(wtFolder.alias).toBe('funny-bohr-cfce08')
    expect(wtFolder.sessions.map((s) => s.sessionId)).toEqual([
      'cccc3333-0000-0000-0000-000000000001'
    ])
    // Non-git temp dirs carry no git fields at the folder level.
    expect('gitBranch' in rootFolder).toBe(false)
    expect('repoId' in rootFolder).toBe(false)
    expect('isMainWorktree' in rootFolder).toBe(false)
  })

  it('keeps each session on its own branch (G2)', async () => {
    await fs.writeFile(
      join(slugDir, 'bbbb2222-0000-0000-0000-000000000001.jsonl'),
      userLine({
        sessionId: 'bbbb2222-0000-0000-0000-000000000001',
        cwd: ROOT_CWD,
        gitBranch: 'master',
        content: 'root'
      }) + '\n'
    )
    await fs.writeFile(
      join(slugDir, 'cccc3333-0000-0000-0000-000000000001.jsonl'),
      userLine({
        sessionId: 'cccc3333-0000-0000-0000-000000000001',
        cwd: WT_CWD,
        gitBranch: 'claude/funny-bohr-cfce08',
        content: 'wt'
      }) + '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    // Each session keeps its own per-session `gitBranch` (set from the JSONL),
    // independent of the folder-level git probe (absent on a non-repo temp dir).
    expect(folderFor(folders, ROOT_CWD).sessions[0].gitBranch).toBe('master')
    expect(folderFor(folders, WT_CWD).sessions[0].gitBranch).toBe('claude/funny-bohr-cfce08')
  })

  it('resolves a slash-command first turn to the command name', async () => {
    await fs.writeFile(
      join(slugDir, 'dddd4444-0000-0000-0000-000000000001.jsonl'),
      userLine({
        sessionId: 'dddd4444-0000-0000-0000-000000000001',
        cwd: ROOT_CWD,
        gitBranch: 'master',
        content:
          '<command-message>dtk:smart-commit is running</command-message><command-name>dtk:smart-commit</command-name>'
      }) + '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    expect(folderFor(folders, ROOT_CWD).sessions[0].firstPrompt).toBe('dtk:smart-commit')
  })

  it('ignores sidechain (subagent) user turns when naming', async () => {
    await fs.writeFile(
      join(slugDir, 'eeee5555-0000-0000-0000-000000000001.jsonl'),
      userLine({
        sessionId: 'eeee5555-0000-0000-0000-000000000001',
        cwd: ROOT_CWD,
        gitBranch: 'master',
        content: 'subagent noise',
        isSidechain: true
      }) +
        '\n' +
        userLine({
          sessionId: 'eeee5555-0000-0000-0000-000000000001',
          cwd: ROOT_CWD,
          gitBranch: 'master',
          content: 'the real first prompt'
        }) +
        '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    expect(folderFor(folders, ROOT_CWD).sessions[0].firstPrompt).toBe('the real first prompt')
  })
})

describe('scanFolders — SDK session filtering (#6)', () => {
  let root: string
  let slugDir: string
  const ROOT_CWD = '/work/DemoApp'

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-sdk-'))
    slugDir = join(root, '-work-DemoApp')
    await fs.mkdir(slugDir, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  function lineWithEntrypoint(sessionId: string, entrypoint: string, content: string): string {
    return JSON.stringify({
      type: 'user',
      sessionId,
      entrypoint,
      cwd: ROOT_CWD,
      gitBranch: 'master',
      isSidechain: false,
      message: { role: 'user', content },
      uuid: `${sessionId}-u1`,
      timestamp: '2026-06-01T00:00:00.000Z'
    })
  }

  it('drops a programmatic sdk-py session but keeps the interactive cli one', async () => {
    await fs.writeFile(
      join(slugDir, 'c04f4c0b-0000-0000-0000-000000000001.jsonl'),
      lineWithEntrypoint('c04f4c0b-0000-0000-0000-000000000001', 'cli', 'real user work') + '\n'
    )
    await fs.writeFile(
      join(slugDir, '75b74d4c-0000-0000-0000-000000000002.jsonl'),
      lineWithEntrypoint(
        '75b74d4c-0000-0000-0000-000000000002',
        'sdk-py',
        'Review this change for security vulnerabilities.'
      ) + '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    const ids = folderFor(folders, ROOT_CWD).sessions.map((s) => s.sessionId)
    expect(ids).toEqual(['c04f4c0b-0000-0000-0000-000000000001'])
  })

  it('hides a folder whose only session is programmatic', async () => {
    await fs.writeFile(
      join(slugDir, '75b74d4c-0000-0000-0000-000000000002.jsonl'),
      lineWithEntrypoint('75b74d4c-0000-0000-0000-000000000002', 'sdk-py', 'programmatic') + '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    expect(folders).toHaveLength(0)
  })

  it('keeps sessions that have no entrypoint field (older transcripts)', async () => {
    await fs.writeFile(
      join(slugDir, 'aaaa1111-0000-0000-0000-000000000003.jsonl'),
      userLine({
        sessionId: 'aaaa1111-0000-0000-0000-000000000003',
        cwd: ROOT_CWD,
        gitBranch: 'master',
        content: 'legacy prompt'
      }) + '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    expect(folderFor(folders, ROOT_CWD).sessions).toHaveLength(1)
  })
})

describe('scanFolders — late /rename precedence (#7)', () => {
  let root: string
  let slugDir: string
  const ROOT_CWD = '/work/DemoApp'

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-rename-'))
    slugDir = join(root, '-work-DemoApp')
    await fs.mkdir(slugDir, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('picks up a custom-title written far past the head window via the tail scan', async () => {
    const sessionId = '24a00b67-0000-0000-0000-000000000001'
    const first = userLine({
      sessionId,
      cwd: ROOT_CWD,
      gitBranch: 'master',
      content: 'check status'
    })
    // One ~120 KB filler line so the custom-title lands well beyond the 64 KB
    // head window — mirrors the real exampleapp transcript (rename at offset ~254 KB).
    const filler = JSON.stringify({ type: 'assistant', sessionId, pad: 'x'.repeat(120 * 1024) })
    const title = titleLine(sessionId, 'exampleapp-project-status')
    await fs.writeFile(join(slugDir, `${sessionId}.jsonl`), `${first}\n${filler}\n${title}\n`)

    const folders = await scanFolders({ rootDir: root })
    const s = folderFor(folders, ROOT_CWD).sessions[0]
    expect(s.summary).toBe('exampleapp-project-status') // custom-title wins, not the first prompt
  })
})

describe('scanFolders — bridge/cloud + large-file naming', () => {
  let root: string
  let slugDir: string
  const ROOT_CWD = '/work/DemoApp'

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-bridge-'))
    slugDir = join(root, '-work-DemoApp')
    await fs.mkdir(slugDir, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  function aiTitleLine(sessionId: string, aiTitle: string): string {
    return JSON.stringify({ type: 'ai-title', sessionId, aiTitle })
  }
  function bridgeLine(sessionId: string, lastSequenceNum: number): string {
    return JSON.stringify({
      type: 'bridge-session',
      sessionId,
      bridgeSessionId: `cse_${sessionId}`,
      lastSequenceNum
    })
  }
  /** ~`approxBytes` of harmless metadata lines, to push later lines past the 64KB head. */
  function filler(sessionId: string, approxBytes: number): string {
    const one =
      JSON.stringify({ type: 'mode', sessionId, mode: 'normal', pad: 'x'.repeat(200) }) + '\n'
    const n = Math.ceil(approxBytes / one.length)
    return one.repeat(n)
  }

  it('finds a /rename custom-title that lives far beyond the old 64KB head window', async () => {
    const id = 'ffff6666-0000-0000-0000-000000000001'
    await fs.writeFile(
      join(slugDir, `${id}.jsonl`),
      userLine({ sessionId: id, cwd: ROOT_CWD, gitBranch: 'master', content: 'real prompt' }) +
        '\n' +
        filler(id, 80 * 1024) +
        titleLine(id, 'renamed-after-much-talk') +
        '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    const s = folderFor(folders, ROOT_CWD).sessions[0]
    expect(s.summary).toBe('renamed-after-much-talk')
  })

  it('extracts the first real prompt even when it sits beyond the old 64KB head window', async () => {
    const id = 'ffff6666-0000-0000-0000-000000000002'
    await fs.writeFile(
      join(slugDir, `${id}.jsonl`),
      filler(id, 80 * 1024) +
        userLine({ sessionId: id, cwd: ROOT_CWD, gitBranch: 'master', content: 'late prompt' }) +
        '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    const s = folderFor(folders, ROOT_CWD).sessions[0]
    expect(s.firstPrompt).toBe('late prompt')
  })

  it('falls back to aiTitle for the summary when there was no /rename', async () => {
    const id = 'ffff6666-0000-0000-0000-000000000003'
    await fs.writeFile(
      join(slugDir, `${id}.jsonl`),
      userLine({ sessionId: id, cwd: ROOT_CWD, gitBranch: 'master', content: 'hello there' }) +
        '\n' +
        aiTitleLine(id, 'A helpful generated title') +
        '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    const s = folderFor(folders, ROOT_CWD).sessions[0]
    expect(s.summary).toBe('A helpful generated title')
  })

  it('prefers an explicit /rename custom-title over the aiTitle', async () => {
    const id = 'ffff6666-0000-0000-0000-000000000004'
    await fs.writeFile(
      join(slugDir, `${id}.jsonl`),
      userLine({ sessionId: id, cwd: ROOT_CWD, gitBranch: 'master', content: 'hi' }) +
        '\n' +
        aiTitleLine(id, 'Generated title') +
        '\n' +
        titleLine(id, 'user-renamed') +
        '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    expect(folderFor(folders, ROOT_CWD).sessions[0].summary).toBe('user-renamed')
  })

  it('marks a metadata-only bridge session (0 local turns) as non-resumable + bridged', async () => {
    // Mirrors the real a3e4b100 case: only metadata lines, conversation is in the cloud.
    const id = 'ffff6666-0000-0000-0000-000000000005'
    await fs.writeFile(
      join(slugDir, `${id}.jsonl`),
      JSON.stringify({ type: 'last-prompt', sessionId: id, cwd: ROOT_CWD, gitBranch: 'master' }) +
        '\n' +
        titleLine(id, 'session-persistence-behavior') +
        '\n' +
        bridgeLine(id, 931) +
        '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    const s = folderFor(folders, ROOT_CWD).sessions[0]
    expect(s.summary).toBe('session-persistence-behavior')
    expect(s.resumable).toBe(false)
    expect(s.bridged).toBe(true)
  })

  it('marks a session with real conversation turns as resumable', async () => {
    const id = 'ffff6666-0000-0000-0000-000000000006'
    await fs.writeFile(
      join(slugDir, `${id}.jsonl`),
      userLine({ sessionId: id, cwd: ROOT_CWD, gitBranch: 'master', content: 'a real turn' }) +
        '\n' +
        bridgeLine(id, 12) +
        '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    const s = folderFor(folders, ROOT_CWD).sessions[0]
    expect(s.resumable).toBe(true)
    expect(s.bridged).toBe(true)
  })
})

describe('scanFolders — worktree slugs split into per-cwd folders (G5)', () => {
  let root: string
  const ROOT_CWD = '/work/DemoApp'
  const WT_NAME = 'funny-bohr-cfce08'
  const WT_CWD = `${ROOT_CWD}/.claude/worktrees/${WT_NAME}`

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-merge-'))
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  async function mkSlug(
    slug: string,
    sessions: Array<{ id: string; cwd: string; branch: string }>
  ): Promise<void> {
    const dir = join(root, slug)
    await fs.mkdir(dir, { recursive: true })
    for (const s of sessions) {
      await fs.writeFile(
        join(dir, `${s.id}.jsonl`),
        userLine({ sessionId: s.id, cwd: s.cwd, gitBranch: s.branch, content: `prompt ${s.id}` }) +
          '\n'
      )
    }
  }

  it('keeps a separate worktree slug as its own folder, keyed by cwd (JSONL path)', async () => {
    // In the project model these two slugs merged into one project + nested
    // worktree. In the folder model they stay SEPARATE folders, one per cwd.
    await mkSlug('-work-DemoApp', [{ id: 'root-sess-001', cwd: ROOT_CWD, branch: 'master' }])
    await mkSlug(`-work-DemoApp--claude-worktrees-${WT_NAME}`, [
      { id: 'wt-sess-001', cwd: WT_CWD, branch: `claude/${WT_NAME}` }
    ])

    const folders = await scanFolders({ rootDir: root })
    expect(folders).toHaveLength(2)

    const rootFolder = folderFor(folders, ROOT_CWD)
    expect(rootFolder.alias).toBe('DemoApp')
    expect(rootFolder.sessions.map((s) => s.sessionId)).toEqual(['root-sess-001'])

    const wtFolder = folderFor(folders, WT_CWD)
    expect(wtFolder.alias).toBe(WT_NAME)
    expect(wtFolder.sessions.map((s) => s.sessionId)).toEqual(['wt-sess-001'])
  })

  it('splits multiple worktree slugs into one folder per cwd', async () => {
    const ALPHA_CWD = `${ROOT_CWD}/.claude/worktrees/wt-alpha`
    const BETA_CWD = `${ROOT_CWD}/.claude/worktrees/wt-beta`
    await mkSlug('-work-DemoApp', [{ id: 'root-s1', cwd: ROOT_CWD, branch: 'master' }])
    await mkSlug(`-work-DemoApp--claude-worktrees-wt-alpha`, [
      { id: 'wt-alpha-s1', cwd: ALPHA_CWD, branch: 'claude/wt-alpha' }
    ])
    await mkSlug(`-work-DemoApp--claude-worktrees-wt-beta`, [
      { id: 'wt-beta-s1', cwd: BETA_CWD, branch: 'claude/wt-beta' }
    ])

    const folders = await scanFolders({ rootDir: root })
    expect(folders).toHaveLength(3) // root + alpha + beta, all distinct cwds
    const paths = folders.map((f) => f.path).sort()
    expect(paths).toEqual([ROOT_CWD, ALPHA_CWD, BETA_CWD].sort())
    // Each session lands under its own cwd.
    expect(folderFor(folders, ROOT_CWD).sessions.map((s) => s.sessionId)).toEqual(['root-s1'])
    expect(folderFor(folders, ALPHA_CWD).sessions.map((s) => s.sessionId)).toEqual(['wt-alpha-s1'])
    expect(folderFor(folders, BETA_CWD).sessions.map((s) => s.sessionId)).toEqual(['wt-beta-s1'])
  })

  it('keeps an orphan worktree slug (no root) as its own folder', async () => {
    // No root slug — only the worktree. The folder is still keyed by its cwd.
    await mkSlug(`-work-DemoApp--claude-worktrees-${WT_NAME}`, [
      { id: 'wt-sess-001', cwd: WT_CWD, branch: `claude/${WT_NAME}` }
    ])

    const folders = await scanFolders({ rootDir: root })
    expect(folders).toHaveLength(1)
    expect(folders[0].path).toBe(WT_CWD)
    expect(folders[0].sessions.map((s) => s.sessionId)).toEqual(['wt-sess-001'])
  })

  it('splits the REAL on-disk slug shape into one folder per cwd (regression: `--claude-worktrees-`, double dash)', async () => {
    // Locks the exact slug encoding observed on disk. Claude slugifies
    // `/home/.../DemoApp/.claude/worktrees/<name>` by turning every `/` AND
    // the leading `.` of `.claude` into `-`. In the project model the four
    // on-disk slugs collapsed to ONE project; in the folder model each session
    // regroups by its own cwd, so we get one folder per distinct cwd.
    const REAL_ROOT_SLUG = '-home-u-Workspace-sandbox-DemoApp'
    const REAL_ROOT_CWD = '/home/u/Workspace/sandbox/DemoApp'
    const wts = ['awesome-elbakyan-427a87', 'fervent-lumiere-e193c8', 'gallant-satoshi-41c3c1']

    await mkSlug(REAL_ROOT_SLUG, [{ id: 'root-real-001', cwd: REAL_ROOT_CWD, branch: 'master' }])
    for (const name of wts) {
      await mkSlug(`${REAL_ROOT_SLUG}--claude-worktrees-${name}`, [
        {
          id: `wt-${name}`,
          cwd: `${REAL_ROOT_CWD}/.claude/worktrees/${name}`,
          branch: `claude/${name}`
        }
      ])
    }

    const folders = await scanFolders({ rootDir: root })
    // The root + three worktree cwds become FOUR distinct folders.
    expect(folders).toHaveLength(4)
    const paths = folders.map((f) => f.path).sort()
    expect(paths).toEqual(
      [
        REAL_ROOT_CWD,
        `${REAL_ROOT_CWD}/.claude/worktrees/awesome-elbakyan-427a87`,
        `${REAL_ROOT_CWD}/.claude/worktrees/fervent-lumiere-e193c8`,
        `${REAL_ROOT_CWD}/.claude/worktrees/gallant-satoshi-41c3c1`
      ].sort()
    )
    expect(folderFor(folders, REAL_ROOT_CWD).alias).toBe('DemoApp')
    // Each worktree folder owns exactly its one session, keyed by its real cwd.
    for (const name of wts) {
      const wtCwd = `${REAL_ROOT_CWD}/.claude/worktrees/${name}`
      const wtFolder = folderFor(folders, wtCwd)
      expect(wtFolder.alias).toBe(name)
      expect(wtFolder.sessions.map((s) => s.sessionId)).toEqual([`wt-${name}`])
    }
  })

  it('splits a worktree slug with sessions-index.json (fast path) into per-cwd folders', async () => {
    // Root via index
    const rootSlugDir = join(root, '-work-DemoApp')
    await fs.mkdir(rootSlugDir, { recursive: true })
    await fs.writeFile(
      join(rootSlugDir, 'sessions-index.json'),
      JSON.stringify({
        version: 1,
        originalPath: ROOT_CWD,
        entries: [
          {
            sessionId: 'root-idx-001',
            fullPath: `${ROOT_CWD}/root-idx-001.jsonl`,
            fileMtime: 1000,
            firstPrompt: 'root prompt',
            summary: '',
            messageCount: 1,
            created: '2026-06-01T00:00:00.000Z',
            modified: '2026-06-01T00:00:00.000Z',
            gitBranch: 'master',
            projectPath: ROOT_CWD,
            isSidechain: false
          }
        ]
      })
    )
    // Worktree via index (originalPath = worktree path)
    const wtSlugDir = join(root, `-work-DemoApp--claude-worktrees-${WT_NAME}`)
    await fs.mkdir(wtSlugDir, { recursive: true })
    await fs.writeFile(
      join(wtSlugDir, 'sessions-index.json'),
      JSON.stringify({
        version: 1,
        originalPath: WT_CWD,
        entries: [
          {
            sessionId: 'wt-idx-001',
            fullPath: `${WT_CWD}/wt-idx-001.jsonl`,
            fileMtime: 2000,
            firstPrompt: 'wt prompt',
            summary: '',
            messageCount: 1,
            created: '2026-06-01T00:00:00.000Z',
            modified: '2026-06-01T00:00:00.000Z',
            gitBranch: `claude/${WT_NAME}`,
            projectPath: WT_CWD,
            isSidechain: false
          }
        ]
      })
    )

    const folders = await scanFolders({ rootDir: root })
    expect(folders).toHaveLength(2)
    expect(folderFor(folders, ROOT_CWD).sessions.map((s) => s.sessionId)).toEqual(['root-idx-001'])
    const wtFolder = folderFor(folders, WT_CWD)
    expect(wtFolder.path).toBe(WT_CWD) // keyed by the session's own cwd
    expect(wtFolder.sessions.map((s) => s.sessionId)).toEqual(['wt-idx-001'])
  })
})

/**
 * Issue #9 — nested parallel agents (subagents). The reader seeds pre-existing
 * `<slug>/<parentUuid>/subagents/agent-*.jsonl` onto the parent session's
 * `agents[]`, with attribution + a recency-based running/done status. Migrated
 * to the folder model: the parent session is found inside its cwd's folder.
 */
describe('scanFolders — subagent seeding (issue #9)', () => {
  let root: string
  let slugDir: string
  const CWD = '/work/Demo'
  const PARENT = 'pppppppp-0000-0000-0000-000000000001'

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-subagent-'))
    slugDir = join(root, '-work-Demo')
    await fs.mkdir(slugDir, { recursive: true })
    // Parent (interactive) session transcript.
    await fs.writeFile(
      join(slugDir, `${PARENT}.jsonl`),
      userLine({ sessionId: PARENT, cwd: CWD, gitBranch: 'main', content: 'Parent task' }) + '\n'
    )
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  async function writeSubagent(
    agentId: string,
    lines: object[],
    opts?: { mtimeMs?: number }
  ): Promise<string> {
    const dir = join(slugDir, PARENT, 'subagents')
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, `agent-${agentId}.jsonl`)
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    if (opts?.mtimeMs !== undefined) {
      const t = opts.mtimeMs / 1000
      await fs.utimes(file, t, t)
    }
    return file
  }

  function firstUserLine(task: string, attribution?: Record<string, unknown>): object {
    return {
      type: 'user',
      isSidechain: true,
      sessionId: PARENT,
      attributionAgent: null,
      attributionSkill: null,
      attributionPlugin: null,
      entrypoint: 'remote',
      cwd: CWD,
      gitBranch: 'main',
      message: { role: 'user', content: task },
      ...attribution
    }
  }
  function assistantLine(model: string): object {
    return {
      type: 'assistant',
      sessionId: PARENT,
      message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] }
    }
  }

  it('attaches a subagent to its parent session with attribution + model + task', async () => {
    await writeSubagent('a261360aa7cdd561e', [
      firstUserLine('Map the codebase for issue #9', {
        attributionAgent: 'general-purpose',
        attributionSkill: 'superpowers:dispatching-parallel-agents'
      }),
      assistantLine('claude-haiku-4-5-20251001')
    ])

    const folders = await scanFolders({ rootDir: root })
    const parent = folderFor(folders, CWD).sessions.find((s) => s.sessionId === PARENT)!
    expect(parent.agents).toHaveLength(1)
    const a = parent.agents[0]
    expect(a.agentId).toBe('a261360aa7cdd561e')
    expect(a.parentSessionId).toBe(PARENT)
    expect(a.agentType).toBe('general-purpose')
    expect(a.skill).toBe('superpowers:dispatching-parallel-agents')
    expect(a.model).toBe('claude-haiku-4-5-20251001')
    expect(a.task).toBe('Map the codebase for issue #9')
  })

  it('derives agentId from the filename when the field is absent', async () => {
    await writeSubagent('beadfeed', [
      {
        type: 'user',
        isSidechain: true,
        sessionId: PARENT,
        message: { role: 'user', content: 'x' }
      }
    ])
    const folders = await scanFolders({ rootDir: root })
    const parent = folderFor(folders, CWD).sessions.find((s) => s.sessionId === PARENT)!
    expect(parent.agents[0].agentId).toBe('beadfeed')
  })

  it('labels a recently-appended subagent running and an old one done', async () => {
    await writeSubagent('fresh01', [firstUserLine('recent')], { mtimeMs: Date.now() })
    const folders = await scanFolders({ rootDir: root })
    const parent = folderFor(folders, CWD).sessions.find((s) => s.sessionId === PARENT)!
    expect(parent.agents[0].status).toBe('running')

    // Re-scan with the file aged well past the active window.
    await fs.utimes(
      join(slugDir, PARENT, 'subagents', 'agent-fresh01.jsonl'),
      (Date.now() - 60_000) / 1000,
      (Date.now() - 60_000) / 1000
    )
    const folders2 = await scanFolders({ rootDir: root })
    const parent2 = folderFor(folders2, CWD).sessions.find((s) => s.sessionId === PARENT)!
    expect(parent2.agents[0].status).toBe('done')
  })

  it('leaves agents empty for sessions with no subagents', async () => {
    const folders = await scanFolders({ rootDir: root })
    const parent = folderFor(folders, CWD).sessions.find((s) => s.sessionId === PARENT)!
    expect(parent.agents).toEqual([])
  })
})

describe('scanFolders — agent-teams teammate grouping (T99)', () => {
  let root: string
  let slugDir: string
  const CWD = '/work/Demo'
  const LEAD = '7399191c-0ea7-4d4e-90ab-bf36a3f5c610'
  const TEAMMATE = '03777eec-00f1-46a5-a7d0-2df48cb65492'

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-teammate-'))
    slugDir = join(root, '-work-Demo')
    await fs.mkdir(slugDir, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  /** A teammate's first `user` line: `teamName`/`agentName` sit top-level, from line 1. */
  function teammateUserLine(opts: {
    sessionId: string
    cwd: string
    teamName: string
    agentName: string
    content: string
  }): string {
    return JSON.stringify({
      type: 'user',
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      gitBranch: 'main',
      teamName: opts.teamName,
      agentName: opts.agentName,
      isSidechain: false,
      message: { role: 'user', content: opts.content },
      uuid: `${opts.sessionId}-u1`,
      timestamp: '2026-06-01T00:00:00.000Z'
    })
  }

  it('reads teamName + agentName from a teammate transcript', async () => {
    await fs.writeFile(
      join(slugDir, `${TEAMMATE}.jsonl`),
      teammateUserLine({
        sessionId: TEAMMATE,
        cwd: CWD,
        teamName: 'session-7399191c',
        agentName: 'spec-ui',
        content: 'Implement the spec-ui piece'
      }) + '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    const s = folderFor(folders, CWD).sessions.find((x) => x.sessionId === TEAMMATE)!
    expect(s.teamName).toBe('session-7399191c')
    expect(s.agentName).toBe('spec-ui')
  })

  it('leaves teamName/agentName empty for a normal (non-team) session', async () => {
    await fs.writeFile(
      join(slugDir, `${LEAD}.jsonl`),
      userLine({
        sessionId: LEAD,
        cwd: CWD,
        gitBranch: 'main',
        content: 'Regular session prompt'
      }) + '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    const s = folderFor(folders, CWD).sessions.find((x) => x.sessionId === LEAD)!
    expect(s.teamName).toBe('')
    expect(s.agentName).toBe('')
  })

  it('leaves teamName/agentName empty for the team LEAD session itself', async () => {
    // The lead's own transcript never carries teamName/agentName — only its
    // teammates' do.
    await fs.writeFile(
      join(slugDir, `${LEAD}.jsonl`),
      userLine({ sessionId: LEAD, cwd: CWD, gitBranch: 'main', content: 'Orchestrate the team' }) +
        '\n'
    )
    await fs.writeFile(
      join(slugDir, `${TEAMMATE}.jsonl`),
      teammateUserLine({
        sessionId: TEAMMATE,
        cwd: CWD,
        teamName: 'session-7399191c',
        agentName: 'spec-ui',
        content: 'Implement the spec-ui piece'
      }) + '\n'
    )
    const folders = await scanFolders({ rootDir: root })
    const lead = folderFor(folders, CWD).sessions.find((x) => x.sessionId === LEAD)!
    expect(lead.teamName).toBe('')
    expect(lead.agentName).toBe('')
  })
})

describe('scanFolders — repeated /rename (BUG-78)', () => {
  let root: string
  let slugDir: string
  const CWD = '/work/Demo'
  const ID = 'bbbb7878-0000-4000-8000-000000000001'

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'harnu-bug78-'))
    slugDir = join(root, '-work-Demo')
    await fs.mkdir(slugDir, { recursive: true })
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  /** The CLI's real two-line `/rename` shape (Claude Code 2.1.287). */
  const rename = (sessionId: string, name: string): string[] => [
    JSON.stringify({ type: 'custom-title', customTitle: name, sessionId }),
    JSON.stringify({ type: 'agent-name', agentName: name, sessionId })
  ]
  /** The CLI re-appends the pair a few times per rename. */
  const renamed = (sessionId: string, name: string, times = 3): string[] =>
    Array.from({ length: times }, () => rename(sessionId, name)).flat()
  const turn = (sessionId: string, content: string): string =>
    userLine({ sessionId, cwd: CWD, gitBranch: 'main', content })
  /** ~`approxBytes` of harmless metadata lines. */
  function filler(sessionId: string, approxBytes: number): string[] {
    const one = JSON.stringify({ type: 'mode', sessionId, mode: 'normal', pad: 'x'.repeat(200) })
    return Array.from({ length: Math.ceil(approxBytes / (one.length + 1)) }, () => one)
  }
  async function scanOne(lines: string[]): Promise<FolderEntry['sessions'][number]> {
    await fs.writeFile(join(slugDir, `${ID}.jsonl`), lines.join('\n') + '\n')
    const folders = await scanFolders({ rootDir: root })
    return folderFor(folders, CWD).sessions.find((x) => x.sessionId === ID)!
  }

  it('AC1: a session renamed twice scans to the latest name, with no agentName', async () => {
    const s = await scanOne([
      turn(ID, 'first prompt'),
      ...renamed(ID, 'A'),
      turn(ID, 'more work'),
      turn(ID, 'and more'),
      ...renamed(ID, 'B')
    ])
    expect(s.summary).toBe('B')
    expect(s.agentName).toBe('')
    expect(s.teamName).toBe('')
  })

  it('AC2: same past MAX_SCAN_BYTES — A pair in the head, final B pair in the last 512 KB', async () => {
    const lines = [
      turn(ID, 'first prompt'),
      ...renamed(ID, 'A'),
      ...filler(ID, 2.5 * 1024 * 1024),
      turn(ID, 'late work'),
      ...renamed(ID, 'B')
    ]
    const s = await scanOne(lines)
    const size = (await fs.stat(join(slugDir, `${ID}.jsonl`))).size
    expect(size).toBeGreaterThan(2 * 1024 * 1024)
    expect(s.summary).toBe('B')
    expect(s.agentName).toBe('')
    expect(s.teamName).toBe('')
  })

  it('AC4: an agent-name line as line 1, with no teamName anywhere, never sets agentName', async () => {
    const s = await scanOne([...rename(ID, 'first-name'), turn(ID, 'first prompt')])
    expect(s.agentName).toBe('')
    expect(s.teamName).toBe('')
  })

  it('AC5: teamName and agentName never on the same line → agentName stays empty', async () => {
    const s = await scanOne([
      JSON.stringify({ type: 'attachment', sessionId: ID, teamName: 'session-7399191c' }),
      JSON.stringify({ type: 'attachment', sessionId: ID, agentName: 'spec-ui' }),
      turn(ID, 'first prompt')
    ])
    expect(s.teamName).toBe('session-7399191c')
    expect(s.agentName).toBe('')
  })

  it('AC3: a real-shape teammate keeps the teamName/agentName of its teammate line', async () => {
    const s = await scanOne([
      ...rename(ID, 'other'),
      JSON.stringify({
        type: 'attachment',
        sessionId: ID,
        cwd: CWD,
        teamName: 'session-7399191c',
        agentName: 'spec-ui'
      }),
      turn(ID, 'Implement the spec-ui piece')
    ])
    expect(s.teamName).toBe('session-7399191c')
    expect(s.agentName).toBe('spec-ui')
  })
})
