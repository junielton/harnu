import { describe, it, expect } from 'vitest'
import { buildPlanInput, strField } from '../src/main/mcp/plan-input'
import { parseToolInput } from '../src/main/mcp/validate'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { MCP_TOOLS } from '../src/main/mcp/tool-catalog'
import { type Policy } from '../src/main/mcp/permission-core'

/**
 * BUG-14 — the seam `buildPlanInput → parseToolInput` was never exercised
 * end-to-end: the grant-branch tests fed `planToolCall` well-formed input
 * directly, while the shell's `buildPlanInput` returned `{}` for
 * `plan_mission` — so the T10 structural gate denied EVERY live mission-grant
 * call (`BAD_ARGS: … received undefined` ×5) before the single human confirm
 * could ever appear.
 *
 * These tests pin the seam CONTRACT for every catalog op: a well-formed
 * catalog-shaped call must survive the translation and parse OK. A field
 * `buildPlanInput` drops is a structurally dead verb — for every agent, with
 * any arguments — which is exactly the class of bug that shipped.
 */

const FIXED_NOW = 1_700_000_000_000
const ALLOWED = '/home/u/repo'

/** Well-formed CATALOG-shaped args per op (what the MCP tool advertises). */
const CATALOG_ARGS: Record<string, Record<string, unknown>> = {
  get_fleet: {},
  get_approval: { approvalId: 'appr-1' },
  get_session: { sessionId: 'sess-1' },
  message_session: { sessionId: 'sess-1', message: 'ping' },
  list_worktrees: { folder: ALLOWED },
  create_session: { folder: ALLOWED, prePrompt: 'hi' },
  create_worktree: { folder: ALLOWED, branch: 'test/agumon' },
  spawn_terminal: { folder: ALLOWED },
  adopt_folder: { folder: ALLOWED },
  remove_folder: { folder: ALLOWED },
  plan_mission: {
    goal: 'fan-out 3 disposable worktrees',
    folders: [ALLOWED],
    verbs: ['create_worktree', 'create_session'],
    budget: 8,
    ttlMinutes: 30
  },
  memory_read: { folder: ALLOWED, page: 'hot' },
  memory_append: { folder: ALLOWED, page: 'decisions', entry: 'chose grep over embeddings for v1' },
  memory_query: { folder: ALLOWED, query: 'retomada' },
  open_file: { folder: ALLOWED, path: `${ALLOWED}/report.md` },
  draw_canvas: {
    folder: ALLOWED,
    path: `${ALLOWED}/.harnu/out/canvas/board.harnucanvas.json`,
    ops: [{ op: 'add_node', shape: 'box', x: 0, y: 0, label: 'Reader' }],
    images: [`${ALLOWED}/shot.png`],
    open: true
  },
  notify: { folder: ALLOWED, title: 'Migration finished', kind: 'success', sessionId: 'sess-1' },
  speak: { folder: ALLOWED, text: 'The migration finished, zero conflicts.', sessionId: 'sess-1' },
  create_card: { folder: ALLOWED, title: 'Investigate flaky test', kind: 'bug' },
  update_card: { folder: ALLOWED, slug: 'investigate-flaky-test', set: { priority: 'alta' } },
  move_card: { folder: ALLOWED, slug: 'investigate-flaky-test', to: 'ready' },
  archive_card: { folder: ALLOWED, slug: 'investigate-flaky-test' },
  delete_card: { folder: ALLOWED, slug: 'investigate-flaky-test' },
  submit_manifest: {
    folder: ALLOWED,
    cards: [{ slug: 'investigate-flaky-test', substrate: 'worktree', model: 'sonnet' }],
    note: 'batch 1'
  },
  create_worker: {
    folder: ALLOWED,
    name: 'PR watcher',
    prompt: 'Check gh pr list and notify on anything red.',
    everyMinutes: 30,
    mode: 'observe'
  },
  list_workers: { folder: ALLOWED },
  list_containers: { folder: ALLOWED },
  // T445: the cleanup read and the release both gate on the `folder` arg.
  list_cleanup: { folder: ALLOWED },
  release_worktree: { folder: ALLOWED },
  // T329: stacks are addressed by id; there is no folder to carry.
  stop_containers: { stacks: ['wave-1'], force: true },
  start_containers: { stacks: ['wave-1'] },
  remove_containers: { stack: 'wave-1', removeVolumes: true },
  // T316: same reasoning as message_session/orchestrator_arm's fixtures below —
  // no caller-supplied `folder`, the gate anchor is resolved server-side from
  // the worker's own `id`.
  update_worker: { id: 'worker-1', set: { everyMinutes: 45 } },
  delete_worker: { id: 'worker-1' },
  // T309: same shape as message_session's fixture above — no caller-supplied
  // `folder`, since the gate anchor is resolved server-side from the TARGET
  // session (ADR-0013).
  orchestrator_arm: { sessionId: 'sess-1' },
  orchestrator_disarm: { sessionId: 'sess-1' },
  // T358 S3: the gate folder IS the catalog `folder` arg, like the board verbs.
  mission_create: {
    folder: ALLOWED,
    title: 'Ship the verb catalog',
    declaredEnd: { kind: 'code', target: 'PR merged', evidence: 'green gates' },
    sessionId: '11111111-2222-4333-8444-555555555555',
    linkedCard: 'T358-mission-progress'
  },
  mission_get: { folder: ALLOWED, missionId: 'mnt-0000abcd' },
  mission_list: { folder: ALLOWED },
  mission_add_step: {
    folder: ALLOWED,
    missionId: 'mnt-0000abcd',
    title: 'Wire the handlers',
    verification: 'verifier',
    afterStepId: 'stp-1',
    reason: 'split out of stp-1'
  },
  mission_update_step: {
    folder: ALLOWED,
    missionId: 'mnt-0000abcd',
    stepId: 'stp-3',
    set: { proof: 'claimed' }
  },
  mission_link_child: {
    folder: ALLOWED,
    missionId: 'mnt-0000abcd',
    stepId: 'stp-3',
    link: { kind: 'session', ref: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }
  },
  mission_log: { folder: ALLOWED, missionId: 'mnt-0000abcd', stepId: 'stp-3', note: 'child done' },
  // T358 S4
  mission_set_blocker: {
    folder: ALLOWED,
    missionId: 'mnt-0000abcd',
    stepId: 'stp-3',
    reason: 'CI red',
    unblocks: 'green gates',
    owner: 'agent'
  },
  mission_clear_blocker: { folder: ALLOWED, missionId: 'mnt-0000abcd', reason: 'CI red' },
  mission_set_end: {
    folder: ALLOWED,
    missionId: 'mnt-0000abcd',
    declaredEnd: { kind: 'research', target: 'memo', evidence: 'memo merged' },
    reason: 'scope moved'
  },
  mission_verify_step: {
    folder: ALLOWED,
    missionId: 'mnt-0000abcd',
    stepId: 'stp-2',
    verdict: 'met',
    evidence: 'verifier report',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  },
  mission_request_close: {
    folder: ALLOWED,
    missionId: 'mnt-0000abcd',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  },
  mission_import_legacy: {
    folder: ALLOWED,
    legacyPath: '.harnu/goals/3f2a9c10-export.md',
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  },
  // Mission v3 §3.6
  mission_add_check: {
    folder: ALLOWED,
    missionId: 'mnt-0000abcd',
    stepId: 'stp-1',
    label: 'Validated visually'
  }
}

