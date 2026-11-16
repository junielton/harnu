/**
 * The `mission_*` CONTRACT suite (T358 decision 19 layer 1, rewritten for Missions v4 by S-40): every
 * verb's ACK checked, one call per verb, on a v4 mission.
 *
 * Why this is a vitest suite and not a `claude plugin eval` case: plugin evals start only the MCP
 * servers a plugin DECLARES, and Harnu's server is declared by no plugin; it is a loopback HTTP server
 * the running app hands each session through a per-spawn `--mcp-config` (port + bearer token). An eval
 * could only reach it through a mock, and a grader checking a mocked ACK checks the mock.
 *
 * What this suite exercises instead is the whole in-process call path a real call takes after the HTTP
 * transport, per verb:
 *   1. the catalog `inputSchema` (what the MCP SDK validates on the way in);
 *   2. the gate translation + validation (`buildPlanInput` -> `parseToolInput`);
 *   3. the handler wired in `WIRED_TOOLS` (the array `server.ts` registers);
 * and then checks the ACK against a schema written from the verb's contract.
 *
 * EXTENDING IT: add the new verb's row to `CONTRACT` (its ACK schema and a `call` that builds its args
 * from the scenario state), in the order it should run (and a `setup` when its success path needs
 * prior state). The coverage guard below fails until every `mission_*` op in `MCP_OPS` has a row, so a
 * verb cannot ship without its contract. A verb the catalog keeps but no slice built (`mission_update_step`)
 * has a row that asserts its refusal instead of an ACK.
 *
 * The last describe is AC-89's proof: the catalog is the fate table's sixteen verbs, no more.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import { MCP_OPS, toolByName, type McpOp } from '../src/main/mcp/tool-catalog'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { parseToolInput } from '../src/main/mcp/validate'
import {
  buildMissionRecordContent,
  parseMissionRecordFile,
  readMissionRecordLog
} from '../src/main/missions/model'

import type { StepInput } from '../src/main/missions/state'

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

// ---- the shapes the ACKs share ------------------------------------------------

const Headline = z.string().min(1)

/** Every ACK carries `ok: true` and its `op` (the convention all verbs share). */
function ack<T extends z.ZodRawShape>(op: McpOp, shape: T): z.ZodType {
  return z.object({ ok: z.literal(true), op: z.literal(op), ...shape })
}

// ---- the contract table (extend here) ----------------------------------------

interface ScenarioState {
  folder: string
  sessionId: string
  /** The v4 mission the rows run against (made by the first of them). */
  missionId?: string
  /** An agent-owned blocker raised by a setup, for `mission_clear_blocker`. */
  agentBlockerId?: string
  /** The second mission, led by CLOSER_ID, that the close request runs on. */
  closeMissionId?: string
}

interface ContractRow {
  op: McpOp
  /** The ACK, as a schema. */
  ack?: z.ZodType
  /** For a verb that is in the catalog but refuses by design: the refusal's text, and no ACK. */
  refuses?: RegExp
  /** The call's args, built from what earlier rows left in the state. */
  call: (s: ScenarioState) => Record<string, unknown>
  /** Pull what later rows need out of this row's ACK. */
  capture?: (ackPayload: Record<string, unknown>, s: ScenarioState) => void
  /**
   * Bring the scenario to the state this row's SUCCESS path needs, before the call: through the wired
   * handlers where a verb exists, and on disk only for a transition no verb makes (an operator door).
   */
  setup?: (s: ScenarioState) => Promise<void>
}

/** The id the contract's second session declares: not the leader, not a builder. */
const VERIFIER_ID = 'cccccccc-dddd-4eee-8fff-000000000000'
/** The leader of the second mission, the one a close is requested on. */
const CLOSER_ID = 'e1e1e1e1-2f2f-4000-8111-222222222222'
/** A session that asks to join. */
const JOINER_ID = 'dddddddd-eeee-4fff-8000-111111111111'

