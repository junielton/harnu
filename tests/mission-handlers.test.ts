/**
 * T358 S3 — the core `mission_*` verb catalog (design `docs/specs/2026-09-26-mission-progress/design.md`
 * §4), as it stands after Missions v4 S-40: every `mission_*` verb is v4-shaped. The six verbs only v3 had
 * (`mission_link_child`, `mission_set_end`, `mission_verify_step`, `mission_add_check`,
 * `mission_transfer_owner`, `mission_import_legacy`), the v3 handlers and the operator doors they staged for
 * are gone; what each remaining verb returns is pinned, one call per verb, in
 * `tests/mission-verbs-contract.test.ts`, and its rules in the `mission-verbs-*` suites.
 *
 * Two layers are pinned here:
 *  - the CATALOG entries (name, `mutates`, gate fields, input schema) — the contract half of AC-S3-1;
 *  - the HANDLERS against a real temp filesystem (`tool-handlers.ts` is an env-bound shell, so it is driven
 *    directly with electron mocked, the same way tests/mcp-update-worker-handler.test.ts drives the worker
 *    verbs): which repo a call lands in, and which folders it refuses.
 *
 * Missions are repo-scoped (design §9, decision 17): every handler resolves the MAIN checkout from the
 * `folder` it is given, so a fake git layout (a main checkout with a `.git` dir, a linked worktree with a
 * `.git` file) is enough to prove a worktree call lands in the main checkout's `.harnu/missions-v4/`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import { MCP_TOOLS, toolByName } from '../src/main/mcp/tool-catalog'
import { buildV3MissionFile, v3MissionObject, v3MissionPath } from './helpers/v3-mission-file'

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
  expect(res.isError, res.content[0]?.text).not.toBe(true)
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

const v4Dir = (root: string): string => path.join(root, '.harnu', 'missions-v4')

/** The v4 record files of a repo, by name. */
async function missionFiles(root: string): Promise<string[]> {
  try {
    return (await fs.readdir(v4Dir(root))).filter((n) => n.endsWith('.md'))
  } catch {
    return []
  }
}

/** Every record file of a repo with its bytes: to prove a refusal wrote nothing. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of await missionFiles(root)) {
    out[name] = await fs.readFile(path.join(v4Dir(root), name), 'utf8')
  }
  return out
}

let handlers: Record<string, Handler>
let repo: { main: string; worktree: string }

beforeEach(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-mission-ud-'))
  repo = await fakeRepo()
  handlers = await loadHandlers()
})

/** A v4 mission with two steps, one criterion each: the layout the verb tests below address. */
async function createMission(
  extra: Record<string, unknown> = {},
  folder = repo.main
): Promise<{ id: string }> {
  const res = await handlers.mission_create(
    {
      folder,
      title: 'Ship the verb catalog',
      doneWhen: 'Every mission verb answers in the v4 shape',
      sessionId: OWNER,
      steps: [
        { title: 'Spec on disk', criteria: [{ text: 'The spec is committed' }] },
        { title: 'Verbs wired', criteria: [{ text: 'Every verb answers' }] }
      ],
      ...extra
    },
    ctxFor(folder)
  )
  return { id: payloadOf(res).id as string }
}

// ---- AC-S3-1 — catalog contract (design.md §4 table) ------------------------

