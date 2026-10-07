import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  MCP_TOOLS,
  MCP_OPS,
  SAFE_GRANT_VERBS,
  ALWAYS_LOAD_OPS,
  isMcpOp,
  isGrantableVerb,
  isAlwaysLoadOp,
  toolByName,
  opByTool,
  formatHarnuUri,
  parseHarnuUri,
  type McpToolDef,
  type HarnuResource
} from '../src/main/mcp/tool-catalog'

/**
 * T5 — static MCP tool catalog + capy:// resource URIs + the op drift valve.
 *
 * The catalog is the single source of truth the server (T24) iterates to
 * register tools, and the router switches on each tool's `op`. The drift valve
 * (mirrors `claude-config-catalog`'s known-keys contract) pins that EVERY
 * tool's `op` is a member of the shared `MCP_OPS` union — a tool wired to an op
 * the router doesn't know is a latent 500, so the test fails loudly instead.
 *
 * Mutating vs read tools are pinned by name because the gate (T6/T9) keys the
 * approval requirement off `mutates`: a read mislabeled mutating just nags; a
 * mutation mislabeled read escapes the gate. `remove_worktree` is intentionally
 * absent from M1 (no destructive worktree op shipped).
 */

const READ_TOOLS = [
  'get_fleet',
  'get_session',
  'list_worktrees',
  'memory_read',
  'memory_query',
  'list_workers',
  'list_containers',
  'list_cleanup',
  // T358 S3: the Mission reads (design §4 "read, no gate").
  'mission_get',
  'mission_list'
] as const
const MUTATE_TOOLS = [
  'create_session',
  'create_worktree',
  'spawn_terminal',
  'remove_folder',
  'memory_append',
  'open_file',
  'draw_canvas',
  'create_card',
  'update_card',
  'move_card',
  'archive_card',
  'delete_card',
  'submit_manifest',
  'message_session',
  'create_worker',
  'update_worker',
  'delete_worker',
  'stop_containers',
  'start_containers',
  'remove_containers',
  'release_worktree',
  'orchestrator_arm',
  'orchestrator_disarm',
  // T358 S3: the Mission verb family's writes.
  'mission_create',
  'mission_add_step',
  'mission_update_step',
  'mission_link_child',
  'mission_log',
  // T358 S4
  'mission_set_blocker',
  'mission_clear_blocker',
  'mission_set_end',
  'mission_verify_step',
  'mission_request_close',
  // T358 S7
  'mission_import_legacy',
  // Mission v3 §3.6
  'mission_add_check'
] as const