/** Call a wired handler outside a row (setup), failing loudly on a refusal. */
async function callOk(
  op: McpOp,
  s: ScenarioState,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await handlers[op](
    { folder: s.folder, missionId: s.missionId, ...args },
    { folder: s.folder, folders: [], denyFolders: [], bridge: undefined }
  )
  expect(res.isError, res.content[0]?.text).not.toBe(true)
  return JSON.parse(res.content[0].text!) as Record<string, unknown>
}

/** Attach a session to the scenario's mission on disk (the operator's door has no verb). */
async function attachOnDisk(s: ScenarioState, sessionId: string): Promise<void> {
  const dir = path.join(s.folder, '.harnu', 'missions-v4')
  const name = (await fs.readdir(dir)).find((n) => n.startsWith(`${s.missionId}-`))!
  const file = path.join(dir, name)
  const raw = await fs.readFile(file, 'utf8')
  const record = parseMissionRecordFile(raw)
  record.sessions.push({ id: sessionId, role: 'worked', from: '2026-11-15T09:00:00Z', to: null })
  await fs.writeFile(file, buildMissionRecordContent(record, readMissionRecordLog(raw)), 'utf8')
}

const CONTRACT: ContractRow[] = [
  {
    op: 'mission_create',
    ack: ack('mission_create', {
      id: z.string().regex(/^mnt-[0-9a-f]{8}$/),
      headline: Headline,
      summary: z.string().min(1),
      recall: z.array(z.unknown())
    }),
    call: (s) => ({
      folder: s.folder,
      sessionId: s.sessionId,
      title: 'Export the report as CSV',
      doneWhen: 'The CSV export is merged and a spreadsheet opens it',
      milestones: [{ title: 'Plan the work' }],
      steps: [
        {
          title: 'Add the CSV exporter',
          milestone: 'mls-1',
          criteria: [{ text: 'The export is reviewed by another session' }]
        }
      ]
    }),
    capture: (p, s) => {
      s.missionId = p.id as string
    }
  },
  {
    op: 'mission_add_milestone',
    ack: ack('mission_add_milestone', {
      milestoneId: z.literal('mls-2'),
      totalMilestones: z.literal(2)
    }),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      sessionId: s.sessionId,
      title: 'Ship the report'
    })
  },
  {
    op: 'mission_add_step',
    ack: ack('mission_add_step', {
      stepId: z.literal('stp-2'),
      totalSteps: z.literal(2)
    }),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      sessionId: s.sessionId,
      title: 'Document the export',
      milestone: 'mls-2',
      criteria: [{ text: 'The README names the export', fact: 'pr-merged' }],
      reason: 'the reviewer asked for docs',
      // A step can be born with its links.
      links: [{ kind: 'pr', ref: '12' }]
    })
  },
  {
    // Kept in the catalog, built by no slice: a call is refused and writes nothing.
    op: 'mission_update_step',
    refuses: /^NOT_AVAILABLE:/,
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      sessionId: s.sessionId,
      stepId: 'stp-1',
      set: { title: 'Export the report' }
    })
  },
  {
    op: 'mission_add_ac',
    ack: ack('mission_add_ac', {
      stepId: z.literal('stp-1'),
      criterionId: z.literal('ac-2'),
      totalCriteria: z.literal(2)
    }),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      sessionId: s.sessionId,
      stepId: 'stp-1',
      text: 'The export opens in a spreadsheet',
      by: 'operator'
    })
  },
  {
    op: 'mission_link',
    ack: ack('mission_link', {
      stepId: z.literal('stp-1'),
      link: z.object({ kind: z.literal('pr'), ref: z.string() }).passthrough(),
      added: z.literal(true)
    }),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      sessionId: s.sessionId,
      stepId: 'stp-1',
      link: { kind: 'pr', ref: '13' }
    })
  },
  {
    op: 'mission_log',
    ack: ack('mission_log', {}),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      sessionId: s.sessionId,
      stepId: 'stp-1',
      kind: 'decision',
      note: 'Export one file per report, not one per row'
    })
  },
  {
    op: 'mission_set_blocker',
    ack: ack('mission_set_blocker', { blockerId: z.string().regex(/^blk-\d+$/) }),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      sessionId: s.sessionId,
      reason: 'The STAGING_API_KEY is missing from the shared vault',
      ask: 'Add the staging key',
      unblocks: 'the export can run',
      owner: 'operator'
    })
  },
  {
    // An agent-owned blocker is the session's own to clear (an operator-owned one is refused
    // OPERATOR_ONLY, which the dual suite proves).
    op: 'mission_clear_blocker',
    ack: ack('mission_clear_blocker', {}),
    setup: async (s) => {
      const raised = await callOk('mission_set_blocker', s, {
        sessionId: s.sessionId,
        reason: 'The export waits on a second review of `export-name-rules.md`',
        ask: 'Review the file name rules',
        unblocks: 'the export is named',
        owner: 'agent'
      })
      s.agentBlockerId = raised.blockerId as string
    },
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      sessionId: s.sessionId,
      blockerId: s.agentBlockerId
    })
  },
  {
    op: 'mission_set_done_when',
    ack: ack('mission_set_done_when', {
      staged: z.object({
        text: z.string().min(1),
        reason: z.string().min(1),
        at: z.iso.datetime(),
        by: z.string().min(1)
      }),
      deduped: z.literal(false)
    }),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      sessionId: s.sessionId,
      doneWhen: 'A score report opens for every candidate',
      reason: 'The first Done when missed the report'
    })
  },
  {
    op: 'mission_settle_ac',
    // A second session (not the leader, not a builder) settles a criterion a session settles.
    ack: ack('mission_settle_ac', {
      outcome: z.literal('settled'),
      stepId: z.literal('stp-1'),
      criterionId: z.literal('ac-1')
    }),
    // The verifier has to be attached to write: the leader's own dispatch is not a verb, so the
    // contract attaches it the way the operator's door does, on disk.
    setup: async (s) => {
      await attachOnDisk(s, VERIFIER_ID)
    },
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      sessionId: VERIFIER_ID,
      stepId: 'stp-1',
      criterionId: 'ac-1',
      evidence: 'Opened the export and read every row'
    })
  },
  {
    op: 'mission_attach',
    ack: ack('mission_attach', {
      requestId: z.string().regex(/^atr-\d+$/),
      deduped: z.literal(false)
    }),
    call: (s) => ({ folder: s.folder, missionId: s.missionId, sessionId: JOINER_ID })
  },
  {
    op: 'mission_get',
    ack: ack('mission_get', {
      id: z.string().regex(/^mnt-[0-9a-f]{8}$/),
      title: z.string().min(1),
      doneWhen: z.string().min(1),
      source: z.literal('v4'),
      status: z.string(),
      steps: z.array(z.object({ id: z.string().regex(/^stp-\d+$/) }).passthrough()).min(2),
      milestones: z.array(z.object({ id: z.string().regex(/^mls-\d+$/) }).passthrough()).min(2),
      progress: z.object({ headline: Headline }).passthrough(),
      waiting: z.unknown(),
      summary: z.string().min(1)
    }),
    call: (s) => ({ folder: s.folder, missionId: s.missionId, sessionId: s.sessionId })
  },
  {
    op: 'mission_list',
    ack: ack('mission_list', {
      missions: z
        .array(
          z.object({
            id: z.string().regex(/^mnt-[0-9a-f]{8}$/),
            title: z.string().min(1),
            headline: Headline,
            leads: z.string(),
            format: z.enum(['v4', 'v3'])
          })
        )
        .min(1)
    }),
    call: (s) => ({ folder: s.folder, sessionId: s.sessionId })
  },
  {
    // Last: the close request needs every required step done, so it runs on a mission of its own
    // (a second leader), with the facts read on the server stubbed to a merged pull request.
    op: 'mission_request_close',
    ack: ack('mission_request_close', {
      closeRequested: z.object({ at: z.iso.datetime() }),
      deduped: z.literal(false)
    }),
    setup: async (s) => {
      const made = await callOk('mission_create', s, {
        missionId: undefined,
        sessionId: CLOSER_ID,
        title: 'Fix the date parser',
        doneWhen: 'The date parser fix is merged',
        steps: [
          {
            title: 'Fix the parser',
            criteria: [{ text: 'The pull request is merged', fact: 'pr-merged' }]
          }
        ]
      })
      s.closeMissionId = made.id as string
      setInputs(() => ({ 'stp-1': { pr: 'merged' } }))
    },
    call: (s) => ({ folder: s.folder, missionId: s.closeMissionId, sessionId: CLOSER_ID })
  }
]

