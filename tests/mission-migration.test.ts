/**
 * T358 S7 — legacy goal-file migration (design
 * `docs/specs/2026-09-26-mission-progress/design.md` §9, §12 layer 2): the pure
 * importer `importLegacyGoalFile` against the three corpus shapes, and the
 * `mission_import_legacy` verb against a real temp filesystem.
 *
 * This suite IS the migration-eval layer (plan S7 "Eval gate — migration"). The
 * real corpus (55 goal files across 7 repos) holds client identifiers, so it is
 * never copied here: `tests/fixtures/mission-migration/*.md` are hand-written in
 * the SHAPES the T360 smoke test measured — `standard.md` (the mission skill's
 * section set), `partial.md` (`Objective`/`Topology`/`Units`/`Ticks` plus the
 * Portuguese `Executores`), `unrecognized.md` (no recognized heading at all,
 * with trailing whitespace, a tab and no final newline, which is why the fixture
 * directory is excluded from prettier and editorconfig).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { importLegacyGoalFile } from '../src/main/mission-migration'
import {
  missionsDir,
  parseMissionFile,
  readMissionLog,
  type Mission
} from '../src/main/mission-core'

const h = vi.hoisted(() => ({ userDataDir: '' }))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (): string => h.userDataDir,
    getAppPath: (): string => h.userDataDir
  },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  ipcMain: { handle: (): void => {}, on: (): void => {} }
}))

const FIXTURES = path.join(__dirname, 'fixtures', 'mission-migration')
const NOW = '2026-09-28T12:00:00.000Z'

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8')
}

describe('importLegacyGoalFile — standard-shaped goal files (design §9 step 1)', () => {
  it('importLegacyGoalFile extracts North star into declaredEnd, Executors rows into StepLinks, Pending gates into Blockers, for a standard-shaped fixture', () => {
    const raw = fixture('standard.md')
    const out = importLegacyGoalFile(raw, { now: NOW, fileName: '3f2a9c10-proj-231-export.md' })

    expect(out.title).toBe('PROJ-231 CSV export')
    expect(out.session).toBe('3f2a9c10-5b7d-4e21-9a8c-0d1e2f3a4b5c')
    expect(out.declaredEnd).toStrictEqual({
      kind: 'code',
      target:
        "Ship the CSV export for Acme's reporting screen: one PR merged into main with the exporter, its tests and the settings toggle.",
      evidence:
        'PR merged into main with green CI; delivery-verifier report with every AC met; spec approved by the operator'
    })
    expect(out.needsReview).toStrictEqual([])

    // One custom step per Executors row, between the fixed frame's ids.
    expect(out.steps.map((s) => [s.id, s.ordinal, s.kind, s.title])).toStrictEqual([
      ['stp-3', 2, 'custom', 'exporter + tests (PR #412)'],
      ['stp-4', 3, 'custom', 'settings toggle']
    ])
    expect(out.steps[0].links).toStrictEqual([
      { kind: 'session', ref: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f' },
      { kind: 'card', ref: 'T231' },
      { kind: 'pr', ref: '#412' }
    ])
    expect(out.steps[1].links).toStrictEqual([
      { kind: 'session', ref: '0e9d8c7b-6a5f-4e3d-9c2b-1a0f9e8d7c6b' },
      { kind: 'card', ref: 'T232' }
    ])
    for (const s of out.steps) {
      // Proof is never inferred from prose: a legacy "state" column is not evidence.
      expect(s).toMatchObject({ verification: 'verifier', proof: 'unproven', blockers: [] })
      expect(s.addedReason).toMatch(/legacy goal file/)
    }

    expect(out.blockers.map((b) => b.reason)).toStrictEqual([
      'approval apr-7f3e: operator to allow the schema migration',
      'blocked on the org/proj/www staging deploy'
    ])
    for (const b of out.blockers) {
      expect(b).toMatchObject({ owner: 'agent', raisedAt: NOW })
      expect(b.unblocks.length).toBeGreaterThan(0)
    }

    // The Log section is carried over verbatim, never re-summarized.
    expect(out.log).toBe(
      '\n<!-- newest first, ONE line per tick: date time — state → action taken -->\n' +
        '- 2026-08-15 10:40 — T231 working, T232 idle → nudged T232\n' +
        '- 2026-08-14 17:05 — mission set, two executors dispatched\n'
    )
    expect(out.extractedFields).toStrictEqual([
      'title',
      'session',
      'declaredEnd.target',
      'declaredEnd.evidence',
      'declaredEnd.kind',
      'steps',
      'blockers',
      'log'
    ])
    expect(out.legacyRaw).toBe(raw)
  })

  it('partial shape: Objective → target, Units + Executores rows → steps merged by card id, declaredEnd flagged needs-review', () => {
    const raw = fixture('partial.md')
    const out = importLegacyGoalFile(raw, { now: NOW, fileName: 'wave-2.md' })

    expect(out.title).toBe('Wave 2 — ProjectAlpha importer')
    expect(out.session).toBeUndefined()
    expect(out.declaredEnd.kind).toBe('code')
    expect(out.declaredEnd.target).toBe(
      'Land the ProjectAlpha importer rewrite as two stacked PRs on org/proj/www, each with green CI, before the Acme demo.'
    )
    // No Done criteria: the evidence is a placeholder, so the end needs review.
    expect(out.declaredEnd.evidence).toMatch(/not stated in the legacy goal file/i)
    expect(out.needsReview).toStrictEqual(['declaredEnd'])

    expect(out.steps.map((s) => s.title)).toStrictEqual([
      'T401-importer-parser',
      'T402-importer-writer'
    ])
    expect(out.steps[0].links).toStrictEqual([
      { kind: 'card', ref: 'T401-importer-parser' },
      { kind: 'pr', ref: 'owner/repo#88' }
    ])
    // The Executores bullet names T402 again: its session joins the Units row's step.
    expect(out.steps[1].links).toStrictEqual([
      { kind: 'card', ref: 'T402-importer-writer' },
      { kind: 'pr', ref: 'owner/repo#91' },
      { kind: 'session', ref: '5d4c3b2a-1f0e-4d9c-8b7a-6e5f4d3c2b1a' }
    ])
    // Topology and Ticks have no Mission field: they live on in legacyRaw only.
    expect(out.blockers).toStrictEqual([])
    expect(out.log).toBe('')
    expect(out.extractedFields).toStrictEqual([
      'title',
      'declaredEnd.target',
      'declaredEnd.kind',
      'steps'
    ])
    expect(out.legacyRaw).toBe(raw)
  })
})

describe('importLegacyGoalFile — lossless fallback for unrecognized shapes (Review Focus #3)', () => {
  it('importLegacyGoalFile on a file with zero recognized headings still returns a Mission with declaredEnd flagged needs-review and legacyRaw equal to the original byte-for-byte', () => {
    const bytes = readFileSync(path.join(FIXTURES, 'unrecognized.md'))
    const raw = bytes.toString('utf8')
    const out = importLegacyGoalFile(raw, { now: NOW, fileName: 'c0ffee12-field-notes.md' })

    expect(out.needsReview).toStrictEqual(['declaredEnd'])
    // Still a COMPLETE declared end (decision 5) — placeholders, never empty strings.
    expect(out.declaredEnd.kind).toBe('other')
    expect(out.declaredEnd.target).toMatch(/not stated in the legacy goal file "field notes"/i)
    expect(out.declaredEnd.evidence).toMatch(/not stated in the legacy goal file/i)
    expect(out.title).toBe('field notes')
    expect(out.steps).toStrictEqual([])
    expect(out.blockers).toStrictEqual([])
    expect(out.openQuestions).toStrictEqual([])
    expect(out.log).toBe('')
    expect(out.extractedFields).toStrictEqual([])
    // Byte-for-byte: trailing spaces, the tab and the missing final newline included.
    expect(out.legacyRaw).toBe(raw)
    expect(Buffer.from(out.legacyRaw, 'utf8').equals(bytes)).toBe(true)
  })

  it('all three fixture shapes import, and each keeps its source verbatim (AC-S7-1, AC-S7-2)', () => {
    for (const name of ['standard.md', 'partial.md', 'unrecognized.md']) {
      const raw = fixture(name)
      const out = importLegacyGoalFile(raw, { now: NOW, fileName: name })
      expect(out.legacyRaw, name).toBe(raw)
      expect(out.declaredEnd.target.length, name).toBeGreaterThan(0)
      expect(out.declaredEnd.evidence.length, name).toBeGreaterThan(0)
    }
  })

  it('importLegacyGoalFile never throws — malformed, empty and hostile inputs', () => {
    const inputs: unknown[] = [
      '',
      '\n',
      '---',
      '---\n',
      '---\nsession: not-a-uuid\n',
      '---\nsession: 3f2a9c10-5b7d-4e21-9a8c-0d1e2f3a4b5c\n---\n',
      '# \n## \n##\n',
      '## North star\n',
      '## Executors\n|\n||\n| a |\n|---|\n| <id> | <card> |\n',
      '## Units\n| card |\n| --- |\n| T9 |\n| T9-dup |\n',
      '```\n## Log\nnot a section\n```\n## Log\nreal\n',
      '## Pending gates\n- none\n- \n-\n',
      '﻿# Goal — bom\r\n## North star\r\nship a PR\r\n',
      '\u0000\u0001\u0002',
      '# '.repeat(5000),
      'x'.repeat(200_000),
      '| '.repeat(2000),
      '## Log\n'.repeat(1000),
      42,
      null,
      undefined
    ]
    for (const input of inputs) {
      const out = importLegacyGoalFile(input as string, { now: NOW })
      expect(out.declaredEnd.target.length).toBeGreaterThan(0)
      expect(out.declaredEnd.evidence.length).toBeGreaterThan(0)
      expect(out.legacyRaw).toBe(typeof input === 'string' ? input : '')
      for (const s of out.steps) expect(s.id).toMatch(/^stp-\d+$/)
    }
  })

  it('does not read a heading inside a fenced code block as structure', () => {
    const out = importLegacyGoalFile('```md\n## North star\nfenced\n```\n', { now: NOW })
    expect(out.needsReview).toStrictEqual(['declaredEnd'])
    expect(out.extractedFields).not.toContain('declaredEnd.target')
  })

  it('ignores a frontmatter session that is not a full session UUID (it could never match an owner)', () => {
    const out = importLegacyGoalFile('---\nsession: 3f2a9c10\n---\n# Goal — x\n', { now: NOW })
    expect(out.session).toBeUndefined()
  })
})

// ---- the verb: mission_import_legacy (design §4, §9) -------------------------

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }
type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

const OWNER = '11111111-2222-4333-8444-555555555555'
const LEGACY_SESSION = '3f2a9c10-5b7d-4e21-9a8c-0d1e2f3a4b5c'

function payloadOf(res: ToolResult): Record<string, unknown> {
  expect(res.isError, res.content[0]?.text).not.toBe(true)
  return JSON.parse(res.content[0].text!) as Record<string, unknown>
}

function errText(res: ToolResult): string {
  expect(res.isError).toBe(true)
  return res.content[0].text!
}

function ctxFor(folder: string, denyFolders: string[] = []): Record<string, unknown> {
  return { folder, folders: [], denyFolders, bridge: undefined }
}

/** A main checkout (`.git` dir) plus one linked worktree (`.git` file → commondir). */
async function fakeRepo({ nested = true } = {}): Promise<{ main: string; worktree: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-migration-repo-'))
  const main = path.join(base, 'main')
  const wtGitDir = path.join(main, '.git', 'worktrees', 'wt')
  await fs.mkdir(wtGitDir, { recursive: true })
  await fs.writeFile(path.join(wtGitDir, 'commondir'), '../..\n', 'utf8')
  const worktree = nested
    ? path.join(main, '.claude', 'worktrees', 'wt')
    : path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-migration-wt-')), 'wt')
  await fs.mkdir(worktree, { recursive: true })
  await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${wtGitDir}\n`, 'utf8')
  return { main, worktree }
}

/** Put a fixture's exact bytes at `<folder>/.harnu/goals/<name>`; returns its absolute path. */
async function plantGoal(folder: string, name: string, fixtureName: string): Promise<string> {
  const dir = path.join(folder, '.harnu', 'goals')
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fs.copyFile(path.join(FIXTURES, fixtureName), file)
  return file
}

/** Bytes + mtime + mode: "never modified" means none of the three moved. */
async function fingerprint(file: string): Promise<{ sha: string; mtimeMs: number; mode: number }> {
  const [bytes, stat] = await Promise.all([fs.readFile(file), fs.stat(file)])
  return {
    sha: createHash('sha256').update(bytes).digest('hex'),
    mtimeMs: stat.mtimeMs,
    mode: stat.mode
  }
}

async function readImported(
  root: string,
  missionId: string
): Promise<{ mission: Mission; log: string; raw: string }> {
  const dir = missionsDir(root)
  const name = (await fs.readdir(dir)).find((n) => n.startsWith(`${missionId}-`))!
  const raw = await fs.readFile(path.join(dir, name), 'utf8')
  return { mission: parseMissionFile(raw) as Mission, log: readMissionLog(raw), raw }
}

describe('mission_import_legacy — the verb (design §4, §9)', () => {
  let handlers: Record<string, Handler>
  let repo: { main: string; worktree: string }

  beforeEach(async () => {
    h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-migration-ud-'))
    vi.resetModules()
    const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
    handlers = Object.fromEntries(WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
    repo = await fakeRepo()
  })

  it('mission_import_legacy never deletes or modifies the source file', async () => {
    for (const [name, fixtureName] of [
      ['3f2a9c10-proj-231-export.md', 'standard.md'],
      ['wave-2.md', 'partial.md'],
      ['c0ffee12-field-notes.md', 'unrecognized.md']
    ]) {
      const source = await plantGoal(repo.main, name, fixtureName)
      const before = await fingerprint(source)
      const res = await handlers.mission_import_legacy(
        { folder: repo.main, legacyPath: `.harnu/goals/${name}`, sessionId: OWNER },
        ctxFor(repo.main)
      )
      payloadOf(res)
      expect(await fingerprint(source), name).toStrictEqual(before)
    }
    expect((await fs.readdir(path.join(repo.main, '.harnu', 'goals'))).sort()).toStrictEqual([
      '3f2a9c10-proj-231-export.md',
      'c0ffee12-field-notes.md',
      'wave-2.md'
    ])
  })

  it('writes an active Mission in the v3 shape: the imported steps then the fixed end, legacyRaw byte-for-byte, Log carried over', async () => {
    const source = await plantGoal(repo.main, '3f2a9c10-proj-231-export.md', 'standard.md')
    const bytes = await fs.readFile(source)
    const ack = payloadOf(
      await handlers.mission_import_legacy(
        { folder: repo.main, legacyPath: source, sessionId: OWNER },
        ctxFor(repo.main)
      )
    )
    expect(ack).toMatchObject({
      ok: true,
      op: 'mission_import_legacy',
      slug: 'proj-231-csv-export',
      legacyPreserved: true,
      needsReview: []
    })
    expect(ack.extractedFields).toContain('declaredEnd.target')

    const { mission, log } = await readImported(repo.main, ack.missionId as string)
    expect(mission.status).toBe('active')
    expect(mission.owner).toStrictEqual({ sessionId: OWNER, folder: repo.main })
    expect(mission.folder).toBe(repo.main)
    // Mission v3 §3.3/§3.4: no fixed start, steps numbered from stp-1, never draft.
    expect(mission.steps.map((s) => [s.id, s.ordinal, s.kind])).toStrictEqual([
      ['stp-1', 1, 'custom'],
      ['stp-2', 2, 'custom'],
      ['stp-3', 3, 'fixed-end']
    ])
    expect(mission.scope).toBeUndefined()
    expect(mission.blockers).toHaveLength(2)
    expect(mission.legacy).toStrictEqual({
      source,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      needsReview: []
    })
    expect(mission.legacyRaw).toBe(bytes.toString('utf8'))
    expect(Buffer.from(mission.legacyRaw!, 'utf8').equals(bytes)).toBe(true)
    expect(log.startsWith('# PROJ-231 CSV export\n\n## Log\n')).toBe(true)
    expect(log).toContain('- 2026-08-15 10:40 — T231 working, T232 idle → nudged T232\n')
  })

  it('the unrecognized shape imports too, with declaredEnd flagged needs-review (AC-S7-1)', async () => {
    const source = await plantGoal(repo.main, 'c0ffee12-field-notes.md', 'unrecognized.md')
    const ack = payloadOf(
      await handlers.mission_import_legacy(
        { folder: repo.main, legacyPath: '.harnu/goals/c0ffee12-field-notes.md', sessionId: OWNER },
        ctxFor(repo.main)
      )
    )
    expect(ack).toMatchObject({
      slug: 'field-notes',
      needsReview: ['declaredEnd'],
      extractedFields: []
    })
    const { mission } = await readImported(repo.main, ack.missionId as string)
    expect(mission.legacy?.needsReview).toStrictEqual(['declaredEnd'])
    expect(mission.legacyRaw).toBe(await fs.readFile(source, 'utf8'))
    expect(mission.status).toBe('active')
    expect(mission.steps.map((s) => s.kind)).toStrictEqual(['fixed-end'])
  })

  it('a worktree call reads its own goals dir but writes into the main checkout (design §9)', async () => {
    await plantGoal(repo.worktree, 'wave-2.md', 'partial.md')
    const ack = payloadOf(
      await handlers.mission_import_legacy(
        { folder: repo.worktree, legacyPath: '.harnu/goals/wave-2.md', sessionId: OWNER },
        ctxFor(repo.worktree)
      )
    )
    const { mission } = await readImported(repo.main, ack.missionId as string)
    expect(mission.legacy?.source).toBe(path.join(repo.worktree, '.harnu', 'goals', 'wave-2.md'))
    expect(mission.owner.folder).toBe(repo.worktree)
  })

  it("defaults the owner to the legacy file's own session when sessionId is omitted", async () => {
    await plantGoal(repo.main, '3f2a9c10-proj-231-export.md', 'standard.md')
    const ack = payloadOf(
      await handlers.mission_import_legacy(
        { folder: repo.main, legacyPath: '.harnu/goals/3f2a9c10-proj-231-export.md' },
        ctxFor(repo.main)
      )
    )
    const { mission } = await readImported(repo.main, ack.missionId as string)
    expect(mission.owner.sessionId).toBe(LEGACY_SESSION)
  })

  it('refuses with BAD_SESSION_ID when neither sessionId nor the file names a session UUID', async () => {
    await plantGoal(repo.main, 'wave-2.md', 'partial.md')
    const res = await handlers.mission_import_legacy(
      { folder: repo.main, legacyPath: '.harnu/goals/wave-2.md' },
      ctxFor(repo.main)
    )
    expect(errText(res)).toMatch(/^BAD_SESSION_ID/)
  })

  it('resolves a bare card id to its board slug when exactly one card matches', async () => {
    const board = path.join(repo.main, '.harnu', 'memory', 'roadmap')
    await fs.mkdir(board, { recursive: true })
    await fs.writeFile(
      path.join(board, 'T231-csv-exporter.md'),
      '---\nid: T231\ntitle: CSV exporter\nstatus: backlog\n---\n',
      'utf8'
    )
    await plantGoal(repo.main, '3f2a9c10-proj-231-export.md', 'standard.md')
    const ack = payloadOf(
      await handlers.mission_import_legacy(
        {
          folder: repo.main,
          legacyPath: '.harnu/goals/3f2a9c10-proj-231-export.md',
          sessionId: OWNER
        },
        ctxFor(repo.main)
      )
    )
    const { mission } = await readImported(repo.main, ack.missionId as string)
    const cards = mission.steps.flatMap((s) =>
      s.links.filter((l) => l.kind === 'card').map((l) => l.ref)
    )
    // T231 has a card on this board; T232 does not, so it keeps the id the file gave.
    expect(cards).toStrictEqual(['T231-csv-exporter', 'T232'])
  })

  it('refuses to import the same legacy file twice (ALREADY_IMPORTED), naming the mission', async () => {
    await plantGoal(repo.main, 'wave-2.md', 'partial.md')
    const args = { folder: repo.main, legacyPath: '.harnu/goals/wave-2.md', sessionId: OWNER }
    const first = payloadOf(await handlers.mission_import_legacy(args, ctxFor(repo.main)))
    const second = errText(await handlers.mission_import_legacy(args, ctxFor(repo.main)))
    expect(second).toMatch(/^ALREADY_IMPORTED/)
    expect(second).toContain(first.missionId as string)
    expect(await fs.readdir(missionsDir(repo.main))).toHaveLength(1)
  })

  it('refuses a path that is not a .harnu/goals/*.md file of this folder (BAD_LEGACY_PATH)', async () => {
    await plantGoal(repo.main, 'wave-2.md', 'partial.md')
    await fs.writeFile(path.join(repo.main, 'README.md'), '# readme\n', 'utf8')
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-migration-outside-'))
    await fs.writeFile(path.join(outside, 'secret.md'), '# secret\n', 'utf8')
    await fs.symlink(
      path.join(outside, 'secret.md'),
      path.join(repo.main, '.harnu', 'goals', 'link.md')
    )
    await fs.writeFile(path.join(repo.main, '.harnu', 'goals', 'notes.txt'), 'x', 'utf8')
    for (const legacyPath of [
      'README.md',
      '.harnu/goals/../../README.md',
      path.join(outside, 'secret.md'),
      '.harnu/goals/link.md',
      '.harnu/goals/notes.txt',
      '.harnu/missions/x.md'
    ]) {
      const res = await handlers.mission_import_legacy(
        { folder: repo.main, legacyPath, sessionId: OWNER },
        ctxFor(repo.main)
      )
      expect(errText(res), legacyPath).toMatch(/^BAD_LEGACY_PATH/)
    }
    await expect(fs.readdir(missionsDir(repo.main))).rejects.toThrow()
  })

  describe('reads exactly what it validated (TOCTOU, PR #385 review)', () => {
    type Seam = { _setLegacyImportBeforeOpen: (fn: (() => Promise<void>) | null) => void }
    let seam: Seam
    let outside: string
    beforeEach(async () => {
      seam = (await import('../src/main/mcp/tool-handlers')) as unknown as Seam
      outside = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-migration-toctou-'))
      await fs.writeFile(path.join(outside, 'secret.md'), '# SECRET from outside goals\n', 'utf8')
    })
    const importIt = (legacyPath: string): Promise<ToolResult> =>
      handlers.mission_import_legacy(
        { folder: repo.main, legacyPath, sessionId: OWNER },
        ctxFor(repo.main)
      )

    it('a symlink re-pointed outside goals/ after validation: the validated target is read', async () => {
      const goals = path.join(repo.main, '.harnu', 'goals')
      await plantGoal(repo.main, 'real.md', 'partial.md')
      await fs.symlink(path.join(goals, 'real.md'), path.join(goals, 'link.md'))
      seam._setLegacyImportBeforeOpen(async () => {
        await fs.unlink(path.join(goals, 'link.md'))
        await fs.symlink(path.join(outside, 'secret.md'), path.join(goals, 'link.md'))
      })
      try {
        const ack = payloadOf(await importIt('.harnu/goals/link.md'))
        const { mission } = await readImported(repo.main, ack.missionId as string)
        expect(mission.legacyRaw).toBe(fixture('partial.md'))
        expect(mission.legacyRaw).not.toContain('SECRET')
      } finally {
        seam._setLegacyImportBeforeOpen(null)
      }
    })

    it('the validated file itself swapped for a symlink before the read is refused', async () => {
      const goals = path.join(repo.main, '.harnu', 'goals')
      await plantGoal(repo.main, 'real.md', 'partial.md')
      seam._setLegacyImportBeforeOpen(async () => {
        await fs.unlink(path.join(goals, 'real.md'))
        await fs.symlink(path.join(outside, 'secret.md'), path.join(goals, 'real.md'))
      })
      try {
        expect(errText(await importIt('.harnu/goals/real.md'))).toMatch(/^BAD_LEGACY_PATH/)
      } finally {
        seam._setLegacyImportBeforeOpen(null)
      }
      await expect(fs.readdir(missionsDir(repo.main))).rejects.toThrow()
    })

    it('the goals/ directory swapped for a symlink outside before the read is refused', async () => {
      const goals = path.join(repo.main, '.harnu', 'goals')
      await plantGoal(repo.main, 'real.md', 'partial.md')
      await fs.copyFile(path.join(outside, 'secret.md'), path.join(outside, 'real.md'))
      seam._setLegacyImportBeforeOpen(async () => {
        await fs.rename(goals, `${goals}-old`)
        await fs.symlink(outside, goals)
      })
      try {
        expect(errText(await importIt('.harnu/goals/real.md'))).toMatch(/^BAD_LEGACY_PATH/)
      } finally {
        seam._setLegacyImportBeforeOpen(null)
      }
      await expect(fs.readdir(missionsDir(repo.main))).rejects.toThrow()
    })
  })

  it('refuses a .harnu/goals or .harnu that is ALREADY a symlink to outside the repo, reading nothing', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-migration-linkdir-'))
    await fs.mkdir(path.join(outside, 'goals'), { recursive: true })
    await fs.writeFile(path.join(outside, 'x.md'), '# SECRET outside\n', 'utf8')
    await fs.writeFile(path.join(outside, 'goals', 'x.md'), '# SECRET outside\n', 'utf8')

    // Case 1: <repo>/.harnu is real, <repo>/.harnu/goals → outside/
    await fs.mkdir(path.join(repo.main, '.harnu'), { recursive: true })
    await fs.symlink(outside, path.join(repo.main, '.harnu', 'goals'))
    const viaGoals = await handlers.mission_import_legacy(
      { folder: repo.main, legacyPath: '.harnu/goals/x.md', sessionId: OWNER },
      ctxFor(repo.main)
    )
    expect(errText(viaGoals)).toMatch(/^BAD_LEGACY_PATH/)
    await expect(fs.readdir(missionsDir(repo.main))).rejects.toThrow()

    // Case 2: <worktree>/.harnu → outside/ (so .harnu/goals is outside/goals)
    await fs.symlink(outside, path.join(repo.worktree, '.harnu'))
    const viaCapy = await handlers.mission_import_legacy(
      { folder: repo.worktree, legacyPath: '.harnu/goals/x.md', sessionId: OWNER },
      ctxFor(repo.worktree)
    )
    expect(errText(viaCapy)).toMatch(/^BAD_LEGACY_PATH/)
    await expect(fs.readdir(missionsDir(repo.main))).rejects.toThrow()
  })

  describe('contains the file in the SAME base that lexically holds it (delta 3, AC-S7-3)', () => {
    let outside: string
    beforeEach(async () => {
      outside = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-migration-crossbase-'))
      await fs.writeFile(path.join(outside, 'secret.md'), '# SECRET outside\n', 'utf8')
    })

    it("a symlinked file in the worktree's goals/ pointing into main's symlinked goals/ is refused", async () => {
      await fs.mkdir(path.join(repo.main, '.harnu'), { recursive: true })
      await fs.symlink(outside, path.join(repo.main, '.harnu', 'goals'))
      await fs.mkdir(path.join(repo.worktree, '.harnu', 'goals'), { recursive: true })
      await fs.symlink(
        path.join(outside, 'secret.md'),
        path.join(repo.worktree, '.harnu', 'goals', 'link.md')
      )
      const res = await handlers.mission_import_legacy(
        { folder: repo.worktree, legacyPath: '.harnu/goals/link.md', sessionId: OWNER },
        ctxFor(repo.worktree)
      )
      expect(errText(res)).toMatch(/^BAD_LEGACY_PATH/)
      await expect(fs.readdir(missionsDir(repo.main))).rejects.toThrow()
    })

    it("the mirror: a symlinked file in main's goals/ pointing into the worktree's symlinked goals/ is refused", async () => {
      await fs.mkdir(path.join(repo.worktree, '.harnu'), { recursive: true })
      await fs.symlink(outside, path.join(repo.worktree, '.harnu', 'goals'))
      await fs.mkdir(path.join(repo.main, '.harnu', 'goals'), { recursive: true })
      const link = path.join(repo.main, '.harnu', 'goals', 'link.md')
      await fs.symlink(path.join(outside, 'secret.md'), link)
      const res = await handlers.mission_import_legacy(
        { folder: repo.worktree, legacyPath: link, sessionId: OWNER },
        ctxFor(repo.worktree)
      )
      expect(errText(res)).toMatch(/^BAD_LEGACY_PATH/)
      await expect(fs.readdir(missionsDir(repo.main))).rejects.toThrow()
    })

    it("a symlinked file in the worktree's goals/ pointing into main's REAL goals/ is refused too", async () => {
      await plantGoal(repo.main, 'wave-2.md', 'partial.md')
      await fs.mkdir(path.join(repo.worktree, '.harnu', 'goals'), { recursive: true })
      await fs.symlink(
        path.join(repo.main, '.harnu', 'goals', 'wave-2.md'),
        path.join(repo.worktree, '.harnu', 'goals', 'link.md')
      )
      const res = await handlers.mission_import_legacy(
        { folder: repo.worktree, legacyPath: '.harnu/goals/link.md', sessionId: OWNER },
        ctxFor(repo.worktree)
      )
      expect(errText(res)).toMatch(/^BAD_LEGACY_PATH/)
      await expect(fs.readdir(missionsDir(repo.main))).rejects.toThrow()
    })
  })

  it('refuses a missing file (LEGACY_NOT_FOUND) and a non-UTF-8 one (LEGACY_NOT_UTF8), writing nothing', async () => {
    const missing = await handlers.mission_import_legacy(
      { folder: repo.main, legacyPath: '.harnu/goals/gone.md', sessionId: OWNER },
      ctxFor(repo.main)
    )
    expect(errText(missing)).toMatch(/^LEGACY_NOT_FOUND/)
    const dir = path.join(repo.main, '.harnu', 'goals')
    await fs.mkdir(dir, { recursive: true })
    const latin1 = path.join(dir, 'latin1.md')
    await fs.writeFile(latin1, Buffer.from([0x23, 0x20, 0x61, 0xe7, 0xe3, 0x6f, 0x0a])) // "# a\xe7\xe3o"
    const before = await fingerprint(latin1)
    const res = await handlers.mission_import_legacy(
      { folder: repo.main, legacyPath: '.harnu/goals/latin1.md', sessionId: OWNER },
      ctxFor(repo.main)
    )
    expect(errText(res)).toMatch(/^LEGACY_NOT_UTF8/)
    expect(await fingerprint(latin1)).toStrictEqual(before)
    await expect(fs.readdir(missionsDir(repo.main))).rejects.toThrow()
  })

  it('refuses a file over the 1 MiB cap (LEGACY_TOO_LARGE), writing nothing', async () => {
    const dir = path.join(repo.main, '.harnu', 'goals')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'huge.md'), `# huge\n${'x'.repeat(1024 * 1024)}`, 'utf8')
    const res = await handlers.mission_import_legacy(
      { folder: repo.main, legacyPath: '.harnu/goals/huge.md', sessionId: OWNER },
      ctxFor(repo.main)
    )
    expect(errText(res)).toMatch(/^LEGACY_TOO_LARGE/)
    await expect(fs.readdir(missionsDir(repo.main))).rejects.toThrow()
  })

  it('refuses a blocked folder, and a non-nested worktree of a blocked main checkout, writing nothing', async () => {
    const detached = await fakeRepo({ nested: false })
    await plantGoal(detached.worktree, 'wave-2.md', 'partial.md')
    const args = {
      folder: detached.worktree,
      legacyPath: '.harnu/goals/wave-2.md',
      sessionId: OWNER
    }
    const viaRoot = await handlers.mission_import_legacy(
      args,
      ctxFor(detached.worktree, [detached.main])
    )
    expect(errText(viaRoot)).toMatch(/^FOLDER_NOT_ALLOWED/)
    const viaFolder = await handlers.mission_import_legacy(
      args,
      ctxFor(detached.worktree, [detached.worktree])
    )
    expect(errText(viaFolder)).toMatch(/^FOLDER_NOT_ALLOWED/)
    await expect(fs.readdir(missionsDir(detached.main))).rejects.toThrow()
  })

  it('mission_get omits legacyRaw from its projection and says where it lives; later edits keep it intact', async () => {
    const source = await plantGoal(repo.main, 'c0ffee12-field-notes.md', 'unrecognized.md')
    const { missionId } = payloadOf(
      await handlers.mission_import_legacy(
        { folder: repo.main, legacyPath: source, sessionId: OWNER },
        ctxFor(repo.main)
      )
    ) as { missionId: string }
    payloadOf(
      await handlers.mission_log(
        { folder: repo.main, missionId, note: 'reviewed the import' },
        ctxFor(repo.main)
      )
    )
    const got = payloadOf(
      await handlers.mission_get({ folder: repo.main, missionId }, ctxFor(repo.main))
    )
    const projected = got.mission as Record<string, unknown>
    expect(projected).not.toHaveProperty('legacyRaw')
    expect(projected.legacy).toMatchObject({ source, needsReview: ['declaredEnd'] })
    const bytes = await fs.readFile(source)
    const file = (await fs.readdir(missionsDir(repo.main)))[0]
    expect(got.legacyRaw).toStrictEqual({
      bytes: bytes.length,
      file: path.join(missionsDir(repo.main), file)
    })
    // The mission_log write round-tripped the record: legacyRaw is still byte-identical.
    expect((await readImported(repo.main, missionId)).mission.legacyRaw).toBe(
      bytes.toString('utf8')
    )
  })
})