describe('MCP_TOOLS catalog shape', () => {
  it('every tool has a non-empty name, description, and zod inputSchema', () => {
    for (const t of MCP_TOOLS) {
      expect(typeof t.name).toBe('string')
      expect(t.name.length).toBeGreaterThan(0)
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(0)
      expect(t.inputSchema instanceof z.ZodType).toBe(true)
      expect(typeof t.inputSchema.parse).toBe('function')
      expect(typeof t.mutates).toBe('boolean')
    }
  })

  it('tool names are unique', () => {
    const names = MCP_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('exposes the M1 read + mutate tools', () => {
    const names = new Set(MCP_TOOLS.map((t) => t.name))
    for (const n of [...READ_TOOLS, ...MUTATE_TOOLS]) expect(names.has(n)).toBe(true)
  })
})

describe('mutates classification', () => {
  it.each(READ_TOOLS)('read tool %s is mutates:false', (name) => {
    expect(toolByName(name)?.mutates).toBe(false)
  })

  it.each(MUTATE_TOOLS)('write tool %s is mutates:true', (name) => {
    expect(toolByName(name)?.mutates).toBe(true)
  })
})

describe('op drift valve (router shares the op union)', () => {
  it('every tool.op is a member of MCP_OPS', () => {
    const ops = new Set<string>(MCP_OPS)
    for (const t of MCP_TOOLS) {
      expect(ops.has(t.op)).toBe(true)
      expect(isMcpOp(t.op)).toBe(true)
    }
  })

  it('isMcpOp rejects unknown ops', () => {
    expect(isMcpOp('remove_worktree')).toBe(false)
    expect(isMcpOp('')).toBe(false)
    expect(isMcpOp(undefined)).toBe(false)
    expect(isMcpOp(42)).toBe(false)
  })

  it('opByTool resolves a known tool, undefined otherwise', () => {
    expect(opByTool('get_fleet')).toBe(toolByName('get_fleet')?.op)
    expect(opByTool('does_not_exist')).toBeUndefined()
  })

  it('toolByName resolves a known tool, undefined otherwise', () => {
    expect(toolByName('get_fleet')?.name).toBe('get_fleet')
    expect(toolByName('nope')).toBeUndefined()
  })
})

describe('grantable verbs (SAFE_GRANT_VERBS ⊂ mutating verbs, never a read)', () => {
  it('every SAFE_GRANT_VERB is a mutating tool op (a grant can only auto-allow mutations)', () => {
    for (const verb of SAFE_GRANT_VERBS) {
      const tool = MCP_TOOLS.find((t) => t.op === verb)
      expect(tool, `no catalog tool for grant verb ${verb}`).toBeDefined()
      expect(tool?.mutates).toBe(true)
    }
  })

  it('open_file (T74 S4) is grantable; reads + plan_mission are not', () => {
    expect(isGrantableVerb('open_file')).toBe(true)
    expect(isGrantableVerb('memory_read')).toBe(false)
    expect(isGrantableVerb('get_fleet')).toBe(false)
    expect(isGrantableVerb('plan_mission')).toBe(false)
  })

  it('T96: the board verbs need no grant — they are always silent-allowed, never SAFE_GRANT_VERBS', () => {
    expect(isGrantableVerb('create_card')).toBe(false)
    expect(isGrantableVerb('update_card')).toBe(false)
    expect(isGrantableVerb('move_card')).toBe(false)
  })

  it('T148: archive_card is ungrantable like the other board verbs; delete_card is ungrantable too (it never runs under a grant at all)', () => {
    expect(isGrantableVerb('archive_card')).toBe(false)
    expect(isGrantableVerb('delete_card')).toBe(false)
  })

  it('T104: submit_manifest is NEVER grantable — the verb IS the gate request, no grant can cover it', () => {
    expect(isGrantableVerb('submit_manifest')).toBe(false)
    expect((SAFE_GRANT_VERBS as readonly string[]).includes('submit_manifest')).toBe(false)
  })
})

describe('alwaysLoad turn-1 visibility (T93)', () => {
  // The exact set the card names: reads the session needs at hand + the memory +
  // mission planning + report delivery. A change here is a deliberate decision.
  const EXPECTED_ALWAYS_LOAD = [
    'get_fleet',
    'get_session',
    'memory_read',
    'memory_query',
    'plan_mission',
    'open_file'
  ] as const

  it('ALWAYS_LOAD_OPS is exactly the intended turn-1 verb set', () => {
    expect([...ALWAYS_LOAD_OPS].sort()).toEqual([...EXPECTED_ALWAYS_LOAD].sort())
  })

  it('each turn-1 verb def carries alwaysLoad:true (derived from the set, no drift)', () => {
    for (const op of ALWAYS_LOAD_OPS) {
      const tool = MCP_TOOLS.find((t) => t.op === op)
      expect(tool, `no catalog tool for always-load op ${op}`).toBeDefined()
      expect(tool?.alwaysLoad).toBe(true)
      expect(isAlwaysLoadOp(op)).toBe(true)
    }
  })

  it('every OTHER verb stays deferred (alwaysLoad falsy)', () => {
    for (const t of MCP_TOOLS) {
      if ((ALWAYS_LOAD_OPS as readonly string[]).includes(t.op)) continue
      expect(t.alwaysLoad ?? false).toBe(false)
      expect(isAlwaysLoadOp(t.op)).toBe(false)
    }
  })

  it('list_worktrees, create_*, spawn_terminal, adopt_folder, memory_append stay deferred', () => {
    for (const op of [
      'list_worktrees',
      'create_session',
      'create_worktree',
      'spawn_terminal',
      'adopt_folder',
      'memory_append',
      'get_approval',
      'submit_manifest'
    ]) {
      expect(isAlwaysLoadOp(op)).toBe(false)
    }
  })
})

describe('T120 declarative gate fields — the def is the single source of truth', () => {
  const grantableExpected = [
    'create_session',
    'create_worktree',
    'spawn_terminal',
    'adopt_folder',
    'remove_folder',
    'memory_append',
    'open_file',
    'notify',
    'draw_canvas',
    // T215: grant-listed, but NOT on `notify`'s justification — a peer message
    // is input injected into an agent that can act. Its containment is the
    // recipient scope enforced in the handler, not this flag.
    'message_session'
  ]
  const alwaysAllowableExpected = grantableExpected
  const dangerousExpected = ['create_worktree', 'spawn_terminal']
  // Post-reversal this is EVERY mutating verb except the one that must always face a
  // human: `plan_mission` (mints a grant). `submit_manifest` (T187) carries this flag
  // too — moving a card to Ready is the operator's consent to dispatch it, so a second
  // confirm here was the whole reported bug. `plan-tool-call.ts` reads the absence of
  // this flag as "force a confirm", so this list IS the free/asks split — keep it
  // exhaustive.
  const silentAllowExpected = [
    'create_session',
    'create_worktree',
    'spawn_terminal',
    'adopt_folder',
    'remove_folder',
    'memory_append',
    'open_file',
    'notify',
    // T238: free like every other mutating verb, but NOT grantable and NOT
    // always-allowable — its real gate is the operator's voice switch, which
    // nothing may buy on their behalf.
    'speak',
    'draw_canvas',
    'submit_manifest',
    'create_card',
    'update_card',
    'move_card',
    'archive_card',
    'message_session',
    // T308: carries the tool-level flag like every other mutating verb — the
    // `mode: 'act'` narrowing is a SEPARATE mechanism (`forceConfirmFor`),
    // exercised in mcp-plan-tool-call.test.ts, not this list.
    'create_worker',
    // T316: same reasoning as create_worker — the tool-level flag is free; the
    // `mode:'act'`/`prompt` narrowing is `forceConfirmFor`, tested separately.
    'update_worker',
    // T329: both reversible, so free; stop's `force: true` narrowing is
    // `forceConfirmFor`, tested separately. remove_containers is NOT here.
    'stop_containers',
    'start_containers',
    // T309: free like every other mutating verb; NOT grantable/always-allowable
    // — see the MCP_OPS T309 comment (a different risk class from the repeated,
    // in-scope actions a mission grant exists to cover).
    'orchestrator_arm',
    'orchestrator_disarm',
    // T358 S3: the Mission writes run free, the same class as create_card
    // (design §4) — NOT grantable/always-allowable.
    'mission_create',
    'mission_add_step',
    'mission_update_step',
    'mission_link_child',
    'mission_log',
    // T358 S4
    'mission_set_blocker',
    'mission_clear_blocker',
    'mission_set_end',
    'mission_verify_step',
    'mission_request_close',
    // T358 S7
    'mission_import_legacy',
    // Mission v3 §3.6
    'mission_add_check'
  ]
  const bootstrapExpected = ['adopt_folder', 'plan_mission']

  it('grantable is exactly the SAFE_GRANT_VERBS set', () => {
    const actual = MCP_TOOLS.filter((t) => t.grantable).map((t) => t.op)
    expect([...actual].sort()).toEqual([...grantableExpected].sort())
  })

  it('alwaysAllowable is exactly the durable-allow-eligible set', () => {
    const actual = MCP_TOOLS.filter((t) => t.alwaysAllowable).map((t) => t.op)
    expect([...actual].sort()).toEqual([...alwaysAllowableExpected].sort())
  })

  it('dangerousAlwaysAllow is exactly create_worktree/spawn_terminal', () => {
    const actual = MCP_TOOLS.filter((t) => t.dangerousAlwaysAllow).map((t) => t.op)
    expect([...actual].sort()).toEqual([...dangerousExpected].sort())
  })

  it('silentAllowInAgentFolder is every mutating verb EXCEPT plan_mission', () => {
    const actual = MCP_TOOLS.filter((t) => t.silentAllowInAgentFolder).map((t) => t.op)
    expect([...actual].sort()).toEqual([...silentAllowExpected].sort())
  })

  it('the ONLY mutating verbs without the free flag are plan_mission + delete_card + delete_worker + remove_containers', () => {
    // Derived from `mutates`, so a new mutating verb that forgets the flag shows up
    // here instead of silently becoming an always-confirm verb nobody intended.
    // T148: delete_card is here DELIBERATELY (irreversible, unlike its archive_card
    // sibling); T187 removed submit_manifest from this list — see the HARD INVARIANT
    // tests below. T316: delete_worker joins it for the identical reason, and T329's
    // remove_containers too (a removed container has no undo).
    const asks = MCP_TOOLS.filter((t) => t.mutates && !t.silentAllowInAgentFolder).map((t) => t.op)
    expect([...asks].sort()).toEqual([
      'delete_card',
      'delete_worker',
      'plan_mission',
      'remove_containers'
    ])
  })

  it('bootstrapConfirmOnDeny is exactly adopt_folder + plan_mission', () => {
    const actual = MCP_TOOLS.filter((t) => t.bootstrapConfirmOnDeny).map((t) => t.op)
    expect([...actual].sort()).toEqual([...bootstrapExpected].sort())
  })

  it('discloses is get_session:transcript, get_fleet/list_containers/list_cleanup:paths, everything else undefined', () => {
    for (const t of MCP_TOOLS) {
      if (t.op === 'get_session') expect(t.discloses).toBe('transcript')
      else if (t.op === 'get_fleet' || t.op === 'list_containers' || t.op === 'list_cleanup')
        expect(t.discloses).toBe('paths')
      else expect(t.discloses).toBeUndefined()
    }
  })

  it('disclosesTranscript is get_session/memory_read/memory_query only', () => {
    const actual = MCP_TOOLS.filter((t) => t.disclosesTranscript).map((t) => t.op)
    expect([...actual].sort()).toEqual(['get_session', 'memory_query', 'memory_read'].sort())
  })

  it('HARD INVARIANT: submit_manifest is NEVER grantable — but IS silently allowed (T187)', () => {
    const def = toolByName('submit_manifest')
    expect(def?.grantable).toBeFalsy()
    expect(def?.alwaysAllowable).toBeFalsy()
    expect(def?.silentAllowInAgentFolder).toBe(true)
  })

  it('HARD INVARIANT: delete_card is NEVER grantable and NEVER silently allowed — unlike archive_card, there is no undo', () => {
    const def = toolByName('delete_card')
    expect(def?.mutates).toBe(true)
    expect(def?.grantable).toBeFalsy()
    expect(def?.alwaysAllowable).toBeFalsy()
    expect(def?.silentAllowInAgentFolder).toBeFalsy()
  })

  it('HARD INVARIANT: delete_worker is NEVER grantable and NEVER silently allowed — unlike update_worker, there is no undo', () => {
    const def = toolByName('delete_worker')
    expect(def?.mutates).toBe(true)
    expect(def?.grantable).toBeFalsy()
    expect(def?.alwaysAllowable).toBeFalsy()
    expect(def?.silentAllowInAgentFolder).toBeFalsy()
  })

  it('HARD INVARIANT: plan_mission is never always-allowable but keeps its bootstrap exemption', () => {
    const def = toolByName('plan_mission')
    expect(def?.alwaysAllowable).toBeFalsy()
    expect(def?.grantable).toBeFalsy()
    expect(def?.bootstrapConfirmOnDeny).toBe(true)
  })

  it('HARD INVARIANT: adopt_folder keeps its bootstrap exemption', () => {
    expect(toolByName('adopt_folder')?.bootstrapConfirmOnDeny).toBe(true)
  })

  it('a gate field omitted on MCP_TOOLS fails CLOSED (falsy), never throws', () => {
    // list_worktrees/get_approval carry none of the mutation-gate fields.
    for (const name of ['list_worktrees', 'get_approval']) {
      const def = toolByName(name)
      expect(def?.grantable).toBeFalsy()
      expect(def?.alwaysAllowable).toBeFalsy()
      expect(def?.silentAllowInAgentFolder).toBeFalsy()
      expect(def?.bootstrapConfirmOnDeny).toBeFalsy()
    }
  })

  it('MCP_TOOLS itself never carries a handler — only WIRED_TOOLS (tool-handlers.ts) does', () => {
    for (const t of MCP_TOOLS) {
      expect(t.handler).toBeUndefined()
    }
  })
})

describe('draw_canvas gate class (T218 U5 §8.4)', () => {
  it('is classed exactly like open_file/notify — free, grantable, always-allowable', () => {
    const draw = toolByName('draw_canvas')
    const openFile = toolByName('open_file')
    expect(draw?.mutates).toBe(true)
    expect(draw?.grantable).toBe(openFile?.grantable)
    expect(draw?.alwaysAllowable).toBe(openFile?.alwaysAllowable)
    expect(draw?.silentAllowInAgentFolder).toBe(openFile?.silentAllowInAgentFolder)
    // NOT dangerous (it runs no shell) and NOT a bootstrap verb.
    expect(draw?.dangerousAlwaysAllow ?? false).toBe(false)
    expect(draw?.bootstrapConfirmOnDeny ?? false).toBe(false)
  })

  it('stays DEFERRED — it is not a turn-1 verb', () => {
    expect(isAlwaysLoadOp('draw_canvas')).toBe(false)
  })

  it('the description discloses the three facts an agent must not have to guess', () => {
    const d = toolByName('draw_canvas')?.description ?? ''
    // all-or-nothing, the server-stamped origin, and the ACK-borne catalog.
    expect(d).toMatch(/ALL-OR-NOTHING/)
    expect(d).toMatch(/origin/)
    expect(d).toMatch(/shapes/)
  })
})

describe("speak gate class (T238) — deliberately NOT notify's", () => {
  it('is free like every mutating verb, but NEITHER grantable NOR always-allowable', () => {
    const speak = toolByName('speak')
    expect(speak?.mutates).toBe(true)
    expect(speak?.silentAllowInAgentFolder).toBe(true)
    // The whole point of the card: `notify`'s justification ("only appends to a
    // local, read-only history") does not survive a verb that makes the machine
    // talk to the room. No mission grant and no durable checkbox buys the
    // speakers — the operator's own voice switch is the only door.
    expect(speak?.grantable ?? false).toBe(false)
    expect(speak?.alwaysAllowable ?? false).toBe(false)
    expect(speak?.bootstrapConfirmOnDeny ?? false).toBe(false)
  })

  it('is classed differently from notify, on exactly those two fields', () => {
    const speak = toolByName('speak')
    const notify = toolByName('notify')
    expect(speak?.grantable).not.toBe(notify?.grantable)
    expect(speak?.alwaysAllowable).not.toBe(notify?.alwaysAllowable)
    expect(speak?.silentAllowInAgentFolder).toBe(notify?.silentAllowInAgentFolder)
  })

  it('is NOT in SAFE_GRANT_VERBS — a mission cannot buy the speakers', () => {
    expect((SAFE_GRANT_VERBS as readonly string[]).includes('speak')).toBe(false)
  })

  it('stays DEFERRED — it is not a turn-1 verb', () => {
    expect(isAlwaysLoadOp('speak')).toBe(false)
  })

  it('the description discloses the four facts an agent must not have to guess', () => {
    const d = toolByName('speak')?.description ?? ''
    expect(d).toMatch(/EPHEMERAL/) // no Activity row, no toast
    expect(d).toMatch(/VOICE_DISABLED/) // the refusal it will actually meet
    expect(d).toMatch(/TRUNCATED/) // over-cap text is not rejected
    expect(d).toMatch(/focus|focused/) // silent while you are looking at it
  })
})

describe('create_worker / list_workers (T308)', () => {
  it('create_worker is mutating, free by tool-level flag, but NOT grantable/always-allowable', () => {
    const def = toolByName('create_worker')
    expect(def?.mutates).toBe(true)
    expect(def?.silentAllowInAgentFolder).toBe(true)
    expect(def?.grantable ?? false).toBe(false)
    expect(def?.alwaysAllowable ?? false).toBe(false)
  })

  it('create_worker carries forceConfirmFor, forced true ONLY for mode:"act"', () => {
    const def = toolByName('create_worker')
    expect(typeof def?.forceConfirmFor).toBe('function')
    expect(def?.forceConfirmFor?.({ mode: 'act' })).toBe(true)
    expect(def?.forceConfirmFor?.({ mode: 'observe' })).toBe(false)
    expect(def?.forceConfirmFor?.({})).toBe(false)
  })

  it('list_workers is a plain read, no gate fields', () => {
    const def = toolByName('list_workers')
    expect(def?.mutates).toBe(false)
    expect(def?.grantable ?? false).toBe(false)
    expect(def?.silentAllowInAgentFolder ?? false).toBe(false)
  })

  it('both stay deferred — neither is a turn-1 verb', () => {
    expect(isAlwaysLoadOp('create_worker')).toBe(false)
    expect(isAlwaysLoadOp('list_workers')).toBe(false)
  })

  it('neither is grant-listed', () => {
    expect((SAFE_GRANT_VERBS as readonly string[]).includes('create_worker')).toBe(false)
    expect((SAFE_GRANT_VERBS as readonly string[]).includes('list_workers')).toBe(false)
  })
})

describe('list_containers (T328)', () => {
  it('is a read that discloses paths, with no gate field of a mutation', () => {
    const def = toolByName('list_containers')
    expect(def?.op).toBe('list_containers')
    expect(def?.mutates).toBe(false)
    expect(def?.discloses).toBe('paths')
    expect(def?.disclosesTranscript ?? false).toBe(false)
    expect(def?.grantable ?? false).toBe(false)
    expect(def?.alwaysAllowable ?? false).toBe(false)
    expect(def?.silentAllowInAgentFolder ?? false).toBe(false)
  })

  it('is deferred and never grant-listed', () => {
    expect(isAlwaysLoadOp('list_containers')).toBe(false)
    expect((SAFE_GRANT_VERBS as readonly string[]).includes('list_containers')).toBe(false)
  })

  it('takes only an optional folder', () => {
    const schema = toolByName('list_containers')!.inputSchema
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ folder: '/abs' }).success).toBe(true)
    expect(schema.safeParse({ folder: '' }).success).toBe(false)
  })

  it('the description names the DOCKER_UNAVAILABLE refusal', () => {
    expect(toolByName('list_containers')!.description).toContain('DOCKER_UNAVAILABLE')
  })
})