// ---- the runner ---------------------------------------------------------------

type Handler = (
  args: Record<string, unknown>,
  ctx: Record<string, unknown>
) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>

let handlers: Record<string, Handler>
const state: ScenarioState = { folder: '', sessionId: '11111111-2222-4333-8444-555555555555' }
let setInputs: (fn: ((root: string) => Record<string, StepInput>) | null) => void
let detachedWorktree = ''

beforeAll(async () => {
  h.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-contract-ud-'))
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-contract-repo-'))
  await fs.mkdir(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true })
  await fs.writeFile(path.join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n', 'utf8')
  state.folder = repo
  // A linked worktree OUTSIDE the main checkout's tree: blocking the main checkout
  // does not block this path by prefix, only by what it resolves to.
  detachedWorktree = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'harnu-contract-wt-')), 'wt')
  await fs.mkdir(detachedWorktree)
  await fs.writeFile(
    path.join(detachedWorktree, '.git'),
    `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`,
    'utf8'
  )
  const mod = await import('../src/main/mcp/tool-handlers')
  handlers = Object.fromEntries(mod.WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
  // The facts a verb reads (card column, pull request, CI) are computed on the server; the contract
  // runs without `gh` or a board, so it replaces that gathering with an empty one.
  setInputs = (fn) => mod._setStepInputsForTest(fn ? async (root) => fn(root) : null)
  setInputs(() => ({}))
})

