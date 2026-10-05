import { describe, it, expect } from 'vitest'
import { planToolCall } from '../src/main/mcp/plan-tool-call'
import { type Policy } from '../src/main/mcp/permission-core'
import type { MissionGrant } from '../src/main/mcp/grant-core'

/**
 * T14 — `planToolCall` is the PURE security-composition reducer that fuses the
 * three leaf cores (T3 `evaluateToolCall`, T5 tool-catalog `mutates`/gate fields,
 * T10 `validate`) into one plan: `{ auditRecord, verdict, shouldConfirm,
 * shouldDispatch, redact }`. The DANGEROUS ORDER lives here so Stryker can reach it:
 *
 *   audit  →  permission  →  free-vs-confirm  →  promotion layers  →  redact
 *
 * POST-REVERSAL contract pinned here (agents free by default):
 *
 *  - EVERY call is audited, denied ones included. With mutations running unattended,
 *    the audit record is the operator's ONLY trace — a mutant that only audits a
 *    dispatched call dies here.
 *  - A mutating verb carrying `silentAllowInAgentFolder` (all of them except
 *    `plan_mission`) resolves to `allow` and DISPATCHES with no confirm parked.
 *  - `plan_mission` still always `confirm`s. `submit_manifest` (T187) now carries
 *    `silentAllowInAgentFolder` too — free by default, still `confirm`s under `ask`.
 *  - `ask: true` re-arms the confirm for EVERY mutation, and re-arms containment.
 *  - An explicit folder BLOCK is absolute: no grant, no bootstrap exemption, no T72
 *    discovery may promote it. The kill switch outranks even that.
 *  - `shouldDispatch` ⇔ `verdict === 'allow'`; `shouldConfirm` ⇔ `verdict === 'confirm'`.
 *  - The redact directive is a property of the TOOL, independent of the verdict.
 *
 * Pure: no fs/electron/timers; the clock is injected as `now`, so the function is
 * deterministic and lands in the pure-core coverage surface (ADR-0001).
 */

const FIXED_NOW = 1_700_000_000_000

const REPO = '/home/u/repo'

/** A healthy default policy: free mode, `/home/u/repo` known, nothing blocked. */
const policy = (over: Partial<Policy> = {}): Policy => ({
  serverEnabled: true,
  denyFolders: [],
  allowFolders: [REPO],
  knownRoots: [REPO],
  ...over
})

/** Plan a tool call with the shared clock + policy defaults. */
const plan = (
  tool: string,
  input: unknown,
  over: Partial<Policy> = {}
): ReturnType<typeof planToolCall> =>
  planToolCall({ tool, input, policy: policy(over), now: FIXED_NOW })

describe('planToolCall — audit happens for EVERY call (audit before permission)', () => {
  it('a denied call (server disabled) is STILL audited', () => {
    const r = plan('get_fleet', {}, { serverEnabled: false })
    expect(r.verdict).toBe('deny')
    expect(r.auditRecord.tool).toBe('get_fleet')
    expect(r.auditRecord.result).toBe('SERVER_DISABLED')
  })

  it('a denied mutation (blocked folder) is STILL audited with its reason', () => {
    const r = plan('create_session', { folder: REPO, kind: 'new' }, { denyFolders: [REPO] })
    expect(r.verdict).toBe('deny')
    expect(r.auditRecord.result).toBe('FOLDER_NOT_ALLOWED')
    expect(r.auditRecord.folder).toBe(REPO)
  })

  it('an ALLOWED (unattended) mutation is audited as AGENT_ALLOWED — the only trace of it', () => {
    const r = plan('create_session', { folder: REPO, kind: 'new' })
    expect(r.verdict).toBe('allow')
    expect(r.auditRecord.result).toBe('AGENT_ALLOWED')
    expect(r.auditRecord.tool).toBe('create_session')
    expect(r.auditRecord.folder).toBe(REPO)
  })

  it('stamps the audit record with the INJECTED clock, not wall time', () => {
    expect(plan('get_fleet', {}).auditRecord.ts).toBe(FIXED_NOW)
  })

  it('a malformed call is denied BEFORE permission yet STILL audited (BAD_ARGS)', () => {
    const r = plan('create_session', { folder: 42, kind: 'new' })
    expect(r.verdict).toBe('deny')
    expect(r.shouldDispatch).toBe(false)
    expect(r.auditRecord.result).toMatch(/^BAD_ARGS/)
  })

  it('an unknown tool fails closed: deny / no-dispatch / audited', () => {
    const r = plan('rm_rf', { folder: REPO })
    expect(r.verdict).toBe('deny')
    expect(r.shouldDispatch).toBe(false)
    expect(r.auditRecord.result).toBe('UNKNOWN_TOOL')
  })
})