describe('list_cleanup / release_worktree (T445)', () => {
  it('list_cleanup is a deferred read that discloses paths, with no mutation gate field', () => {
    const def = toolByName('list_cleanup')
    expect(def?.op).toBe('list_cleanup')
    expect(def?.mutates).toBe(false)
    expect(def?.discloses).toBe('paths')
    expect(def?.grantable ?? false).toBe(false)
    expect(def?.alwaysAllowable ?? false).toBe(false)
    expect(def?.silentAllowInAgentFolder ?? false).toBe(false)
    expect(isAlwaysLoadOp('list_cleanup')).toBe(false)
  })

  it('list_cleanup takes only an optional folder', () => {
    const schema = toolByName('list_cleanup')!.inputSchema
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ folder: '/abs' }).success).toBe(true)
    expect(schema.safeParse({ folder: '' }).success).toBe(false)
  })

  it('release_worktree runs free — silent-allowed, not grantable, not always-allowable, no force-confirm', () => {
    const def = toolByName('release_worktree')
    expect(def?.mutates).toBe(true)
    expect(def?.silentAllowInAgentFolder).toBe(true)
    expect(def?.forceConfirmFor).toBeUndefined()
    expect(def?.grantable ?? false).toBe(false)
    expect(def?.alwaysAllowable ?? false).toBe(false)
    expect(isAlwaysLoadOp('release_worktree')).toBe(false)
    expect((SAFE_GRANT_VERBS as readonly string[]).includes('release_worktree')).toBe(false)
  })

  it('release_worktree requires a folder', () => {
    const schema = toolByName('release_worktree')!.inputSchema
    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ folder: '/abs' }).success).toBe(true)
  })

  it('the descriptions name the refusal codes and say nothing is deleted', () => {
    const d = toolByName('release_worktree')!.description
    for (const code of [
      'FATE_NOT_MERGED',
      'FOLDER_NOT_ALLOWED',
      'IS_MAIN_CHECKOUT',
      'NOT_A_WORKTREE'
    ])
      expect(d).toContain(code)
    expect(d).toMatch(/deletes nothing/i)
  })

  it('AC-5: no verb that removes a worktree, bundle or volume exists', () => {
    const names = MCP_TOOLS.map((t) => t.name)
    expect(names.filter((n) => /clean|remove_worktree|sweep|prune/.test(n))).toEqual([
      'list_cleanup'
    ])
  })
})

