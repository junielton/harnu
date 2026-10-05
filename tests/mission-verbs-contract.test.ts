/**
 * T358 — the `mission_*` CONTRACT suite (plan "Eval gate — contract", decision
 * 19 layer 1): every verb's ACK checked against design
 * `docs/specs/2026-09-26-mission-progress/design.md` §4, one call per verb.
 *
 * Why this is a vitest suite and not a `claude plugin eval` case: plugin evals
 * start only the MCP servers a plugin DECLARES, and Harnu's server is declared by
 * no plugin — it is a loopback HTTP server the running app hands each session
 * through a per-spawn `--mcp-config` (port + bearer token). An eval could only
 * reach it through a mock, and a grader checking a mocked ACK checks the mock.
 * See T364's report (AC-S3-8) for the evidence.
 *
 * What this suite exercises instead is the whole in-process call path a real
 * call takes after the HTTP transport, per verb:
 *   1. the catalog `inputSchema` (what the MCP SDK validates on the way in);
 *   2. the gate translation + validation (`buildPlanInput` → `parseToolInput`);
 *   3. the handler wired in `WIRED_TOOLS` (the array `server.ts` registers);
 * and then checks the ACK against a schema written from the design §4 table.
 *
 * EXTENDING IT (S4, S7 — done): add the new verb's row to `CONTRACT` — its §4 ACK
 * schema and a `call` that builds its args from the scenario state — in the
 * order it should run (and a `setup` when its success path needs prior state).
 * The coverage guard below fails until every `mission_*`
 * op in `MCP_OPS` has a row, so a verb cannot ship without its contract.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { z } from 'zod'
import { MCP_OPS, toolByName, type McpOp } from '../src/main/mcp/tool-catalog'
import { buildPlanInput } from '../src/main/mcp/plan-input'
import { parseToolInput } from '../src/main/mcp/validate'
import {
  buildMissionFileContent,
  missionsDir,
  parseMissionFile,
  readMissionLog,
  type Mission as MissionRecord
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

// ---- design §4 / §1 shapes ---------------------------------------------------

const StepLink = z.object({
  kind: z.enum(['session', 'worktree', 'card', 'pr']),
  ref: z.string()
})

const Blocker = z.object({
  reason: z.string(),
  unblocks: z.string(),
  owner: z.enum(['agent', 'operator']),
  raisedAt: z.string()
})

const MissionStep = z.object({
  id: z.string().regex(/^stp-\d+$/),
  ordinal: z.number().int(),
  kind: z.enum(['fixed-start', 'fixed-end', 'custom']),
  title: z.string(),
  verification: z.enum(['existence', 'verifier', 'human']),
  proof: z.enum(['unproven', 'claimed', 'verified', 'self-verified']),
  links: z.array(StepLink),
  blockers: z.array(Blocker)
})

const DeclaredEnd = z.object({
  kind: z.enum(['code', 'ui', 'research', 'decision', 'other']),
  target: z.string().min(1),
  evidence: z.string().min(1)
})

/** design §1.1 — the full Mission projection `mission_get` returns. */
const Mission = z.object({
  id: z.string().regex(/^mnt-[0-9a-f]{8}$/),
  slug: z.string(),
  folder: z.string(),
  owner: z.object({ sessionId: z.string(), folder: z.string() }),
  status: z.enum(['draft', 'active', 'stale', 'delivered', 'closed']),
  declaredEnd: DeclaredEnd,
  // Mission v3 §3.3: at least the fixed end; no fixed start.
  steps: z.array(MissionStep).min(1),
  blockers: z.array(Blocker),
  openQuestions: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  provenance: z.object({ author: z.enum(['agent', 'human']), at: z.string() })
})

/** design §7 — one linked child's live state (the scoped fleet projection's row). */
const ChildState = z
  .object({
    sessionId: z.string(),
    known: z.boolean(),
    folderAlias: z.string().optional(),
    status: z.enum(['active', 'idle', 'archived']).optional(),
    taskState: z
      .enum(['working', 'needs-input', 'idle', 'completed', 'failed', 'stopped'])
      .optional(),
    failureReason: z.string().optional(),
    hibernated: z.literal(true).optional(),
    inflight: z.literal(true).optional(),
    peer: z.object({ pid: z.number(), socket: z.string() }).optional(),
    modified: z.string().optional(),
    pendingApprovals: z.number().int().min(0),
    lastTransitionAt: z.iso.datetime().optional()
  })
  .strict()