describe('planToolCall — mutations are FREE by default (the reversal)', () => {
  // Shapes are the SHELL-built ones (`buildPlanInput`), which is what the validate
  // layer sees — hence `repoPath` / `worktreePath` / `kind` rather than the raw MCP args.
  const freeVerbs: Array<[string, unknown]> = [
    ['create_session', { folder: REPO, kind: 'new' }],
    ['create_worktree', { repoPath: REPO, branch: 'x' }],
    ['spawn_terminal', { worktreePath: REPO }],
    ['adopt_folder', { folder: REPO }],
    ['memory_append', { folder: REPO, page: 'decisions', entry: 'a decision' }],
    ['open_file', { folder: REPO, path: `${REPO}/a.md` }],
    ['notify', { folder: REPO, title: 'hi' }],
    ['create_card', { folder: REPO, title: 'c' }],
    ['update_card', { folder: REPO, slug: 's', appendBody: 'b' }],
    ['move_card', { folder: REPO, slug: 's', to: 'ready' }],
    ['archive_card', { folder: REPO, slug: 's' }],
    // T187: the dispatch go-door is now free by default too — moving a card to
    // Ready is the operator's consent; a second confirm here was the whole bug.
    ['submit_manifest', { folder: REPO, cards: [{ slug: 'c1' }] }],
    // T308: an `observe` worker (the default) is body-allowlisted read-only —
    // free like every other mutating verb. `mode: 'act'` is NOT here — see the
    // dedicated describe block below.
    [
      'create_worker',
      { folder: REPO, name: 'PR watcher', prompt: 'watch prs', everyMinutes: 30, mode: 'observe' }
    ]
  ]

  for (const [tool, input] of freeVerbs) {
    it(`${tool} → allow + dispatch, NO confirm parked`, () => {
      const r = plan(tool, input)
      expect(r.verdict, r.auditRecord.result).toBe('allow')
      expect(r.shouldDispatch).toBe(true)
      expect(r.shouldConfirm).toBe(false)
      expect(r.silentAllowInAgentFolder).toBe(true)
    })
  }

  it('create_session in a folder that is NOT in projects.json at all → allow (the exact bug)', () => {
    // `create_session` handed back a session id, then everything else was refused
    // with FOLDER_NOT_ALLOWED and the machine sat idle. Never again.
    const r = plan(
      'create_session',
      { folder: '/tmp/brand-new', kind: 'new' },
      { knownRoots: [], allowFolders: [] }
    )
    expect(r.verdict).toBe('allow')
    expect(r.shouldConfirm).toBe(false)
  })

  it('get_session in a folder nobody pinned → allow (the other half of that bug)', () => {
    const r = plan('get_session', { id: 's1' }, { knownRoots: [], allowFolders: [] })
    expect(r.verdict).toBe('allow')
    expect(r.shouldDispatch).toBe(true)
  })
})

describe('planToolCall — the verbs that STILL face a human', () => {
  it('T148: delete_card confirms even in the free mode (irreversible, unlike archive_card)', () => {
    const r = plan('delete_card', { folder: REPO, slug: 's' })
    expect(r.verdict).toBe('confirm')
    expect(r.shouldConfirm).toBe(true)
    expect(r.shouldDispatch).toBe(false)
    expect(r.silentAllowInAgentFolder).toBeUndefined()
  })

  it('plan_mission confirms even in the free mode (a grant nobody approved is not a grant)', () => {
    const r = plan('plan_mission', {
      goal: 'g',
      folders: [REPO],
      verbs: ['create_worktree'],
      budget: 1,
      ttlMinutes: 5
    })
    expect(r.verdict).toBe('confirm')
    expect(r.shouldConfirm).toBe(true)
  })

  it('T316: delete_worker confirms even in the free mode (irreversible, unlike update_worker)', () => {
    const r = plan('delete_worker', { id: 'w1', folder: REPO })
    expect(r.verdict).toBe('confirm')
    expect(r.shouldConfirm).toBe(true)
    expect(r.shouldDispatch).toBe(false)
    expect(r.silentAllowInAgentFolder).toBeUndefined()
  })
})