describe('stop / start / remove_containers (T329)', () => {
  it('start_containers runs free like archive_card — silent-allowed, not grantable/always-allowable', () => {
    const def = toolByName('start_containers')
    expect(def?.mutates).toBe(true)
    expect(def?.silentAllowInAgentFolder).toBe(true)
    expect(def?.forceConfirmFor).toBeUndefined()
    expect(def?.grantable ?? false).toBe(false)
    expect(def?.alwaysAllowable ?? false).toBe(false)
  })

  it('stop_containers runs free, and forceConfirmFor fires ONLY on force:true', () => {
    const def = toolByName('stop_containers')
    expect(def?.mutates).toBe(true)
    expect(def?.silentAllowInAgentFolder).toBe(true)
    expect(def?.grantable ?? false).toBe(false)
    expect(def?.alwaysAllowable ?? false).toBe(false)
    expect(def?.forceConfirmFor?.({ stacks: ['a'], force: true })).toBe(true)
    expect(def?.forceConfirmFor?.({ stacks: ['a'], force: false })).toBe(false)
    expect(def?.forceConfirmFor?.({ stacks: ['a'] })).toBe(false)
    expect(def?.forceConfirmFor?.({ stacks: ['a'], force: 'true' })).toBe(false)
  })

  it('remove_containers ALWAYS asks — no free flag, not grantable, not always-allowable', () => {
    const def = toolByName('remove_containers')
    expect(def?.mutates).toBe(true)
    expect(def?.silentAllowInAgentFolder ?? false).toBe(false)
    expect(def?.grantable ?? false).toBe(false)
    expect(def?.alwaysAllowable ?? false).toBe(false)
    expect(def?.forceConfirmFor).toBeUndefined()
  })

  it('none is grant-listed or a turn-1 verb', () => {
    for (const op of ['stop_containers', 'start_containers', 'remove_containers']) {
      expect((SAFE_GRANT_VERBS as readonly string[]).includes(op)).toBe(false)
      expect(isAlwaysLoadOp(op)).toBe(false)
    }
  })

  it('remove_containers takes exactly one stack, never a list', () => {
    const schema = toolByName('remove_containers')!.inputSchema
    expect(schema.safeParse({ stack: 'a' }).success).toBe(true)
    expect(schema.safeParse({ stack: 'a', removeVolumes: true }).success).toBe(true)
    expect(schema.safeParse({ stack: ['a'] }).success).toBe(false)
    expect(schema.safeParse({ stacks: ['a'] }).success).toBe(false)
    expect(schema.safeParse({ stack: 'a', stacks: ['a', 'b'] }).success).toBe(false)
  })

  it('stop_containers and start_containers take a non-empty list', () => {
    for (const name of ['stop_containers', 'start_containers']) {
      const schema = toolByName(name)!.inputSchema
      expect(schema.safeParse({ stacks: ['a', 'b'] }).success).toBe(true)
      expect(schema.safeParse({ stacks: [] }).success).toBe(false)
      expect(schema.safeParse({ stacks: 'a' }).success).toBe(false)
    }
  })
})

