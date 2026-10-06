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
    }
  }
}