describe('planToolCall — T329: the Containers actions gate on reversibility', () => {
  it('start_containers runs free, like archive_card', () => {
    const r = plan('start_containers', { stacks: ['wave-1'] })
    expect(r.verdict).toBe('allow')
    expect(r.shouldDispatch).toBe(true)
    expect(r.silentAllowInAgentFolder).toBe(true)
    expect(r.auditRecord.result).toBe('AGENT_ALLOWED')
  })

  it('stop_containers runs free without force, and with force:false', () => {
    for (const input of [{ stacks: ['wave-1'] }, { stacks: ['wave-1'], force: false }]) {
      const r = plan('stop_containers', input)
      expect(r.verdict).toBe('allow')
      expect(r.silentAllowInAgentFolder).toBe(true)
    }
  })

  it('stop_containers with force:true confirms — the input carries the risk (forceConfirmFor)', () => {
    const r = plan('stop_containers', { stacks: ['busy'], force: true })
    expect(r.verdict).toBe('confirm')
    expect(r.shouldConfirm).toBe(true)
    expect(r.shouldDispatch).toBe(false)
    expect(r.silentAllowInAgentFolder).toBeUndefined()
  })

  it('remove_containers confirms in the free mode AND under ask', () => {
    for (const over of [{}, { ask: true }]) {
      const r = plan('remove_containers', { stack: 'wave-1' }, over)
      expect(r.verdict).toBe('confirm')
      expect(r.shouldDispatch).toBe(false)
      expect(r.silentAllowInAgentFolder).toBeUndefined()
    }
  })

  it('no mission grant can cover remove_containers', () => {
    const grant: MissionGrant = {
      id: 'g1',
      goal: 'clean up zombies',
      folders: [REPO],
      dynamicFolders: [],
      // Not constructible through plan_mission's schema; forced here to prove
      // the planner refuses it at the gate too (`grantable` is absent).
      verbs: ['remove_containers'] as unknown as MissionGrant['verbs'],
      budget: 5,
      spent: 0,
      expiresAt: FIXED_NOW + 60_000,
      createdAt: FIXED_NOW - 1,
      revoked: false
    }
    for (const ask of [false, true]) {
      const r = planToolCall({
        tool: 'remove_containers',
        input: { stack: 'wave-1' },
        policy: policy({ ask }),
        now: FIXED_NOW,
        grants: [grant],
        homeDir: '/home/u'
      })
      expect(r.verdict).toBe('confirm')
      expect(r.grantAllow).toBeUndefined()
    }
  })

  it('a stacks list sent to remove_containers is BAD_ARGS, never narrowed to one stack', () => {
    const r = plan('remove_containers', { stack: 'wave-1', stacks: ['wave-1', 'wave-2'] })
    expect(r.verdict).toBe('deny')
    expect(r.auditRecord.result).toMatch(/^BAD_ARGS/)
  })
})

describe('planToolCall — T316: update_worker confirms on mode:"act" OR any prompt edit (forceConfirmFor)', () => {
  it('set.mode:"act" confirms even in the free mode — the SAME class as create_worker', () => {
    const r = plan('update_worker', { id: 'w1', folder: REPO, set: { mode: 'act' } })
    expect(r.verdict).toBe('confirm')
    expect(r.shouldConfirm).toBe(true)
    expect(r.shouldDispatch).toBe(false)
    expect(r.silentAllowInAgentFolder).toBeUndefined()
  })

  it('set.prompt confirms even when mode is untouched — the tool cannot see the CURRENT mode', () => {
    const r = plan('update_worker', { id: 'w1', folder: REPO, set: { prompt: 'new prompt' } })
    expect(r.verdict).toBe('confirm')
    expect(r.shouldConfirm).toBe(true)
  })

  it('set.systemPrompt confirms too — it is the SAME unattended body, pushed as --system-prompt', () => {
    const r = plan('update_worker', {
      id: 'w1',
      folder: REPO,
      set: { systemPrompt: 'you are a release bot' }
    })
    expect(r.verdict).toBe('confirm')
    expect(r.shouldConfirm).toBe(true)
    expect(r.shouldDispatch).toBe(false)
  })

  it('a non-prompt, non-mode edit stays free — e.g. cadence or disabling the worker', () => {
    const r = plan('update_worker', { id: 'w1', folder: REPO, set: { everyMinutes: 45 } })
    expect(r.verdict).toBe('allow')
    expect(r.silentAllowInAgentFolder).toBe(true)
  })

  it('update_worker({ set: { enabled: false } }) — the reversible pause — stays free', () => {
    const r = plan('update_worker', { id: 'w1', folder: REPO, set: { enabled: false } })
    expect(r.verdict).toBe('allow')
    expect(r.silentAllowInAgentFolder).toBe(true)
  })

  it('an explicit folder BLOCK still wins over everything, prompt edit included', () => {
    const r = plan(
      'update_worker',
      { id: 'w1', folder: REPO, set: { prompt: 'p' } },
      { denyFolders: [REPO] }
    )
    expect(r.verdict).toBe('deny')
    expect(r.auditRecord.result).toBe('FOLDER_NOT_ALLOWED')
  })
})