/** Mirrors the shell: the gate folder is plucked from the catalog `folder` arg. */
const gateFolderOf = (args: Record<string, unknown>): string | undefined => strField(args, 'folder')

describe('buildPlanInput → parseToolInput seam (BUG-14 regression net)', () => {
  it.each(MCP_TOOLS.map((t) => [t.op] as const))(
    '%s: a well-formed catalog call survives the translation and parses OK',
    (op) => {
      const args = CATALOG_ARGS[op]
      expect(args, `missing catalog fixture for op ${op}`).toBeDefined()
      const input = buildPlanInput(op, args, gateFolderOf(args))
      const parsed = parseToolInput(op, input)
      expect(parsed.ok, parsed.ok ? undefined : `BAD_ARGS: ${parsed.detail}`).toBe(true)
    }
  )

  it('plan_mission: the five grant fields pass through VERBATIM', () => {
    const input = buildPlanInput('plan_mission', CATALOG_ARGS.plan_mission, undefined)
    expect(input).toEqual({
      goal: 'fan-out 3 disposable worktrees',
      folders: [ALLOWED],
      verbs: ['create_worktree', 'create_session'],
      budget: 8,
      ttlMinutes: 30
    })
  })

  it('plan_mission: NO folder key is smuggled in (no single gate folder by design)', () => {
    const input = buildPlanInput('plan_mission', CATALOG_ARGS.plan_mission, ALLOWED)
    expect(input).not.toHaveProperty('folder')
  })

  it('plan_mission: absent fields stay absent (zod names the gap, not `undefined` spam)', () => {
    const input = buildPlanInput('plan_mission', { goal: 'g' }, undefined)
    expect(Object.keys(input)).toEqual(['goal'])
  })

  // BUG-79: `translateUpdateCard` carried `set`/`appendBody` through but
  // silently dropped `replaceBody` — a catalog call using ONLY that field
  // translated to a T10 gate input with none of set/appendBody/replaceBody
  // present, so `parseUpdateCard`'s refine denied it with BAD_ARGS before
  // `update_card`'s handler ever ran. The per-op loop above only exercises
  // ONE well-formed shape per op (`set`, for update_card) — these three cases
  // pin each single-field call shape individually, exactly the granularity a
  // future arg-list edit could regress without the loop above catching it.
  describe('update_card: each single-field call shape survives the seam (BUG-79 regression net)', () => {
    const slugArgs = { folder: ALLOWED, slug: 'investigate-flaky-test' }

    it('set only', () => {
      const args = { ...slugArgs, set: { priority: 'high' } }
      const input = buildPlanInput('update_card', args, gateFolderOf(args))
      expect(parseToolInput('update_card', input).ok).toBe(true)
      expect(input.set).toEqual({ priority: 'high' })
    })

    it('appendBody only', () => {
      const args = { ...slugArgs, appendBody: 'a progress note' }
      const input = buildPlanInput('update_card', args, gateFolderOf(args))
      expect(parseToolInput('update_card', input).ok).toBe(true)
      expect(input.appendBody).toBe('a progress note')
    })

    it('replaceBody only', () => {
      const args = { ...slugArgs, replaceBody: '## Goal\n\nRewritten.' }
      const input = buildPlanInput('update_card', args, gateFolderOf(args))
      const parsed = parseToolInput('update_card', input)
      expect(parsed.ok, parsed.ok ? undefined : `BAD_ARGS: ${parsed.detail}`).toBe(true)
      expect(input.replaceBody).toBe('## Goal\n\nRewritten.')
    })
  })
})