describe('update_worker / delete_worker (T316)', () => {
  it('update_worker is mutating, free by tool-level flag, but NOT grantable/always-allowable', () => {
    const def = toolByName('update_worker')
    expect(def?.mutates).toBe(true)
    expect(def?.silentAllowInAgentFolder).toBe(true)
    expect(def?.grantable ?? false).toBe(false)
    expect(def?.alwaysAllowable ?? false).toBe(false)
  })

  it('update_worker carries forceConfirmFor, forced true for mode:"act" OR any prompt edit', () => {
    const def = toolByName('update_worker')
    expect(typeof def?.forceConfirmFor).toBe('function')
    expect(def?.forceConfirmFor?.({ set: { mode: 'act' } })).toBe(true)
    expect(def?.forceConfirmFor?.({ set: { prompt: 'new prompt' } })).toBe(true)
    expect(def?.forceConfirmFor?.({ set: { mode: 'observe' } })).toBe(false)
    expect(def?.forceConfirmFor?.({ set: { everyMinutes: 10 } })).toBe(false)
    expect(def?.forceConfirmFor?.({ set: {} })).toBe(false)
    expect(def?.forceConfirmFor?.({})).toBe(false)
  })

  it('delete_worker ALWAYS confirms — mutating, no free flag, not grantable/always-allowable', () => {
    const def = toolByName('delete_worker')
    expect(def?.mutates).toBe(true)
    expect(def?.silentAllowInAgentFolder ?? false).toBe(false)
    expect(def?.grantable ?? false).toBe(false)
    expect(def?.alwaysAllowable ?? false).toBe(false)
  })

  it('both stay deferred — neither is a turn-1 verb', () => {
    expect(isAlwaysLoadOp('update_worker')).toBe(false)
    expect(isAlwaysLoadOp('delete_worker')).toBe(false)
  })

  it('neither is grant-listed', () => {
    expect((SAFE_GRANT_VERBS as readonly string[]).includes('update_worker')).toBe(false)
    expect((SAFE_GRANT_VERBS as readonly string[]).includes('delete_worker')).toBe(false)
  })
})