describe('planToolCall — T308: create_worker mode:"act" always confirms (forceConfirmFor)', () => {
  const actInput = {
    folder: REPO,
    name: 'auto-fixer',
    prompt: 'fix and push',
    everyMinutes: 15,
    mode: 'act'
  }

  it('mode:"act" confirms even in the free mode — the SAME class as plan_mission/delete_card', () => {
    const r = plan('create_worker', actInput)
    expect(r.verdict).toBe('confirm')
    expect(r.shouldConfirm).toBe(true)
    expect(r.shouldDispatch).toBe(false)
    expect(r.silentAllowInAgentFolder).toBeUndefined()
  })

  it("mode:'observe' on the SAME tool stays free — the narrowing is per-input, not per-tool", () => {
    const r = plan('create_worker', { ...actInput, mode: 'observe' })
    expect(r.verdict).toBe('allow')
    expect(r.silentAllowInAgentFolder).toBe(true)
  })

  it('an explicit folder BLOCK still wins over everything, act mode included', () => {
    const r = plan('create_worker', actInput, { denyFolders: [REPO] })
    expect(r.verdict).toBe('deny')
    expect(r.auditRecord.result).toBe('FOLDER_NOT_ALLOWED')
  })
})

describe('planToolCall — the `ask` friction mode re-arms every confirm', () => {
  it('create_session confirms again under ask:true', () => {
    const r = plan('create_session', { folder: REPO, kind: 'new' }, { ask: true })
    expect(r.verdict).toBe('confirm')
    expect(r.shouldConfirm).toBe(true)
    expect(r.shouldDispatch).toBe(false)
    expect(r.silentAllowInAgentFolder).toBeUndefined()
  })

  it('even the lowest-risk verbs (open_file, board verbs) confirm under ask:true', () => {
    for (const [tool, input] of [
      ['open_file', { folder: REPO, path: `${REPO}/a.md` }],
      ['create_card', { folder: REPO, title: 'c' }],
      ['notify', { folder: REPO, title: 'n' }]
    ] as Array<[string, unknown]>) {
      expect(plan(tool, input, { ask: true }).verdict, tool).toBe('confirm')
    }
  })

  it('T187 AC-3: submit_manifest — free by default (AC-1), still confirms under ask:true', () => {
    const input = { folder: REPO, cards: [{ slug: 'c1' }] }
    const free = plan('submit_manifest', input)
    expect(free.verdict).toBe('allow')
    expect(free.shouldDispatch).toBe(true)
    expect(free.shouldConfirm).toBe(false)
    expect(free.silentAllowInAgentFolder).toBe(true)

    const asked = plan('submit_manifest', input, { ask: true })
    expect(asked.verdict).toBe('confirm')
    expect(asked.shouldConfirm).toBe(true)
    expect(asked.shouldDispatch).toBe(false)
  })

  it('reads still dispatch under ask:true (the friction is on mutations only)', () => {
    const r = plan('get_fleet', {}, { ask: true })
    expect(r.verdict).toBe('allow')
    expect(r.shouldDispatch).toBe(true)
  })

  it('containment is re-armed under ask:true — a mutation outside the roots is PATH_ESCAPE', () => {
    // NB a `..` traversal never gets this far: the T10 validator refuses it as
    // BAD_ARGS before permission is consulted, in BOTH modes. PATH_ESCAPE is about a
    // clean absolute path that simply lives outside every known root.
    const r = plan('create_session', { folder: '/var/elsewhere', kind: 'new' }, { ask: true })
    expect(r.verdict).toBe('deny')
    expect(r.auditRecord.result).toBe('PATH_ESCAPE')
  })

  it('…and that same call is simply ALLOWED in the free mode (no boundary at all)', () => {
    const r = plan('create_session', { folder: '/var/elsewhere', kind: 'new' })
    expect(r.verdict).toBe('allow')
  })

  it('a `..` traversal is BAD_ARGS in both modes — the structural gate precedes permission', () => {
    for (const over of [{}, { ask: true }]) {
      const r = plan('create_session', { folder: '/home/u/repo/../../etc', kind: 'new' }, over)
      expect(r.verdict).toBe('deny')
      expect(r.auditRecord.result).toMatch(/^BAD_ARGS/)
    }
  })
})