const PrSummary = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED']),
  isDraft: z.boolean(),
  ci: z.string(),
  url: z.string(),
  // Mission v2 §3.6: the branch the PR merges into.
  baseRefName: z.string()
})

/** design §7 — a resolved worktree / card / pr link. */
const LinkSignal = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('worktree'),
    ref: z.string(),
    exists: z.boolean(),
    branch: z.string().nullable(),
    head: z.object({ sha: z.string(), subject: z.string(), at: z.string() }).nullable(),
    prs: z.array(PrSummary)
  }),
  z.object({
    kind: z.literal('card'),
    ref: z.string(),
    exists: z.boolean(),
    status: z.string().optional(),
    executedIn: z.string().optional(),
    prs: z.array(PrSummary)
  }),
  z.object({
    kind: z.literal('pr'),
    ref: z.string(),
    number: z.number().int().nullable(),
    exists: z.boolean(),
    state: z.enum(['OPEN', 'MERGED', 'CLOSED']).optional(),
    url: z.string().optional(),
    baseRefName: z.string().optional()
  })
])

/** Every ACK carries `ok: true` and its `op` (the convention all verbs share). */
function ack<T extends z.ZodRawShape>(op: McpOp, shape: T): z.ZodType {
  return z.object({ ok: z.literal(true), op: z.literal(op), ...shape })
}

// ---- the contract table (extend here) ----------------------------------------

interface ScenarioState {
  folder: string
  sessionId: string
  missionId?: string
  stepId?: string
}

interface ContractRow {
  op: McpOp
  /** design §4 ACK column, as a schema. */
  ack: z.ZodType
  /** The call's args, built from what earlier rows left in the state. */
  call: (s: ScenarioState) => Record<string, unknown>
  /** Pull what later rows need out of this row's ACK. */
  capture?: (ackPayload: Record<string, unknown>, s: ScenarioState) => void
  /**
   * Bring the scenario to the state this row's SUCCESS path needs, before the
   * call — through the wired handlers where a verb exists, and on disk only for
   * a transition no verb makes (an operator UI door).
   */
  setup?: (s: ScenarioState) => Promise<void>
}

/** The id the contract's verifier declares — not the child linked to the step. */
const VERIFIER_ID = 'cccccccc-dddd-4eee-8fff-000000000000'

/** Rewrite the scenario's mission on disk — stands in for an operator UI door. */
async function mutateMission(s: ScenarioState, fn: (m: MissionRecord) => void): Promise<void> {
  const dir = missionsDir(s.folder)
  const name = (await fs.readdir(dir)).find((n) => n.startsWith(`${s.missionId}-`))!
  const file = path.join(dir, name)
  const raw = await fs.readFile(file, 'utf8')
  const mission = parseMissionFile(raw) as MissionRecord
  fn(mission)
  await fs.writeFile(file, buildMissionFileContent(mission, readMissionLog(raw)), 'utf8')
}

/** Call a wired handler outside a row (setup), failing loudly on a refusal. */
async function callOk(op: McpOp, s: ScenarioState, args: Record<string, unknown>): Promise<void> {
  const res = await handlers[op](
    { folder: s.folder, missionId: s.missionId, ...args },
    { folder: s.folder, folders: [], denyFolders: [], bridge: undefined }
  )
  expect(res.isError, res.content[0]?.text).not.toBe(true)
}

