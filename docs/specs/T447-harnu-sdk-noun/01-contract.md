# T447 — `$.harnu` contract (§5.1 of the spec)

**Part of:** [`00-spec.md`](00-spec.md) · **Card:** T447 · **Status:** specified (not implemented)

This file is §5.1 of the spec, split out for length. It is the proposed content of
`resources/harnu-sdk/types/index.d.ts`: the one self-contained contract the `harnu` mod ships and
the engine lays into every dependent (`00-spec.md` §3.3, §3.4). Section references below point at
`00-spec.md`.

```ts
// The `harnu` mod's contract. Self-contained: no import, no reference (TYPES:91-99).
// Every exported name is led by `Harnu`. SemVer: HARNU_SDK_VERSION below (§11).

/** Where this session stands relative to Harnu (§7). */
export type HarnuEnv =
  | 'inside' // spawned by Harnu, Harnu MCP connected
  | 'inside-no-mcp' // spawned by Harnu, MCP withheld (agent-controlled or read-only spawn)
  | 'outside' // not spawned by Harnu (no HARNU_SPAWN_TOKEN), or the binding is gone
  | 'no-harnu' // Harnu is not running, or not reachable

/** The companion's state as the user sees it in Settings → Mods (T389/P1W3 §10). */
export type HarnuCompanionState = 'live' | 'legacy' | 'off'

export type HarnuIdentity = {
  env: HarnuEnv
  /** True only for `inside` and `inside-no-mcp`: Harnu spawned this session. */
  inside: boolean
  /** The id Harnu has for this session (the companion's bound `sid`); absent when unknown. */
  sessionId?: string
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
  | 'UNSUPPORTED' // the server does not know the verb (older Harnu) or the SDK lacks it
  | 'EXCLUDED' // the argument asks for something the noun never offers (§9.1)
  | 'BAD_ARGS' // refused by the noun's own validation before any call
  | 'FOLDER_NOT_ALLOWED' // the operator blocked this folder for agents
  | 'CONFIRM_DENIED' // "Ask before agent actions" is on and the operator said no
  | 'TIMEOUT' // TOOL_TIMEOUT from the server, or a confirm nobody answered
  | 'REFUSED' // any other server refusal; `serverCode` carries Harnu's own code

export type HarnuError = {
  ok: false
  error: HarnuErrorCode
  /** Harnu's own refusal code, verbatim (`CARD_IN_PROGRESS`, `MISSION_CLOSED`, …). */
  serverCode?: string
  message: string
  /** Harnu's `nextActions`, passed through when the refusal carried them. */
  nextActions?: readonly { do: string; why: string }[]
}

/** Every method resolves; none rejects for a refusal (the `$.mcp.connect` convention, TYPES:2719-2732). */
export type HarnuResult<T> = ({ ok: true } & T) | HarnuError

/** A read answered from a cache or from disk says so. */
export type HarnuFreshness = {
  source: 'mcp' | 'cache' | 'disk'
  /** Epoch ms of the underlying read. */
  fetchedAt: number
  /** True when the last refresh failed and this is the previous value. */
  stale: boolean
}

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
export type HarnuCardFields = {
  title?: string
  kind?: HarnuCardKind
  complexity?: string
  parent?: string
  deps?: readonly string[]
  priority?: 'high' | 'medium' | 'low'
  spec?: string
  prd?: string
  adr?: string
}

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
} & HarnuFreshness

export type HarnuTopic = 'fleet' | 'mission' | 'memory'

export type HarnuCapabilities = {
  sdk: string
  /** The methods this build of the noun implements, by name. */
  methods: readonly string[]
  /** The verbs the noun found on the connected server; empty when none is connected. */
  verbs: readonly string[]
  env: HarnuEnv
}

export type HarnuNoun = {
  // identity
  identity: () => Promise<HarnuIdentity>
  capabilities: () => Promise<HarnuCapabilities>
  // fleet (read)
  fleetGet: () => Promise<HarnuResult<{ fleet: HarnuFleet }>>
  sessionGet: (a: { sessionId?: string }) => Promise<HarnuResult<{ session: HarnuFleetSession }>>
  // memory
  memoryRead: (a: { page?: string }) => Promise<HarnuResult<{ memory: HarnuMemoryPage }>>
  memoryQuery: (a: { query: string }) => Promise<HarnuResult<{ hits: readonly HarnuMemoryHit[] }>>
  memoryAppend: (a: {
    page: 'decisions' | `sessions/${string}`
    entry: string
  }) => Promise<HarnuResult<{ page: string }>>
  // board
  cardCreate: (
    a: { title: string; body?: string } & Omit<HarnuCardFields, 'title'>
  ) => Promise<HarnuResult<{ slug: string }>>
  cardUpdate: (a: {
    slug: string
    set?: HarnuCardFields
    appendBody?: string
  }) => Promise<HarnuResult<{ slug: string; stampVoided: boolean }>>
  cardMove: (a: { slug: string; to: HarnuCardMoveTarget }) => Promise<HarnuResult<{ slug: string }>>
  // mission (the one this session owns)
  missionCurrent: () => Promise<HarnuResult<{ mission: HarnuMissionView | null }>>
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
      /** Bumped on every successful write through the noun; dependents may derive from it. */
      writes: number
    }
  }
}
```