describe('planToolCall — speak (T238)', () => {
  it('runs FREE in an ordinary folder — the voice switch is the gate, not a confirm', () => {
    const r = plan('speak', { folder: REPO, text: 'the migration finished' })
    expect(r.verdict).toBe('allow')
    expect(r.shouldDispatch).toBe(true)
    expect(r.shouldConfirm).toBe(false)
  })

  it('but `ask` mode still puts a human in front of it, like every other mutation', () => {
    const r = plan('speak', { folder: REPO, text: 'the migration finished' }, { ask: true })
    expect(r.verdict).toBe('confirm')
    expect(r.shouldConfirm).toBe(true)
  })

  it('a mission grant CANNOT cover it — no grant buys the speakers', () => {
    const grant: MissionGrant = {
      id: 'grant-1',
      goal: 'talk at me',
      folders: [REPO],
      // A grant listing `speak` is not even constructible through plan_mission's
      // schema; forcing it here proves the planner refuses it at the gate too.
      verbs: ['speak'] as unknown as MissionGrant['verbs'],
      budget: 5,
      used: 0,
      expiresAt: FIXED_NOW + 60_000
    }
    const r = planToolCall({
      tool: 'speak',
      input: { folder: REPO, text: 'hello' },
      policy: policy({ ask: true }),
      now: FIXED_NOW,
      grants: [grant]
    })
    expect(r.verdict).toBe('confirm')
    expect(r.grantAllow).toBeUndefined()
  })
})

describe('planToolCall — an explicit folder BLOCK is absolute', () => {
  const blocked = { denyFolders: [REPO] }

  it('a blocked folder denies a mutation', () => {
    const r = plan('create_session', { folder: REPO, kind: 'new' }, blocked)
    expect(r.verdict).toBe('deny')
    expect(r.shouldDispatch).toBe(false)
    expect(r.shouldConfirm).toBe(false)
  })

  it('a blocked folder denies a READ too', () => {
    const r = plan('memory_read', { folder: REPO }, blocked)
    expect(r.verdict).toBe('deny')
    expect(r.auditRecord.result).toBe('FOLDER_NOT_ALLOWED')
  })

  it('a path INSIDE a blocked folder is denied (the block covers the subtree)', () => {
    const wt = `${REPO}/.claude/worktrees/feat`
    const r = plan('spawn_terminal', { worktreePath: wt }, blocked)
    expect(r.verdict).toBe('deny')
  })

  it('T238: speak is denied in a blocked folder, before any voice setting is consulted', () => {
    // AC-3c at the GATE, not just in the handler: voice must never become a back
    // door into a folder the operator closed, so the block has to refuse `speak`
    // the same way it refuses `create_session` — with no per-verb exemption.
    const r = plan('speak', { folder: REPO, text: 'let me in' }, blocked)
    expect(r.verdict).toBe('deny')
    expect(r.auditRecord.result).toBe('FOLDER_NOT_ALLOWED')
    expect(r.shouldDispatch).toBe(false)
    expect(r.shouldConfirm).toBe(false)
  })

  it('adopt_folder does NOT bootstrap-confirm past a block (the exemption must not undo a deny)', () => {
    // `bootstrapConfirmOnDeny` used to turn a FOLDER_NOT_ALLOWED into a confirm. The
    // only FOLDER_NOT_ALLOWED left is an explicit block, and promoting THAT would put
    // the denylist one click away from being undone.
    const r = plan('adopt_folder', { folder: REPO }, blocked)
    expect(r.verdict).toBe('deny')
    expect(r.shouldConfirm).toBe(false)
  })

  it('plan_mission does NOT bootstrap-confirm past a block either', () => {
    const r = planToolCall({
      tool: 'plan_mission',
      input: { goal: 'g', folders: [REPO], verbs: ['create_worktree'], budget: 1, ttlMinutes: 5 },
      policy: policy({ denyFolders: [REPO] }),
      now: FIXED_NOW
    })
    // plan_mission carries no folder arg, so the gate cannot match it against the
    // block — it lands on its ordinary always-confirm path. The GRANT it would mint
    // still cannot reach the blocked folder (asserted in the grants suite below).
    expect(r.verdict).toBe('confirm')
  })

  it('the kill switch outranks even a block (SERVER_DISABLED is reported, not the block)', () => {
    const r = plan(
      'create_session',
      { folder: REPO, kind: 'new' },
      { ...blocked, serverEnabled: false }
    )
    expect(r.auditRecord.result).toBe('SERVER_DISABLED')
  })
})

