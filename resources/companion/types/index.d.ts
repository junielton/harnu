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
    }
  }
}