describe('plan_mission through planToolCall with SHELL-built input (the live path)', () => {
  const policy = (over: Partial<Policy> = {}): Policy => ({
    serverEnabled: true,
    allowFolders: [ALLOWED],
    knownRoots: [ALLOWED],
    ...over
  })

  const liveInput = (): Record<string, unknown> =>
    buildPlanInput('plan_mission', CATALOG_ARGS.plan_mission, undefined)

  it('reaches the ONE human confirm (the exemption), not a BAD_ARGS deny', () => {
    const result = planToolCall({
      tool: 'plan_mission',
      input: liveInput(),
      policy: policy(),
      now: FIXED_NOW
    })
    expect(result.verdict).toBe('confirm')
    expect(result.shouldConfirm).toBe(true)
    expect(result.auditRecord.result).not.toMatch(/^BAD_ARGS/)
  })

  it('still fail-closed: SERVER_DISABLED wins over everything', () => {
    const result = planToolCall({
      tool: 'plan_mission',
      input: liveInput(),
      policy: policy({ serverEnabled: false }),
      now: FIXED_NOW
    })
    expect(result.verdict).toBe('deny')
    expect(result.auditRecord.result).toBe('SERVER_DISABLED')
  })

  it('still structurally gated: a malformed grant (budget over cap) is BAD_ARGS-denied', () => {
    const input = buildPlanInput(
      'plan_mission',
      { ...CATALOG_ARGS.plan_mission, budget: 10_000 },
      undefined
    )
    const result = planToolCall({
      tool: 'plan_mission',
      input,
      policy: policy(),
      now: FIXED_NOW
    })
    expect(result.verdict).toBe('deny')
    expect(result.auditRecord.result).toMatch(/^BAD_ARGS/)
  })
})