describe('planToolCall — shouldDispatch / shouldConfirm derive strictly from the verdict', () => {
  it('an allowed read dispatches and never confirms', () => {
    const r = plan('get_fleet', {})
    expect(r.shouldDispatch).toBe(true)
    expect(r.shouldConfirm).toBe(false)
  })

  it('a deny neither dispatches nor confirms', () => {
    const r = plan('get_fleet', {}, { serverEnabled: false })
    expect(r.shouldDispatch).toBe(false)
    expect(r.shouldConfirm).toBe(false)
  })

  it('a confirm does NOT dispatch — dispatch waits for the human', () => {
    const r = plan('plan_mission', {
      goal: 'g',
      folders: [REPO],
      verbs: ['create_worktree'],
      budget: 1,
      ttlMinutes: 5
    })
    expect(r.shouldConfirm).toBe(true)
    expect(r.shouldDispatch).toBe(false)
  })
})

describe('planToolCall — redact directive is a property of the tool', () => {
  it('get_session => redact:transcript', () => {
    expect(plan('get_session', { id: 's1' }).redact).toBe('transcript')
  })

  it('get_session keeps redact:transcript EVEN when denied (verdict-independent)', () => {
    const r = plan('get_session', { id: 's1' }, { serverEnabled: false })
    expect(r.verdict).toBe('deny')
    expect(r.redact).toBe('transcript')
  })

  it('get_fleet => redact:paths', () => {
    expect(plan('get_fleet', {}).redact).toBe('paths')
  })

  it('a mutation carries redact:none', () => {
    expect(plan('create_session', { folder: REPO, kind: 'new' }).redact).toBe('none')
  })

  it('a non-disclosing read (list_worktrees) carries redact:none', () => {
    expect(plan('list_worktrees', { repoPath: REPO }).redact).toBe('none')
  })
})

describe('planToolCall — disclosedPayloadSummary reflects what was disclosed', () => {
  it('a non-dispatched (denied) call discloses nothing', () => {
    const r = plan('get_session', { id: 's1' }, { serverEnabled: false })
    expect(r.auditRecord.disclosedPayloadSummary).toBe('none')
  })

  it('an allowed disclosing read names the redaction applied to its payload', () => {
    expect(plan('get_fleet', {}).auditRecord.disclosedPayloadSummary).toBe('paths')
  })
})