describe('mission_* catalog entries (design §4)', () => {
  /** The fate table's `mission_*` verbs and whether each writes. */
  const expected: Record<string, { mutates: boolean }> = {
    mission_create: { mutates: true },
    mission_get: { mutates: false },
    mission_list: { mutates: false },
    mission_add_step: { mutates: true },
    mission_update_step: { mutates: true },
    mission_log: { mutates: true },
    mission_set_blocker: { mutates: true },
    mission_clear_blocker: { mutates: true },
    mission_request_close: { mutates: true },
    // Missions v4 S-24: the verbs that exist in v4 alone (their own suites: mission-verbs-dual and
    // mission-verbs-contract).
    mission_add_milestone: { mutates: true },
    mission_add_ac: { mutates: true },
    mission_link: { mutates: true },
    mission_set_done_when: { mutates: true },
    mission_settle_ac: { mutates: true },
    mission_attach: { mutates: true }
  }

  it('declares exactly the fate table’s verbs, each op matching its name', () => {
    const names = MCP_TOOLS.map((t) => t.name).filter((n) => n.startsWith('mission_'))
    expect(names.sort()).toEqual(Object.keys(expected).sort())
    for (const name of names) expect(toolByName(name)?.op).toBe(name)
  })

  it('the six verbs only v3 had are not in the catalog', () => {
    for (const name of [
      'mission_link_child',
      'mission_set_end',
      'mission_verify_step',
      'mission_add_check',
      'mission_transfer_owner',
      'mission_import_legacy'
    ]) {
      expect(toolByName(name), name).toBeUndefined()
      expect(handlers[name], name).toBeUndefined()
    }
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
    for (const name of ['mission_create', 'mission_get']) {
      const shape = (toolByName(name)!.inputSchema as unknown as z.ZodObject).shape
      const text = (shape.sessionId as z.ZodType).description ?? ''
      expect(text, name).toMatch(/self-declared/i)
      expect(text, name).toMatch(/not authenticated|unauthenticated/i)
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

// ---- mission_create -------------------------------------------------------------

describe('mission_create', () => {
  it('catalog: mutating, runs free like create_card, and says what it refuses of the v3 shape', () => {
    const def = toolByName('mission_create')!
    expect(def.op).toBe('mission_create')
    expect(def.mutates).toBe(true)
    expect(def.silentAllowInAgentFolder).toBe(true)
    expect(def.grantable).toBeUndefined()
    expect(def.alwaysAllowable).toBeUndefined()
    expect(def.description).toMatch(/declaredEnd/)
    expect(def.description).toMatch(/refused and nothing is written/)
  })

  it('catalog: the schema asks for a Done when and steps with criteria, and takes no v3 declared end', () => {
    const schema = toolByName('mission_create')!.inputSchema
    const base = {
      folder: repo.main,
      title: 't',
      doneWhen: 'It ships',
      sessionId: OWNER,
      steps: [{ title: 's', criteria: [{ text: 'c' }] }]
    }
    expect(schema.safeParse(base).success).toBe(true)
    const { doneWhen: _d, ...noDoneWhen } = base
    expect(schema.safeParse(noDoneWhen).success).toBe(false)
    expect(schema.safeParse({ ...base, doneWhen: '' }).success).toBe(false)
    const { title: _t, ...noTitle } = base
    expect(schema.safeParse(noTitle).success).toBe(false)
    expect(schema.safeParse({ ...base, steps: [{ title: 's' }] }).success).toBe(false)
    // The v3 shape — a declared end, a steward flag, a scope — is refused, never half read.
    for (const v3 of [
      { declaredEnd: { kind: 'code', target: 'x', evidence: 'y' } },
      { steward: false },
      { scope: [{ kind: 'doc', ref: 'spec.md' }] },
      { linkedCard: 'T1' }
    ]) {
      expect(schema.safeParse({ ...base, ...v3 }).success, JSON.stringify(v3)).toBe(false)
    }
  })

  it('writes one v4 record in the MAIN checkout, even when called from a worktree', async () => {
    const { id } = await createMission({}, repo.worktree)
    expect(id).toMatch(/^mnt-[0-9a-f]{8}$/)
    expect(await missionFiles(repo.main)).toHaveLength(1)
    expect((await missionFiles(repo.main))[0]).toMatch(new RegExp(`^${id}-`))
    expect(await missionFiles(repo.worktree)).toEqual([])
    // Nothing of the old v3 layout appears beside it.
    await expect(fs.stat(path.join(repo.main, '.harnu', 'missions'))).rejects.toThrow()
  })

  it('refuses a blocked folder, on the folder arg and on the resolved main root, and writes nothing', async () => {
    const args = {
      title: 'Blocked',
      doneWhen: 'It never lands',
      sessionId: OWNER,
      steps: [{ title: 's', criteria: [{ text: 'c' }] }]
    }
    expect(
      errText(
        await handlers.mission_create(
          { folder: repo.main, ...args },
          ctxFor(repo.main, [repo.main])
        )
      )
    ).toMatch(/^FOLDER_NOT_ALLOWED/)
    // A worktree whose main checkout is blocked resolves to a blocked root.
    expect(
      errText(
        await handlers.mission_create(
          { folder: repo.worktree, ...args },
          ctxFor(repo.worktree, [repo.main])
        )
      )
    ).toMatch(/^FOLDER_NOT_ALLOWED/)
    expect(await missionFiles(repo.main)).toEqual([])
  })

  it('refuses a step with no criterion and writes nothing', async () => {
    const res = await handlers.mission_create(
      {
        folder: repo.main,
        title: 'No criteria',
        doneWhen: 'x',
        sessionId: OWNER,
        steps: [{ title: 'A step nobody can settle', criteria: [] }]
      },
      ctxFor(repo.main)
    )
    expect(res.isError, res.content[0]?.text).toBe(true)
    expect(await missionFiles(repo.main)).toEqual([])
  })
})

// ---- mission_get / mission_list ---------------------------------------------------

describe('mission_get', () => {
  it('catalog: a read with no gate field', () => {
    const def = toolByName('mission_get')!
    expect(def.op).toBe('mission_get')
    expect(def.mutates).toBe(false)
    expect(def.silentAllowInAgentFolder).toBeUndefined()
    expect(def.disclosesTranscript).toBeUndefined()
    const schema = def.inputSchema
    expect(schema.safeParse({ folder: repo.main, missionId: 'mnt-0000abcd' }).success).toBe(true)
    expect(schema.safeParse({ folder: repo.main, sessionId: OWNER }).success).toBe(true)
  })

  it('reads a record from any worktree of the repo, by id or by the session that leads it', async () => {
    const { id } = await createMission()
    for (const sel of [{ missionId: id }, { sessionId: OWNER }]) {
      const p = payloadOf(
        await handlers.mission_get(
          { folder: repo.worktree, sessionId: OWNER, ...sel },
          ctxFor(repo.worktree)
        )
      )
      expect(p).toMatchObject({ ok: true, op: 'mission_get', id, source: 'v4', status: 'open' })
    }
  })

  it('reading writes nothing: the record is byte for byte as it was', async () => {
    const { id } = await createMission()
    const before = await snapshot(repo.main)
    payloadOf(
      await handlers.mission_get(
        { folder: repo.main, missionId: id, sessionId: OWNER },
        ctxFor(repo.main)
      )
    )
    expect(await snapshot(repo.main)).toEqual(before)
  })

  it('answers a mission that still lives in a v3 file, as a v3 source, and never rewrites it', async () => {
    const file = v3MissionPath(repo.main, 'mnt-0a1b2c3d', 'older')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      buildV3MissionFile(
        v3MissionObject(repo.main, {
          id: 'mnt-0a1b2c3d',
          slug: 'older',
          owner: { sessionId: OWNER, folder: repo.main }
        }),
        '# Older\n\n## Log\n'
      )
    )
    const before = await fs.readFile(file)
    const p = payloadOf(
      await handlers.mission_get(
        { folder: repo.main, missionId: 'mnt-0a1b2c3d', sessionId: OWNER },
        ctxFor(repo.main)
      )
    )
    expect(p).toMatchObject({ id: 'mnt-0a1b2c3d', source: 'v3-mission' })
    expect((await fs.readFile(file)).equals(before)).toBe(true)
    await expect(fs.stat(v4Dir(repo.main))).rejects.toThrow()
  })

  it('refuses an unknown id, a missing selector, and a blocked folder', async () => {
    const { id } = await createMission()
    expect(
      errText(
        await handlers.mission_get(
          { folder: repo.main, missionId: 'mnt-deadbeef', sessionId: OWNER },
          ctxFor(repo.main)
        )
      )
    ).toMatch(/^MISSION_NOT_FOUND/)
    expect(errText(await handlers.mission_get({ folder: repo.main }, ctxFor(repo.main)))).toMatch(
      /^BAD_ARGS/
    )
    expect(
      errText(
        await handlers.mission_get(
          { folder: repo.main, missionId: id, sessionId: OWNER },
          ctxFor(repo.main, [repo.main])
        )
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
    const { id } = await createMission()
    await createMission({ title: 'Elsewhere' }, other.main)

    const p = payloadOf(
      await handlers.mission_list({ folder: repo.worktree }, ctxFor(repo.worktree))
    )
    const rows = p.missions as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      title: 'Ship the verb catalog',
      leads: OWNER,
      format: 'v4'
    })
  })

  it('lists a mission that still lives in a v3 file, marked as such, beside the v4 ones', async () => {
    await createMission()
    const file = v3MissionPath(repo.main, 'mnt-0a1b2c3d', 'older')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      buildV3MissionFile(
        v3MissionObject(repo.main, {
          id: 'mnt-0a1b2c3d',
          slug: 'older',
          owner: { sessionId: CHILD, folder: repo.main }
        })
      )
    )
    const p = payloadOf(await handlers.mission_list({ folder: repo.main }, ctxFor(repo.main)))
    const rows = p.missions as Array<Record<string, unknown>>
    expect(rows.map((r) => [r.id === 'mnt-0a1b2c3d', r.format])).toEqual(
      expect.arrayContaining([
        [true, 'v3'],
        [false, 'v4']
      ])
    )
  })

  it('refuses a blocked folder outright', async () => {
    expect(
      errText(await handlers.mission_list({ folder: repo.main }, ctxFor(repo.main, [repo.main])))
    ).toMatch(/^FOLDER_NOT_ALLOWED/)
  })
})

// ---- the writing verbs refuse a blocked folder on both the folder arg and the resolved root ----

describe('the writing verbs refuse a blocked folder on the folder arg AND the resolved main root', () => {
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

  const WRITES: Record<string, (missionId: string) => Record<string, unknown>> = {
    mission_add_step: (missionId) => ({
      missionId,
      sessionId: OWNER,
      title: 'Another step',
      criteria: [{ text: 'It is done' }],
      reason: 'the plan grew'
    }),
    mission_log: (missionId) => ({
      missionId,
      sessionId: OWNER,
      kind: 'decision',
      note: 'One file per report'
    }),
    mission_set_blocker: (missionId) => ({
      missionId,
      sessionId: OWNER,
      reason: 'The key is missing from the vault',
      ask: 'Add the key',
      unblocks: 'the run can start',
      owner: 'operator'
    }),
    mission_clear_blocker: (missionId) => ({ missionId, sessionId: OWNER, blockerId: 'blk-1' }),
    mission_request_close: (missionId) => ({ missionId, sessionId: OWNER }),
    mission_add_milestone: (missionId) => ({ missionId, sessionId: OWNER, title: 'A milestone' }),
    mission_add_ac: (missionId) => ({
      missionId,
      sessionId: OWNER,
      stepId: 'stp-1',
      text: 'One more thing holds',
      by: 'operator'
    }),
    mission_link: (missionId) => ({
      missionId,
      sessionId: OWNER,
      stepId: 'stp-1',
      link: { kind: 'pr', ref: '12' }
    }),
    mission_set_done_when: (missionId) => ({
      missionId,
      sessionId: OWNER,
      doneWhen: 'A different end',
      reason: 'the end moved'
    })
  }

  for (const [op, argsFor] of Object.entries(WRITES)) {
    it(`${op}: a non-nested worktree of a blocked main checkout is refused, and nothing is written`, async () => {
      const wt = await outsideWorktree()
      const { id } = await createMission()
      // Precondition: the worktree really resolves to the main checkout's missions.
      payloadOf(
        await handlers.mission_get({ folder: wt, missionId: id, sessionId: OWNER }, ctxFor(wt))
      )
      expect(wt.startsWith(repo.main + path.sep)).toBe(false)
      const before = await snapshot(repo.main)

      const viaRoot = await handlers[op]({ folder: wt, ...argsFor(id) }, ctxFor(wt, [repo.main]))
      expect(errText(viaRoot)).toMatch(/^FOLDER_NOT_ALLOWED/)
      const viaFolder = await handlers[op]({ folder: wt, ...argsFor(id) }, ctxFor(wt, [wt]))
      expect(errText(viaFolder)).toMatch(/^FOLDER_NOT_ALLOWED/)
      expect(await snapshot(repo.main)).toEqual(before)
    })
  }
})
