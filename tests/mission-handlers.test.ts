/**
 * T358 S3 — the core `mission_*` verb catalog (design
 * `docs/specs/2026-09-26-mission-progress/design.md` §4): `mission_create`,
 * `mission_get`, `mission_list`, `mission_add_step`, `mission_update_step`,
 * `mission_link_child`, `mission_log` — plus T358 S4's blockers, re-scope, close
 * and verify verbs (`mission_set_blocker`, `mission_clear_blocker`,
 * `mission_set_end`, `mission_request_close`, `mission_verify_step`) and the two
 * operator doors they stage for (`applyApprovedRescope`, `applyOperatorEnd`).
 *
 * Two layers are pinned here:
 *  - the CATALOG entries (name, `mutates`, gate fields, input schema) — the
 *    contract half of AC-S3-1;
 *  - the HANDLERS against a real temp filesystem (`tool-handlers.ts` is an
 *    env-bound shell, so it is driven directly with electron mocked, the same
 *    way tests/mcp-update-worker-handler.test.ts drives the worker verbs).
 *
 * Missions are repo-scoped (design §9, decision 17): every handler resolves the
 * MAIN checkout from the `folder` it is given, so a fake git layout (a main
 * checkout with a `.git` dir, a linked worktree with a `.git` file) is enough to
 * prove a worktree call lands in the main checkout's `.capy/missions/`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import { MCP_TOOLS, toolByName } from '../src/main/mcp/tool-catalog'
import { computeProgress } from '../src/main/mission-progress'
import {
  applyApprovedRescope,
  applyOperatorEnd,
  applyOperatorVerifyStep,
  buildMissionFileContent,
  closeWarnings,
  declaredEndHash,
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

type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> }

function payloadOf(res: ToolResult): Record<string, unknown> {
  expect(res.isError).not.toBe(true)
  const first = res.content[0]
  if (!first || first.type !== 'text' || !first.text) throw new Error('expected text content')
  return JSON.parse(first.text) as Record<string, unknown>
}

function errText(res: ToolResult): string {
  expect(res.isError).toBe(true)
  const first = res.content[0]
  if (!first || first.type !== 'text' || !first.text) throw new Error('expected text content')
  return first.text
}

const OWNER = '11111111-2222-4333-8444-555555555555'
const CHILD = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const END = { kind: 'code', target: 'PR merging the slice', evidence: 'green gates + verifier' }

/**
 * A main checkout (`.git` dir) plus one linked worktree (`.git` file → commondir).
 * `nested: false` puts the worktree in an UNRELATED temp dir, so the main checkout
 * is not a path ancestor of it — the layout a blocked-folder check on the raw
 * `folder` arg alone cannot see.
 */
async function fakeRepo({ nested = true } = {}): Promise<{ main: string; worktree: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-repo-'))
  const main = path.join(base, 'main')
  const gitDir = path.join(main, '.git')
  const wtGitDir = path.join(gitDir, 'worktrees', 'wt')
  await fs.mkdir(wtGitDir, { recursive: true })
  await fs.writeFile(path.join(wtGitDir, 'commondir'), '../..\n', 'utf8')
  const worktree = nested
    ? path.join(main, '.claude', 'worktrees', 'wt')
    : path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-wt-')), 'wt')
  await fs.mkdir(worktree, { recursive: true })
  await fs.writeFile(path.join(worktree, '.git'), `gitdir: ${wtGitDir}\n`, 'utf8')
  return { main, worktree }
}

type Handler = (args: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<ToolResult>

async function loadHandlers(): Promise<Record<string, Handler>> {
  vi.resetModules()
  const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
  const out: Record<string, Handler> = {}
  for (const t of WIRED_TOOLS) out[t.op] = t.handler as unknown as Handler
  return out
}

function ctxFor(folder: string, denyFolders: string[] = []): Record<string, unknown> {
  return { folder, folders: [], denyFolders, bridge: undefined }
}

async function missionFiles(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(missionsDir(root))).filter((n) => n.endsWith('.md'))
  } catch {
    return []
  }
}

async function readMissionOnDisk(
  root: string,
  id: string
): Promise<{ mission: Mission; raw: string }> {
  const name = (await missionFiles(root)).find((n) => n.startsWith(`${id}-`))
  if (!name) throw new Error(`no file for ${id}`)
  const raw = await fs.readFile(path.join(missionsDir(root), name), 'utf8')
  const parsed = parseMissionFile(raw)
  if ('error' in parsed) throw new Error(parsed.error)
  return { mission: parsed, raw }
}

let handlers: Record<string, Handler>
let repo: { main: string; worktree: string }

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-ud-'))
  repo = await fakeRepo()
  handlers = await loadHandlers()
})

/**
 * Mission v3: a mission is born with its plan and no fixed start. The default
 * plan here is one existence step, so `stp-1` is a planned step and `stp-2` the
 * fixed end — the layout the verb tests below address.
 */
const DEFAULT_PLAN = [{ title: 'Spec on disk', verification: 'existence' }]

async function createMission(
  extra: Record<string, unknown> = {},
  folder = repo.main
): Promise<{ missionId: string; slug: string }> {
  const res = await handlers.mission_create(
    {
      folder,
      title: 'Ship the verb catalog',
      declaredEnd: END,
      sessionId: OWNER,
      steps: DEFAULT_PLAN,
      ...extra
    },
    ctxFor(folder)
  )
  const p = payloadOf(res)
  return { missionId: p.missionId as string, slug: p.slug as string }
}

// ---- AC-S3-1 — catalog contract (design.md §4 table) ------------------------

describe('mission_* catalog entries (design §4)', () => {
  const expected: Record<string, { mutates: boolean }> = {
    mission_create: { mutates: true },
    mission_get: { mutates: false },
    mission_list: { mutates: false },
    mission_add_step: { mutates: true },
    mission_update_step: { mutates: true },
    mission_link_child: { mutates: true },
    mission_log: { mutates: true },
    // S4
    mission_set_blocker: { mutates: true },
    mission_clear_blocker: { mutates: true },
    mission_set_end: { mutates: true },
    mission_verify_step: { mutates: true },
    mission_request_close: { mutates: true },
    // S7
    mission_import_legacy: { mutates: true },
    // Mission v3 §3.6
    mission_add_check: { mutates: true }
  }

  it('declares exactly the S3 + S4 verbs, each op matching its name', () => {
    const names = MCP_TOOLS.map((t) => t.name).filter((n) => n.startsWith('mission_'))
    expect(names.sort()).toEqual(Object.keys(expected).sort())
    for (const name of names) expect(toolByName(name)?.op).toBe(name)
  })

  it('mutating verbs run free (silentAllowInAgentFolder) like create_card; reads carry no gate field', () => {
    for (const [name, { mutates }] of Object.entries(expected)) {
      const def = toolByName(name)!
      expect(def.mutates, name).toBe(mutates)
      if (mutates) expect(def.silentAllowInAgentFolder, name).toBe(true)
      else expect(def.silentAllowInAgentFolder, name).toBeUndefined()
      // Same class as create_card: no grant, no durable allow, no bootstrap, no force-confirm.
      expect(def.grantable, name).toBeUndefined()
      expect(def.alwaysAllowable, name).toBeUndefined()
      expect(def.bootstrapConfirmOnDeny, name).toBeUndefined()
      expect(def.forceConfirmFor, name).toBeUndefined()
      expect(def.alwaysLoad, name).toBeUndefined()
    }
  })

  it('every verb that takes a caller session id says it is self-declared and unauthenticated', () => {
    for (const name of [
      'mission_create',
      'mission_get',
      'mission_link_child',
      'mission_verify_step',
      'mission_import_legacy'
    ]) {
      expect(toolByName(name)!.description, name).toMatch(/self-declared/i)
      expect(toolByName(name)!.description, name).toMatch(/not authenticated|unauthenticated/i)
    }
  })

  it('mission_update_step schema keeps set open so the handler can name a controlled field', () => {
    const schema = toolByName('mission_update_step')!.inputSchema
    const ok = schema.safeParse({
      folder: repo.main,
      missionId: 'mnt-0000abcd',
      stepId: 'stp-1',
      set: { verifiedBy: { sessionId: 'x' } }
    })
    expect(ok.success).toBe(true)
  })
})

// ---- Task 1 — mission_create -------------------------------------------------