describe('planToolCall — mission grants (T44 S5) still serve the guarded (ask) mode', () => {
  const NOW = FIXED_NOW
  const grant = (over: Partial<MissionGrant> = {}): MissionGrant => ({
    id: 'g1',
    goal: 'review PRs',
    folders: [REPO],
    dynamicFolders: [],
    verbs: ['create_worktree'],
    budget: 5,
    spent: 0,
    expiresAt: NOW + 60_000,
    createdAt: NOW - 1,
    revoked: false,
    ...over
  })
  const planG = (
    tool: string,
    input: unknown,
    grants: MissionGrant[],
    over: Partial<Policy> = {}
  ): ReturnType<typeof planToolCall> =>
    planToolCall({
      tool,
      input,
      // Grants only bite where there is a confirm to lift — i.e. the ask mode.
      policy: policy({ ask: true, ...over }),
      now: NOW,
      grants,
      homeDir: '/home/u'
    })

  it('auto-allows an in-scope mutation (ask-mode confirm → allow) + sets grantAllow', () => {
    const r = planG('create_worktree', { repoPath: REPO, branch: 'x' }, [grant()])
    expect(r.verdict).toBe('allow')
    expect(r.shouldDispatch).toBe(true)
    expect(r.grantAllow).toEqual({ grantId: 'g1' })
  })

  it('escalates (→confirm) an in-ambit call whose verb is out of scope; no grantAllow', () => {
    const r = planG('create_session', { folder: REPO, kind: 'new' }, [
      grant({ verbs: ['create_worktree'] })
    ])
    expect(r.verdict).toBe('confirm')
    expect(r.grantAllow).toBeUndefined()
  })

  it('an exhausted grant escalates instead of allowing', () => {
    const r = planG('create_worktree', { repoPath: REPO, branch: 'x' }, [
      grant({ spent: 5, budget: 5 })
    ])
    expect(r.verdict).toBe('confirm')
    expect(r.grantAllow).toBeUndefined()
  })

  it('NEVER overrides SERVER_DISABLED (grant behind the kill switch)', () => {
    const r = planG('create_worktree', { repoPath: REPO, branch: 'x' }, [grant()], {
      serverEnabled: false
    })
    expect(r.verdict).toBe('deny')
    expect(r.grantAllow).toBeUndefined()
  })

  it('NEVER overrides PATH_ESCAPE (grant behind containment), even when in scope', () => {
    const r = planG('create_worktree', { repoPath: REPO, branch: 'x' }, [grant()], {
      knownRoots: ['/other']
    })
    expect(r.verdict).toBe('deny')
    expect(r.grantAllow).toBeUndefined()
  })

  it('NEVER overrides an explicit folder BLOCK, even when the grant names that folder', () => {
    // The operator blocked the folder AND (earlier) approved a mission covering it.
    // The block is the later, narrower, more explicit statement — it wins.
    const r = planG(
      'create_worktree',
      { repoPath: REPO, branch: 'x' },
      [grant({ folders: [REPO] })],
      {
        denyFolders: [REPO]
      }
    )
    expect(r.verdict).toBe('deny')
    expect(r.grantAllow).toBeUndefined()
  })

  it('plan_mission is NEVER grant-allowed (no grant can mint another grant)', () => {
    const r = planG(
      'plan_mission',
      { goal: 'g', folders: [REPO], verbs: ['create_worktree'], budget: 1, ttlMinutes: 5 },
      [grant()]
    )
    expect(r.verdict).toBe('confirm')
    expect(r.grantAllow).toBeUndefined()
  })

  it('in the FREE mode a grant is inert — the mutation was already allowed, no grant burned', () => {
    // Nothing to lift, so no budget is spent: `grantAllow` must stay unset or a
    // free-mode fan-out would silently drain a mission's budget.
    const r = planToolCall({
      tool: 'create_worktree',
      input: { repoPath: REPO, branch: 'x' },
      policy: policy(),
      now: NOW,
      grants: [grant()],
      homeDir: '/home/u'
    })
    expect(r.verdict).toBe('allow')
    expect(r.grantAllow).toBeUndefined()
    expect(r.silentAllowInAgentFolder).toBe(true)
  })
})

describe('planToolCall — T72 inheritance machinery is retained but inert', () => {
  const WT = `${REPO}/.claude/worktrees/wt`
  const HOME = '/home/u'

  it('a mutation in a canonical worktree just RUNS — no discovery confirm to raise', () => {
    const r = planToolCall({
      tool: 'spawn_terminal',
      input: { worktreePath: WT },
      policy: policy(),
      now: FIXED_NOW,
      homeDir: HOME
    })
    expect(r.verdict).toBe('allow')
    expect(r.inheritDiscovery).toBeUndefined()
  })

  it('an inherit-once entry is not needed and burns nothing', () => {
    const r = planToolCall({
      tool: 'spawn_terminal',
      input: { worktreePath: WT },
      policy: policy(),
      now: FIXED_NOW,
      inheritOnce: [WT],
      homeDir: HOME
    })
    expect(r.verdict).toBe('allow')
    expect(r.inheritOnceAllow).toBeUndefined()
  })

  it('an inherit-once entry can NEVER unblock a blocked worktree', () => {
    // The once-registry survives a restart-free app session; if it could shadow a
    // block, a stale "Only this" would silently defeat a fresh operator block.
    const r = planToolCall({
      tool: 'spawn_terminal',
      input: { worktreePath: WT },
      policy: policy({ denyFolders: [REPO] }),
      now: FIXED_NOW,
      inheritOnce: [WT],
      homeDir: HOME
    })
    expect(r.verdict).toBe('deny')
    expect(r.inheritOnceAllow).toBeUndefined()
  })

  it('no discovery confirm is raised for a worktree inside a blocked repo', () => {
    const r = planToolCall({
      tool: 'spawn_terminal',
      input: { worktreePath: WT },
      policy: policy({ denyFolders: [REPO] }),
      now: FIXED_NOW,
      homeDir: HOME
    })
    expect(r.verdict).toBe('deny')
    expect(r.inheritDiscovery).toBeUndefined()
  })
})

