# T447 — `$.harnu` contract (§5.1 of the spec)

**Part of:** [`00-spec.md`](00-spec.md) · **Card:** T447 · **Status:** specified (not implemented)

This file is §5.1 of the spec, split out for length. It is the proposed content of
`resources/harnu-sdk/types/index.d.ts`: the one self-contained contract the `harnu` mod ships and
the engine lays into every dependent (`00-spec.md` §3.3, §3.4). Section references below point at
`00-spec.md`.

**Checked, not just written.** This exact text was laid at
`decision-log/.claude-plugin/types/harnu/index.d.ts` (where the engine puts a dependency's
contract) beside the 2.1.295 `claude-code` types, and `tsc -p` over the worked example of
[`02-worked-example.md`](02-worked-example.md) reported no error (2026-10-09).

Changes from round 1: `PENDING` and `approvalWait` (a parked confirm is never success, §5.3);
`PATH_ESCAPE`, `NOT_LINKED`, `READ_ONLY`; `sessionGet` takes no id (own session only); `boardGet`
and the `board` topic; `missionGet`, and `role`/`mySteps` on a mission (§5.4); `sessionVerified`
and `interactive` on the identity; `cardCreate` no longer accepts `prd`/`adr`, which `create_card`
does not take.

```ts
// The `harnu` mod's contract. Self-contained: no import, no reference (TYPES:91-99).
// Every exported name is led by `Harnu`. SemVer: the mod's plugin.json `version` (§11).

/** Where this session stands relative to Harnu (§7). */
export type HarnuEnv =
  | 'inside' // spawned by Harnu, Harnu MCP connected
  | 'inside-no-mcp' // spawned by Harnu, MCP withheld (agent-controlled or read-only spawn)
  | 'outside' // not spawned by Harnu (no HARNU_SPAWN_TOKEN)
  | 'no-harnu' // Harnu is not running, or not reachable

/** The companion's state as the user sees it in Settings → Mods (T389/P1W3 §10). */
export type HarnuCompanionState = 'live' | 'legacy' | 'off'

export type HarnuIdentity = {
  env: HarnuEnv
  /** True only for `inside` and `inside-no-mcp`: Harnu spawned this session. */
  inside: boolean
  /** The companion's bound `sid`. Outside Harnu it is a CLAIM the host has not verified (§7.1). */
  sessionId?: string
  /** True when `sessionId` comes from a spawn-token binding; false for an outside claim. */
  sessionVerified: boolean
  /** `session.start`'s `isInteractive`. False (a `-p` run, a tick) makes every write `READ_ONLY`. */
  interactive: boolean
  /** The folder every folder-scoped call targets: `$.session.root()` at session start. */
  folder: string
  companion: HarnuCompanionState
  /** Whether a server named `harnu` answered in this session. */
  mcp: boolean
  sdk: string
}

export type HarnuErrorCode =
  | 'OUTSIDE_HARNU' // env is `outside` or `no-harnu` and the method has no fallback
  | 'NO_MCP' // env is `inside-no-mcp`: Harnu withheld its server on purpose
  | 'NO_IDENTITY' // the method needs this session's id and none is known
  | 'NOT_LINKED' // the mission or step is not this session's (§5.4)
  | 'READ_ONLY' // a write in a non-interactive session (§7.3)
  | 'UNSUPPORTED' // the server does not know the verb (older Harnu) or the SDK lacks it
  | 'EXCLUDED' // the argument asks for something the noun never offers (§9.1)
  | 'BAD_ARGS' // refused by the noun's own validation before any call
  | 'FOLDER_NOT_ALLOWED' // the operator blocked this folder for agents
  | 'PATH_ESCAPE' // "Ask" is on and the folder is outside every known root
  | 'PENDING' // "Ask" is on and the operator has not answered yet: NOT done (§5.3)
  | 'CONFIRM_DENIED' // the operator said no, or the confirm could not be shown
  | 'TIMEOUT' // TOOL_TIMEOUT from the server, or `approvalWait` ran out
  | 'REFUSED' // any other server refusal; `serverCode` carries Harnu's own code

export type HarnuError = {
  ok: false
  error: HarnuErrorCode
  /** Harnu's own refusal code or confirm reason, verbatim (`CARD_IN_PROGRESS`, `DENY_BUSY`, …). */
  serverCode?: string
  /** Present only with `PENDING`: pass it to `approvalWait`. */
  approvalId?: string
  message: string
  /** Harnu's `nextActions`, passed through when the refusal carried them. */
  nextActions?: readonly { do: string; why: string }[]
}

/**
 * Every method resolves; none rejects for a refusal (the `$.mcp.connect` convention,
 * TYPES:2719-2732). A write the operator has not approved yet is `{ ok: false, error: 'PENDING' }`,
 * never `ok: true`.
 */
export type HarnuResult<T> = ({ ok: true } & T) | HarnuError

/** A read answered from a cache or from disk says so. */
export type HarnuFreshness = {
  source: 'mcp' | 'cache' | 'disk'
  /** Epoch ms of the underlying read. */
  fetchedAt: number
  /** True when the last refresh failed and this is the previous value. */
  stale: boolean
}

/** A `get_fleet` row, less `peer` and less rows whose folder is blocked for agents (§9.1). */
export type HarnuFleetSession = {
  sessionId: string
  folderAlias: string
  status: string
  taskState?: string
  hibernated?: boolean
  orchestrator?: boolean
}
export type HarnuFleet = { sessions: readonly HarnuFleetSession[] } & HarnuFreshness

export type HarnuMemoryPage = { page: string; text: string } & HarnuFreshness
export type HarnuMemoryHit = { page: string; line: number; text: string }

export type HarnuCardKind = 'scout' | 'bug' | 'feature' | 'review' | 'chore'
export type HarnuCardMoveTarget = 'backlog' | 'ready' | 'review'
/** The keys `create_card` accepts (TC:856), less `images` and `substrate`. */
export type HarnuCardCreateFields = {
  kind?: HarnuCardKind
  complexity?: string
  parent?: string
  deps?: readonly string[]
  priority?: 'high' | 'medium' | 'low'
  spec?: string
}
/** The `set` keys `update_card` accepts (TC:908), less `substrate`. */
export type HarnuCardSetFields = HarnuCardCreateFields & {
  title?: string
  prd?: string
  adr?: string
}
export type HarnuCardRow = {
  slug: string
  title?: string
  status?: string
  kind?: string
}
/** `partial: true` while only card membership is known (no `list_cards` verb yet, §10.2). */
export type HarnuBoard = { cards: readonly HarnuCardRow[]; partial: boolean } & HarnuFreshness

export type HarnuMissionProgress = {
  total: number
  current: { from: number; to: number } | null
  allDone: boolean
  done: number
  verified: number
}
export type HarnuMissionView = {
  missionId: string
  title: string
  status: string
  progress: HarnuMissionProgress
  blocked: boolean
  /** `mission_get`'s `you` line, verbatim. */
  you: string
  steps: readonly { stepId: string; title: string; state: string }[]
  /** How this session relates to the mission (§5.4). */
  role: 'owner' | 'child'
  /** The steps this session is linked to as a builder; every step for the owner. */
  mySteps: readonly string[]
} & HarnuFreshness

export type HarnuTopic = 'fleet' | 'mission' | 'memory' | 'board'

export type HarnuCapabilities = {
  sdk: string
  /** The methods this build of the noun implements, by name. */
  methods: readonly string[]
  /** The verbs the noun found on the connected server; empty when none is connected. */
  verbs: readonly string[]
  env: HarnuEnv
}

export type HarnuApproval =
  { status: 'allowed'; result?: unknown } | { status: 'denied'; reason?: string }

export type HarnuNoun = {
  // identity
  identity: () => Promise<HarnuIdentity>
  capabilities: () => Promise<HarnuCapabilities>
  // fleet and this session (read)
  fleetGet: () => Promise<HarnuResult<{ fleet: HarnuFleet }>>
  sessionGet: () => Promise<HarnuResult<{ session: HarnuFleetSession }>>
  // memory
  memoryRead: (a: { page?: string }) => Promise<HarnuResult<{ memory: HarnuMemoryPage }>>
  memoryQuery: (a: { query: string }) => Promise<HarnuResult<{ hits: readonly HarnuMemoryHit[] }>>
  memoryAppend: (a: {
    page: 'decisions' | `sessions/${string}`
    entry: string
  }) => Promise<HarnuResult<{ page: string }>>
  // board
  boardGet: () => Promise<HarnuResult<{ board: HarnuBoard }>>
  cardCreate: (
    a: { title: string; body?: string } & HarnuCardCreateFields
  ) => Promise<HarnuResult<{ slug: string }>>
  cardUpdate: (a: {
    slug: string
    set?: HarnuCardSetFields
    appendBody?: string
  }) => Promise<HarnuResult<{ slug: string; stampVoided: boolean }>>
  cardMove: (a: { slug: string; to: HarnuCardMoveTarget }) => Promise<HarnuResult<{ slug: string }>>
  // mission: the one this session owns or builds a step of (§5.4)
  missionCurrent: () => Promise<HarnuResult<{ mission: HarnuMissionView | null }>>
  missionGet: (a: { missionId: string }) => Promise<HarnuResult<{ mission: HarnuMissionView }>>
  missionStepClaim: (a: {
    missionId: string
    stepId: string
  }) => Promise<HarnuResult<{ stepId: string }>>
  missionLog: (a: {
    missionId: string
    stepId?: string
    note: string
  }) => Promise<HarnuResult<Record<never, never>>>
  missionBlockerSet: (a: {
    missionId: string
    stepId?: string
    reason: string
    unblocks: string
    owner: 'agent' | 'operator'
  }) => Promise<HarnuResult<{ open: number }>>
  missionBlockerClear: (a: {
    missionId: string
    stepId?: string
    reason: string
  }) => Promise<HarnuResult<{ open: number }>>
  // operator signals
  notify: (a: {
    title: string
    description?: string
    kind?: 'info' | 'success' | 'warning' | 'danger'
  }) => Promise<HarnuResult<Record<never, never>>>
  speak: (a: { text: string }) => Promise<HarnuResult<{ spoken: boolean; reason?: string }>>
  openFile: (a: { path: string }) => Promise<HarnuResult<{ opened: boolean }>>
  // a write that came back PENDING (§5.3)
  approvalWait: (a: {
    approvalId: string
    timeoutMs?: number
  }) => Promise<HarnuResult<{ approval: HarnuApproval }>>
  // subscriptions (§10)
  watch: (a: { topic: HarnuTopic }) => Promise<HarnuResult<{ topic: HarnuTopic }>>
  unwatch: (a: { topic: HarnuTopic }) => Promise<HarnuResult<{ topic: HarnuTopic }>>
}

declare module 'claude-code' {
  interface EngineInterface {
    harnu: HarnuNoun
  }
  interface PluginState {
    harnu: {
      identity: HarnuIdentity | null
      fleet: HarnuFleet | null
      mission: HarnuMissionView | null
      /** `hot.md` only; other pages are read on demand. */
      memory: HarnuMemoryPage | null
      board: HarnuBoard | null
      /** Bumped on every successful write through the noun; dependents may derive from it. */
      writes: number
    }
  }
}
```