describe('mission_create', () => {
  it('catalog: mutating, runs free like create_card, disambiguated from plan_mission', () => {
    const def = toolByName('mission_create')!
    expect(def.op).toBe('mission_create')
    expect(def.mutates).toBe(true)
    expect(def.silentAllowInAgentFolder).toBe(true)
    expect(def.grantable).toBeUndefined()
    expect(def.alwaysAllowable).toBeUndefined()
    expect(def.description).toMatch(/plan_mission/)
    expect(def.description).toMatch(/self-declared/i)
  })

  it('catalog: the schema requires a complete declaredEnd (design §1.2)', () => {
    const schema = toolByName('mission_create')!.inputSchema
    const base = { folder: repo.main, title: 't', sessionId: OWNER }
    expect(schema.safeParse({ ...base, declaredEnd: END }).success).toBe(true)
    expect(schema.safeParse(base).success).toBe(false)
    expect(schema.safeParse({ ...base, declaredEnd: { kind: 'code', target: 'x' } }).success).toBe(
      false
    )
    expect(schema.safeParse({ ...base, declaredEnd: { ...END, target: '' } }).success).toBe(false)
    expect(schema.safeParse({ ...base, declaredEnd: { ...END, kind: 'epic' } }).success).toBe(false)
  })

  it('AC-S3-2: refuses an incomplete declaredEnd and writes nothing', async () => {
    const cases: unknown[] = [
      undefined,
      { kind: 'code', target: 'x' },
      { kind: 'code', evidence: 'y' },
      { kind: 'code', target: '   ', evidence: 'y' },
      { kind: 'code', target: 'x', evidence: '' },
      { kind: 'epic', target: 'x', evidence: 'y' },
      { target: 'x', evidence: 'y' }
    ]
    for (const declaredEnd of cases) {
      const res = await handlers.mission_create(
        { folder: repo.main, title: 'Half-declared', sessionId: OWNER, declaredEnd },
        ctxFor(repo.main)
      )
      expect(errText(res), JSON.stringify(declaredEnd)).toMatch(/^DECLARED_END_INCOMPLETE/)
    }
    expect(await missionFiles(repo.main)).toEqual([])
  })

  it('returns the plan + the fixed end and persists an active mission (Mission v3 §3.3, §3.4)', async () => {
    const res = await handlers.mission_create(
      {
        folder: repo.main,
        title: 'Ship the verb catalog',
        declaredEnd: END,
        sessionId: OWNER,
        linkedCard: 'T358-mission-progress',
        steps: [{ title: 'Implement', verification: 'verifier' }]
      },
      ctxFor(repo.main)
    )
    const p = payloadOf(res)
    expect(p.ok).toBe(true)
    expect(p.op).toBe('mission_create')
    expect(p.missionId).toMatch(/^mnt-[0-9a-f]{8}$/)
    expect(p.slug).toBe('ship-the-verb-catalog')
    const steps = p.steps as Array<Record<string, unknown>>
    expect(steps.map((s) => [s.id, s.kind, s.verification, s.proof])).toEqual([
      ['stp-1', 'custom', 'verifier', 'unproven'],
      ['stp-2', 'fixed-end', 'verifier', 'unproven']
    ])
    expect(steps.map((s) => s.title)).toEqual(['Implement', 'Delivered and verified'])

    const { mission, raw } = await readMissionOnDisk(repo.main, p.missionId as string)
    expect(mission.status).toBe('active')
    expect(mission.owner).toEqual({ sessionId: OWNER, folder: repo.main })
    expect(mission.folder).toBe(repo.main)
    expect(mission.declaredEnd).toEqual(END)
    expect(mission.linkedCard).toBe('T358-mission-progress')
    expect(mission.provenance.author).toBe('agent')
    expect(mission.steps).toHaveLength(2)
    // The title has no Mission field; it heads the free-text Log body.
    expect(readMissionLog(raw)).toMatch(/^# Ship the verb catalog\n/)
  })

  it('a worktree call lands in the MAIN checkout (missions are repo-scoped, design §9)', async () => {
    const { missionId } = await createMission({}, repo.worktree)
    expect(await missionFiles(repo.worktree)).toEqual([])
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(mission.folder).toBe(repo.main)
    expect(mission.owner.folder).toBe(repo.worktree)
  })

  it('refuses when the RESOLVED main checkout is blocked, even from a non-nested worktree', async () => {
    const detached = await fakeRepo({ nested: false })
    // The raw folder arg is not under the blocked root — only the resolved root is.
    expect(detached.worktree.startsWith(detached.main)).toBe(false)
    const res = await handlers.mission_create(
      {
        folder: detached.worktree,
        title: 'Into a blocked repo',
        declaredEnd: END,
        sessionId: OWNER
      },
      ctxFor(detached.worktree, [detached.main])
    )
    expect(errText(res)).toMatch(/^FOLDER_NOT_ALLOWED/)
    expect(await missionFiles(detached.main)).toEqual([])
    expect(await missionFiles(detached.worktree)).toEqual([])
  })

  it('refuses an owner id that is not a Claude session UUID (the S2 exemption matches on it)', async () => {
    for (const sessionId of ['synthetic-1234', 'sess-1']) {
      const res = await handlers.mission_create(
        { folder: repo.main, title: 'Bad owner', declaredEnd: END, sessionId },
        ctxFor(repo.main)
      )
      expect(errText(res)).toMatch(/^BAD_SESSION_ID/)
    }
    expect(await missionFiles(repo.main)).toEqual([])
  })

  it('keeps slugs unique per repo, even for concurrent creates with the same title', async () => {
    const [a, b] = await Promise.all([createMission(), createMission()])
    expect(a.missionId).not.toBe(b.missionId)
    expect(new Set([a.slug, b.slug])).toEqual(
      new Set(['ship-the-verb-catalog', 'ship-the-verb-catalog-2'])
    )
    expect(await missionFiles(repo.main)).toHaveLength(2)
  })
})

// ---- Mission v2 §3.1 — `scope` links the fixed start at birth (AC-3) ----------

describe('mission_create { scope } — the scope attachment (Mission v2 §3.1, v3 §3.3)', () => {
  type StepSignals = { stepId: string; existence: { proven: boolean; reason?: string } | null }

  async function writeRepoFile(rel: string, body = '# doc\n'): Promise<void> {
    const abs = path.join(repo.main, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, body, 'utf8')
  }

  /** The mission's scope attachment and whether it resolves (`derived.scope`). */
  async function startOf(missionId: string): Promise<{
    links: Array<{ kind: string; ref: string }>
    existence: StepSignals['existence']
  }> {
    const got = payloadOf(
      await handlers.mission_get({ folder: repo.main, missionId }, ctxFor(repo.main))
    )
    const mission = got.mission as Mission
    const scope = (got.derived as { scope: { resolved: StepSignals['existence'] } }).scope
    return { links: mission.scope ?? [], existence: scope.resolved }
  }

  const createRaw = (scope: unknown, folder = repo.main): Promise<ToolResult> =>
    handlers.mission_create(
      { folder, title: 'Scoped mission', declaredEnd: END, sessionId: OWNER, scope },
      ctxFor(folder)
    )

  it('attaches scope paths to the mission (never a step), and an existing repo file resolves', async () => {
    await writeRepoFile('docs/spec.md')
    const created = payloadOf(await createRaw(['docs/spec.md']))
    expect(created.scope).toEqual([{ kind: 'worktree', ref: 'docs/spec.md' }])
    expect((created.steps as Mission['steps']).flatMap((s) => s.links)).toEqual([])
    const start = await startOf(created.missionId as string)
    expect(start.links).toEqual([{ kind: 'worktree', ref: 'docs/spec.md' }])
    expect(start.existence).toEqual({ proven: true })
  })

  it('accepts a directory and normalizes the path to repo-relative (deduped)', async () => {
    await writeRepoFile('docs/adr/0001.md')
    const created = payloadOf(
      await createRaw(['./docs/adr/', 'docs/adr', path.join(repo.main, 'docs/adr')])
    )
    expect(created.scope).toEqual([{ kind: 'worktree', ref: 'docs/adr' }])
    expect((await startOf(created.missionId as string)).existence).toEqual({ proven: true })
  })

  it('attaches a missing path but reads the scope unresolved (it may live on a branch)', async () => {
    await writeRepoFile('docs/spec.md')
    const created = payloadOf(await createRaw(['docs/spec.md', 'docs/prd-not-yet.md']))
    const start = await startOf(created.missionId as string)
    expect(start.links.map((l) => l.ref)).toEqual(['docs/spec.md', 'docs/prd-not-yet.md'])
    expect(start.existence?.proven).toBe(false)
    expect(start.existence?.reason).toMatch(/docs\/prd-not-yet\.md does not exist/)
  })

  it('a worktree call resolves scope against the main checkout, where the mission lives', async () => {
    await writeRepoFile('docs/spec.md')
    const created = payloadOf(await createRaw(['docs/spec.md'], repo.worktree))
    expect((await startOf(created.missionId as string)).existence).toEqual({ proven: true })
  })

  it.each([
    ['a parent escape', '../outside.md'],
    ['a deep parent escape', 'docs/../../..'],
    ['an absolute path outside the repo', '/etc/hostname'],
    ['a symlink resolving outside the repo', 'link-out'],
    ['a missing file under a symlink resolving outside the repo', 'link-out/not-there.md'],
    ['a dangling symlink whose missing target is outside the repo', 'docs/dangling.md'],
    ['a relative dangling symlink climbing out of the repo', 'docs/climb.md'],
    ['a symlink chain that ends outside the repo', 'docs/chain-a.md'],
    ['a `..` taken physically after an escaping symlink', 'link-out/../later.md'],
    ['a symlink loop', 'docs/loop-a']
  ])('refuses %s with BAD_SCOPE_PATH and writes nothing', async (_label, p) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-scope-outside-'))
    await fs.writeFile(path.join(outside, 'secret.md'), 'x', 'utf8')
    await fs.symlink(outside, path.join(repo.main, 'link-out'))
    await fs.mkdir(path.join(repo.main, 'docs'), { recursive: true })
    // Targets that do not exist yet — a later write outside would prove the step.
    await fs.symlink(path.join(outside, 'later.md'), path.join(repo.main, 'docs', 'dangling.md'))
    await fs.symlink('../../../../../../../../tmp/later.md', path.join(repo.main, 'docs/climb.md'))
    await fs.symlink('chain-b.md', path.join(repo.main, 'docs', 'chain-a.md'))
    await fs.symlink(path.join(outside, 'secret.md'), path.join(repo.main, 'docs', 'chain-b.md'))
    await fs.symlink('loop-b', path.join(repo.main, 'docs', 'loop-a'))
    await fs.symlink('loop-a', path.join(repo.main, 'docs', 'loop-b'))
    const res = await createRaw(['README.md', p])
    expect(errText(res)).toMatch(/^BAD_SCOPE_PATH: /)
    expect(errText(res)).toContain(JSON.stringify(p))
    expect(await missionFiles(repo.main)).toEqual([])
  })

  it('accepts a symlink (or a chain, dangling or not) that stays inside the repo, storing the path it resolves to', async () => {
    await writeRepoFile('docs/real.md')
    await fs.symlink('real.md', path.join(repo.main, 'docs', 'alias.md'))
    await fs.symlink('alias.md', path.join(repo.main, 'docs', 'alias-2.md'))
    await fs.symlink('not-yet.md', path.join(repo.main, 'docs', 'pending.md'))
    const created = payloadOf(await createRaw(['docs/alias-2.md', 'docs/pending.md'], repo.main))
    const start = await startOf(created.missionId as string)
    // What is stored is what was checked (BUG-145): the physically-resolved path.
    expect(start.links.map((l) => l.ref)).toEqual(['docs/real.md', 'docs/not-yet.md'])
    expect(start.existence?.proven).toBe(false) // pending.md's target is not written yet
    await writeRepoFile('docs/not-yet.md')
    expect((await startOf(created.missionId as string)).existence).toEqual({ proven: true })
  })

  it.each([
    ['the repo root', '.'],
    ['the repo root, spelled through a subdirectory', 'docs/..'],
    ['the repo root, spelled absolute', '<root>'],
    ['a symlink to the repo root', 'docs/root-link']
  ])('refuses %s — the scope names documents, not the repo', async (_label, raw) => {
    await writeRepoFile('docs/spec.md')
    await fs.symlink(repo.main, path.join(repo.main, 'docs', 'root-link'))
    const p = raw === '<root>' ? repo.main : raw
    const text = errText(await createRaw([p]))
    expect(text).toMatch(/^BAD_SCOPE_PATH: /)
    expect(text).toMatch(/name the scope documents, not the repo/)
    expect(await missionFiles(repo.main)).toEqual([])
  })

  it('a scope link swapped for a symlink out of the repo after creation reads unproven', async () => {
    await writeRepoFile('docs/spec.md')
    const created = payloadOf(await createRaw(['docs/spec.md']))
    const missionId = created.missionId as string
    expect((await startOf(missionId)).existence).toEqual({ proven: true })
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-scope-swap-'))
    await fs.writeFile(path.join(outside, 'spec.md'), 'not ours', 'utf8')
    await fs.rm(path.join(repo.main, 'docs', 'spec.md'))
    await fs.symlink(path.join(outside, 'spec.md'), path.join(repo.main, 'docs', 'spec.md'))
    expect((await startOf(missionId)).existence).toEqual({
      proven: false,
      reason: 'worktree docs/spec.md resolves outside the repo'
    })
    // A whole directory swapped the same way is caught too.
    await fs.rm(path.join(repo.main, 'docs'), { recursive: true })
    await fs.symlink(outside, path.join(repo.main, 'docs'))
    expect((await startOf(missionId)).existence?.reason).toBe(
      'worktree docs/spec.md resolves outside the repo'
    )
  })

  it('stores the physically-resolved path, not the lexical spelling (BUG-145)', async () => {
    await writeRepoFile('a/x.md')
    await fs.mkdir(path.join(repo.main, 'a', 'b'), { recursive: true })
    await fs.symlink(path.join('a', 'b'), path.join(repo.main, 'inlink'))
    await writeRepoFile('x.md', '# a decoy at the lexical spelling\n')
    // Lexically `inlink/../x.md` is `x.md`; on disk it climbs out of a/b into a/.
    const created = payloadOf(await createRaw(['inlink/../x.md']))
    const start = await startOf(created.missionId as string)
    expect(start.links).toEqual([{ kind: 'worktree', ref: 'a/x.md' }])
    await fs.rm(path.join(repo.main, 'a', 'x.md'))
    expect((await startOf(created.missionId as string)).existence?.proven).toBe(false)
  })

  it.each([
    ['.git', '.git'],
    ['a file under .git', '.git/HEAD'],
    ['.harnu', '.harnu'],
    ["Harnu's own missions dir", '.harnu/missions'],
    ['the legacy .capy', '.capy'],
    ['the legacy .capy missions dir', '.capy/missions'],
    ['a symlink into .git', 'docs/git-link']
  ])(
    'refuses %s — git internals and Harnu state prove nothing about the scope (BUG-145)',
    async (_label, p) => {
      await fs.mkdir(path.join(repo.main, '.harnu', 'missions'), { recursive: true })
      await fs.mkdir(path.join(repo.main, '.capy', 'missions'), { recursive: true })
      await fs.writeFile(path.join(repo.main, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
      await fs.mkdir(path.join(repo.main, 'docs'), { recursive: true })
      await fs.symlink(path.join(repo.main, '.git'), path.join(repo.main, 'docs', 'git-link'))
      const text = errText(await createRaw([p]))
      expect(text).toMatch(/^BAD_SCOPE_PATH: /)
      expect(text).toMatch(/\.git, \.harnu or \.capy/)
      expect(await missionFiles(repo.main)).toEqual([])
    }
  )

  it('refuses a malformed scope (not an array of non-empty strings, or more than 20)', async () => {
    for (const scope of [
      'docs/spec.md',
      [''],
      [42],
      Array.from({ length: 21 }, (_, i) => `d${i}.md`)
    ]) {
      expect(errText(await createRaw(scope)), JSON.stringify(scope)).toMatch(/^BAD_ARGS: scope/)
    }
    expect(await missionFiles(repo.main)).toEqual([])
  })

  it('without scope the mission has no scope attachment', async () => {
    const { missionId } = await createMission()
    const start = await startOf(missionId)
    expect(start.links).toEqual([])
    expect(start.existence).toEqual({
      proven: false,
      reason: 'no artifact link (a path in the repo, a card or a PR) to check'
    })
  })

  it('catalog: scope is an optional array of 1..20 non-empty strings', () => {
    const schema = toolByName('mission_create')!.inputSchema
    const base = { folder: repo.main, title: 't', declaredEnd: END, sessionId: OWNER }
    expect(schema.safeParse(base).success).toBe(true)
    expect(schema.safeParse({ ...base, scope: ['docs/spec.md'] }).success).toBe(true)
    expect(schema.safeParse({ ...base, scope: [''] }).success).toBe(false)
    expect(
      schema.safeParse({ ...base, scope: Array.from({ length: 21 }, (_, i) => `${i}`) }).success
    ).toBe(false)
  })
})

// ---- BUG-145 — a path on the fixed start is a scope path, whichever verb put it there

describe('mission_link_child { scope: true } is held to the scope rules (BUG-145, v3 §3.3)', () => {
  /** `SCOPE` links a scope document; any other value links that step. */
  const SCOPE = 'scope'
  const link = (missionId: string, stepId: string, ref: string): Promise<ToolResult> =>
    handlers.mission_link_child(
      stepId === SCOPE
        ? { folder: repo.main, missionId, scope: true, link: { kind: 'worktree', ref } }
        : { folder: repo.main, missionId, stepId, link: { kind: 'worktree', ref } },
      ctxFor(repo.main)
    )

  async function start(missionId: string): Promise<{
    links: Array<{ kind: string; ref: string }>
    existence: { proven: boolean; reason?: string } | null
  }> {
    const got = payloadOf(
      await handlers.mission_get({ folder: repo.main, missionId }, ctxFor(repo.main))
    )
    const scope = (got.derived as { scope: { resolved: unknown } }).scope
    return {
      links: (got.mission as Mission).scope ?? [],
      existence: scope.resolved as { proven: boolean; reason?: string } | null
    }
  }

  it.each([
    ['an absolute path outside the repo', '/etc/hostname', /outside this repo/],
    ['the repo root, absolute', '<root>', /is the repo root/],
    ['.git', '.git', /\.git, \.harnu or \.capy/],
    ['a parent escape', '../elsewhere.md', /outside this repo/]
  ])('refuses %s at link time and stores nothing', async (_label, raw, why) => {
    const { missionId } = await createMission()
    const ref = raw === '<root>' ? repo.main : raw
    const text = errText(await link(missionId, SCOPE, ref))
    expect(text).toMatch(/^BAD_SCOPE_PATH: /)
    expect(text).toMatch(why)
    expect((await readMissionOnDisk(repo.main, missionId)).mission.scope).toBeUndefined()
  })

  it('accepts a path inside the repo, stored repo-relative (absolute or not), and the scope resolves', async () => {
    const { missionId } = await createMission()
    await fs.mkdir(path.join(repo.main, 'docs'), { recursive: true })
    await fs.writeFile(path.join(repo.main, 'docs', 'spec.md'), '# spec', 'utf8')
    await fs.writeFile(path.join(repo.main, 'docs', 'prd.md'), '# prd', 'utf8')
    payloadOf(await link(missionId, SCOPE, path.join(repo.main, 'docs', 'spec.md')))
    const ack = payloadOf(await link(missionId, SCOPE, 'docs/prd.md'))
    expect(ack.scope).toEqual([
      { kind: 'worktree', ref: 'docs/spec.md' },
      { kind: 'worktree', ref: 'docs/prd.md' }
    ])
    expect((await start(missionId)).existence).toEqual({ proven: true })
  })

  it('leaves worktree links on any other step exactly as before', async () => {
    const { missionId } = await createMission()
    const added = payloadOf(
      await handlers.mission_add_step(
        { folder: repo.main, missionId, title: 'Unit', verification: 'existence' },
        ctxFor(repo.main)
      )
    )
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-other-step-'))
    const ack = payloadOf(await link(missionId, added.stepId as string, outside))
    expect(ack.links).toEqual([{ kind: 'worktree', ref: outside }])
  })

  it('read time: a scope path stored before this rule (absolute, outside or the root) reads unresolved', async () => {
    const { missionId } = await createMission()
    for (const [ref, reason] of [
      ['/etc/hostname', 'worktree /etc/hostname resolves outside the repo'],
      [repo.main, `worktree ${repo.main} is the repo root`],
      ['.git', 'worktree .git is inside .git, .harnu or .capy']
    ]) {
      await mutateStored(repo.main, missionId, (m) => {
        m.scope = [{ kind: 'worktree', ref }]
        return m
      })
      expect((await start(missionId)).existence, ref).toEqual({ proven: false, reason })
    }
  })

  it('a legacy fixed start keeps the same rules: refused at link time, re-checked at read time', async () => {
    const { missionId } = await createMission()
    await mutateStored(repo.main, missionId, (m) => {
      m.steps.unshift({
        id: 'stp-9',
        ordinal: 0,
        kind: 'fixed-start',
        title: 'Scope confirmed',
        verification: 'existence',
        proof: 'unproven',
        links: [],
        blockers: []
      })
      return m
    })
    expect(errText(await link(missionId, 'stp-9', '/etc/hostname'))).toMatch(/^BAD_SCOPE_PATH: /)
    await mutateStored(repo.main, missionId, (m) => {
      m.steps[0].links = [{ kind: 'worktree', ref: '/etc/hostname' }]
      return m
    })
    const got = payloadOf(
      await handlers.mission_get({ folder: repo.main, missionId }, ctxFor(repo.main))
    )
    const derived = got.derived as {
      scope: { resolved: unknown }
      steps: Array<{ stepId: string; existence: unknown }>
    }
    const reason = 'worktree /etc/hostname resolves outside the repo'
    // The legacy links read as scope (missionScope) and on the step itself.
    expect(derived.scope.resolved).toEqual({ proven: false, reason })
    expect(derived.steps.find((x) => x.stepId === 'stp-9')!.existence).toEqual({
      proven: false,
      reason
    })
  })
})

// ---- BUG-145 delta 3 — worktree checkouts and internals at any depth ----------

describe('scope paths never land on a worktree checkout or git/Harnu internals (BUG-145)', () => {
  /**
   * `repo.worktree` is Harnu's layout: `<main>/.claude/worktrees/wt`, whose `.git`
   * is a pointer FILE. `vendor/sub` is a nested checkout elsewhere (a `.git` dir).
   */
  async function layout(): Promise<void> {
    await fs.mkdir(path.join(repo.main, 'vendor', 'sub', '.git'), { recursive: true })
    await fs.writeFile(path.join(repo.main, 'vendor', 'sub', 'README.md'), '# sub', 'utf8')
    await fs.mkdir(path.join(repo.main, 'docs', 'x', '.git'), { recursive: true })
    await fs.writeFile(path.join(repo.main, 'docs', 'x', '.git', 'y'), 'y', 'utf8')
    await fs.mkdir(path.join(repo.main, 'docs', '.CAPY'), { recursive: true })
    await fs.writeFile(path.join(repo.main, 'docs', '.CAPY', 'z.md'), 'z', 'utf8')
    await fs.mkdir(path.join(repo.main, 'docs', '.HARNU'), { recursive: true })
    await fs.writeFile(path.join(repo.main, 'docs', '.HARNU', 'z.md'), 'z', 'utf8')
    await fs.writeFile(path.join(repo.worktree, 'spec.md'), '# in the worktree', 'utf8')
  }

  const CASES: Array<[string, () => string, RegExp]> = [
    ['the nested worktree root (absolute)', () => repo.worktree, /worktree checkout/],
    [
      'the nested worktree .git pointer file',
      () => path.join(repo.worktree, '.git'),
      /\.git, \.harnu or \.capy/
    ],
    [
      'a file inside the nested worktree',
      () => path.join(repo.worktree, 'spec.md'),
      /worktree checkout/
    ],
    ["Harnu's worktree home", () => '.claude/worktrees', /worktree checkout/],
    ["Harnu's worktree home, other case", () => '.Claude/WORKTREES/wt', /worktree checkout/],
    ['a deep .git component', () => 'docs/x/.git/y', /\.git, \.harnu or \.capy/],
    ['a deep .CAPY component', () => 'docs/.HARNU/z.md', /\.git, \.harnu or \.capy/],
    ['a deep .HARNU component', () => 'docs/.HARNU/z.md', /\.git, \.harnu or \.capy/],
    ['a nested checkout root elsewhere', () => 'vendor/sub', /worktree checkout/],
    ['a file inside a nested checkout elsewhere', () => 'vendor/sub/README.md', /worktree checkout/]
  ]

  it.each(CASES)(
    'mission_create { scope } refuses %s, called from the worktree folder',
    async (_label, p, why) => {
      await layout()
      const res = await handlers.mission_create(
        { folder: repo.worktree, title: 'T', declaredEnd: END, sessionId: OWNER, scope: [p()] },
        ctxFor(repo.worktree)
      )
      const text = errText(res)
      expect(text).toMatch(/^BAD_SCOPE_PATH: /)
      expect(text).toMatch(why)
      expect(await missionFiles(repo.main)).toEqual([])
    }
  )

  it.each(CASES)('mission_link_child { scope: true } refuses %s', async (_label, p, why) => {
    await layout()
    const { missionId } = await createMission({}, repo.worktree)
    const res = await handlers.mission_link_child(
      { folder: repo.worktree, missionId, scope: true, link: { kind: 'worktree', ref: p() } },
      ctxFor(repo.worktree)
    )
    const text = errText(res)
    expect(text).toMatch(/^BAD_SCOPE_PATH: /)
    expect(text).toMatch(why)
    expect((await readMissionOnDisk(repo.main, missionId)).mission.scope).toBeUndefined()
  })

  it('read time: each of them swapped in after creation reads unproven, with the reason', async () => {
    await layout()
    const { missionId } = await createMission()
    const refs: Array<[string, string]> = [
      ['.claude/worktrees/wt', 'is a worktree checkout'],
      ['.claude/worktrees', 'is a worktree checkout'],
      ['.claude/worktrees/wt/.git', 'is inside .git, .harnu or .capy'],
      ['docs/x/.git/y', 'is inside .git, .harnu or .capy'],
      ['docs/.HARNU/z.md', 'is inside .git, .harnu or .capy'],
      ['docs/.HARNU/z.md', 'is inside .git, .harnu or .capy'],
      ['vendor/sub', 'is a worktree checkout'],
      ['vendor/sub/README.md', 'is a worktree checkout']
    ]
    for (const [ref, why] of refs) {
      await mutateStored(repo.main, missionId, (m) => {
        m.scope = [{ kind: 'worktree', ref }]
        return m
      })
      const got = payloadOf(
        await handlers.mission_get({ folder: repo.main, missionId }, ctxFor(repo.main))
      )
      const existence = (got.derived as { scope: { resolved: unknown } }).scope.resolved
      expect(existence, ref).toEqual({ proven: false, reason: expect.stringContaining(why) })
    }
  })

  // Root ignores directory permissions, so chmod cannot deny it the probe.
  it.skipIf(process.getuid?.() === 0)(
    'fails closed: an unreadable directory holding a .git entry is refused at create/link and reads unproven',
    async () => {
      const locked = path.join(repo.main, 'vendor', 'w')
      await fs.mkdir(locked, { recursive: true })
      await fs.writeFile(path.join(locked, '.git'), 'gitdir: /elsewhere\n', 'utf8')
      // Seed a mission whose stored fixed start already points there (read time).
      const { missionId } = await createMission()
      await mutateStored(repo.main, missionId, (m) => {
        m.scope = [{ kind: 'worktree', ref: 'vendor/w' }]
        return m
      })
      await fs.chmod(locked, 0o600) // readable bits, no search: lstat(<w>/.git) is EACCES
      try {
        const created = await handlers.mission_create(
          {
            folder: repo.main,
            title: 'T',
            declaredEnd: END,
            sessionId: OWNER,
            scope: ['vendor/w']
          },
          ctxFor(repo.main)
        )
        expect(errText(created)).toMatch(/^BAD_SCOPE_PATH: .*is a worktree checkout/)
        const other = await createMission()
        const linked = await handlers.mission_link_child(
          {
            folder: repo.main,
            missionId: other.missionId,
            scope: true,
            link: { kind: 'worktree', ref: 'vendor/w' }
          },
          ctxFor(repo.main)
        )
        expect(errText(linked)).toMatch(/^BAD_SCOPE_PATH: .*is a worktree checkout/)
        const got = payloadOf(
          await handlers.mission_get({ folder: repo.main, missionId }, ctxFor(repo.main))
        )
        expect((got.derived as { scope: { resolved: unknown } }).scope.resolved).toEqual({
          proven: false,
          reason: 'worktree vendor/w is a worktree checkout (or inside one)'
        })
      } finally {
        await fs.chmod(locked, 0o755)
      }
    }
  )

  it('a scope directory that later becomes a git checkout (git init) reads unproven', async () => {
    await fs.mkdir(path.join(repo.main, 'docs', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(repo.main, 'docs', 'pkg', 'spec.md'), '# spec', 'utf8')
    const created = payloadOf(
      await handlers.mission_create(
        {
          folder: repo.main,
          title: 'T',
          declaredEnd: END,
          sessionId: OWNER,
          scope: ['docs/pkg']
        },
        ctxFor(repo.main)
      )
    )
    const read = async (): Promise<unknown> =>
      (
        payloadOf(
          await handlers.mission_get(
            { folder: repo.main, missionId: created.missionId },
            ctxFor(repo.main)
          )
        ).derived as { scope: { resolved: unknown } }
      ).scope.resolved
    expect(await read()).toEqual({ proven: true })
    await fs.mkdir(path.join(repo.main, 'docs', 'pkg', '.git'))
    expect(await read()).toEqual({
      proven: false,
      reason: expect.stringContaining('docs/pkg is a worktree checkout')
    })
  })
})

// ---- Task 2 — mission_get + mission_list (read verbs) ------------------------

describe('mission_get', () => {
  it('catalog: a read with no gate field; the owner lookup id is flagged self-declared', () => {
    const def = toolByName('mission_get')!
    expect(def.op).toBe('mission_get')
    expect(def.mutates).toBe(false)
    expect(def.silentAllowInAgentFolder).toBeUndefined()
    expect(def.disclosesTranscript).toBeUndefined()
    expect(def.description).toMatch(/self-declared/i)
    const schema = def.inputSchema
    expect(schema.safeParse({ folder: repo.main, missionId: 'mnt-0000abcd' }).success).toBe(true)
    expect(schema.safeParse({ folder: repo.main, ownerSessionId: OWNER }).success).toBe(true)
    expect(schema.safeParse({ folder: repo.main }).success).toBe(false)
  })

  it('returns a full projection with a static you-line when nothing is owed', async () => {
    const { missionId } = await createMission()
    const p = payloadOf(
      await handlers.mission_get({ folder: repo.main, missionId }, ctxFor(repo.main))
    )
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(p.ok).toBe(true)
    expect(p.op).toBe('mission_get')
    expect(p.mission).toEqual(mission)
    expect(p.you).toBe("— nothing, you're clear")
    expect(p.title).toBe('Ship the verb catalog')
    expect(p.log).toMatch(/## Log/)
    // Derived live signals are computed since S6 (tests/mission-derived-signals.test.ts);
    // a fresh draft with no links derives nothing live and is never stale.
    expect(p.derived).toMatchObject({
      live: true,
      stale: false,
      gh: 'not-needed',
      pendingApprovals: 0,
      steps: [
        {
          stepId: 'stp-1',
          children: [],
          links: [],
          existence: { proven: false }
        },
        { stepId: 'stp-2', children: [], links: [], existence: null }
      ]
    })
  })

  it('finds a mission by its owner session from any worktree of the repo', async () => {
    const { missionId } = await createMission()
    const p = payloadOf(
      await handlers.mission_get(
        { folder: repo.worktree, ownerSessionId: OWNER },
        ctxFor(repo.worktree)
      )
    )
    expect((p.mission as Mission).id).toBe(missionId)
  })

  it('refuses an unknown id, a missing selector, and a blocked folder', async () => {
    const { missionId } = await createMission()
    expect(
      errText(
        await handlers.mission_get(
          { folder: repo.main, missionId: 'mnt-deadbeef' },
          ctxFor(repo.main)
        )
      )
    ).toMatch(/^MISSION_NOT_FOUND/)
    expect(
      errText(
        await handlers.mission_get({ folder: repo.main, ownerSessionId: CHILD }, ctxFor(repo.main))
      )
    ).toMatch(/^MISSION_NOT_FOUND/)
    expect(errText(await handlers.mission_get({ folder: repo.main }, ctxFor(repo.main)))).toMatch(
      /^BAD_ARGS/
    )
    expect(
      errText(
        await handlers.mission_get({ folder: repo.main, missionId }, ctxFor(repo.main, [repo.main]))
      )
    ).toMatch(/^FOLDER_NOT_ALLOWED/)
  })
})

describe('mission_list', () => {
  it('catalog: a read with no gate field, folder optional', () => {
    const def = toolByName('mission_list')!
    expect(def.op).toBe('mission_list')
    expect(def.mutates).toBe(false)
    expect(def.silentAllowInAgentFolder).toBeUndefined()
    expect(def.inputSchema.safeParse({}).success).toBe(true)
    expect(def.inputSchema.safeParse({ folder: repo.main }).success).toBe(true)
  })

  it("scopes to the given folder — another repo's missions are not listed", async () => {
    const other = await fakeRepo()
    const { missionId, slug } = await createMission()
    await createMission({ title: 'Elsewhere' }, other.main)

    const p = payloadOf(
      await handlers.mission_list({ folder: repo.worktree }, ctxFor(repo.worktree))
    )
    const rows = p.missions as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: missionId,
      slug,
      title: 'Ship the verb catalog',
      status: 'active',
      folder: repo.main,
      ownerSessionId: OWNER,
      steps: { total: 2, verified: 0, claimed: 0 },
      blocked: false
    })
  })

  it('with no folder, lists every known repo once and skips a blocked one', async () => {
    const other = await fakeRepo()
    const blocked = await fakeRepo()
    await createMission()
    await createMission({ title: 'Elsewhere' }, other.main)
    await createMission({ title: 'Hidden' }, blocked.main)
    const folders = [repo.main, repo.worktree, other.main, blocked.main].map((p) => ({ path: p }))

    const p = payloadOf(
      await handlers.mission_list(
        {},
        { folder: '', folders, denyFolders: [blocked.main], bridge: undefined }
      )
    )
    const slugs = (p.missions as Array<Record<string, unknown>>).map((r) => r.slug).sort()
    expect(slugs).toEqual(['elsewhere', 'ship-the-verb-catalog'])
  })

  it('refuses a blocked folder outright', async () => {
    expect(
      errText(await handlers.mission_list({ folder: repo.main }, ctxFor(repo.main, [repo.main])))
    ).toMatch(/^FOLDER_NOT_ALLOWED/)
  })
})

// ---- Task 3 — step mutation verbs --------------------------------------------

/** Force a stored status — no verb moves draft → active (that is the operator's UI). */
async function setStoredStatus(root: string, id: string, status: Mission['status']): Promise<void> {
  const name = (await missionFiles(root)).find((n) => n.startsWith(`${id}-`))!
  const file = path.join(missionsDir(root), name)
  const raw = await fs.readFile(file, 'utf8')
  const mission = parseMissionFile(raw) as Mission
  await fs.writeFile(
    file,
    buildMissionFileContent({ ...mission, status }, readMissionLog(raw)),
    'utf8'
  )
}

describe('mission_add_step', () => {
  it('before the start, inserts before the fixed end with no reason required', async () => {
    const { missionId } = await createMission()
    const p = payloadOf(
      await handlers.mission_add_step(
        { folder: repo.main, missionId, title: 'Wire the handlers', verification: 'verifier' },
        ctxFor(repo.main)
      )
    )
    expect(p).toEqual({ ok: true, op: 'mission_add_step', stepId: 'stp-3', totalSteps: 3 })
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(mission.steps.map((s) => [s.id, s.ordinal, s.kind])).toEqual([
      ['stp-1', 1, 'custom'],
      ['stp-3', 2, 'custom'],
      ['stp-2', 3, 'fixed-end']
    ])
    expect(mission.steps[1]).toMatchObject({
      title: 'Wire the handlers',
      verification: 'verifier',
      proof: 'unproven',
      links: [],
      blockers: []
    })
  })

  it('requires a reason once the mission has STARTED (Mission v3 §3.4, decision 7), and stores it', async () => {
    const { missionId } = await createMission()
    // A status alone is not a start: an active mission with no link or proof is still planning.
    await setStoredStatus(repo.main, missionId, 'active')
    const planned = payloadOf(
      await handlers.mission_add_step(
        { folder: repo.main, missionId, title: 'Planned', verification: 'verifier' },
        ctxFor(repo.main)
      )
    )
    payloadOf(
      await handlers.mission_link_child(
        {
          folder: repo.main,
          missionId,
          stepId: planned.stepId,
          link: { kind: 'session', ref: CHILD }
        },
        ctxFor(repo.main)
      )
    )
    const args = { folder: repo.main, missionId, title: 'Late step', verification: 'human' }
    expect(errText(await handlers.mission_add_step(args, ctxFor(repo.main)))).toMatch(
      /^REASON_REQUIRED/
    )
    const p = payloadOf(
      await handlers.mission_add_step(
        { ...args, reason: 'review found a missing migration' },
        ctxFor(repo.main)
      )
    )
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    const added = mission.steps.find((s) => s.id === p.stepId)!
    expect(added.addedReason).toBe('review found a missing migration')
  })

  it('honours afterStepId, never after the fixed end, and refuses an unknown step', async () => {
    const { missionId } = await createMission()
    const add = (extra: Record<string, unknown>): Promise<ToolResult> =>
      handlers.mission_add_step(
        { folder: repo.main, missionId, title: 'x', verification: 'verifier', ...extra },
        ctxFor(repo.main)
      )
    payloadOf(await add({ title: 'second' }))
    payloadOf(await add({ title: 'first', afterStepId: 'stp-1' }))
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(mission.steps.map((s) => s.title)).toEqual([
      'Spec on disk',
      'first',
      'second',
      'Delivered and verified'
    ])
    expect(errText(await add({ afterStepId: 'stp-2' }))).toMatch(/^BAD_POSITION/)
    expect(errText(await add({ afterStepId: 'stp-99' }))).toMatch(/^STEP_NOT_FOUND/)
  })

  it('refuses to touch a closed mission', async () => {
    const { missionId } = await createMission()
    await setStoredStatus(repo.main, missionId, 'closed')
    const res = await handlers.mission_add_step(
      { folder: repo.main, missionId, title: 'x', verification: 'verifier', reason: 'r' },
      ctxFor(repo.main)
    )
    expect(errText(res)).toMatch(/^MISSION_CLOSED/)
  })
})

describe('mission_update_step', () => {
  async function withCustomStep(verification = 'verifier'): Promise<{ missionId: string }> {
    const { missionId } = await createMission()
    payloadOf(
      await handlers.mission_add_step(
        { folder: repo.main, missionId, title: 'Custom', verification },
        ctxFor(repo.main)
      )
    )
    return { missionId }
  }

  it('AC-S3-3: refuses to set proof or verifiedBy (controlled fields) and writes nothing', async () => {
    const { missionId } = await withCustomStep()
    const before = (await readMissionOnDisk(repo.main, missionId)).raw
    const refused: Record<string, unknown>[] = [
      { proof: 'verified' },
      { proof: 'self-verified' },
      { proof: 'unproven' },
      { verifiedBy: { sessionId: OWNER, at: '2026-09-28T00:00:00.000Z', verdict: 'met' } },
      { title: 'sneak', verifiedBy: { sessionId: OWNER, at: 'now' } }
    ]
    for (const set of refused) {
      const res = await handlers.mission_update_step(
        { folder: repo.main, missionId, stepId: 'stp-3', set },
        ctxFor(repo.main)
      )
      expect(errText(res), JSON.stringify(set)).toMatch(/^CONTROLLED_FIELD/)
    }
    expect((await readMissionOnDisk(repo.main, missionId)).raw).toBe(before)
  })

  it("edits a custom step's title and lets the owner claim a verifier step (design §1.3)", async () => {
    const { missionId } = await withCustomStep()
    const p = payloadOf(
      await handlers.mission_update_step(
        {
          folder: repo.main,
          missionId,
          stepId: 'stp-3',
          set: { title: 'Renamed', proof: 'claimed' }
        },
        ctxFor(repo.main)
      )
    )
    expect(p).toMatchObject({ ok: true, op: 'mission_update_step', stepId: 'stp-3' })
    const step = (await readMissionOnDisk(repo.main, missionId)).mission.steps.find(
      (s) => s.id === 'stp-3'
    )!
    expect(step.title).toBe('Renamed')
    expect(step.proof).toBe('claimed')
    expect(step.verifiedBy).toBeUndefined()
  })

  it('refuses claiming an existence step, renaming the fixed frame, and unknown fields', async () => {
    const { missionId } = await withCustomStep()
    const update = (stepId: string, set: Record<string, unknown>): Promise<ToolResult> =>
      handlers.mission_update_step({ folder: repo.main, missionId, stepId, set }, ctxFor(repo.main))
    expect(errText(await update('stp-1', { proof: 'claimed' }))).toMatch(/^PROOF_NOT_CLAIMABLE/)
    expect(errText(await update('stp-2', { title: 'Done-ish' }))).toMatch(/^FIXED_STEP/)
    expect(errText(await update('stp-3', { owner: 'me' }))).toMatch(/^BAD_ARGS/)
    expect(errText(await update('stp-3', {}))).toMatch(/^BAD_ARGS/)
    expect(errText(await update('stp-99', { title: 'x' }))).toMatch(/^STEP_NOT_FOUND/)
  })
})

describe('mission_link_child', () => {
  it('appends a StepLink, idempotently, and returns the step links', async () => {
    const { missionId } = await createMission()
    const link = (l: Record<string, unknown>): Promise<ToolResult> =>
      handlers.mission_link_child(
        { folder: repo.main, missionId, stepId: 'stp-2', link: l },
        ctxFor(repo.main)
      )
    payloadOf(await link({ kind: 'session', ref: CHILD }))
    const p = payloadOf(await link({ kind: 'pr', ref: 'owner/repo#12' }))
    expect(p.op).toBe('mission_link_child')
    expect(p.stepId).toBe('stp-2')
    expect(p.links).toEqual([
      { kind: 'session', ref: CHILD },
      { kind: 'pr', ref: 'owner/repo#12' }
    ])
    payloadOf(await link({ kind: 'session', ref: CHILD }))
    const step = (await readMissionOnDisk(repo.main, missionId)).mission.steps[1]
    expect(step.links).toHaveLength(2)
  })

  it('refuses a session link that is not a Claude session UUID (S2 matches on it)', async () => {
    const { missionId } = await createMission()
    const res = await handlers.mission_link_child(
      {
        folder: repo.main,
        missionId,
        stepId: 'stp-2',
        link: { kind: 'session', ref: 'synthetic-abc' }
      },
      ctxFor(repo.main)
    )
    expect(errText(res)).toMatch(/^BAD_SESSION_ID/)
  })
})

describe('mission_log', () => {
  it('appends to the free-text Log section without touching frontmatter', async () => {
    const { missionId } = await createMission()
    const before = (await readMissionOnDisk(repo.main, missionId)).raw
    const frontmatter = before.slice(0, before.length - readMissionLog(before).length)

    const p = payloadOf(
      await handlers.mission_log(
        { folder: repo.main, missionId, stepId: 'stp-1', note: 'Spec reviewed.\nTwo gaps.' },
        ctxFor(repo.main)
      )
    )
    expect(p).toEqual({ ok: true, op: 'mission_log' })
    const after = (await readMissionOnDisk(repo.main, missionId)).raw
    expect(after.startsWith(before)).toBe(true)
    expect(after.slice(0, frontmatter.length)).toBe(frontmatter)
    const appended = after.slice(before.length)
    expect(appended).toMatch(
      /^\n### \d{4}-\d\d-\d\dT[\d:.]+Z · stp-1\n\nSpec reviewed\.\nTwo gaps\.\n$/
    )
  })

  it('never loses a note when two land at once (per-mission lock)', async () => {
    const { missionId } = await createMission()
    await Promise.all(
      ['alpha', 'beta', 'gamma'].map((note) =>
        handlers.mission_log({ folder: repo.main, missionId, note }, ctxFor(repo.main))
      )
    )
    const log = readMissionLog((await readMissionOnDisk(repo.main, missionId)).raw)
    for (const note of ['alpha', 'beta', 'gamma']) expect(log).toContain(note)
  })

  it('refuses an unknown step', async () => {
    const { missionId } = await createMission()
    const res = await handlers.mission_log(
      { folder: repo.main, missionId, stepId: 'stp-9', note: 'x' },
      ctxFor(repo.main)
    )
    expect(errText(res)).toMatch(/^STEP_NOT_FOUND/)
  })
})

// ---- S4 Task 1 — blocker verbs (design §1.4, decision 12) --------------------

describe('mission_set_blocker / mission_clear_blocker', () => {
  it('catalog: both mutate and run free like create_card; owner is agent | operator', () => {
    for (const name of ['mission_set_blocker', 'mission_clear_blocker']) {
      const def = toolByName(name)!
      expect(def.op, name).toBe(name)
      expect(def.mutates, name).toBe(true)
      expect(def.silentAllowInAgentFolder, name).toBe(true)
    }
    const schema = toolByName('mission_set_blocker')!.inputSchema
    const base = { folder: repo.main, missionId: 'mnt-0000abcd', reason: 'r', unblocks: 'u' }
    expect(schema.safeParse({ ...base, owner: 'operator' }).success).toBe(true)
    expect(schema.safeParse({ ...base, owner: 'nobody' }).success).toBe(false)
    const clear = toolByName('mission_clear_blocker')!.inputSchema
    expect(
      clear.safeParse({ folder: repo.main, missionId: 'mnt-0000abcd', index: 0 }).success
    ).toBe(true)
    expect(clear.safeParse({ folder: repo.main, missionId: 'mnt-0000abcd' }).success).toBe(false)
  })

  it('mission_set_blocker adds a Blocker without changing mission.status', async () => {
    const { missionId } = await createMission()
    await setStoredStatus(repo.main, missionId, 'active')
    const p = payloadOf(
      await handlers.mission_set_blocker(
        {
          folder: repo.main,
          missionId,
          reason: 'waiting on a release window',
          unblocks: 'the operator picks a date',
          owner: 'operator'
        },
        ctxFor(repo.main)
      )
    )
    expect(p).toMatchObject({ ok: true, op: 'mission_set_blocker' })
    expect(p.blockers).toEqual([
      expect.objectContaining({
        reason: 'waiting on a release window',
        unblocks: 'the operator picks a date',
        owner: 'operator',
        raisedAt: expect.any(String)
      })
    ])
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    // A flag, not a status (design §1.4): the mission stays active.
    expect(mission.status).toBe('active')
    expect(mission.blockers).toHaveLength(1)
    expect(mission.steps.every((s) => s.blockers.length === 0)).toBe(true)

    // With stepId it lands on the step, not the mission.
    const s = payloadOf(
      await handlers.mission_set_blocker(
        {
          folder: repo.main,
          missionId,
          stepId: 'stp-2',
          reason: 'CI red',
          unblocks: 'green gates',
          owner: 'agent'
        },
        ctxFor(repo.main)
      )
    )
    expect(s).toMatchObject({ ok: true, stepId: 'stp-2' })
    const after = (await readMissionOnDisk(repo.main, missionId)).mission
    expect(after.status).toBe('active')
    expect(after.blockers).toHaveLength(1)
    expect(after.steps[1].blockers).toEqual([expect.objectContaining({ reason: 'CI red' })])
  })

  it('stores the same reason once, updating what unblocks it and who owns it', async () => {
    const { missionId } = await createMission()
    const set = (unblocks: string, owner: string): Promise<ToolResult> =>
      handlers.mission_set_blocker(
        { folder: repo.main, missionId, reason: 'same', unblocks, owner },
        ctxFor(repo.main)
      )
    payloadOf(await set('first', 'agent'))
    const p = payloadOf(await set('second', 'operator'))
    expect(p.blockers).toEqual([
      expect.objectContaining({ reason: 'same', unblocks: 'second', owner: 'operator' })
    ])
  })

  it('surfaces a mission-level operator blocker on the you line and in mission_list', async () => {
    const { missionId } = await createMission()
    payloadOf(
      await handlers.mission_set_blocker(
        {
          folder: repo.main,
          missionId,
          reason: 'needs a product call',
          unblocks: 'the operator decides',
          owner: 'operator'
        },
        ctxFor(repo.main)
      )
    )
    const got = payloadOf(
      await handlers.mission_get({ folder: repo.main, missionId }, ctxFor(repo.main))
    )
    expect(got.you).toMatch(/needs a product call/)
    const list = payloadOf(await handlers.mission_list({ folder: repo.main }, ctxFor(repo.main)))
    expect((list.missions as Array<Record<string, unknown>>)[0].blocked).toBe(true)
  })

  it('mission_clear_blocker removes it by index/reason', async () => {
    const { missionId } = await createMission()
    for (const reason of ['first', 'second', 'third']) {
      payloadOf(
        await handlers.mission_set_blocker(
          { folder: repo.main, missionId, reason, unblocks: 'u', owner: 'agent' },
          ctxFor(repo.main)
        )
      )
    }
    const byReason = payloadOf(
      await handlers.mission_clear_blocker(
        { folder: repo.main, missionId, reason: 'second' },
        ctxFor(repo.main)
      )
    )
    expect(byReason).toMatchObject({ ok: true, op: 'mission_clear_blocker' })
    expect((byReason.blockers as Array<{ reason: string }>).map((b) => b.reason)).toEqual([
      'first',
      'third'
    ])
    const byIndex = payloadOf(
      await handlers.mission_clear_blocker(
        { folder: repo.main, missionId, index: 0 },
        ctxFor(repo.main)
      )
    )
    expect((byIndex.blockers as Array<{ reason: string }>).map((b) => b.reason)).toEqual(['third'])
    expect((await readMissionOnDisk(repo.main, missionId)).mission.blockers).toEqual([
      expect.objectContaining({ reason: 'third' })
    ])

    // Step-level: clears from the step's own list.
    payloadOf(
      await handlers.mission_set_blocker(
        {
          folder: repo.main,
          missionId,
          stepId: 'stp-1',
          reason: 'r',
          unblocks: 'u',
          owner: 'agent'
        },
        ctxFor(repo.main)
      )
    )
    const step = payloadOf(
      await handlers.mission_clear_blocker(
        { folder: repo.main, missionId, stepId: 'stp-1', reason: 'r' },
        ctxFor(repo.main)
      )
    )
    expect(step).toMatchObject({ stepId: 'stp-1', blockers: [] })
  })

  it('refuses an unknown blocker, an unknown step, and a closed mission', async () => {
    const { missionId } = await createMission()
    expect(
      errText(
        await handlers.mission_clear_blocker(
          { folder: repo.main, missionId, reason: 'nope' },
          ctxFor(repo.main)
        )
      )
    ).toMatch(/^BLOCKER_NOT_FOUND/)
    expect(
      errText(
        await handlers.mission_clear_blocker(
          { folder: repo.main, missionId, index: 3 },
          ctxFor(repo.main)
        )
      )
    ).toMatch(/^BLOCKER_NOT_FOUND/)
    expect(
      errText(
        await handlers.mission_set_blocker(
          {
            folder: repo.main,
            missionId,
            stepId: 'stp-9',
            reason: 'r',
            unblocks: 'u',
            owner: 'agent'
          },
          ctxFor(repo.main)
        )
      )
    ).toMatch(/^STEP_NOT_FOUND/)
    await setStoredStatus(repo.main, missionId, 'closed')
    expect(
      errText(
        await handlers.mission_set_blocker(
          { folder: repo.main, missionId, reason: 'r', unblocks: 'u', owner: 'agent' },
          ctxFor(repo.main)
        )
      )
    ).toMatch(/^MISSION_CLOSED/)
  })
})

// ---- S4 Task 2 — re-scope (design §3, decision 6, Review Focus #4) -----------

/** Rewrite one stored mission through a mutator — the tests' stand-in for a UI door. */
async function mutateStored(root: string, id: string, fn: (m: Mission) => Mission): Promise<void> {
  const name = (await missionFiles(root)).find((n) => n.startsWith(`${id}-`))!
  const file = path.join(missionsDir(root), name)
  const raw = await fs.readFile(file, 'utf8')
  const mission = parseMissionFile(raw) as Mission
  await fs.writeFile(file, buildMissionFileContent(fn(mission), readMissionLog(raw)), 'utf8')
}

const NEW_END = { kind: 'research', target: 'a written go/no-go memo', evidence: 'memo merged' }

describe('mission_set_end (re-scope) never overwrites in place (Review Focus #4)', () => {
  it('catalog: mutating, runs free, requires a complete declaredEnd and a reason', () => {
    const def = toolByName('mission_set_end')!
    expect(def.op).toBe('mission_set_end')
    expect(def.mutates).toBe(true)
    expect(def.silentAllowInAgentFolder).toBe(true)
    const base = { folder: repo.main, missionId: 'mnt-0000abcd', declaredEnd: NEW_END }
    expect(def.inputSchema.safeParse({ ...base, reason: 'scope moved' }).success).toBe(true)
    expect(def.inputSchema.safeParse(base).success).toBe(false)
    expect(
      def.inputSchema.safeParse({
        ...base,
        declaredEnd: { kind: 'code', target: 'x' },
        reason: 'r'
      }).success
    ).toBe(false)
    expect(def.description).toMatch(/pendingRescope/)
  })

  it('mission_set_end writes pendingRescope, leaves declaredEnd untouched', async () => {
    const { missionId } = await createMission()
    await setStoredStatus(repo.main, missionId, 'active')
    const before = (await readMissionOnDisk(repo.main, missionId)).mission
    const p = payloadOf(
      await handlers.mission_set_end(
        { folder: repo.main, missionId, declaredEnd: NEW_END, reason: 'the build is not needed' },
        ctxFor(repo.main)
      )
    )
    expect(p).toEqual({ ok: true, op: 'mission_set_end', pendingRescope: true })
    const { mission, raw } = await readMissionOnDisk(repo.main, missionId)
    expect(mission.declaredEnd).toEqual(before.declaredEnd)
    expect(mission.declaredEnd).toEqual(END)
    expect(mission.pendingRescope).toEqual(NEW_END)
    // The chat agreement stamped at create stays: a staged re-scope approves nothing.
    expect(mission.declaredEndApproval).toEqual(before.declaredEndApproval)
    expect(mission.status).toBe('active')
    // The reason is the audit trail: it lands in the Log with the was/now pair.
    const log = readMissionLog(raw)
    expect(log).toMatch(/re-scope requested/)
    expect(log).toMatch(/the build is not needed/)
    expect(log).toContain(END.target)
    expect(log).toContain(NEW_END.target)
    // …and the operator owes it an approval.
    const got = payloadOf(
      await handlers.mission_get({ folder: repo.main, missionId }, ctxFor(repo.main))
    )
    expect(got.you).toMatch(/Approve the new declared end/)
  })

  it('refuses an incomplete end, a missing reason, and an end identical to the current one', async () => {
    const { missionId } = await createMission()
    const setEnd = (extra: Record<string, unknown>): Promise<ToolResult> =>
      handlers.mission_set_end({ folder: repo.main, missionId, ...extra }, ctxFor(repo.main))
    expect(
      errText(
        await setEnd({ declaredEnd: { kind: 'code', target: ' ', evidence: 'e' }, reason: 'r' })
      )
    ).toMatch(/^DECLARED_END_INCOMPLETE/)
    expect(errText(await setEnd({ declaredEnd: NEW_END }))).toMatch(/^BAD_ARGS: reason/)
    expect(errText(await setEnd({ declaredEnd: END, reason: 'r' }))).toMatch(/^END_UNCHANGED/)
    expect((await readMissionOnDisk(repo.main, missionId)).mission.pendingRescope).toBeUndefined()
  })

  // Review Focus #4 — named literally so a regression search finds both by name.
  it("approving a pendingRescope resets the fixed-end step's proof to unproven from verified", () =>
    approveRescopeFrom('verified'))
  it("approving a pendingRescope resets the fixed-end step's proof to unproven from self-verified", () =>
    approveRescopeFrom('self-verified'))

  async function approveRescopeFrom(from: 'verified' | 'self-verified'): Promise<void> {
    const { missionId } = await createMission()
    await mutateStored(repo.main, missionId, (m) => {
      const end = m.steps.find((s) => s.kind === 'fixed-end')!
      end.proof = from
      end.verifiedBy = { sessionId: CHILD, at: '2026-09-28T10:00:00.000Z', verdict: 'met' }
      return { ...m, status: 'active' }
    })
    payloadOf(
      await handlers.mission_set_end(
        { folder: repo.main, missionId, declaredEnd: NEW_END, reason: 'target changed' },
        ctxFor(repo.main)
      )
    )
    // Staging alone never touches the old proof — only the approval voids it.
    const staged = (await readMissionOnDisk(repo.main, missionId)).mission
    expect(staged.steps.find((s) => s.kind === 'fixed-end')!.proof).toBe(from)

    const approved = applyApprovedRescope(staged, { at: '2026-09-28T11:00:00.000Z' })
    const end = approved.steps.find((s) => s.kind === 'fixed-end')!
    expect(end.proof).toBe('unproven')
    expect(end.verifiedBy).toBeUndefined()
    expect(approved.declaredEnd).toEqual(NEW_END)
    expect(approved.pendingRescope).toBeUndefined()
    // Mission v3 §3.4: the operator approved it, so it is stamped via 'operator'
    // (a chat-agreed end carries via 'chat').
    expect(approved.declaredEndApproval).toEqual({
      at: '2026-09-28T11:00:00.000Z',
      bodyHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      via: 'operator'
    })
    // Pure: the input record is not mutated, and the result still writes.
    expect(staged.steps.find((s) => s.kind === 'fixed-end')!.proof).toBe(from)
    expect(() => buildMissionFileContent(approved)).not.toThrow()
  }
})

describe('applyApprovedRescope (the operator UI door, wired by S9)', () => {
  it('refuses a mission with no pending re-scope', async () => {
    const { missionId } = await createMission()
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(() => applyApprovedRescope(mission, { at: '2026-09-28T11:00:00.000Z' })).toThrow(
      /no pending re-scope/
    )
  })

  it('voids a pending close and returns a delivered mission to active — its end just changed', async () => {
    const { missionId } = await createMission()
    await mutateStored(repo.main, missionId, (m) => ({
      ...m,
      status: 'delivered',
      pendingClose: { at: '2026-09-28T10:00:00.000Z', requestedBy: OWNER },
      pendingRescope: NEW_END as Mission['declaredEnd']
    }))
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    const approved = applyApprovedRescope(mission, { at: '2026-09-28T11:00:00.000Z' })
    expect(approved.status).toBe('active')
    expect(approved.pendingClose).toBeUndefined()
    expect(approved.updatedAt).toBe('2026-09-28T11:00:00.000Z')
  })

  it('stamps a body hash that changes with the declared end', async () => {
    const { missionId } = await createMission()
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    const a = applyApprovedRescope(
      { ...mission, pendingRescope: NEW_END as Mission['declaredEnd'] },
      {
        at: 't'
      }
    )
    const b = applyApprovedRescope(
      {
        ...mission,
        pendingRescope: { ...NEW_END, target: 'another memo' } as Mission['declaredEnd']
      },
      { at: 't' }
    )
    expect(a.declaredEndApproval!.bodyHash).not.toBe(b.declaredEndApproval!.bodyHash)
  })
})

// ---- S4 Task 3 — mission_verify_step (design §1.3, §13 Resolved A, Review Focus #1)

const VERIFIER = 'cccccccc-dddd-4eee-8fff-000000000000'

describe('mission_verify_step never refuses — verified vs self-verified (Review Focus #1)', () => {
  /** A mission whose fixed end (stp-2) optionally links one child session. */
  async function missionWithEnd(link?: string): Promise<{ missionId: string }> {
    const { missionId } = await createMission()
    if (link) {
      payloadOf(
        await handlers.mission_link_child(
          { folder: repo.main, missionId, stepId: 'stp-2', link: { kind: 'session', ref: link } },
          ctxFor(repo.main)
        )
      )
    }
    return { missionId }
  }

  function verify(missionId: string, extra: Record<string, unknown> = {}): Promise<ToolResult> {
    return handlers.mission_verify_step(
      {
        folder: repo.main,
        missionId,
        stepId: 'stp-2',
        verdict: 'met',
        evidence: 'delivery-verifier report: 5/5 ACs met',
        sessionId: VERIFIER,
        ...extra
      },
      ctxFor(repo.main)
    )
  }

  it('catalog: mutating, runs free, and the description carries the self-declared, not authenticated caveat', () => {
    const def = toolByName('mission_verify_step')!
    expect(def.op).toBe('mission_verify_step')
    expect(def.mutates).toBe(true)
    expect(def.silentAllowInAgentFolder).toBe(true)
    expect(def.description).toMatch(/self-declared/i)
    expect(def.description).toMatch(/not authenticated/i)
    expect(def.description).toMatch(/self-verified/)
    const base = {
      folder: repo.main,
      missionId: 'mnt-0000abcd',
      stepId: 'stp-2',
      evidence: 'e',
      sessionId: VERIFIER
    }
    for (const verdict of ['met', 'unmet', 'blocked', 'needs-human']) {
      expect(def.inputSchema.safeParse({ ...base, verdict }).success, verdict).toBe(true)
    }
    expect(def.inputSchema.safeParse({ ...base, verdict: 'pass' }).success).toBe(false)
    const { evidence: _evidence, ...noEvidence } = base
    expect(def.inputSchema.safeParse({ ...noEvidence, verdict: 'met' }).success).toBe(false)
  })

  it('mission_verify_step sets proof to verified with verifiedBy when the step has a session link that differs from the declared caller id', async () => {
    const { missionId } = await missionWithEnd(CHILD)
    const p = payloadOf(await verify(missionId))
    expect(p).toMatchObject({
      ok: true,
      op: 'mission_verify_step',
      stepId: 'stp-2',
      proof: 'verified'
    })
    const end = (await readMissionOnDisk(repo.main, missionId)).mission.steps[1]
    expect(end.proof).toBe('verified')
    expect(end.verifiedBy).toEqual({ sessionId: VERIFIER, at: expect.any(String), verdict: 'met' })
  })

  it('mission_verify_step sets proof to self-verified when the step has no session link at all', async () => {
    const { missionId } = await missionWithEnd()
    const p = payloadOf(await verify(missionId))
    expect(p).toMatchObject({ ok: true, stepId: 'stp-2', proof: 'self-verified' })
    const end = (await readMissionOnDisk(repo.main, missionId)).mission.steps[1]
    expect(end.proof).toBe('self-verified')
    expect(end.verifiedBy).toMatchObject({ sessionId: VERIFIER, verdict: 'met' })
  })

  it('mission_verify_step sets proof to self-verified when the declared caller id matches an existing session link', async () => {
    const { missionId } = await missionWithEnd(CHILD)
    payloadOf(
      await handlers.mission_link_child(
        { folder: repo.main, missionId, stepId: 'stp-2', link: { kind: 'session', ref: VERIFIER } },
        ctxFor(repo.main)
      )
    )
    // Two links; the caller declares itself as one of them — it built what it verifies.
    const p = payloadOf(await verify(missionId, { sessionId: CHILD }))
    expect(p).toMatchObject({ ok: true, proof: 'self-verified' })
    expect(
      (await readMissionOnDisk(repo.main, missionId)).mission.steps[1].verifiedBy
    ).toMatchObject({ sessionId: CHILD })
  })

  it('mission_verify_step always returns { ok: true }, never a SELF_VERIFICATION refusal', async () => {
    // Every self-verification shape: no link, the linked child itself, the owner on an
    // unlinked step, and a second verification over an earlier one.
    const cases: Array<{ link?: string; caller: string }> = [
      { caller: VERIFIER },
      { link: CHILD, caller: CHILD },
      { caller: OWNER },
      { link: OWNER, caller: OWNER }
    ]
    for (const c of cases) {
      const { missionId } = await missionWithEnd(c.link)
      for (let i = 0; i < 2; i++) {
        const res = await verify(missionId, { sessionId: c.caller })
        expect(res.isError, JSON.stringify(c)).not.toBe(true)
        expect(res.content[0].text).not.toMatch(/SELF_VERIFICATION/)
        expect(payloadOf(res)).toMatchObject({ ok: true, proof: 'self-verified' })
      }
    }
  })

  it('a self-declared id that lies about which session actually called still produces verified, not self-verified, since Harnu cannot check it', async () => {
    // The linked child (CHILD) is the one really calling, but it DECLARES another id.
    // Harnu's MCP transport has no per-session identity (one shared config + token), so
    // the declared id is all there is: this is convention + audit, not security
    // (design §13 Resolved A). A change that closes this gap must update this test.
    const { missionId } = await missionWithEnd(CHILD)
    const reallyCalledBy = CHILD
    const declared = VERIFIER
    expect(declared).not.toBe(reallyCalledBy)
    const p = payloadOf(await verify(missionId, { sessionId: declared }))
    expect(p).toMatchObject({ ok: true, proof: 'verified' })
    // The audit trail records the DECLARED id — which is how the operator can spot it.
    expect(
      (await readMissionOnDisk(repo.main, missionId)).mission.steps[1].verifiedBy
    ).toMatchObject({ sessionId: declared })
  })

  it('logs the evidence and verdict, so the operator can audit who said what', async () => {
    const { missionId } = await missionWithEnd(CHILD)
    payloadOf(await verify(missionId))
    const log = readMissionLog((await readMissionOnDisk(repo.main, missionId)).raw)
    expect(log).toMatch(/stp-2 · verified \(met\)/)
    expect(log).toContain(VERIFIER)
    expect(log).toContain('delivery-verifier report: 5/5 ACs met')
  })

  it('a verdict other than met records the verification but leaves the step unproven', async () => {
    const { missionId } = await missionWithEnd(CHILD)
    payloadOf(await verify(missionId))
    // Mission v3 §3.6: needs-human is no longer one of these — it keeps the proof
    // label and adds a check (covered in the Mission v3 checks block below).
    for (const verdict of ['unmet', 'blocked']) {
      const p = payloadOf(await verify(missionId, { verdict }))
      expect(p, verdict).toMatchObject({ ok: true, proof: 'unproven', verdict })
      const end = (await readMissionOnDisk(repo.main, missionId)).mission.steps[1]
      expect(end.proof, verdict).toBe('unproven')
      expect(end.verifiedBy, verdict).toMatchObject({ sessionId: VERIFIER, verdict })
    }
  })

  it('AC-S4-2: never marks a human step (operator only) or an existence step (Harnu computes it)', async () => {
    const { missionId } = await createMission()
    payloadOf(
      await handlers.mission_add_step(
        { folder: repo.main, missionId, title: 'Operator signs off', verification: 'human' },
        ctxFor(repo.main)
      )
    )
    const human = await verify(missionId, { stepId: 'stp-3' })
    expect(errText(human)).toMatch(/^WRONG_VERIFICATION_LEVEL: stp-3 is a human step/)
    const existence = await verify(missionId, { stepId: 'stp-1' })
    expect(errText(existence)).toMatch(/^WRONG_VERIFICATION_LEVEL: stp-1 is an existence step/)
    const m = (await readMissionOnDisk(repo.main, missionId)).mission
    expect(m.steps.map((s) => s.proof)).toEqual(['unproven', 'unproven', 'unproven'])
  })

  it('refuses a caller id that is not a Claude session UUID and an unknown step', async () => {
    const { missionId } = await missionWithEnd(CHILD)
    expect(errText(await verify(missionId, { sessionId: 'synthetic-1' }))).toMatch(
      /^BAD_SESSION_ID/
    )
    expect(errText(await verify(missionId, { stepId: 'stp-9' }))).toMatch(/^STEP_NOT_FOUND/)
  })
})

// ---- Mission v2 §3.5 — the fixed end's authors are every step's builders ------

describe('mission_verify_step — the fixed end is built by every custom step (Mission v2 §3.5, AC-6)', () => {
  const EXEC = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb'
  const EXEC_2 = 'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc'

  /**
   * An active mission with one custom verifier step per entry of `children`
   * (stp-3, stp-4, …), each linked to that child session — `null` leaves the
   * step without any session link.
   */
  async function seedMissionWithCustomSteps(
    children: Array<string | null>
  ): Promise<{ missionId: string; endId: string; customIds: string[] }> {
    const { missionId } = await createMission()
    const customIds: string[] = []
    // Plan every step first (no reason needed before the mission starts), then link.
    for (const i of children.keys()) {
      const added = payloadOf(
        await handlers.mission_add_step(
          { folder: repo.main, missionId, title: `Unit ${i + 1}`, verification: 'verifier' },
          ctxFor(repo.main)
        )
      )
      customIds.push(added.stepId as string)
    }
    for (const [i, child] of children.entries()) {
      const stepId = customIds[i]
      if (child) {
        payloadOf(
          await handlers.mission_link_child(
            { folder: repo.main, missionId, stepId, link: { kind: 'session', ref: child } },
            ctxFor(repo.main)
          )
        )
      }
    }
    await setStoredStatus(repo.main, missionId, 'active')
    const end = (await readMissionOnDisk(repo.main, missionId)).mission.steps.find(
      (s) => s.kind === 'fixed-end'
    )!
    return { missionId, endId: end.id, customIds }
  }

  async function verifyAs(missionId: string, stepId: string, sessionId: string): Promise<string> {
    const p = payloadOf(
      await handlers.mission_verify_step(
        { folder: repo.main, missionId, stepId, verdict: 'met', evidence: 'checked', sessionId },
        ctxFor(repo.main)
      )
    )
    return p.proof as string
  }

  it('verifies the fixed end as verified when the caller built no step', async () => {
    const { missionId, endId, customIds } = await seedMissionWithCustomSteps([EXEC])
    expect(await verifyAs(missionId, customIds[0], OWNER)).toBe('verified')
    expect(await verifyAs(missionId, endId, OWNER)).toBe('verified')
  })

  it('keeps the fixed end self-verified when the caller built a step', async () => {
    const { missionId, endId } = await seedMissionWithCustomSteps([EXEC, EXEC_2])
    expect(await verifyAs(missionId, endId, EXEC_2)).toBe('self-verified')
  })

  it('keeps the fixed end self-verified when no step has a session link', async () => {
    const { missionId, endId } = await seedMissionWithCustomSteps([null])
    expect(await verifyAs(missionId, endId, OWNER)).toBe('self-verified')
  })

  it('keeps the fixed end self-verified on a mission with zero custom steps (no crash on an empty author set)', async () => {
    const { missionId, endId } = await seedMissionWithCustomSteps([])
    expect(await verifyAs(missionId, endId, OWNER)).toBe('self-verified')
  })

  it('end to end: every unit linked and verified, the owner verifies the end, the close lands delivered, the operator closes', async () => {
    const { missionId, endId, customIds } = await seedMissionWithCustomSteps([EXEC, EXEC_2])
    for (const id of customIds) expect(await verifyAs(missionId, id, OWNER)).toBe('verified')
    expect(await verifyAs(missionId, endId, OWNER)).toBe('verified')
    expect(
      payloadOf(
        await handlers.mission_request_close(
          { folder: repo.main, missionId, sessionId: OWNER },
          ctxFor(repo.main)
        )
      )
    ).toMatchObject({ ok: true, pendingClose: true })
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(mission.status).toBe('delivered')
    expect(mission.pendingClose).toMatchObject({ requestedBy: OWNER })
    expect(
      applyOperatorEnd(mission, { at: '2026-09-29T12:00:00.000Z', closedAs: 'delivered' }).status
    ).toBe('closed')
  })

  it('end to end: with no session link anywhere the end stays self-verified and the close is refused', async () => {
    const { missionId, endId } = await seedMissionWithCustomSteps([null, null])
    expect(await verifyAs(missionId, endId, OWNER)).toBe('self-verified')
    const refused = await handlers.mission_request_close(
      { folder: repo.main, missionId, sessionId: OWNER },
      ctxFor(repo.main)
    )
    expect(errText(refused)).toMatch(/^END_NOT_VERIFIED/)
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(mission.status).toBe('active')
    expect(mission.pendingClose).toBeUndefined()
  })
})

// ---- S4 Task 4 — mission_request_close (design §3, decision 14) --------------

/** An active mission whose fixed end was verified by an independent session. */
async function verifiedMission(): Promise<{ missionId: string }> {
  const { missionId } = await createMission()
  await setStoredStatus(repo.main, missionId, 'active')
  payloadOf(
    await handlers.mission_link_child(
      { folder: repo.main, missionId, stepId: 'stp-2', link: { kind: 'session', ref: CHILD } },
      ctxFor(repo.main)
    )
  )
  payloadOf(
    await handlers.mission_verify_step(
      {
        folder: repo.main,
        missionId,
        stepId: 'stp-2',
        verdict: 'met',
        evidence: 'all ACs met',
        sessionId: VERIFIER
      },
      ctxFor(repo.main)
    )
  )
  return { missionId }
}

const requestClose = (
  missionId: string,
  extra: Record<string, unknown> = {}
): Promise<ToolResult> =>
  handlers.mission_request_close({ folder: repo.main, missionId, ...extra }, ctxFor(repo.main))

describe('mission_request_close', () => {
  it('catalog: mutating, runs free, and names both refusals', () => {
    const def = toolByName('mission_request_close')!
    expect(def.op).toBe('mission_request_close')
    expect(def.mutates).toBe(true)
    expect(def.silentAllowInAgentFolder).toBe(true)
    expect(def.description).toMatch(/END_NOT_VERIFIED/)
    expect(def.description).toMatch(/OPEN_BLOCKERS/)
    expect(
      def.inputSchema.safeParse({ folder: repo.main, missionId: 'mnt-0000abcd' }).success
    ).toBe(true)
  })

  it('mission_request_close refuses unless the fixed-end step is verified', async () => {
    const { missionId } = await createMission()
    await setStoredStatus(repo.main, missionId, 'active')
    // unproven
    expect(errText(await requestClose(missionId))).toMatch(/^END_NOT_VERIFIED/)
    // claimed
    payloadOf(
      await handlers.mission_update_step(
        { folder: repo.main, missionId, stepId: 'stp-2', set: { proof: 'claimed' } },
        ctxFor(repo.main)
      )
    )
    expect(errText(await requestClose(missionId))).toMatch(/^END_NOT_VERIFIED/)
    // self-verified never counts (design §1.3 — never renders as proven)
    payloadOf(
      await handlers.mission_verify_step(
        {
          folder: repo.main,
          missionId,
          stepId: 'stp-2',
          verdict: 'met',
          evidence: 'I checked my own work',
          sessionId: OWNER
        },
        ctxFor(repo.main)
      )
    )
    expect((await readMissionOnDisk(repo.main, missionId)).mission.steps[1].proof).toBe(
      'self-verified'
    )
    expect(errText(await requestClose(missionId))).toMatch(/^END_NOT_VERIFIED.*self-verified/)
    const m = (await readMissionOnDisk(repo.main, missionId)).mission
    expect(m.pendingClose).toBeUndefined()
    expect(m.status).toBe('active')
  })

  it('mission_request_close refuses with open blockers', async () => {
    const { missionId } = await verifiedMission()
    const block = (extra: Record<string, unknown>): Promise<ToolResult> =>
      handlers.mission_set_blocker(
        { folder: repo.main, missionId, reason: 'r', unblocks: 'u', owner: 'agent', ...extra },
        ctxFor(repo.main)
      )
    // A mission-level blocker…
    payloadOf(await block({}))
    expect(errText(await requestClose(missionId))).toMatch(/^OPEN_BLOCKERS/)
    payloadOf(
      await handlers.mission_clear_blocker(
        { folder: repo.main, missionId, index: 0 },
        ctxFor(repo.main)
      )
    )
    // …and a step-level one both hold the close.
    payloadOf(await block({ stepId: 'stp-1' }))
    expect(errText(await requestClose(missionId))).toMatch(/^OPEN_BLOCKERS/)
    expect((await readMissionOnDisk(repo.main, missionId)).mission.pendingClose).toBeUndefined()
  })

  it('mission_request_close sets pendingClose', async () => {
    const { missionId } = await verifiedMission()
    const p = payloadOf(await requestClose(missionId, { sessionId: VERIFIER }))
    expect(p).toEqual({ ok: true, op: 'mission_request_close', pendingClose: true })
    const m = (await readMissionOnDisk(repo.main, missionId)).mission
    expect(m.pendingClose).toEqual({ at: expect.any(String), requestedBy: VERIFIER })
    // design §3: the request moves the mission to delivered — never to closed.
    expect(m.status).toBe('delivered')
    const got = payloadOf(
      await handlers.mission_get({ folder: repo.main, missionId }, ctxFor(repo.main))
    )
    expect(got.you).toMatch(/Close the mission/)
  })

  it('defaults requestedBy to the owner, and never refuses a former draft with MISSION_DRAFT (Mission v3 §3.4)', async () => {
    const { missionId } = await verifiedMission()
    payloadOf(await requestClose(missionId))
    expect((await readMissionOnDisk(repo.main, missionId)).mission.pendingClose?.requestedBy).toBe(
      OWNER
    )
    const draft = (await createMission()).missionId
    await mutateStored(repo.main, draft, (m) => {
      m.steps[1].proof = 'verified'
      return m
    })
    expect(payloadOf(await requestClose(draft))).toMatchObject({ ok: true, pendingClose: true })
  })

  it('refuses a staged re-scope with RESCOPE_PENDING, and leaves the mission untouched', async () => {
    const { missionId } = await verifiedMission()
    payloadOf(
      await handlers.mission_set_end(
        {
          folder: repo.main,
          missionId,
          declaredEnd: { kind: 'code', target: 'stacked PRs, never merged', evidence: 'PRs open' },
          reason: 'the operator changed the delivery rule'
        },
        ctxFor(repo.main)
      )
    )
    expect(errText(await requestClose(missionId))).toMatch(/^RESCOPE_PENDING: /)
    const m = (await readMissionOnDisk(repo.main, missionId)).mission
    expect(m.status).toBe('active')
    expect(m.pendingClose).toBeUndefined()
  })
})

// ---- Mission v2 §3.5 — mission_get.closeReadiness (AC-7) ---------------------

describe('mission_get.closeReadiness equals what mission_request_close would return', () => {
  const closeReadiness = async (missionId: string): Promise<unknown> =>
    payloadOf(await handlers.mission_get({ folder: repo.main, missionId }, ctxFor(repo.main)))
      .closeReadiness

  /** Reads closeReadiness, then asks for the close — the two must agree. */
  async function expectAgreement(missionId: string, code: string | null): Promise<void> {
    const readiness = (await closeReadiness(missionId)) as { code: string; reason: string } | null
    const res = await requestClose(missionId)
    if (code === null) {
      expect(readiness).toBeNull()
      expect(payloadOf(res)).toMatchObject({ ok: true, pendingClose: true })
      return
    }
    expect(readiness).toEqual({ code, reason: expect.any(String) })
    expect(errText(res)).toMatch(new RegExp(`^${code}: `))
    // The same refusal, word for word.
    expect(errText(res)).toBe(`${readiness!.code}: ${readiness!.reason}`)
  }

  it('a legacy draft reads active → END_NOT_VERIFIED, never MISSION_DRAFT (Mission v3 §3.4)', async () => {
    const { missionId } = await createMission()
    await setStoredStatus(repo.main, missionId, 'draft')
    await expectAgreement(missionId, 'END_NOT_VERIFIED')
  })

  it('an unproven or self-verified end → END_NOT_VERIFIED', async () => {
    const { missionId } = await createMission()
    await setStoredStatus(repo.main, missionId, 'active')
    await expectAgreement(missionId, 'END_NOT_VERIFIED')
    payloadOf(
      await handlers.mission_verify_step(
        {
          folder: repo.main,
          missionId,
          stepId: 'stp-2',
          verdict: 'met',
          evidence: 'my own work',
          sessionId: OWNER
        },
        ctxFor(repo.main)
      )
    )
    await expectAgreement(missionId, 'END_NOT_VERIFIED')
  })

  it('an open blocker → OPEN_BLOCKERS', async () => {
    const { missionId } = await verifiedMission()
    payloadOf(
      await handlers.mission_set_blocker(
        { folder: repo.main, missionId, reason: 'merge #6', unblocks: 'merged', owner: 'operator' },
        ctxFor(repo.main)
      )
    )
    await expectAgreement(missionId, 'OPEN_BLOCKERS')
  })

  it('a staged re-scope → RESCOPE_PENDING', async () => {
    const { missionId } = await verifiedMission()
    payloadOf(
      await handlers.mission_set_end(
        {
          folder: repo.main,
          missionId,
          declaredEnd: { kind: 'code', target: 'stacked PRs', evidence: 'PRs open' },
          reason: 'rule change'
        },
        ctxFor(repo.main)
      )
    )
    await expectAgreement(missionId, 'RESCOPE_PENDING')
  })

  it('closed → MISSION_CLOSED', async () => {
    const { missionId } = await verifiedMission()
    await setStoredStatus(repo.main, missionId, 'closed')
    // editMission refuses a closed mission before requestCloseRefusal runs, so the
    // two texts live in two places — pin them equal so they cannot drift.
    const readiness = (await closeReadiness(missionId)) as { code: string; reason: string } | null
    expect(readiness?.code).toBe('MISSION_CLOSED')
    expect(errText(await requestClose(missionId))).toBe(`${readiness!.code}: ${readiness!.reason}`)
  })

  it('a verified end with nothing open → null, and the request lands', async () => {
    const { missionId } = await verifiedMission()
    await expectAgreement(missionId, null)
  })
})

describe('applyOperatorEnd + closeWarnings (the operator UI door, Mission v3 §3.5)', () => {
  // pendingClose is stamped once and survives what happens after it; the end
  // door never refuses on it — it WARNS, computed in one place.
  async function deliveredMission(): Promise<string> {
    const { missionId } = await verifiedMission()
    payloadOf(await requestClose(missionId))
    return missionId
  }
  const warningsOf = (m: Mission): string[] =>
    closeWarnings(m, computeProgress(m, [], Date.now())).map((w) => w.kind)

  it('ends any open mission — active or delivered — and consumes a pending close', async () => {
    const { missionId } = await createMission()
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    const ended = applyOperatorEnd(mission, { at: 't', closedAs: 'discarded' })
    expect(ended).toMatchObject({ status: 'closed', closedAs: 'discarded' })
    const delivered = (await readMissionOnDisk(repo.main, await deliveredMission())).mission
    const closed = applyOperatorEnd(delivered, {
      at: '2026-09-28T12:00:00.000Z',
      closedAs: 'delivered'
    })
    expect(closed.status).toBe('closed')
    expect(closed.pendingClose).toBeUndefined()
    expect(closed.updatedAt).toBe('2026-09-28T12:00:00.000Z')
    expect(delivered.status).toBe('delivered') // pure
  })

  it('warns once a later unmet verdict un-verifies the fixed end — and still ends', async () => {
    const missionId = await deliveredMission()
    payloadOf(
      await handlers.mission_verify_step(
        {
          folder: repo.main,
          missionId,
          stepId: 'stp-2',
          verdict: 'unmet',
          evidence: 'AC-3 fails on a clean checkout',
          sessionId: VERIFIER
        },
        ctxFor(repo.main)
      )
    )
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(mission.status).toBe('delivered') // the verb does not undo the request…
    expect(mission.pendingClose).toBeDefined()
    expect(warningsOf(mission)).toContain('end-unverified') // …the dialog warns
    expect(applyOperatorEnd(mission, { at: 't', closedAs: 'delivered' }).status).toBe('closed')
  })

  it('warns while a mission-level or a step-level blocker is open', async () => {
    const missionId = await deliveredMission()
    const block = (extra: Record<string, unknown>): Promise<ToolResult> =>
      handlers.mission_set_blocker(
        { folder: repo.main, missionId, reason: 'r', unblocks: 'u', owner: 'agent', ...extra },
        ctxFor(repo.main)
      )
    payloadOf(await block({}))
    let { mission } = await readMissionOnDisk(repo.main, missionId)
    // stp-1 (an existence step with no link) sits before the verified end: left behind.
    expect(warningsOf(mission)).toEqual(['left-behind', 'blockers-open'])
    payloadOf(
      await handlers.mission_clear_blocker(
        { folder: repo.main, missionId, index: 0 },
        ctxFor(repo.main)
      )
    )
    payloadOf(await block({ stepId: 'stp-1' }))
    ;({ mission } = await readMissionOnDisk(repo.main, missionId))
    // stp-1 is now blocked, not abandoned — so it is no longer left behind.
    expect(warningsOf(mission)).toEqual(['blockers-open'])
  })

  it('a delivered mission warns only about its left-behind step; a staged re-scope adds one', async () => {
    const missionId = await deliveredMission()
    let { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(warningsOf(mission)).toEqual(['left-behind'])
    payloadOf(
      await handlers.mission_set_end(
        { folder: repo.main, missionId, declaredEnd: NEW_END, reason: 'scope grew' },
        ctxFor(repo.main)
      )
    )
    ;({ mission } = await readMissionOnDisk(repo.main, missionId))
    expect(warningsOf(mission)).toEqual(['left-behind', 'rescope-staged'])
  })
})

// ---- S4 — blocked folders reach every new verb, even from an outside worktree -----

describe('S4 verbs refuse a blocked folder on the folder arg AND the resolved main root', () => {
  /**
   * A linked worktree OUTSIDE the main checkout (a sibling dir, not nested under
   * it): blocking the main checkout does not cover this path by prefix, so only
   * the resolved-root check can refuse it.
   */
  async function outsideWorktree(): Promise<string> {
    const wtGitDir = path.join(repo.main, '.git', 'worktrees', 'outside')
    await fs.mkdir(wtGitDir, { recursive: true })
    await fs.writeFile(path.join(wtGitDir, 'commondir'), '../..\n', 'utf8')
    const wt = path.join(path.dirname(repo.main), 'outside-wt')
    await fs.mkdir(wt, { recursive: true })
    await fs.writeFile(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`, 'utf8')
    return wt
  }

  const S4_CALLS: Record<string, (missionId: string) => Record<string, unknown>> = {
    mission_set_blocker: (missionId) => ({
      missionId,
      reason: 'r',
      unblocks: 'u',
      owner: 'agent'
    }),
    mission_clear_blocker: (missionId) => ({ missionId, index: 0 }),
    mission_set_end: (missionId) => ({ missionId, declaredEnd: NEW_END, reason: 'r' }),
    mission_verify_step: (missionId) => ({
      missionId,
      stepId: 'stp-2',
      verdict: 'met',
      evidence: 'e',
      sessionId: VERIFIER
    }),
    mission_request_close: (missionId) => ({ missionId })
  }

  for (const [op, argsFor] of Object.entries(S4_CALLS)) {
    it(`${op}: a non-nested worktree of a blocked main checkout is refused, and nothing is written`, async () => {
      const wt = await outsideWorktree()
      const { missionId } = await createMission()
      // Precondition: the worktree really resolves to the main checkout's missions.
      payloadOf(await handlers.mission_get({ folder: wt, missionId }, ctxFor(wt)))
      expect(wt.startsWith(repo.main + path.sep)).toBe(false)
      const before = (await readMissionOnDisk(repo.main, missionId)).raw

      const viaRoot = await handlers[op](
        { folder: wt, ...argsFor(missionId) },
        ctxFor(wt, [repo.main])
      )
      expect(errText(viaRoot)).toMatch(/^FOLDER_NOT_ALLOWED/)
      const viaFolder = await handlers[op]({ folder: wt, ...argsFor(missionId) }, ctxFor(wt, [wt]))
      expect(errText(viaFolder)).toMatch(/^FOLDER_NOT_ALLOWED/)
      expect((await readMissionOnDisk(repo.main, missionId)).raw).toBe(before)
    })
  }
})

// ---- Mission v3 Task 1.4 — born active with its plan; scope is an attachment --

describe('Mission v3 — mission_create is born active with its plan (spec §3.3, §3.4)', () => {
  const PLAN = [
    { title: 'Build the core', verification: 'verifier' },
    { title: 'Designer sign-off', verification: 'human' },
    { title: 'Spec on disk', verification: 'existence' }
  ]

  it('(a) writes active, stamps the chat agreement, and takes the plan: given steps + the end, no fixed start', async () => {
    const created = payloadOf(
      await handlers.mission_create(
        { folder: repo.main, title: 'Planned', declaredEnd: END, sessionId: OWNER, steps: PLAN },
        ctxFor(repo.main)
      )
    )
    const { mission, raw } = await readMissionOnDisk(repo.main, created.missionId as string)
    expect(raw).toMatch(/^status: active$/m)
    expect(mission.status).toBe('active')
    expect(mission.declaredEndApproval).toEqual({
      at: mission.createdAt,
      bodyHash: declaredEndHash(END as Mission['declaredEnd']),
      via: 'chat'
    })
    expect(mission.steps).toHaveLength(PLAN.length + 1)
    expect(mission.steps.some((s) => s.kind === 'fixed-start')).toBe(false)
    expect(mission.steps.map((s) => [s.id, s.ordinal, s.kind, s.title, s.verification])).toEqual([
      ['stp-1', 1, 'custom', 'Build the core', 'verifier'],
      ['stp-2', 2, 'custom', 'Designer sign-off', 'human'],
      ['stp-3', 3, 'custom', 'Spec on disk', 'existence'],
      ['stp-4', 4, 'fixed-end', 'Delivered and verified', 'verifier']
    ])
    expect(created.steps).toEqual(mission.steps)
  })

  it('(a) without steps the mission is just its end — stp-1 is the fixed end', async () => {
    const { missionId } = await createMission({ steps: undefined })
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(mission.steps.map((s) => [s.id, s.kind])).toEqual([['stp-1', 'fixed-end']])
    expect(mission.scope).toBeUndefined()
  })

  it('(b) steps declared at create carry no addedReason — they are the plan, not growth', async () => {
    const created = payloadOf(
      await handlers.mission_create(
        { folder: repo.main, title: 'Planned', declaredEnd: END, sessionId: OWNER, steps: PLAN },
        ctxFor(repo.main)
      )
    )
    const { mission } = await readMissionOnDisk(repo.main, created.missionId as string)
    for (const s of mission.steps) expect(s.addedReason, s.id).toBeUndefined()
  })

  it('refuses a malformed plan and writes nothing', async () => {
    for (const steps of [
      'one step',
      [{ title: '', verification: 'verifier' }],
      [{ title: 'x', verification: 'operator' }],
      [{ verification: 'verifier' }],
      Array.from({ length: 51 }, (_, i) => ({ title: `s${i}`, verification: 'verifier' }))
    ]) {
      const res = await handlers.mission_create(
        { folder: repo.main, title: 'Bad plan', declaredEnd: END, sessionId: OWNER, steps },
        ctxFor(repo.main)
      )
      expect(errText(res), JSON.stringify(steps).slice(0, 60)).toMatch(/^BAD_ARGS: steps/)
    }
    expect(await missionFiles(repo.main)).toEqual([])
  })

  it('stores scope on the mission, never as a step (§3.3)', async () => {
    await fs.mkdir(path.join(repo.main, 'docs'), { recursive: true })
    await fs.writeFile(path.join(repo.main, 'docs', 'spec.md'), '# spec', 'utf8')
    const created = payloadOf(
      await handlers.mission_create(
        {
          folder: repo.main,
          title: 'S',
          declaredEnd: END,
          sessionId: OWNER,
          scope: ['docs/spec.md']
        },
        ctxFor(repo.main)
      )
    )
    const { mission } = await readMissionOnDisk(repo.main, created.missionId as string)
    expect(mission.scope).toEqual([{ kind: 'worktree', ref: 'docs/spec.md' }])
    expect(mission.steps.flatMap((s) => s.links)).toEqual([])
  })

  it('catalog: steps is an optional array of { title, verification }', () => {
    const schema = toolByName('mission_create')!.inputSchema
    const base = { folder: repo.main, title: 't', declaredEnd: END, sessionId: OWNER }
    expect(schema.safeParse({ ...base, steps: PLAN }).success).toBe(true)
    expect(schema.safeParse({ ...base, steps: [{ title: 'x' }] }).success).toBe(false)
    expect(toolByName('mission_create')!.description).not.toMatch(/born `draft`/)
  })
})

describe('Mission v3 — mission_add_step before and after the start (spec §3.4, §3.9)', () => {
  const add = (missionId: string, extra: Record<string, unknown> = {}): Promise<ToolResult> =>
    handlers.mission_add_step(
      { folder: repo.main, missionId, title: 'Step', verification: 'verifier', ...extra },
      ctxFor(repo.main)
    )

  it('(c) needs no reason before the start, is refused REASON_REQUIRED after a child link, and stamps addedAt', async () => {
    const { missionId } = await createMission()
    const first = payloadOf(await add(missionId, { reason: 'ignored before the start' }))
    let { mission } = await readMissionOnDisk(repo.main, missionId)
    const planned = mission.steps.find((s) => s.id === first.stepId)!
    expect(Number.isFinite(Date.parse(planned.addedAt ?? ''))).toBe(true)
    // Before the start, no "total changed" marker: no addedReason even when one is passed.
    expect(planned.addedReason).toBeUndefined()

    payloadOf(
      await handlers.mission_link_child(
        {
          folder: repo.main,
          missionId,
          stepId: first.stepId,
          link: { kind: 'session', ref: CHILD }
        },
        ctxFor(repo.main)
      )
    )
    expect(errText(await add(missionId))).toMatch(/^REASON_REQUIRED/)
    const late = payloadOf(await add(missionId, { reason: 'review found a gap' }))
    ;({ mission } = await readMissionOnDisk(repo.main, missionId))
    const added = mission.steps.find((s) => s.id === late.stepId)!
    expect(added.addedReason).toBe('review found a gap')
    expect(Number.isFinite(Date.parse(added.addedAt ?? ''))).toBe(true)
  })

  it('a claimed proof starts the mission too', async () => {
    const { missionId } = await createMission()
    const first = payloadOf(await add(missionId))
    payloadOf(
      await handlers.mission_update_step(
        { folder: repo.main, missionId, stepId: first.stepId, set: { proof: 'claimed' } },
        ctxFor(repo.main)
      )
    )
    expect(errText(await add(missionId))).toMatch(/^REASON_REQUIRED/)
  })

  it('a legacy fixed start with scope links is not a start', async () => {
    const { missionId } = await createMission()
    await mutateStored(repo.main, missionId, (m) => {
      m.steps.unshift({
        id: 'stp-9',
        ordinal: 0,
        kind: 'fixed-start',
        title: 'Scope confirmed',
        verification: 'existence',
        proof: 'unproven',
        links: [{ kind: 'worktree', ref: 'docs/spec.md' }],
        blockers: []
      })
      return m
    })
    payloadOf(await add(missionId))
  })

  it('accepts links, so a step is born provable', async () => {
    const { missionId } = await createMission()
    const links = [
      { kind: 'pr', ref: 'owner/repo#12' },
      { kind: 'worktree', ref: 'docs/spec.md' },
      { kind: 'card', ref: 'T1-thing' }
    ]
    const p = payloadOf(await add(missionId, { verification: 'existence', links }))
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(mission.steps.find((s) => s.id === p.stepId)!.links).toEqual(links)
    expect(
      errText(await add(missionId, { links: [{ kind: 'session', ref: 'synthetic-1' }] }))
    ).toMatch(/^BAD_SESSION_ID/)
    expect(errText(await add(missionId, { links: [{ kind: 'file', ref: 'x' }] }))).toMatch(
      /^BAD_ARGS: links/
    )
  })

  it('catalog: links is optional; the reason is described as needed once started', () => {
    const def = toolByName('mission_add_step')!
    const base = {
      folder: repo.main,
      missionId: 'mnt-0000abcd',
      title: 't',
      verification: 'verifier'
    }
    expect(def.inputSchema.safeParse({ ...base, links: [{ kind: 'pr', ref: '#1' }] }).success).toBe(
      true
    )
    expect(def.description).toMatch(/started/i)
    expect(def.description).not.toMatch(/left `draft`/)
  })
})

describe('Mission v3 — mission_link_child { scope: true } (spec §3.3)', () => {
  const linkScope = (
    missionId: string,
    ref: string,
    extra: Record<string, unknown> = {}
  ): Promise<ToolResult> =>
    handlers.mission_link_child(
      { folder: repo.main, missionId, scope: true, link: { kind: 'worktree', ref }, ...extra },
      ctxFor(repo.main)
    )

  it('(d) appends a contained path to mission.scope, stored repo-relative, idempotently', async () => {
    const { missionId } = await createMission({ scope: ['docs/spec.md'] })
    const ack = payloadOf(await linkScope(missionId, path.join(repo.main, 'docs', 'prd.md')))
    payloadOf(await linkScope(missionId, 'docs/prd.md'))
    expect(ack).toEqual({
      ok: true,
      op: 'mission_link_child',
      scope: [
        { kind: 'worktree', ref: 'docs/spec.md' },
        { kind: 'worktree', ref: 'docs/prd.md' }
      ]
    })
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(mission.scope).toEqual(ack.scope)
    expect(mission.steps.flatMap((s) => s.links)).toEqual([])
  })

  it.each([
    ['.git', '.git', /\.git, \.harnu or \.capy/],
    ['an outside path', '/etc/hostname', /outside this repo/],
    ['a parent escape', '../x.md', /outside this repo/]
  ])('(d) refuses %s with BAD_SCOPE_PATH and stores nothing', async (_l, ref, why) => {
    const { missionId } = await createMission()
    const text = errText(await linkScope(missionId, ref))
    expect(text).toMatch(/^BAD_SCOPE_PATH: /)
    expect(text).toMatch(why)
    expect((await readMissionOnDisk(repo.main, missionId)).mission.scope).toBeUndefined()
  })

  it('refuses scope with a stepId, a non-path link, and a missing stepId without scope', async () => {
    const { missionId } = await createMission()
    expect(errText(await linkScope(missionId, 'docs/a.md', { stepId: 'stp-1' }))).toMatch(
      /^BAD_ARGS/
    )
    expect(
      errText(
        await handlers.mission_link_child(
          { folder: repo.main, missionId, scope: true, link: { kind: 'pr', ref: '#1' } },
          ctxFor(repo.main)
        )
      )
    ).toMatch(/^BAD_ARGS: a scope link is a path/)
    expect(
      errText(
        await handlers.mission_link_child(
          { folder: repo.main, missionId, link: { kind: 'pr', ref: '#1' } },
          ctxFor(repo.main)
        )
      )
    ).toMatch(/^BAD_ARGS: stepId is required/)
  })

  it('on a legacy mission the first scope link keeps the fixed start links as scope', async () => {
    const { missionId } = await createMission()
    await mutateStored(repo.main, missionId, (m) => {
      m.steps.unshift({
        id: 'stp-9',
        ordinal: 0,
        kind: 'fixed-start',
        title: 'Scope confirmed',
        verification: 'existence',
        proof: 'unproven',
        links: [{ kind: 'worktree', ref: 'docs/old.md' }],
        blockers: []
      })
      return m
    })
    const ack = payloadOf(await linkScope(missionId, 'docs/new.md'))
    expect(ack.scope).toEqual([
      { kind: 'worktree', ref: 'docs/old.md' },
      { kind: 'worktree', ref: 'docs/new.md' }
    ])
  })

  it('catalog: stepId is optional and scope is a boolean', () => {
    const schema = toolByName('mission_link_child')!.inputSchema
    const base = {
      folder: repo.main,
      missionId: 'mnt-0000abcd',
      link: { kind: 'worktree', ref: 'docs/a.md' }
    }
    expect(schema.safeParse({ ...base, scope: true }).success).toBe(true)
    expect(schema.safeParse({ ...base, stepId: 'stp-1' }).success).toBe(true)
  })
})

// ---- Mission v3 Task 1.5 — human checks (spec §3.6) --------------------------

describe('Mission v3 — mission_add_check and needs-human checks (spec §3.6)', () => {
  const VERIFIER_ID = 'cccccccc-dddd-4eee-8fff-000000000000'
  const addCheck = (missionId: string, stepId: string, label: string): Promise<ToolResult> =>
    handlers.mission_add_check({ folder: repo.main, missionId, stepId, label }, ctxFor(repo.main))
  const verify = (
    missionId: string,
    stepId: string,
    verdict: string,
    evidence: string,
    extra: Record<string, unknown> = {}
  ): Promise<ToolResult> =>
    handlers.mission_verify_step(
      { folder: repo.main, missionId, stepId, verdict, evidence, sessionId: VERIFIER_ID, ...extra },
      ctxFor(repo.main)
    )
  const plan = { steps: [{ title: 'Build the section', verification: 'verifier' }] }

  it('catalog: mission_add_check is a free-running mutation with no ticked field', () => {
    const def = toolByName('mission_add_check')!
    expect(def.op).toBe('mission_add_check')
    expect(def.mutates).toBe(true)
    expect(def.silentAllowInAgentFolder).toBe(true)
    expect(def.description).toMatch(/only the operator/i)
    const base = { folder: repo.main, missionId: 'mnt-0000abcd', stepId: 'stp-1', label: 'DSQA' }
    expect(def.inputSchema.safeParse(base).success).toBe(true)
    expect(def.inputSchema.safeParse({ ...base, label: '' }).success).toBe(false)
    expect(def.inputSchema.safeParse({ ...base, label: 'x'.repeat(201) }).success).toBe(false)
  })

  it('(a) the agent verb adds a check with source agent', async () => {
    const { missionId } = await createMission(plan)
    const ack = payloadOf(await addCheck(missionId, 'stp-1', 'DSQA done'))
    expect(ack).toEqual({
      ok: true,
      op: 'mission_add_check',
      stepId: 'stp-1',
      checks: [{ id: 'chk-1', label: 'DSQA done', source: 'agent', createdAt: expect.any(String) }]
    })
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(mission.steps[0].checks).toEqual(ack.checks)
  })

  it('(b) the same label in another case is stored once, says deduped, and writes nothing', async () => {
    const { missionId } = await createMission(plan)
    const first = payloadOf(await addCheck(missionId, 'stp-1', 'Designer sign-off'))
    expect(first).not.toHaveProperty('deduped')
    const before = (await readMissionOnDisk(repo.main, missionId)).raw
    const ack = payloadOf(await addCheck(missionId, 'stp-1', 'designer SIGN-OFF'))
    expect((ack.checks as unknown[]).length).toBe(1)
    expect(ack.deduped).toBe(true)
    // No write: the file (and so updatedAt, the stall rule's evidence) is untouched.
    expect((await readMissionOnDisk(repo.main, missionId)).raw).toBe(before)
  })

  it('refuses an unknown step, a blank label and a closed mission', async () => {
    const { missionId } = await createMission(plan)
    expect(errText(await addCheck(missionId, 'stp-9', 'x'))).toMatch(/^STEP_NOT_FOUND/)
    expect(errText(await addCheck(missionId, 'stp-1', '   '))).toMatch(/^BAD_ARGS/)
    await setStoredStatus(repo.main, missionId, 'closed')
    expect(errText(await addCheck(missionId, 'stp-1', 'x'))).toMatch(/^MISSION_CLOSED/)
  })

  it('(c) needs-human: the step reads done and the verifier check exists (checkLabel)', async () => {
    const { missionId } = await createMission(plan)
    payloadOf(
      await handlers.mission_link_child(
        { folder: repo.main, missionId, stepId: 'stp-1', link: { kind: 'session', ref: CHILD } },
        ctxFor(repo.main)
      )
    )
    const ack = payloadOf(
      await verify(missionId, 'stp-1', 'needs-human', 'tests green; visual left', {
        checkLabel: 'Validated visually'
      })
    )
    expect(ack).toMatchObject({ verdict: 'needs-human', proof: 'verified' })
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    const step = mission.steps[0]
    expect(step.checks).toEqual([
      {
        id: 'chk-1',
        label: 'Validated visually',
        source: 'verifier',
        createdAt: expect.any(String)
      }
    ])
    expect(step.verifiedBy?.verdict).toBe('needs-human')
    expect(computeProgress(mission, [], Date.now()).states['stp-1']).toBe('done')
  })

  it('(c) without checkLabel the check is the first line of the evidence, deduped against an agent check', async () => {
    const { missionId } = await createMission(plan)
    payloadOf(await addCheck(missionId, 'stp-1', 'dsqa on the hero'))
    payloadOf(await verify(missionId, 'stp-1', 'needs-human', 'DSQA on the hero\nall else met'))
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(mission.steps[0].checks).toEqual([
      { id: 'chk-1', label: 'dsqa on the hero', source: 'agent', createdAt: expect.any(String) }
    ])
    expect(computeProgress(mission, [], Date.now()).states['stp-1']).toBe('done')
  })

  it('(d) a later met verification leaves the human check open', async () => {
    const { missionId } = await createMission(plan)
    payloadOf(await verify(missionId, 'stp-1', 'needs-human', 'Designer sign-off'))
    payloadOf(await verify(missionId, 'stp-1', 'met', 'all met now'))
    const { mission } = await readMissionOnDisk(repo.main, missionId)
    expect(mission.steps[0].checks).toHaveLength(1)
    expect(mission.steps[0].checks![0].ticked).toBeUndefined()
  })

  it('catalog: verify_step takes checkLabel; no mission_* input schema can write ticked (e)', () => {
    const verifyDef = toolByName('mission_verify_step')!
    expect(
      verifyDef.inputSchema.safeParse({
        folder: repo.main,
        missionId: 'mnt-0000abcd',
        stepId: 'stp-1',
        verdict: 'needs-human',
        evidence: 'e',
        sessionId: OWNER,
        checkLabel: 'Validated visually'
      }).success
    ).toBe(true)
    for (const def of MCP_TOOLS.filter((t) => t.name.startsWith('mission_'))) {
      const json = JSON.stringify(z.toJSONSchema(def.inputSchema, { unrepresentable: 'any' }))
      expect(json, def.name).not.toMatch(/"ticked"/)
    }
    // (f) the agent has no door to tick or delete a check.
    expect(
      MCP_TOOLS.map((t) => t.name).filter((n) => /tick|delete_check|remove_check/.test(n))
    ).toEqual([])
  })
})

// ---- Mission v3 Task 1.7 — the you list, progress on mission_get / mission_list --

describe('Mission v3 — the you list and server-side progress (spec §3.1, §3.10, §3.12)', () => {
  const get = async (missionId: string): Promise<Record<string, unknown>> =>
    payloadOf(await handlers.mission_get({ folder: repo.main, missionId }, ctxFor(repo.main)))
  const call = (op: string, args: Record<string, unknown>): Promise<ToolResult> =>
    handlers[op]({ folder: repo.main, ...args }, ctxFor(repo.main))

  it('(a) an operator blocker, 2 due checks and an unticked current human step → three items, in order', async () => {
    const { missionId } = await createMission({
      steps: [
        { title: 'Build A', verification: 'verifier' },
        { title: 'Build B', verification: 'verifier' },
        { title: 'Designer approval', verification: 'human' }
      ]
    })
    for (const stepId of ['stp-1', 'stp-2']) {
      payloadOf(await call('mission_update_step', { missionId, stepId, set: { proof: 'claimed' } }))
      payloadOf(await call('mission_add_check', { missionId, stepId, label: `DSQA ${stepId}` }))
    }
    // A check on a step not reached yet is not due.
    payloadOf(await call('mission_add_check', { missionId, stepId: 'stp-4', label: 'not yet' }))
    payloadOf(
      await call('mission_set_blocker', {
        missionId,
        reason: 'needs the API key',
        unblocks: 'the key is in the vault',
        owner: 'operator'
      })
    )
    const got = await get(missionId)
    expect(got.youItems).toEqual([
      { kind: 'blocker', reason: 'needs the API key', unblocks: 'the key is in the vault' },
      { kind: 'checks', count: 2, stepIds: ['stp-1', 'stp-2'] },
      { kind: 'human-steps', stepIds: ['stp-3'] }
    ])
    expect(got.you).toBe(
      'Unblock: needs the API key — unblocks when the key is in the vault. (+2 more)'
    )
  })

  it('orders every kind as the spec lists them, and a ticked check or human step is no longer owed', async () => {
    const { missionId } = await createMission({
      steps: [{ title: 'Sign-off', verification: 'human' }]
    })
    await mutateStored(repo.main, missionId, (m) => {
      m.pendingRescope = { kind: 'other', target: 'new end', evidence: 'e' }
      m.pendingClose = { at: 't', requestedBy: OWNER }
      m.legacy = { source: '/x.md', sha256: 'sha256:0', needsReview: ['declaredEnd'] }
      return m
    })
    const kinds = ((await get(missionId)).youItems as Array<{ kind: string }>).map((i) => i.kind)
    expect(kinds).toEqual(['rescope', 'close', 'human-steps', 'review-import'])
    await mutateStored(repo.main, missionId, (m) => {
      m.steps[0].proof = 'verified'
      m.steps[0].verifiedBy = { sessionId: 'operator', at: 't', verdict: 'met' }
      return m
    })
    const after = ((await get(missionId)).youItems as Array<{ kind: string }>).map((i) => i.kind)
    expect(after).toEqual(['rescope', 'close', 'review-import'])
  })

  it('Delta 1: a claimed human step stays owed past the current step, until the operator ticks it', async () => {
    const { missionId } = await createMission({
      steps: [
        { title: 'Designer approval', verification: 'human' },
        { title: 'Build', verification: 'verifier' }
      ]
    })
    // The owner claims the human gate, then a LATER step starts running.
    payloadOf(
      await call('mission_update_step', { missionId, stepId: 'stp-1', set: { proof: 'claimed' } })
    )
    payloadOf(
      await call('mission_link_child', {
        missionId,
        stepId: 'stp-2',
        link: { kind: 'session', ref: CHILD }
      })
    )
    const { youItems } = await import('../src/main/mcp/tool-handlers')
    const mission = (await readMissionOnDisk(repo.main, missionId)).mission
    const running = [
      {
        stepId: 'stp-2',
        children: [{ sessionId: CHILD, taskState: 'working' as const }],
        existenceProven: false
      }
    ]
    const progress = computeProgress(mission, running, Date.now())
    expect(progress.states).toMatchObject({ 'stp-1': 'done', 'stp-2': 'running' })
    expect(progress.current).toEqual({ from: 2, to: 2 }) // the claimed gate is neither current nor left behind
    expect(youItems(mission, [], progress)).toEqual([{ kind: 'human-steps', stepIds: ['stp-1'] }])
    // Only the operator door clears it.
    const ticked = applyOperatorVerifyStep(mission, 'stp-1', { at: 't', verified: true })
    expect(youItems(ticked, [], computeProgress(ticked, running, Date.now()))).toEqual([])
    // An unreached human step (nothing before it done, a later one not started) is not owed yet.
    const fresh = (
      await readMissionOnDisk(
        repo.main,
        (
          await createMission({
            steps: [
              { title: 'G', verification: 'human' },
              { title: 'B', verification: 'verifier' }
            ]
          })
        ).missionId
      )
    ).mission
    fresh.steps[0].proof = 'unproven'
    const fp = computeProgress(fresh, [], Date.now())
    expect(fp.current).toEqual({ from: 1, to: 1 })
  })

  it('(a) all eight kinds, in the spec order — children last', async () => {
    const { youItems, youLine } = await import('../src/main/mcp/tool-handlers')
    const { missionId } = await createMission({
      steps: [
        { title: 'Build', verification: 'verifier' },
        { title: 'Approval', verification: 'human' }
      ]
    })
    payloadOf(
      await call('mission_update_step', { missionId, stepId: 'stp-1', set: { proof: 'claimed' } })
    )
    payloadOf(await call('mission_add_check', { missionId, stepId: 'stp-1', label: 'DSQA' }))
    payloadOf(
      await call('mission_set_blocker', {
        missionId,
        reason: 'r',
        unblocks: 'u',
        owner: 'operator'
      })
    )
    await mutateStored(repo.main, missionId, (m) => {
      m.pendingRescope = { kind: 'other', target: 'new end', evidence: 'e' }
      m.pendingClose = { at: 't', requestedBy: OWNER }
      m.legacy = { source: '/x.md', sha256: 'sha256:0', needsReview: ['declaredEnd'] }
      return m
    })
    const mission = (await readMissionOnDisk(repo.main, missionId)).mission
    const progress = computeProgress(mission, [], Date.now())
    const child = (sessionId: string, extra: Record<string, unknown>): never =>
      ({ sessionId, known: true, pendingApprovals: 0, ...extra }) as never
    const items = youItems(
      mission,
      [child(CHILD, { taskState: 'needs-input' }), child(OWNER, { pendingApprovals: 2 })],
      progress
    )
    expect(items.map((i) => i.kind)).toEqual([
      'rescope',
      'close',
      'blocker',
      'checks',
      'human-steps',
      'review-import',
      'approvals',
      'needs-input'
    ])
    expect(items[6]).toEqual({ kind: 'approvals', count: 2, sessionId: OWNER })
    expect(items[7]).toEqual({ kind: 'needs-input', sessionId: CHILD })
    expect(youLine(items)).toMatch(/^Approve the new declared end .* \(\+7 more\)$/)
    expect(youItems({ ...mission, status: 'closed' }, [], progress)).toEqual([])
  })

  it('(b) a dead legacy draft owes nothing — no you item, no cue source (Review Focus)', async () => {
    const { missionId } = await createMission()
    await mutateStored(repo.main, missionId, (m) => ({
      ...m,
      status: 'draft',
      updatedAt: '2026-09-01T00:00:00.000Z',
      createdAt: '2026-09-01T00:00:00.000Z'
    }))
    const got = await get(missionId)
    expect((got.mission as Mission).status).toBe('active')
    expect((got.derived as { stale: boolean }).stale).toBe(true)
    expect(got.youItems).toEqual([])
    expect(got.you).toBe("— nothing, you're clear")
  })

  it('(c) mission_list rows carry progress from the last derive — null before any', async () => {
    const { missionId } = await createMission()
    const list = async (): Promise<Array<Record<string, unknown>>> =>
      payloadOf(await handlers.mission_list({ folder: repo.main }, ctxFor(repo.main)))
        .missions as Array<Record<string, unknown>>
    expect((await list())[0].progress).toBeNull()
    const got = await get(missionId)
    const row = (await list())[0]
    expect(row.progress).toEqual((got.derived as { progress: unknown }).progress)
    // The deprecated counts exclude a legacy fixed start.
    expect(row.steps).toEqual({ total: 2, verified: 0, claimed: 0 })
  })

  it('(d) derived.progress equals computeProgress over the same stored steps and live signals', async () => {
    const { missionId } = await createMission({
      steps: [
        { title: 'A', verification: 'verifier' },
        { title: 'B', verification: 'verifier' }
      ]
    })
    payloadOf(
      await call('mission_update_step', { missionId, stepId: 'stp-2', set: { proof: 'claimed' } })
    )
    const got = await get(missionId)
    const derived = got.derived as {
      computedAt: string
      progress: unknown
      steps: Array<{
        stepId: string
        children: Array<{ sessionId: string; taskState?: string }>
        existence: { proven: boolean } | null
      }>
    }
    const expected = computeProgress(
      got.mission as Mission,
      derived.steps.map((s) => ({
        stepId: s.stepId,
        children: s.children.map((c) => ({
          sessionId: c.sessionId,
          taskState: c.taskState as never
        })),
        existenceProven: s.existence?.proven === true
      })),
      Date.parse(derived.computedAt)
    )
    expect(derived.progress).toEqual(expected)
    expect(expected).toMatchObject({ current: { from: 3, to: 3 }, leftBehind: ['stp-1'] })
  })

  it('(d) unprovable lists a reached existence step with no resolvable link (§3.9)', async () => {
    const { missionId } = await createMission({
      steps: [
        { title: 'Spec on disk', verification: 'existence' },
        { title: 'Build', verification: 'verifier' }
      ]
    })
    payloadOf(
      await call('mission_update_step', { missionId, stepId: 'stp-2', set: { proof: 'claimed' } })
    )
    const p = ((await get(missionId)).derived as { progress: { unprovable: string[] } }).progress
    expect(p.unprovable).toEqual(['stp-1'])
  })
})