afterAll(async () => {
  setInputs(null)
  await fs.rm(h.userDataDir, { recursive: true, force: true })
})

describe('mission_* contract (design §4 ACKs, one call per verb)', () => {
  it('covers every mission_* op the catalog declares — add a CONTRACT row with each new verb', () => {
    const declared = MCP_OPS.filter((op) => op.startsWith('mission_'))
    expect(CONTRACT.map((r) => r.op).sort()).toEqual([...declared].sort())
  })

  // Sequential on purpose: later rows address the mission/step earlier rows made.
  for (const row of CONTRACT) {
    it(`${row.op}: the call passes schema + gate and its ACK matches design §4`, async () => {
      const def = toolByName(row.op)!
      await row.setup?.(state)
      const raw = row.call(state)
      // 1. what the MCP SDK validates on the way in
      const input = def.inputSchema.parse(raw) as Record<string, unknown>
      // 2. the gate's translation + structural validation (server.ts plucks the folder)
      const gateFolder = typeof input.folder === 'string' ? input.folder : undefined
      const gate = parseToolInput(row.op, buildPlanInput(row.op, input, gateFolder))
      expect(gate.ok, JSON.stringify(gate)).toBe(true)
      // 3. the wired handler
      const res = await handlers[row.op](input, {
        folder: gateFolder ?? '',
        folders: [],
        denyFolders: [],
        bridge: undefined
      })
      if (row.refuses) {
        expect(res.isError, res.content[0]?.text).toBe(true)
        expect(res.content[0]?.text).toMatch(row.refuses)
        return
      }
      expect(res.isError, res.content[0]?.text).not.toBe(true)
      const payload = JSON.parse(res.content[0].text!) as Record<string, unknown>
      const checked = row.ack!.safeParse(payload)
      expect(checked.success, JSON.stringify(checked.error?.issues)).toBe(true)
      row.capture?.(payload, state)
    })
  }
})

/** Every file under the repo's v4 missions dir, with its bytes: to prove a refusal wrote nothing. */
async function missionsSnapshot(root: string): Promise<Record<string, string>> {
  const dir = path.join(root, '.harnu', 'missions-v4')
  const out: Record<string, string> = {}
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    out[name] = await fs.readFile(path.join(dir, name), 'utf8')
  }
  return out
}

