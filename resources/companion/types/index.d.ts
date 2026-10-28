// The plugin's contract. Each wave declares its own `$.state` keys here, in its own change.
// Self-contained on purpose (no import): the shapes mirror `hooks/contract.ts` (spec 01-contract §22).
declare module 'claude-code' {
  interface PluginState {
    'harnu-companion': {
      /** P1W3: the host's per-connection id. Correlation, not authentication (contract §3). */
      conn: `c_${string}`
      /** P1W3: the host boot the `conn` belongs to. */
      bootId: string
      /** P1W3: the id the host has for this binding (the bound sid), not a fresh `$.session.id()`. */
      sid: string
      /** P1W3: captured from `session.start`; a resume hello needs it after a reload. */
      boot: { cwd: string; surface: string | null; isInteractive: boolean }
      /** P1W3: facts about the process; `classic` flips on the first `classic.*` dispatch. */
      probes: { classic: boolean; toolCheck: boolean }
      /** P1W5: the last `permission_mode` of any `classic.*` payload; absent until one is seen. */
      permissionMode: string
      /**
       * P1W5: the fleet sensors' state (contract §22), read back after a reload so the re-sent
       * `session.snapshot` is correct. Reset to the neutral state by a rebound. `agents` holds the
       * per-agent facts, keyed on the agent id (the subagents this sensor counted).
       */
      fleet: {
        activeTurnId: string | null
        nextOrigin: 'human' | 'plugin' | 'peer' | 'unknown'
        open: {
          kind: 'permission' | 'idle' | 'input'
          toolUseId?: string
          tool?: string
          agentId?: string
        }[]
        checks: {
          toolUseId: string
          tool: string
          inputKey?: string
          at: number
          claimedBy?: string
          agentId?: string
          hook?: string
        }[]
        runningSubagents: number
        lastStop: { all: number; subagents: number } | null
        pendingFailure: string | null
        agents: Record<string, string>
        /** The ids of subagents that already stopped: the CLI still lists them as `running`. */
        stopped: string[]
      }
      /**
       * P2W1: the command dedupe (contract §22). `cursor` acknowledges delivery, `resulted` execution;
       * the two id lists are capped at `CMD_DONE_MAX`; `turnId` is the last `turn.start` id.
       */
      channel: {
        bootId: string
        cursor: number
        started: string[]
        resulted: string[]
        turnId: string | null
      }
      /**
       * T257 / P4W2: the one line above the prompt, written by `ui.band.set` and read by the
       * `AbovePrompt` hook. `n` is the `Command.n` that set it (a lower `n` never overwrites a
       * higher one); `expiresAt` is the mod's clock plus `BAND_TTL_MS` at apply time. Display text
       * only, no link and no ticket. `null` once cleared or expired.
       */
      band: {
        v: 1
        lead: string
        detail?: string
        hint?: string
        n: number
        expiresAt: number
      } | null
      /**
       * T589: the last `mission.state` push, written by the command and read by the `UserMessage` hook.
       * `n` is the `Command.n` that carried it. Display data only: the host cuts and strips every string.
       */
      missions: {
        v: 1
        n: number
        at: number
        missions: {
          id: string
          title: string
          card?: string
          role: 'owner' | 'child'
          progress: {
            total: number
            current: { from: number; to: number } | null
            done: number
            verified: number
            allDone: boolean
          }
          steps: {
            id: string
            title: string
            state: 'verified' | 'done' | 'running' | 'waiting' | 'blocked' | 'todo'
            card?: string
            children: { taskState: string; lastTransitionAt: number | null }[]
            prs: { number: number; state: string }[]
          }[]
          blockers: { reason: string; owner: 'agent' | 'operator'; stepId?: string }[]
          you: { kind: string; text: string }[]
        }[]
      } | null
      /**
       * T589: the loop ticks this session has drawn, per mission: the number of each tick row (by its
       * `requestId`), what the mission looked like then, and the card it got. The newest 50 per mission.
       */
      tickRows: {
        v: 1
        byMission: Record<
          string,
          { next: number; rows: { rid: string; n: number; snap: unknown; card: unknown }[] }
        >
      }
    }
  }
}