const CONTRACT: ContractRow[] = [
  {
    op: 'mission_create',
    // §4: { ok, missionId, slug, steps } — Mission v3 §3.3: the declared plan then
    // the fixed end, no fixed start; `scope` is an attachment echoed in the ACK.
    ack: ack('mission_create', {
      missionId: z.string().regex(/^mnt-[0-9a-f]{8}$/),
      slug: z.string().min(1),
      steps: z.tuple([
        MissionStep.extend({
          id: z.literal('stp-1'),
          kind: z.literal('custom'),
          verification: z.literal('verifier'),
          links: z.tuple([])
        }),
        MissionStep.extend({
          id: z.literal('stp-2'),
          kind: z.literal('fixed-end'),
          verification: z.literal('verifier')
        })
      ]),
      scope: z.tuple([z.object({ kind: z.literal('worktree'), ref: z.literal('docs/spec.md') })])
    }),
    call: (s) => ({
      folder: s.folder,
      title: 'Contract eval mission',
      declaredEnd: { kind: 'code', target: 'the verb catalog', evidence: 'this suite green' },
      sessionId: s.sessionId,
      scope: ['docs/spec.md'],
      steps: [{ title: 'Build', verification: 'verifier' }]
    }),
    capture: (p, s) => {
      s.missionId = p.missionId as string
    }
  },
  {
    op: 'mission_add_step',
    // §4: { ok, stepId, totalSteps }
    ack: ack('mission_add_step', {
      stepId: z.string().regex(/^stp-\d+$/),
      totalSteps: z.number().int().min(3)
    }),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      title: 'Implement',
      verification: 'verifier',
      // Mission v3 §3.9: a step can be born with its links.
      links: [{ kind: 'pr', ref: 'owner/repo#1' }]
    }),
    capture: (p, s) => {
      s.stepId = p.stepId as string
    }
  },
  {
    op: 'mission_update_step',
    // §4: { ok, stepId }
    ack: ack('mission_update_step', { stepId: z.string().regex(/^stp-\d+$/) }),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      stepId: s.stepId,
      set: { proof: 'claimed' }
    })
  },
  {
    op: 'mission_link_child',
    // §4: { ok, stepId, links }
    ack: ack('mission_link_child', {
      stepId: z.string().regex(/^stp-\d+$/),
      links: z.array(StepLink).min(1)
    }),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      stepId: s.stepId,
      link: { kind: 'session', ref: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
    })
  },
  {
    op: 'mission_add_check',
    // Mission v3 §3.6: { ok, stepId, checks } — no input can write `ticked`.
    ack: ack('mission_add_check', {
      stepId: z.string().regex(/^stp-\d+$/),
      checks: z
        .array(
          z
            .object({
              id: z.string().regex(/^chk-\d+$/),
              label: z.string().min(1).max(200),
              source: z.literal('agent'),
              createdAt: z.iso.datetime()
            })
            .strict()
        )
        .min(1)
    }),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      stepId: s.stepId,
      label: 'Validated visually'
    })
  },
  {
    op: 'mission_log',
    // §4: { ok }
    ack: ack('mission_log', {}),
    call: (s) => ({ folder: s.folder, missionId: s.missionId, stepId: s.stepId, note: 'done' })
  },
  // ---- S4 (T365): blockers, re-scope, verify, close ----
  {
    op: 'mission_set_blocker',
    // §4: { ok, blockers }
    ack: ack('mission_set_blocker', { blockers: z.array(Blocker).min(1) }),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      reason: 'waiting on a review',
      unblocks: 'a reviewer approves',
      owner: 'operator'
    })
  },
  {
    op: 'mission_clear_blocker',
    // §4: { ok, blockers } — what is still open
    ack: ack('mission_clear_blocker', { blockers: z.array(Blocker) }),
    call: (s) => ({ folder: s.folder, missionId: s.missionId, reason: 'waiting on a review' })
  },
  {
    op: 'mission_set_end',
    // §4: { ok, pendingRescope: true }
    ack: ack('mission_set_end', { pendingRescope: z.literal(true) }),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      declaredEnd: { kind: 'research', target: 'a go/no-go memo', evidence: 'memo merged' },
      reason: 'the scope moved'
    })
  },
  {
    op: 'mission_verify_step',
    // §4: { ok, stepId, proof: 'verified' | 'self-verified' } — plus `unproven` for a
    // non-met verdict and the verdict itself (design §1.3, S4 "Verdict").
    ack: ack('mission_verify_step', {
      stepId: z.string().regex(/^stp-\d+$/),
      proof: z.enum(['verified', 'self-verified', 'unproven']),
      verdict: z.enum(['met', 'unmet', 'blocked', 'needs-human'])
    }),
    call: (s) => ({
      folder: s.folder,
      missionId: s.missionId,
      stepId: s.stepId,
      verdict: 'met',
      evidence: 'contract suite green',
      sessionId: VERIFIER_ID
    })
  },
  {
    op: 'mission_request_close',
    // §4: { ok, pendingClose: true } — the success path needs an active mission
    // (operator door, no verb) and an independently verified fixed end (verbs).
    // The mission_set_end row staged a re-scope, which a close request refuses
    // (Mission v2 §3.5, RESCOPE_PENDING) — the operator approves it first, the
    // way the UI door does: the staged end becomes the declared end.
    ack: ack('mission_request_close', { pendingClose: z.literal(true) }),
    setup: async (s) => {
      await mutateMission(s, (m) => {
        m.status = 'active'
        if (m.pendingRescope) m.declaredEnd = m.pendingRescope
        delete m.pendingRescope
      })
      const link = { kind: 'session', ref: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
      await callOk('mission_link_child', s, { stepId: 'stp-2', link })
      await callOk('mission_verify_step', s, {
        stepId: 'stp-2',
        verdict: 'met',
        evidence: 'delivered',
        sessionId: VERIFIER_ID
      })
    },
    call: (s) => ({ folder: s.folder, missionId: s.missionId })
  },
  {
    op: 'mission_get',
    // §4 + §7 (S6): the full Mission projection, the COMPUTED derived fields
    // (per-step live children, resolved links, existence proofs, the §8 stall
    // verdict) and the always-present you line.
    ack: ack('mission_get', {
      mission: Mission,
      title: z.string().min(1),
      log: z.string(),
      derived: z
        .object({
          live: z.literal(true),
          computedAt: z.iso.datetime(),
          stale: z.boolean(),
          stall: z
            .object({
              stale: z.boolean(),
              lastEvidenceAt: z.iso.datetime().nullable(),
              thresholdMs: z.literal(60 * 60 * 1000),
              workingSessions: z.array(z.string())
            })
            .strict(),
          gh: z.enum(['available', 'unavailable', 'not-needed']),
          pendingApprovals: z.number().int().min(0),
          // Mission v3 §3.3: the scope attachment, resolved.
          scope: z
            .object({
              links: z.array(LinkSignal),
              resolved: z.object({ proven: z.boolean(), reason: z.string().optional() }).strict()
            })
            .strict(),
          // Mission v3 §3.1: the server's progress.
          progress: z
            .object({
              total: z.number().int().min(1),
              current: z.object({ from: z.number().int(), to: z.number().int() }).nullable(),
              allDone: z.boolean(),
              done: z.number().int(),
              verified: z.number().int(),
              states: z.record(
                z.string(),
                z.enum(['verified', 'done', 'running', 'waiting', 'blocked', 'todo'])
              ),
              leftBehind: z.array(z.string()),
              unprovable: z.array(z.string()),
              computedAt: z.iso.datetime()
            })
            .strict(),
          steps: z
            .array(
              z
                .object({
                  stepId: z.string().regex(/^stp-\d+$/),
                  children: z.array(ChildState),
                  links: z.array(LinkSignal),
                  existence: z
                    .object({ proven: z.boolean(), reason: z.string().optional() })
                    .strict()
                    .nullable()
                })
                .strict()
            )
            .min(2)
        })
        .strict(),
      you: z.string().min(1),
      // Mission v3 §3.12: the ordered list behind the `you` line.
      youItems: z.array(
        z
          .object({
            kind: z.enum([
              'rescope',
              'close',
              'blocker',
              'checks',
              'human-steps',
              'review-import',
              'approvals',
              'needs-input'
            ])
          })
          .passthrough()
      ),
      // Mission v2 §3.5: what mission_request_close would refuse now, or null.
      closeReadiness: z
        .object({
          // Mission v3 §3.4: no draft refusal.
          code: z.enum(['MISSION_CLOSED', 'END_NOT_VERIFIED', 'OPEN_BLOCKERS', 'RESCOPE_PENDING']),
          reason: z.string().min(1)
        })
        .strict()
        .nullable()
    }),
    // A scope document (Mission v3 §3.3) and an existence-level step linked to a
    // path, so the resolved-link and existence-proof halves of the shape are
    // exercised, not just empty. Scope names a document in the repo: the repo root
    // itself is refused (BUG-145).
    setup: async (s) => {
      await fs.mkdir(path.join(s.folder, 'docs'), { recursive: true })
      await fs.writeFile(path.join(s.folder, 'docs', 'spec.md'), '# spec\n', 'utf8')
      await callOk('mission_link_child', s, {
        scope: true,
        link: { kind: 'worktree', ref: path.join(s.folder, 'docs', 'prd.md') }
      })
      await callOk('mission_add_step', s, {
        title: 'Spec on disk',
        verification: 'existence',
        reason: 'the contract needs an existence step',
        links: [{ kind: 'worktree', ref: 'docs/spec.md' }]
      })
    },
    call: (s) => ({ folder: s.folder, missionId: s.missionId })
  },
  {
    op: 'mission_list',
    // §4: Mission[] (id, slug, status, step counts)
    ack: ack('mission_list', {
      missions: z
        .array(
          z.object({
            id: z.string().regex(/^mnt-[0-9a-f]{8}$/),
            slug: z.string(),
            status: z.enum(['draft', 'active', 'stale', 'delivered', 'closed']),
            // Mission v3 §3.10: the last derive's progress (mission_get ran above).
            progress: z
              .object({ total: z.number().int(), computedAt: z.iso.datetime() })
              .passthrough(),
            steps: z.object({ total: z.number().int(), verified: z.number().int() })
          })
        )
        .min(1)
    }),
    call: (s) => ({ folder: s.folder })
  },
  // ---- S7 (T368): legacy goal-file migration ----
  {
    op: 'mission_import_legacy',
    // §4: { ok, missionId, extractedFields: string[], legacyPreserved: true } — plus
    // the new mission's slug and which fields need review (§9).
    ack: ack('mission_import_legacy', {
      missionId: z.string().regex(/^mnt-[0-9a-f]{8}$/),
      slug: z.string().min(1),
      extractedFields: z.array(z.string()),
      needsReview: z.array(z.literal('declaredEnd')),
      legacyPreserved: z.literal(true)
    }),
    setup: async (s) => {
      const goals = path.join(s.folder, '.harnu', 'goals')
      await fs.mkdir(goals, { recursive: true })
      await fs.writeFile(
        path.join(goals, 'contract.md'),
        '# Goal — contract import\n\n## North star\n\nMerge the PR.\n\n## Done criteria\n\n- CI green\n',
        'utf8'
      )
    },
    call: (s) => ({
      folder: s.folder,
      legacyPath: '.harnu/goals/contract.md',
      sessionId: s.sessionId
    })
  }
]

// ---- the runner ---------------------------------------------------------------

type Handler = (
  args: Record<string, unknown>,
  ctx: Record<string, unknown>
) => Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>

let handlers: Record<string, Handler>
const state: ScenarioState = { folder: '', sessionId: '11111111-2222-4333-8444-555555555555' }
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
  const { WIRED_TOOLS } = await import('../src/main/mcp/tool-handlers')
  handlers = Object.fromEntries(WIRED_TOOLS.map((t) => [t.op, t.handler as unknown as Handler]))
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
      expect(res.isError, res.content[0]?.text).not.toBe(true)
      const payload = JSON.parse(res.content[0].text!) as Record<string, unknown>
      const checked = row.ack.safeParse(payload)
      expect(checked.success, JSON.stringify(checked.error?.issues)).toBe(true)
      row.capture?.(payload, state)
    })
  }
})

/** Every file under the repo's missions dir, with its bytes — to prove a refusal wrote nothing. */
async function missionsSnapshot(root: string): Promise<Record<string, string>> {
  const dir = path.join(root, '.harnu', 'missions')
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
      expect(res.content[0]?.text).toMatch(/^FOLDER_NOT_ALLOWED/)
      expect(await missionsSnapshot(state.folder)).toEqual(before)
    })
  }
})