// Runs after the scenario above, so the rows that address a mission have one.
describe('mission_* contract — a blocked repo refuses every verb, from any worktree', () => {
  for (const row of CONTRACT) {
    it(`${row.op}: FOLDER_NOT_ALLOWED when the resolved main checkout is blocked`, async () => {
      const before = await missionsSnapshot(state.folder)
      const res = await handlers[row.op](row.call({ ...state, folder: detachedWorktree }), {
        folder: detachedWorktree,
        folders: [],
        denyFolders: [state.folder],
        bridge: undefined
      })
      expect(res.isError).toBe(true)
      // Every verb, the one that refuses by design (`mission_update_step`) included, is stopped by the folder gate.
      expect(res.content[0]?.text).toMatch(/^FOLDER_NOT_ALLOWED/)
      expect(await missionsSnapshot(state.folder)).toEqual(before)
    })
  }
})

// ---- Missions v4 S-40 (AC-89): the catalog is the fate table's sixteen --------------------------

/** The fate table's verbs that stay (spec "Verb fate table": 10 keep, 5 rename, 1 replace, rebase_stack). */
const FATE_TABLE_VERBS = [
  'mission_create',
  'mission_get',
  'mission_list',
  'mission_add_milestone',
  'mission_add_step',
  'mission_update_step',
  'mission_add_ac',
  'mission_link',
  'mission_log',
  'mission_set_blocker',
  'mission_clear_blocker',
  'mission_set_done_when',
  'mission_settle_ac',
  'mission_request_close',
  'mission_attach',
  'rebase_stack'
] as const

/** The six verbs with no v4 verb of the same name (renamed, merged, replaced or removed), from parts. */
const FATE_TABLE_REMOVED = [
  ['link', 'child'],
  ['set', 'end'],
  ['verify', 'step'],
  ['add', 'check'],
  ['transfer', 'owner'],
  ['import', 'legacy']
].map((parts) => ['mission', ...parts].join('_'))

describe('Missions v4 · the verbs after S-40', () => {
  it('the catalog matches the fate table', async () => {
    const registered = (MCP_OPS as readonly string[]).filter((o) =>
      /^(mission_|rebase_stack$)/.test(o)
    )
    // Exactly the sixteen: each registered, each wired to a handler, none of the six, and no seventeenth.
    expect([...registered].sort()).toEqual([...FATE_TABLE_VERBS].sort())
    expect(registered).toHaveLength(16)
    for (const op of FATE_TABLE_VERBS) {
      expect(toolByName(op as McpOp)?.name, op).toBe(op)
      expect(typeof handlers[op], `${op} has a handler`).toBe('function')
    }
    for (const op of FATE_TABLE_REMOVED) {
      expect(registered, op).not.toContain(op)
      expect(handlers[op], `${op} has no handler`).toBeUndefined()
    }

    // The v3 handlers, the v3 writers and the steward files are gone; the frozen reader stays.
    const root = path.join(__dirname, '..')
    for (const gone of [
      'src/main/steward-bridge.ts',
      'src/main/steward-core.ts',
      'src/main/steward-hooks.ts',
      'src/main/steward-pause.ts',
      'src/main/steward-rebase.ts',
      'src/main/steward-routes.ts',
      'src/main/steward-shell.ts'
    ]) {
      await expect(fs.access(path.join(root, gone)), gone).rejects.toThrow()
    }
    await expect(
      fs.access(path.join(root, 'src/main/missions/v3-read.ts'))
    ).resolves.toBeUndefined()

    // The awareness verb index lists the sixteen, and none of the six.
    const doc = await fs.readFile(path.join(root, 'docs', 'harnu-features.md'), 'utf8')
    const start = doc.indexOf('The core verbs are available from the first turn:')
    const end = doc.indexOf('Resources:', start)
    expect(start).toBeGreaterThan(-1)
    const index = doc.slice(start, end)
    for (const op of FATE_TABLE_VERBS) {
      expect(index.includes(`\`${op}\``), `${op} is in the awareness index`).toBe(true)
    }
    for (const op of FATE_TABLE_REMOVED) {
      expect(index.includes(`\`${op}\``), `${op} is not in the awareness index`).toBe(false)
    }
  })
})
