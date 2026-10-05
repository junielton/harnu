import { isForkSynthetic, type Session, type SpawnOrigin } from '../stores/sessions'
import type { ClaudeBootConfig } from '../../../preload'

/**
 * Pure spawn-decision for `TerminalPane` — given the selected session entry,
 * decide what `claude`/shell to launch and (for new sessions) the one-shot
 * per-session Claude Boot override to forward. Framework-free so the renderer's
 * spawn decision is unit-testable without mounting xterm (`tests/spawn-spec.test.ts`).
 */

export type SpawnKind = 'shell' | 'claude-new' | 'claude-resume' | 'claude-fork'

export interface SpawnSpec {
  kind: SpawnKind
  /** Session uuid for resume; the source uuid for a fork. Absent otherwise. */
  claudeSessionId?: string
  /** One-shot launch override for a new session (plain, IPC-cloneable). */
  bootOverride?: ClaudeBootConfig
  /**
   * `true` when the session was created by an MCP agent (`insertAgentSession`).
   * Forwarded to `ptyCreate` so main withholds the app `--mcp-config` and
   * force-downgrades permissions — closing the recursive-Conductor / privilege
   * hole for agent-spawned sessions (BLOCKER-1).
   */
  agentControlled?: boolean
  /**
   * Boot mode (T123/T138): main resolves the injected preamble contract from
   * this id — a builtin or an installed extension's `contributes.modes` entry.
   */
  mode?: string
  /**
   * T215: the entry's recorded {@link SpawnOrigin}, when it has one. Absent
   * for a session created before the marker existed (a cold disk transcript);
   * the spawn site then falls back to the GESTURE — a selection is the
   * operator's, a background wake is the agent's.
   */
  spawnedBy?: SpawnOrigin
}

/**
 * T215: forward the entry's recorded spawn origin onto the spec, if it has
 * one. Applied to every `sessionEntry`-derived branch — the same breadth as
 * `modeField` — so the marker rides along regardless of which
 * spawn kind the entry resolves to. Returns `{}` (spreads to nothing) when the
 * entry carries no origin, keeping the spec free of an `undefined` key.
 */
function spawnedByField(s: Session): { spawnedBy: SpawnOrigin } | Record<string, never> {
  return s.spawnedBy === 'agent' || s.spawnedBy === 'operator' ? { spawnedBy: s.spawnedBy } : {}
}

/**
 * (T123) Forward the entry's `mode` onto the spawn spec, if set. Applied to
 * every `sessionEntry`-derived branch (fork / synthetic / resume) — the same
 * breadth as `agentControlled` above — so the contract rides
 * along regardless of which spawn kind the entry resolves to. Returns `{}`
 * (spreads to nothing) when the entry carries no mode, keeping the resolved
 * spec free of an `undefined` key.
 */
function modeField(s: Session): { mode: string } | Record<string, never> {
  return s.mode ? { mode: s.mode } : {}
}

/**
 * Strip Vue reactivity from a per-session `bootOverride` before it crosses the
 * structured-clone IPC boundary (`ptyCreate`). The value lives in the Pinia
 * reactive store, so a direct read is a Proxy — which Electron's IPC cannot
 * clone ("An object could not be cloned"). `ClaudeBootConfig` is JSON-safe
 * (strings / booleans / string[]), so a JSON round-trip yields a plain, lossless,
 * cloneable snapshot. `undefined`/empty → `undefined`.
 */
export function toPlainBootOverride(o: ClaudeBootConfig | undefined): ClaudeBootConfig | undefined {
  if (!o || Object.keys(o).length === 0) return undefined
  return JSON.parse(JSON.stringify(o)) as ClaudeBootConfig
}

/**
 * Snapshot a per-session `bootOverride` for a RESUME spawn: the plain copy
 * {@link toPlainBootOverride} makes, minus the one-shot `prePrompt`.
 *
 * The boot prompt is written once, at dispatch, onto the synthetic's
 * `bootOverride` (`sessions.ts#dispatchCardSession` / `#insertAgentSession`) —
 * but that field is PERSISTENT: the synth→real migrate keeps the same object,
 * and `RENDERER_ONLY_SESSION_KEYS` deliberately preserves `bootOverride` across
 * every disk reconcile. Forwarding it here replayed the prompt as a `--` argv
 * positional (`claude-args.ts#buildClaudeArgs`) on EVERY respawn of the session:
 * waking it from hibernation, or just closing and reopening its tab. A resume
 * already carries the whole conversation, so the boot prompt has no business
 * there. The durable keys (`remoteControl`, `model`, …) still ride along.
 *
 * Returns `undefined` when nothing survives the strip, so a session whose only
 * override was its boot prompt resumes exactly like a cold disk session.
 */
function resumeBootOverride(o: ClaudeBootConfig | undefined): ClaudeBootConfig | undefined {
  const plain = toPlainBootOverride(o)
  if (!plain || plain.prePrompt === undefined) return plain
  const rest = { ...plain }
  delete rest.prePrompt
  return Object.keys(rest).length ? rest : undefined
}

/**
 * Resolve the spawn spec for a selected session (U-1.4 / U-1.5 / fork-session),
 * narrowest predicate first:
 *  - folder terminal → a plain shell in the folder cwd (no Claude)
 *  - fork synthetic → resume the source + `--fork-session`
 *  - plain synthetic → fresh `claude`, carrying its one-shot `bootOverride`
 *  - real entry → `claude --resume <uuid>`
 *  - unknown id → a bare shell (defensive; mostly dead today)
 */
export function resolveSpawnSpec(sessionEntry: Session | undefined, sessionId: string): SpawnSpec {
  // A folder terminal is an explicit shell — checked first so it can never be
  // mistaken for a resumable/forkable Claude session.
  if (sessionEntry?.isShellTerminal) {
    return { kind: 'shell' }
  }
  if (sessionEntry && isForkSynthetic(sessionEntry)) {
    return {
      kind: 'claude-fork',
      claudeSessionId: sessionEntry.forkSourceId,
      agentControlled: sessionEntry.agentControlled === true ? true : undefined,
      ...modeField(sessionEntry),
      ...spawnedByField(sessionEntry)
    }
  }
  if (sessionEntry?.synthetic === true) {
    return {
      kind: 'claude-new',
      bootOverride: toPlainBootOverride(sessionEntry.bootOverride),
      agentControlled: sessionEntry.agentControlled === true ? true : undefined,
      ...(sessionEntry.mode ? { mode: sessionEntry.mode } : {}),
      ...spawnedByField(sessionEntry)
    }
  }
  if (sessionEntry) {
    // A real disk session resumes from its JSONL, and ALSO carries any
    // per-session `bootOverride` set after creation — currently the
    // operator-only `remoteControl` flag toggled from the context menu
    // (RC-UI). Snapshot it to a plain object (strip the Pinia Proxy) so the
    // `claude --resume` respawn relaunches with `--remote-control`, minus the
    // one-shot boot prompt (see {@link resumeBootOverride}).
    return {
      kind: 'claude-resume',
      claudeSessionId: sessionId,
      bootOverride: resumeBootOverride(sessionEntry.bootOverride),
      ...modeField(sessionEntry),
      ...spawnedByField(sessionEntry)
    }
  }
  return { kind: 'shell' }
}