describe('T215 message_session — the recipient folder is the gate anchor', () => {
  it('runs FREE in an unblocked recipient folder (silentAllowInAgentFolder)', () => {
    const r = plan('message_session', { sessionId: 'sess-1', message: 'hi', folder: REPO })
    expect(r.verdict).toBe('allow')
    expect(r.shouldDispatch).toBe(true)
    expect(r.shouldConfirm).toBe(false)
    expect(r.auditRecord.result).toBe('AGENT_ALLOWED')
  })

  it('a BLOCKED recipient folder is a DEAD-END deny — no bootstrap confirm', () => {
    // The block is the operator's, it covers the whole subtree, and
    // `message_session` carries no `bootstrapConfirmOnDeny`, so there is
    // nothing the agent can do to promote it into a confirm.
    const r = plan(
      'message_session',
      { sessionId: 'sess-1', message: 'hi', folder: REPO },
      { denyFolders: [REPO] }
    )
    expect(r.verdict).toBe('deny')
    expect(r.shouldConfirm).toBe(false)
    expect(r.shouldDispatch).toBe(false)
    expect(r.auditRecord.result).toBe('FOLDER_NOT_ALLOWED')
    expect(r.auditRecord.folder).toBe(REPO)
  })

  it('the `ask` friction pref puts a human confirm back in front of it', () => {
    const r = plan(
      'message_session',
      { sessionId: 'sess-1', message: 'hi', folder: REPO },
      { ask: true }
    )
    expect(r.verdict).toBe('confirm')
    expect(r.shouldConfirm).toBe(true)
  })

  it('with NO resolved folder the base gate allows — which is why the shell must resolve it', () => {
    // Post-reversal an absent folder is not a denial: there is no allowlist to
    // fail, and the denylist cannot match an unknown target. (The T215 spec
    // §2.5 predicted "every call gates as FOLDER_NOT_ALLOWED" — that was the
    // PRE-reversal behaviour and no longer holds.)
    //
    // So the containment is not this layer. It is (a) `server.ts` resolving the
    // RECIPIENT's folder from the scan AND both in-flight registries before
    // planning — which is exactly why the widening matters: without it a live
    // born-synthetic recipient in a BLOCKED folder would resolve to `undefined`
    // and slip past the block; and (b) the handler's own step 1, which refuses
    // `SESSION_NOT_FOUND` for any id absent from those same two sources — so an
    // id that reaches the handler always had a folder to gate on.
    const r = plan('message_session', { sessionId: 'sess-1', message: 'hi' })
    expect(r.shouldDispatch).toBe(true)
    expect(r.auditRecord.folder).toBe('')
  })

  it('discloses nothing — the ACK is an address, not a transcript', () => {
    const r = plan('message_session', { sessionId: 'sess-1', message: 'hi', folder: REPO })
    expect(r.redact).toBe('none')
  })
})

describe('T309 orchestrator_arm/orchestrator_disarm — the TARGET folder is the gate anchor (ADR-0013)', () => {
  for (const tool of ['orchestrator_arm', 'orchestrator_disarm']) {
    it(`${tool} runs FREE in an unblocked target folder (silentAllowInAgentFolder)`, () => {
      const r = plan(tool, { sessionId: 'sess-1', folder: REPO })
      expect(r.verdict).toBe('allow')
      expect(r.shouldDispatch).toBe(true)
      expect(r.shouldConfirm).toBe(false)
      expect(r.auditRecord.result).toBe('AGENT_ALLOWED')
    })

    it(`${tool}: AC-6 — a BLOCKED target folder is a DEAD-END deny (FOLDER_NOT_ALLOWED)`, () => {
      // Same reasoning as message_session: neither op carries
      // `bootstrapConfirmOnDeny`, so an explicit block has nothing to promote it
      // into — no confirm, no dispatch.
      const r = plan(tool, { sessionId: 'sess-1', folder: REPO }, { denyFolders: [REPO] })
      expect(r.verdict).toBe('deny')
      expect(r.shouldConfirm).toBe(false)
      expect(r.shouldDispatch).toBe(false)
      expect(r.auditRecord.result).toBe('FOLDER_NOT_ALLOWED')
      expect(r.auditRecord.folder).toBe(REPO)
    })

    it(`${tool}: the \`ask\` friction pref puts a human confirm back in front of it`, () => {
      const r = plan(tool, { sessionId: 'sess-1', folder: REPO }, { ask: true })
      expect(r.verdict).toBe('confirm')
      expect(r.shouldConfirm).toBe(true)
    })

    it(`${tool} discloses nothing`, () => {
      const r = plan(tool, { sessionId: 'sess-1', folder: REPO })
      expect(r.redact).toBe('none')
    })
  }
})
