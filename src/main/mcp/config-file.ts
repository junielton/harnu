/**
 * Pure builders for wiring Harnu's own MCP HTTP server into a spawned `claude`.
 *
 * Framework-free + side-effect-free so the argv decision is unit-testable in
 * the node vitest env (`tests/mcp-config-file.test.ts`), per ADR-0001
 * (pure-core / thin-shell). The shell (`server.ts`, with the file-write
 * primitive factored into `atomic-write.ts`) owns the file write + the
 * lifecycle; this module only computes the JSON descriptor, the argv, and the
 * spawn-time injection gate.
 *
 * SECURITY / CORRECTNESS — four invariants live here:
 *  1. The app-managed `--mcp-config` MUST lead the user's resolved Boot args so
 *     a user-supplied `--mcp-config` (or `claude-boot.json#mcpConfig`) can never
 *     displace Harnu's server. See {@link orderMcpArgs}.
 *  2. We NEVER emit `--strict-mcp-config`. That flag makes `claude` ignore the
 *     user's own `.mcp.json` / project MCP servers; injecting Harnu's server must
 *     be purely additive. See {@link appManagedMcpArgs}.
 *  3. The app-managed args carry a server-level `--allowedTools mcp__harnu mcp__capy`
 *     allow rule (T93) so every Harnu verb's FIRST call is auto-allowed at `claude`'s
 *     native permission gate — no per-verb "allow this tool?" ask on turn 1. It is
 *     a SEPARATE `--allowedTools` occurrence: `claude`'s variadic option UNIONs all
 *     occurrences, so it composes additively with any user `--allowedTools` (never
 *     replaces it), regardless of order.
 *  4. The injection is withheld ENTIRELY (never pointed at a missing file) when
 *     the config file doesn't exist at spawn time (T123 §3.1 AC14 / BUG-32),
 *     NARROWING the control-server toggle race to a much smaller residual
 *     window — it does not eliminate it. See {@link shouldInjectMcpConfig} for
 *     exactly where that residual TOCTOU sliver still lives.
 */

/** The MCP server name sessions see — verbs surface as `mcp__harnu__<verb>`. */
export const MCP_SERVER_NAME = 'harnu'

/**
 * The pre-rename server name (`mcp__capy__<verb>`). Never registered any more, but
 * still recognized: allow rules saved under it keep working, and the Scheduler's
 * allow/deny lists cover it so a stale prompt can neither leak nor lose a verb.
 */
export const LEGACY_MCP_SERVER_NAME = 'capy'

/** Both server-name prefixes, current first. */
export const MCP_SERVER_NAMES: readonly string[] = [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME]

/** The `mcp__<server>__<op>` tool name of `op` under `server` (default: the current name). */
export function mcpToolName(op: string, server: string = MCP_SERVER_NAME): string {
  return `mcp__${server}__${op}`
}

/** Where Harnu's loopback MCP HTTP server lives + the per-session secret. */
export interface HarnuMcpEndpoint {
  /** Loopback port the Harnu MCP HTTP server listens on. */
  port: number
  /** Bearer token the spawned `claude` presents on every request. */
  token: string
}

/** A single `http`-transport MCP server entry as `claude --mcp-config` expects. */
export interface HarnuMcpServerEntry {
  type: 'http'
  url: string
  headers: { Authorization: string }
}

/** The full `--mcp-config` JSON document Harnu writes for the spawned `claude`. */
export interface HarnuMcpConfigFile {
  mcpServers: { harnu: HarnuMcpServerEntry }
}

/**
 * Build the `--mcp-config` JSON document that registers Harnu's loopback MCP
 * server under the `harnu` key. The URL is always `127.0.0.1` (never `0.0.0.0`
 * or a hostname — loopback only) and the token rides in a `Bearer` header.
 *
 * @param endpoint - the port the server listens on and the session bearer token.
 * @returns the serializable `{ mcpServers: { harnu: … } }` config object.
 */
export function buildHarnuMcpConfig({ port, token }: HarnuMcpEndpoint): HarnuMcpConfigFile {
  return {
    mcpServers: {
      harnu: {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: `Bearer ${token}` }
      }
    }
  }
}

/**
 * The `--mcp-config <path>` flag pair pointing `claude` at a config file.
 *
 * @param path - absolute path to the JSON document written by the shell.
 * @returns `['--mcp-config', path]`.
 */
export function mcpConfigArgs(path: string): string[] {
  return ['--mcp-config', path]
}

/**
 * The server-level permission rules that match EVERY Harnu verb (`mcp__harnu__*`),
 * plus the pre-rename `mcp__capy` so a still-running or resumed session that
 * learned the old tool names keeps auto-allowing them. NOT `mcp__harnu__<verb>` —
 * the bare server prefix is the whole-server allow rule `claude` honors (verified
 * against its `toolMatchesRule`), so one rule covers all verbs, present and future.
 */