describe('create_worker accepts timeoutSeconds (T316 AC-5)', () => {
  it('inputSchema parses an explicit timeoutSeconds and leaves it optional', () => {
    const schema = toolByName('create_worker')!.inputSchema
    const withTimeout = schema.safeParse({
      folder: '/repo',
      name: 'n',
      prompt: 'p',
      everyMinutes: 10,
      timeoutSeconds: 900
    })
    expect(withTimeout.success).toBe(true)
    const without = schema.safeParse({ folder: '/repo', name: 'n', prompt: 'p', everyMinutes: 10 })
    expect(without.success).toBe(true)
  })

  it('rejects a non-positive timeoutSeconds', () => {
    const schema = toolByName('create_worker')!.inputSchema
    const bad = schema.safeParse({
      folder: '/repo',
      name: 'n',
      prompt: 'p',
      everyMinutes: 10,
      timeoutSeconds: 0
    })
    expect(bad.success).toBe(false)
  })
})

describe('orchestrator_arm / orchestrator_disarm gate class (T309, ADR-0013)', () => {
  it('are free like every mutating verb, but NEITHER grantable NOR always-allowable', () => {
    for (const name of ['orchestrator_arm', 'orchestrator_disarm']) {
      const def = toolByName(name)
      expect(def?.mutates).toBe(true)
      expect(def?.silentAllowInAgentFolder).toBe(true)
      expect(def?.grantable ?? false).toBe(false)
      expect(def?.alwaysAllowable ?? false).toBe(false)
      expect(def?.bootstrapConfirmOnDeny ?? false).toBe(false)
    }
  })

  it('are NOT in SAFE_GRANT_VERBS — arming another session is not a mission-buyable action', () => {
    expect((SAFE_GRANT_VERBS as readonly string[]).includes('orchestrator_arm')).toBe(false)
    expect((SAFE_GRANT_VERBS as readonly string[]).includes('orchestrator_disarm')).toBe(false)
  })

  it('stay DEFERRED — neither is a turn-1 verb', () => {
    expect(isAlwaysLoadOp('orchestrator_arm')).toBe(false)
    expect(isAlwaysLoadOp('orchestrator_disarm')).toBe(false)
  })

  it('the input schema is sessionId-only — no caller-supplied folder to spoof', () => {
    for (const name of ['orchestrator_arm', 'orchestrator_disarm']) {
      const def = toolByName(name)
      const shape = (def?.inputSchema as z.ZodObject<z.ZodRawShape>).shape
      expect(Object.keys(shape)).toEqual(['sessionId'])
    }
  })
})

describe('no destructive worktree op in M1', () => {
  it('does NOT expose remove_worktree', () => {
    expect(MCP_TOOLS.some((t) => t.name === 'remove_worktree')).toBe(false)
    expect(toolByName('remove_worktree')).toBeUndefined()
    expect((MCP_OPS as readonly string[]).includes('remove_worktree')).toBe(false)
  })
})

describe('harnu:// resource URIs (parse/format round-trip)', () => {
  const cases: HarnuResource[] = [
    { kind: 'fleet' },
    { kind: 'session', id: 'abc-123' },
    { kind: 'worktrees' }
  ]

  it.each(cases)('format → parse round-trips %o', (resource) => {
    const uri = formatHarnuUri(resource)
    expect(parseHarnuUri(uri)).toEqual(resource)
  })

  it('formats the canonical shapes', () => {
    expect(formatHarnuUri({ kind: 'fleet' })).toBe('harnu://fleet')
    expect(formatHarnuUri({ kind: 'session', id: 'xyz' })).toBe('harnu://session/xyz')
    expect(formatHarnuUri({ kind: 'worktrees' })).toBe('harnu://worktrees')
  })

  it('parse → format round-trips the string form', () => {
    for (const uri of ['harnu://fleet', 'harnu://session/s-1', 'harnu://worktrees']) {
      const parsed = parseHarnuUri(uri)
      expect(parsed).not.toBeNull()
      expect(formatHarnuUri(parsed as HarnuResource)).toBe(uri)
    }
  })

  it('still parses the pre-rename capy:// scheme (a client with a cached URI)', () => {
    expect(parseHarnuUri('capy://fleet')).toEqual({ kind: 'fleet' })
    expect(parseHarnuUri('capy://worktrees')).toEqual({ kind: 'worktrees' })
    expect(parseHarnuUri('capy://session/s-1')).toEqual({ kind: 'session', id: 's-1' })
    // ...but never emits it.
    expect(formatHarnuUri(parseHarnuUri('capy://fleet') as HarnuResource)).toBe('harnu://fleet')
  })

  it('returns null on malformed / foreign URIs, under either scheme', () => {
    expect(parseHarnuUri('http://fleet')).toBeNull()
    expect(parseHarnuUri('')).toBeNull()
    for (const scheme of ['harnu://', 'capy://']) {
      expect(parseHarnuUri(scheme)).toBeNull()
      expect(parseHarnuUri(`${scheme}session`)).toBeNull()
      expect(parseHarnuUri(`${scheme}session/`)).toBeNull()
      expect(parseHarnuUri(`${scheme}unknown`)).toBeNull()
      expect(parseHarnuUri(`${scheme}fleet/extra`)).toBeNull()
    }
  })
})

describe('type surface', () => {
  it('McpToolDef is structurally assignable', () => {
    const t: McpToolDef = MCP_TOOLS[0]
    expect(t).toBeDefined()
  })
})

describe('create_worktree — existingWork collision warning (BUG-40 §3.5 / BUG-50 absorbed)', () => {
  it('the description discloses the non-blocking existingWork ACK field', () => {
    const tool = toolByName('create_worktree')
    expect(tool?.description).toMatch(/existingWork/)
    // "warn, never block" is the load-bearing contract (spec §3.5) — a create
    // that finds a slug match still succeeds.
    expect(tool?.description).toMatch(/non-blocking/)
  })
})