export const ALLOWED_TOOLS_RULES: readonly string[] = MCP_SERVER_NAMES.map((n) => `mcp__${n}`)

/**
 * The `--allowedTools mcp__harnu,mcp__capy` flag (T93). One comma-joined value, because the
 * option is variadic and a second bare value could swallow a following positional. A DISTINCT `--allowedTools`
 * occurrence — `claude`'s variadic option unions it with any user `--allowedTools`
 * rather than replacing it, so Harnu's server-level allow rules are purely additive.
 *
 * @returns `['--allowedTools', 'mcp__harnu,mcp__capy']`.
 */
export function allowedToolsArgs(): string[] {
  return ['--allowedTools', ALLOWED_TOOLS_RULES.join(',')]
}

/**
 * App-managed MCP args: the `--mcp-config` pair PLUS the `--allowedTools mcp__harnu,mcp__capy`
 * server-level allow rule when the feature is enabled, nothing when disabled. NEVER
 * emits `--strict-mcp-config` — Harnu's server is always additive on top of the
 * user's own MCP servers. The `enabled` flag folds BOTH the server-running state
 * and the operator's auto-register opt-out (default ON); disabling it withholds the
 * whole injection so the session gets no Harnu server auto-wired.
 *
 * @param enabled - whether the Harnu MCP server should be auto-registered.
 * @param path - absolute path to Harnu's `--mcp-config` document.
 * @returns the `--mcp-config` + `--allowedTools` args, or `[]` when disabled.
 */
export function appManagedMcpArgs(enabled: boolean, path: string): string[] {
  if (!enabled) return []
  return [...mcpConfigArgs(path), ...allowedToolsArgs()]
}

/**
 * Whether the app-managed `--mcp-config` injection should fire for THIS spawn
 * (BUG-32 / spec T123 §3.1 AC14). Requires all three: the server listener is up,
 * the operator has not opted out of auto-register, AND the config file actually
 * exists on disk right now.
 *
 * The file-existence check NARROWS the toggle race, it does not close it: a
 * `claude-*` session that spawns or resumes in the gap between
 * `deleteConfigFile()` (stop) and the next `writeConfigFile()` (start) must
 * NOT receive a `--mcp-config` pointing at a file that isn't there yet — that
 * made `claude` hard-fail at boot with "MCP config file not found".
 * Withholding the flag entirely (rather than pointing at a missing file) lets
 * the session boot normally, just without the harnu connector.
 *
 * Residual TOCTOU window: `configFileExists` is a snapshot from ONE
 * `fs.existsSync` call at spawn time — the file can still vanish (another
 * disable, a quit-time `deleteConfigFile()`) in the interval between that
 * check and the spawned `claude` process actually opening the path itself to
 * read `--mcp-config`. This function only shrinks the unsafe window down to
 * that sliver; it cannot make the check-then-use atomic across two separate
 * processes. `claude` failing on a config file that disappeared in that
 * narrow gap is an accepted, unlikely-in-practice residual — not eliminated.
 *
 * Kept as pure boolean logic here so it's unit-testable without touching the
 * filesystem; the caller (the shell, `server.ts`) is responsible for the actual
 * `fs.existsSync` check and passes its result in as `configFileExists`.
 *
 * @param serverRunning - `running` in `server.ts`: listener up AND config written.
 * @param autoRegisterEnabled - the T93 auto-register operator opt-out (default ON).
 * @param configFileExists - result of a fresh existence check at spawn time.
 * @returns whether {@link appManagedMcpArgs} should be called with `enabled: true`.
 */
export function shouldInjectMcpConfig(
  serverRunning: boolean,
  autoRegisterEnabled: boolean,
  configFileExists: boolean
): boolean {
  return serverRunning && autoRegisterEnabled && configFileExists
}

/**
 * Compose the final argv with the app-managed MCP args leading the user's
 * resolved Boot args. Ordering is the precedence guarantee: Harnu's
 * `--mcp-config` is emitted first so a user `--mcp-config` (which `claude`
 * merges, not replaces) can never bury it, while the user's own servers still
 * load (we never pass `--strict-mcp-config`).
 *
 * @param appMcpArgs - the app-managed args (from {@link appManagedMcpArgs}).
 * @param userArgs - the user's resolved Boot args (from `resolveClaudeBootArgs`).
 * @returns `[...appMcpArgs, ...userArgs]`.
 */
export function orderMcpArgs(appMcpArgs: string[], userArgs: string[]): string[] {
  return [...appMcpArgs, ...userArgs]
}
