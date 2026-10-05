/**
 * The keystone shell (T24) of the Harnu MCP control server: a loopback HTTP
 * listener that fronts the MCP SDK transport, gates EVERY tool call through the
 * pure security cores, and actuates the survivors through the renderer bridge /
 * git worktrees.
 *
 * Cloned from `hook-bridge.ts`'s loopback template (`createServer` +
 * `listen(0,'127.0.0.1')`, a per-boot `randomUUID` token, a module-level state +
 * `close*`), with three deliberate divergences:
 *   1. The body is handed to the MCP SDK `StreamableHTTPServerTransport`, not a
 *      hand-rolled responder.
 *   2. Per-session transports are tracked in a `Map` and EACH is `close()`-d on
 *      teardown — a plain `http` `close()` hangs on a live SSE stream.
 *   3. The SDK is loaded by DYNAMIC `import()` inside the async register (the T1
 *      spike contract) so the externalized-main bundle never statically requires
 *      it.
 *
 * SECURITY — the contract this shell MUST preserve (the cores enforce the math;
 * this shell must not weaken the wiring):
 *   - ON by default now ({@link readMcpEnabled} ⇒ `true`) — agents are free by
 *     default, and the operator's kill switch is an explicit `enabled: false`.
 *     `enabled` still flips ONLY after `listen()` resolves and the config file is
 *     written.
 *   - Every call: parseMcpRequest (token / Origin / Host / body-cap) → planToolCall
 *     (audit → permission(kill switch, denylist) → dispatch, or a confirm when the
 *     verb always asks / the operator opted into `ask`) → actuate. A confirm that
 *     times out / aborts / has no window is still a DENY. The audit record is
 *     unconditional — it is what an unattended fleet is accountable through.
 *   - `harnu.mcp.json` is written `0600` in a `0700` dir, ATOMICALLY (temp file +
 *     `rename()`, see {@link atomicWriteFile}), force-rewritten per boot BEFORE
 *     `enabled` flips, and deleted (best-effort) on disable/quit. The pty
 *     provider only injects `--mcp-config` while the server is truly listening
 *     AND a fresh `fs.existsSync` check confirms the file is actually there at
 *     spawn time (T123 §3.1 AC14 / BUG-32) — a session spawned/resumed in the
 *     off/on toggle gap gets `--mcp-config` omitted entirely rather than
 *     pointed at a missing file, so it boots normally without the connector
 *     instead of hard-failing with "MCP config file not found". That spawn-time
 *     check only NARROWS the race, it does not close it — see
 *     {@link shouldInjectMcpConfig}'s docstring for the residual TOCTOU sliver
 *     between the check and the spawned `claude`'s own read of the file.
 *
 * env-bound (HTTP + electron + fs + the SDK) ⇒ e2e-only per ADR-0001.
 */

import { app, ipcMain, type BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { promises as fs, existsSync } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { parseMcpRequest, BODY_MAX } from './http-guard'
import { type McpOp, type McpToolDef } from './tool-catalog'
import { WIRED_TOOLS, type ToolHandlerCtx } from './tool-handlers'
import { getContainersService } from '../containers/containers-ipc'
import { containersConfirmPrompt } from './containers-listing'
import { planToolCall } from './plan-tool-call'
import { isCardSubstrate, MANIFEST_BOOT_LABELS } from '../roadmap-core'
import { buildManifestDisclosure, type ManifestCardRequest } from '../roadmap-ipc'
import { buildPlanInput, strField } from './plan-input'
import { ackIsSuccess, asRecord, errorResult, steerError, textResult } from './tool-result'
import { stashApproval } from './approval-stash'
import { createAuditPersister } from './audit-persist'
import { assemblePolicy } from './policy-assemble'
import {
  readMcpEnabled,
  writeMcpEnabled,
  readMcpAsk,
  writeMcpAsk,
  readMcpAutoRegister,
  writeMcpAutoRegister
} from './prefs'
import { appendAudit, getAuditLog, serializeForPersist, parseFromPersist } from './audit-log'
import { withDeadline, TOOL_CALL_DEADLINE_MS, createDeadlineFlag } from './deadline'
import { deriveCallId, beginCall, completeCall, wasRecentlyFailed } from './idempotency-registry'
import {
  MCP_SERVER_NAME,
  buildHarnuMcpConfig,
  appManagedMcpArgs,
  shouldInjectMcpConfig
} from './config-file'
import { atomicWriteFile } from './atomic-write'
import { readOrCreateToken, readStoredPort, writeStore } from './token-store'
import { buildHarnuMcpInstructions } from './instructions'
import { appLocale } from '../app-locale'
import { memoryLanguageLine } from '../memory-language'
import {
  CONFIRM_WINDOW_MS,
  type ConfirmCore,
  type ConfirmDisclosure,
  type ConfirmOutcome,
  type ManifestCardDisclosure
} from './confirm-core'
import { mergeVerbAllowRule, settingsAllowsVerb, verbAllowRule } from './settings-local'
import { outcomeToStatus, type ApprovalStatusResult } from './approval-status'
import { buildGrantDisclosureText, augmentAckWithGrant } from './grant-core'
import {
  snapshotGrants,
  listGrants,
  reserve,
  remainingFor,
  release,
  revokeGrant,
  addDynamicFolder,
  setGrantChangeListener,
  closeGrants
} from './grant-registry'
import { parsePlanMission } from './validate'
import { parseAgentBootOverride } from './agent-boot'
import { listInflightSessions } from './inflight-session-registry'
import { folderForWorkerId } from '../scheduler-shell'
import { inFlightFolderFor } from './agent-inflight-registry'
import { snapshotInheritOnce, addInheritOnce, closeInheritOnce } from './inherit-once-registry'
import { pushShadowEntry } from '../responder-registry'
import type { CommandBridge } from '../command-bridge'
import type { FolderEntry } from '../folder-model'
import { scanFolders } from '../claude-reader'
import { readUserProjects, setUserProjectInheritAgentControl } from '../user-projects'
import { setMcpArgsProvider } from '../pty'
import { previewWorktreeCommands, worktreeInheritOfferForTarget } from '../worktree-ipc'
import { writeWorktreeInheritControl } from './worktree-inherit-prefs'

/** The side-effecting collaborators the integrator wires into the server. */
export interface McpServerDeps {
  /** The renderer command bridge (`create_session` / `spawn_terminal` actuation). */
  bridge: CommandBridge
  /** The fail-closed confirm gate every mutation is parked in. */
  confirm: ConfirmCore
}

// ---- Module-level lifecycle state (mirrors the hook-bridge shell) -----------

/** The live HTTP listener, or `null` when the server is stopped. */
let httpServer: Server | null = null
/** The loopback port `listen()` resolved to (the stored port, or a fresh one). */
let listeningPort = 0
/**
 * Bearer secret the spawned `claude` must present. Persisted across restarts
 * via {@link readOrCreateToken} (ADR-0004 / BUG-35) — no longer a fresh
 * `randomUUID()` per boot, so an already-running session's `--mcp-config`
 * keeps authenticating after the control server restarts.
 */
let token = ''
/**
 * Set by {@link start} when the stored port (from a prior boot) was taken and
 * a fresh ephemeral port had to be bound instead (D3). `null` when the
 * current port matches what was persisted. Surfaced read-only via
 * `mcp:status` — sessions spawned before this restart cannot reach the new
 * port and must be resumed to reconnect.
 */
let portFallbackWarning: string | null = null
/**
 * True ONLY when the listener is up AND the config file is written. The pty
 * provider gates `--mcp-config` injection on this, so a half-started server can
 * never leak a config to a spawned session.
 */
let running = false
/**
 * T93 auto-register opt-out, cached synchronously so the pty arg-build step (sync)
 * can read it without an await. Default ON; hydrated from disk in
 * {@link registerMcpServer} and kept fresh on every `mcp:autoRegister:set`. The
 * injection is gated on `running && autoRegisterEnabled` — either off withholds the
 * whole `--mcp-config` + `--allowedTools mcp__harnu,mcp__capy` injection from spawned sessions.
 */
let autoRegisterEnabled = true
/** Per-MCP-session transports, keyed by the SDK-minted session id. */
const transports = new Map<string, StreamableHTTPServerTransport>()
/** Injected deps (bridge + confirm); set in {@link registerMcpServer}. */
let deps: McpServerDeps | null = null

/** Best-effort parse of a tool result's JSON text payload (for the stash). */
function resultPayload(res: CallToolResult): unknown {
  const first = res.content?.[0]
  if (!first || first.type !== 'text' || typeof first.text !== 'string') return undefined
  try {
    return JSON.parse(first.text)
  } catch {
    return first.text
  }
}

/** Race a parked confirm's settle against the inline window; 'PENDING' on timeout. */
function raceSettle(
  settled: Promise<ConfirmOutcome>,
  ms: number
): Promise<ConfirmOutcome | 'PENDING'> {
  return Promise.race([
    settled,
    new Promise<'PENDING'>((res) => setTimeout(() => res('PENDING'), ms))
  ])
}

/** Audit a confirm settle (deny reasons only; an allow rides the mutation's own path). */
function auditConfirmDeny(tool: string, folder: string, reason: string): void {
  appendAudit({
    ts: Date.now(),
    tool,
    folder,
    verdict: 'deny',
    disclosedPayloadSummary: 'none',
    result: `CONFIRM_${reason}`
  })
  auditPersister.schedule()
}

// ---- SDK handles captured after the dynamic import --------------------------

let McpServerCtor: typeof McpServer | null = null
let TransportCtor: typeof StreamableHTTPServerTransport | null = null
let isInitializeRequestFn: (value: unknown) => boolean = () => false

// ---- File paths -------------------------------------------------------------

/** `<userData>/harnu.mcp.json` — the `--mcp-config` document for spawned `claude`. */
function configPath(): string {
  return path.join(app.getPath('userData'), 'harnu.mcp.json')
}

/**
 * `<userData>/capy.mcp.json` — the pre-rename config document. Never read any more,
 * but it carries a live bearer token, so it is unlinked rather than left behind.
 */
function legacyConfigPath(): string {
  return path.join(app.getPath('userData'), 'capy.mcp.json')
}

/** `<userData>/mcp-audit.json` — the persisted audit ring. */
function auditPath(): string {
  return path.join(app.getPath('userData'), 'mcp-audit.json')
}

// ---- Config-file lifecycle (0600 in a 0700 dir, per-boot rewrite) ----------

/**
 * Force-write `harnu.mcp.json` (0600) in the userData dir (0700), ATOMICALLY
 * (T123 §3.1 AC15 / BUG-32): {@link atomicWriteFile} writes a `0600` temp file
 * in the same directory then `rename()`s it over the target, so a concurrent
 * reader (a `claude-*` spawn resolving `--mcp-config` at the exact moment of a
 * server restart) never observes a partial/truncated file — only the complete
 * prior content or the complete new content.
 */
async function writeConfigFile(port: number, secret: string): Promise<void> {
  const dir = app.getPath('userData')
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  // Best-effort tighten an existing dir (mkdir's mode is ignored if it exists;
  // a no-op on platforms that don't honor POSIX modes).
  await fs.chmod(dir, 0o700).catch(() => {})
  const body = JSON.stringify(buildHarnuMcpConfig({ port, token: secret }), null, 2) + '\n'
  await atomicWriteFile(configPath(), body, 0o600)
  await fs.unlink(legacyConfigPath()).catch(() => {})
}

/** Delete `harnu.mcp.json` (best-effort) so no stale endpoint survives a stop. */
async function deleteConfigFile(): Promise<void> {
  await fs.unlink(configPath()).catch(() => {})
  await fs.unlink(legacyConfigPath()).catch(() => {})
}

// ---- Audit persistence ------------------------------------------------------

/** Hydrate the in-memory audit ring from `<userData>/mcp-audit.json` (best-effort). */
async function loadAudit(): Promise<void> {
  try {
    parseFromPersist(await fs.readFile(auditPath(), 'utf8'))
  } catch {
    /* no file yet / corrupt → start empty (parseFromPersist already fail-soft) */
  }
}

/** Persist the audit ring (best-effort; never throws into the request path). */
async function persistAudit(): Promise<void> {
  try {
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    await fs.writeFile(auditPath(), serializeForPersist(), 'utf8')
  } catch (err) {
    console.error('[mcp] audit persist failed:', err)
  }
}

/**
 * Trailing-coalesce persister over {@link persistAudit} (T26): the request path
 * calls `schedule()` (one write per burst window instead of a full-ring
 * `fs.writeFile` per tool call); `stop()` calls `flush()` so the tail is never
 * lost on disable/quit.
 */
const AUDIT_PERSIST_DEBOUNCE_MS = 750
const auditPersister = createAuditPersister({
  persist: persistAudit,
  delayMs: AUDIT_PERSIST_DEBOUNCE_MS,
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (h) => clearTimeout(h)
})

// ---- Tool-call composition (the security order lives in planToolCall) -------

/** T104: narrow `submit_manifest`'s raw `cards` arg into typed per-card requests. */
function manifestCardRequestsFrom(args: Record<string, unknown>): ManifestCardRequest[] {
  if (!Array.isArray(args.cards)) return []
  const out: ManifestCardRequest[] = []
  for (const raw of args.cards) {
    if (typeof raw !== 'object' || raw === null) continue
    const rec = raw as Record<string, unknown>
    const slug = strField(rec, 'slug')
    if (!slug) continue
    const entry: ManifestCardRequest = { slug }
    const substrateArg = strField(rec, 'substrate')
    if (substrateArg && isCardSubstrate(substrateArg)) entry.substrate = substrateArg
    const model = strField(rec, 'model')
    if (model) entry.model = model
    const effort = strField(rec, 'effort')
    if (effort) entry.effort = effort
    out.push(entry)
  }
  return out
}

/** T104: a dirigible message for why `submit_manifest` couldn't resolve one card. */
function manifestBuildErrorMessage(err: { code: string; slug: string }): string {
  switch (err.code) {
    case 'card-done':
      return `CARD_CLOSED: card "${err.slug}" is already done — a manifest cannot include a closed card.`
    case 'contains-secret':
      return `CONTAINS_SECRET: card "${err.slug}"'s body looks like it contains a secret — refusing to fold it into a boot prompt.`
    case 'not-found':
      return `NOT_FOUND: no card "${err.slug}" exists on this board.`
    default:
      return `BAD_ARGS: invalid slug "${err.slug}".`
  }
}

/**
 * T63/BUG-10: a malformed `create_session` `bootOverride` returns a structured,
 * steering error — NEVER the old silent drop that quietly launched the operator's
 * global model instead of the requested one. Names the allowlist so the agent can
 * retry precisely (errors-that-steer, T44 S1).
 */
function invalidBootOverrideError(reason: string): CallToolResult {
  const denial = {
    error: 'INVALID_BOOT_OVERRIDE',
    message: `The bootOverride was rejected and NOT applied: ${reason}`,
    nextActions: [
      {
        do: 'Pass bootOverride as a JSON object with only { model?, effort? } — both optional strings, e.g. {"model":"sonnet","effort":"high"}.',
        why: 'Only the model + effort capacity knobs are allowlisted at agent boot; every other launch field is a privilege-escalation vector and is refused.'
      }
    ]
  }
  return { content: [{ type: 'text', text: JSON.stringify(denial) }], isError: true }
}

/** Resolve the owning folder path of a session id (or `undefined` if unknown). */
function findSessionFolder(folders: FolderEntry[], sessionId: string): string | undefined {
  if (!sessionId) return undefined
  for (const f of folders) {
    for (const s of f.sessions) {
      if (s.sessionId === sessionId) return s.projectPath
    }
  }
  return undefined
}

/**
 * T215: the gate folder for a verb that carries ONLY a `sessionId` — the
 * disk scan FIRST, then the two in-flight registries.
 *
 * Why the widening is load-bearing rather than defensive: `findSessionFolder`
 * scans sessions with a transcript ON DISK. A live-but-born-synthetic session
 * (`synthetic-<uuid>` — the renderer's `liveTerminals` key, which
 * `PtySessionIndex` happily holds) has no scan row, so the gate folder resolves
 * to `undefined` and the call dies as `FOLDER_NOT_ALLOWED` before any handler
 * runs. That is the same mechanism behind T213's finding that 19 of 28 bound
 * cards carry a dangling `synthetic-` id: a synthetic id is real to the PTY
 * index and invisible to the folder scan. `get_session`'s HANDLER already
 * consults these registries for a spawning id; this lifts the same lookup to
 * the gate, where a `sessionId`-only mutation needs it.
 *
 * `get_session`'s own gate resolution is deliberately left untouched.
 */
function resolveSessionGateFolder(folders: FolderEntry[], sessionId: string): string | undefined {
  const onDisk = findSessionFolder(folders, sessionId)
  if (onDisk) return onDisk
  const registered = listInflightSessions().find((e) => e.syntheticId === sessionId)
  if (registered) return registered.folderPath
  return inFlightFolderFor(sessionId)
}

/**
 * Build the B2 disclosure the operator sees before approving an agent mutation:
 * the ACTUAL action + the verbatim agent-supplied prompt (the prompt-injection
 * surface), the resolved permission mode (agent sessions are force-downgraded to
 * `default`, never inheriting skip-perms), and any non-default launch flags the
 * agent requested (bootOverride is allowlisted to model/effort by `agent-boot`).
 * A generic "requests X" line is not a control — you cannot approve what you
 * cannot see. Most of the disclosure lives in the `prompt` string the overlay
 * renders verbatim; for `create_worktree` the resolved `WORKTREE.md` shell
 * commands that will run (the RCE surface) are additionally disclosed in the
 * dedicated `commands` field (T08). Async because that resolution reads disk.
 */
async function buildConfirmDisclosure(
  op: McpOp,
  args: Record<string, unknown>,
  folder: string,
  /**
   * T72: set when this confirm is an inheritance-DISCOVERY (a mutation denied in a
   * canonical worktree of an already-allowed repo). Overrides the op-specific
   * disclosure with the contextual "inherit agent control?" variant that names the
   * parent repo and narrates all three senses (Always / Only this / Deny).
   */
  inheritDiscovery?: { repoRoot: string; worktree: string }
): Promise<{
  prompt: string
  permissionMode: string
  nonDefaultFlags: string[]
  commands: string[]
  /** T61: whether to render the agent-control-inheritance opt-out checkbox. */
  worktreeInheritOffer?: boolean
  /** T72: whether to render the inheritance-discovery scope selector. */
  inheritDiscoveryOffer?: boolean
  /** T104: the submit_manifest checklist rows, resolved from disk. */
  manifestCards?: ManifestCardDisclosure[]
  /** T104: the whole-batch cost-estimate note. */
  manifestCostNote?: string
}> {
  // T72: the discovery variant is disclosure-shape-independent of the op — it names
  // the nexus (this worktree belongs to a repo you already allow) and every scope,
  // so the parked Inbox row (no selector) still conveys all three. The prompt is
  // built here (verbatim narration, like the other prompts); the overlay adds the
  // segmented Always/Only-this selector via i18n. `inheritDiscoveryOffer` flags it.
  if (inheritDiscovery) {
    const wtName = path.basename(inheritDiscovery.worktree)
    const repoName = path.basename(inheritDiscovery.repoRoot)
    const action =
      op === 'create_session'
        ? 'Create a session'
        : op === 'spawn_terminal'
          ? 'Spawn a terminal'
          : op === 'create_worktree'
            ? 'Create a worktree'
            : `Run ${op}`
    const prompt =
      `${action} in worktree "${wtName}".\n\n` +
      `This worktree belongs to "${repoName}", which you already allow for agents. ` +
      `Inherit agent control here so agents can act in it without a separate "Allow agent control"?\n\n` +
      `• Always — worktrees of this type (.claude/worktrees/*) inherit automatically ` +
      `from now on; revocable by turning off agent control on the repo.\n` +
      `• Only this — allow just this worktree, just this app session.\n` +
      `• Deny — keep it blocked (the fail-closed default).`
    return {
      prompt,
      permissionMode: 'default',
      nonDefaultFlags: [],
      commands: [],
      inheritDiscoveryOffer: true
    }
  }
  switch (op) {
    case 'create_session': {
      const kind = strField(args, 'kind') ?? 'new'
      const prePrompt = strField(args, 'prePrompt')
      const flags: string[] = []
      const boot = asRecord(args.bootOverride)
      const model = strField(boot, 'model')
      const effort = strField(boot, 'effort')
      if (model) flags.push(`model=${model}`)
      if (effort) flags.push(`effort=${effort}`)
      const prompt =
        `Create a new Claude session (${kind}) in:\n  ${folder}\n\n` +
        (prePrompt ? `Initial prompt:\n\n${prePrompt}` : 'No initial prompt.')
      return { prompt, permissionMode: 'default', nonDefaultFlags: flags, commands: [] }
    }
    case 'spawn_terminal': {
      const wt = strField(args, 'worktreePath') ?? folder
      return {
        prompt: `Spawn a split shell terminal in:\n  ${wt}`,
        permissionMode: 'default',
        nonDefaultFlags: [],
        commands: []
      }
    }
    case 'adopt_folder': {
      // Reachable only in the `ask` mode (this verb runs free by default). The copy
      // must not promise a second gate that no longer exists: pinning IS the grant
      // now — agents can act in the folder immediately, and blocking it afterwards
      // is the folder-menu opposite.
      return {
        prompt: `Pin this existing folder into the sidebar:\n  ${folder}\n\nNo files are created or changed. Agents can act in it immediately — create sessions, spawn terminals, read transcripts. Block it from the folder menu if you don't want that.`,
        permissionMode: 'default',
        nonDefaultFlags: [],
        commands: []
      }
    }
    case 'create_worktree': {
      const branch = strField(args, 'branch') ?? '(unnamed)'
      // This card: `base` (not the never-schema'd `baseRef`) is the explicit-fork param.
      const baseRef = strField(args, 'base')
      const ref = strField(args, 'ref')
      // Resolve the WORKTREE.md commands this create will actually run (read-only)
      // and disclose them — this op runs committed shell scripts via `sh -c` (T08).
      const preview = await previewWorktreeCommands(folder, branch, baseRef)
      let prompt = `Create a git worktree in repo:\n  ${folder}\n\nWorktree dir named: ${branch}`
      // T44 S2: disclose whether this checks out an EXISTING ref or branches anew.
      if (ref) prompt += `\nChecks out existing ref: ${ref}`
      else {
        prompt += `\nNew branch: ${branch}`
        if (baseRef) prompt += `\nBase ref: ${baseRef}`
      }
      if (preview.target) prompt += `\nWorktree dir: ${preview.target}`
      // The rollback `remove` runs only on failure, so it goes in the narrative,
      // not the success-path `commands` array (which the overlay renders as "will run").
      if (preview.removeOnFailure)
        prompt += `\n\nOn failure, rollback runs:\n  ${preview.removeOnFailure}`
      if (preview.warnings.length)
        prompt += `\n\n(disclosure warnings: ${preview.warnings.join('; ')})`
      // T61: when the global opt-in is ON and this worktree's canonical parent repo
      // is agent-allowed, offer to let the new worktree inherit that control (an
      // opt-out checkbox, default checked). Disclose it in the prompt too so the
      // parked-Inbox surface (which has no checkbox) still shows what will happen.
      const worktreeInheritOffer = await worktreeInheritOfferForTarget(preview.target)
      if (worktreeInheritOffer)
        prompt +=
          '\n\nThis worktree will INHERIT agent control from the repo — agents may act ' +
          'in it without a separate grant. Uncheck below to deny; you can revoke it later ' +
          'by turning off agent control on the repo.'
      return {
        prompt,
        permissionMode: 'default',
        nonDefaultFlags: [],
        commands: preview.commands,
        worktreeInheritOffer
      }
    }
    case 'plan_mission': {
      // T44 S5: the SINGLE mission-grant approval — verbatim scope disclosure.
      const parsed = parsePlanMission(args)
      const prompt = parsed.ok
        ? buildGrantDisclosureText(parsed.value)
        : `Invalid mission grant request: ${parsed.detail}`
      return { prompt, permissionMode: 'grant', nonDefaultFlags: [], commands: [] }
    }
    case 'memory_append': {
      // T79: disclose WHAT lands in project memory — the page, the write mode
      // (hot=replace, else body-append), and the verbatim entry (which the
      // operator must see; provenance is stamped by Harnu, not the agent).
      const page = strField(args, 'page') ?? '(unnamed)'
      const entry = strField(args, 'entry') ?? ''
      const mode = page === 'hot' ? 'REPLACE the hot snapshot' : 'append to the body'
      const prompt =
        `Write to this project's memory (${page}) in repo:\n  ${folder}\n\n` +
        `Action: ${mode}. Frontmatter/status is never touched; Harnu stamps provenance.\n\n` +
        `Entry:\n\n${entry}`
      return { prompt, permissionMode: 'default', nonDefaultFlags: [], commands: [] }
    }
    case 'open_file': {
      // T74 S4: the disclosure MUST show the (containment-checked) file path — the
      // whole point of the verb is "can I interrupt you with THIS?". It only opens a
      // read-only viewer, in the background (no focus steal), and touches no files.
      const p = strField(args, 'path') ?? '(unnamed)'
      const prompt =
        `Open a READ-ONLY markdown viewer for:\n  ${p}\n\n` +
        `in folder:\n  ${folder}\n\n` +
        `No files are created or changed. The pane opens in the background — it will not steal focus.`
      return { prompt, permissionMode: 'default', nonDefaultFlags: [], commands: [] }
    }
    case 'submit_manifest': {
      // T104 §2.1: the verb IS the gate request — this disclosure is the ONLY
      // surface, so it must be built from disk (never the agent's text) and it
      // must be COMPLETE: any one card the server can't resolve refuses the whole
      // batch (AC-1), rather than silently disclosing a partial list.
      const cards = manifestCardRequestsFrom(args)
      const note = strField(args, 'note')
      if (cards.length === 0) {
        return {
          prompt: 'BAD_ARGS: submit_manifest requires at least one card.',
          permissionMode: 'default',
          nonDefaultFlags: [],
          commands: []
        }
      }
      const built = await buildManifestDisclosure(folder, cards, MANIFEST_BOOT_LABELS)
      if (!built.ok) {
        return {
          prompt: `Cannot build this dispatch manifest: ${manifestBuildErrorMessage(built)}`,
          permissionMode: 'default',
          nonDefaultFlags: [],
          commands: []
        }
      }
      const manifestCards: ManifestCardDisclosure[] = built.resolved
      const summary = manifestCards
        .map((c, i) => {
          const bits = [c.kind, c.complexity, c.substrate, c.model].filter(Boolean).join(', ')
          const gapNote = c.gaps.length ? ` [gaps: ${c.gaps.join('; ')}]` : ''
          return `${i + 1}. ${c.slug} — ${c.title}${bits ? ` (${bits})` : ''}${gapNote}`
        })
        .join('\n')
      const prompt =
        `Dispatch manifest for ${manifestCards.length} card(s), IN THIS ORDER, in:\n  ${folder}\n\n` +
        summary +
        '\n\nNo cost history yet — cost estimate unavailable.' +
        (note ? `\n\nNote from the agent:\n${note}` : '') +
        '\n\nUncheck any card below to leave it out — unchecked cards are left exactly as they are (organizable, not denied).'
      return {
        prompt,
        permissionMode: 'default',
        nonDefaultFlags: [],
        commands: [],
        manifestCards,
        manifestCostNote: 'No usage history yet — cost estimate unavailable.'
      }
    }
    case 'delete_card': {
      // T148: unlike its archive_card sibling (silent-allowed), this verb ALWAYS
      // reaches this confirm — it's the only safety net before an irreversible
      // file delete, so the disclosure names exactly what's being removed.
      const slug = strField(args, 'slug') ?? '(unknown)'
      const prompt =
        `Permanently delete roadmap card "${slug}" in:\n  ${folder}\n\n` +
        `This removes the card's file for good — there is no undo. Archive it instead if you might want it back.`
      return { prompt, permissionMode: 'default', nonDefaultFlags: [], commands: [] }
    }
    // T308: reached whenever `create_worker`'s base verdict is `confirm` — in
    // the default free mode that is ONLY `mode: 'act'` (tool-catalog.ts's
    // `forceConfirmFor`); under the operator's `ask` friction mode BOTH modes
    // land here, so the copy must read honestly for either.
    case 'create_worker': {
      const name = strField(args, 'name') ?? '(unnamed)'
      const modeArg = strField(args, 'mode')
      const mode = modeArg === 'act' ? 'act' : 'observe'
      const prompt = strField(args, 'prompt') ?? '(no prompt)'
      const everyMinutes = typeof args.everyMinutes === 'number' ? args.everyMinutes : undefined
      const cadence =
        everyMinutes !== undefined
          ? `every ${everyMinutes} minute${everyMinutes === 1 ? '' : 's'}`
          : '(no cadence given)'
      const lead =
        mode === 'act'
          ? `Create an ACT Scheduler worker "${name}" in:\n  ${folder}\n\nThis worker runs with PERMISSIONS BYPASSED and the full toolset, and does NOT stop at the Approval Inbox — it is a second, unsupervised body that acts on cadence (${cadence}) until you disable it.`
          : `Create an observe Scheduler worker "${name}" in:\n  ${folder}\n\nCadence: ${cadence}. Read-only by allowlist.`
      return {
        prompt: `${lead}\n\nPrompt:\n\n${prompt}`,
        permissionMode: 'default',
        nonDefaultFlags: [],
        commands: []
      }
    }
    // T316: reached whenever `update_worker`'s base verdict is `confirm` — in
    // the default free mode that is ONLY `set.mode === 'act'` or `set.prompt`
    // present (tool-catalog.ts's `forceConfirmFor`); under the operator's
    // `ask` friction mode EVERY edit lands here, so the copy must read
    // honestly either way.
    case 'update_worker': {
      const id = strField(args, 'id') ?? '(unknown)'
      const set = asRecord(args.set)
      const changing = Object.keys(set)
      const mode = strField(set, 'mode')
      const prompt = strField(set, 'prompt')
      const systemPrompt = strField(set, 'systemPrompt')
      const lead =
        mode === 'act'
          ? `Flip Scheduler worker ${id} to ACT in:\n  ${folder}\n\nFrom its next tick on, this worker runs with PERMISSIONS BYPASSED and the full toolset, and does NOT stop at the Approval Inbox.`
          : `Edit Scheduler worker ${id} in:\n  ${folder}\n\nFields changing: ${changing.length > 0 ? changing.join(', ') : '(none)'}.`
      const promptNote = prompt !== undefined ? `\n\nNew prompt:\n\n${prompt}` : ''
      // The system prompt is a second unattended body (`--system-prompt`), so it
      // gets the same verbatim disclosure the prompt does.
      const systemPromptNote =
        systemPrompt !== undefined ? `\n\nNew system prompt:\n\n${systemPrompt}` : ''
      return {
        prompt: `${lead}${promptNote}${systemPromptNote}`,
        permissionMode: 'default',
        nonDefaultFlags: [],
        commands: []
      }
    }
    // T329: remove_containers ALWAYS reaches this confirm; stop_containers
    // does on `force: true`; under `ask` all three do. The copy names each
    // stack with its verdict and path from the last scan.
    case 'stop_containers':
    case 'start_containers':
    case 'remove_containers': {
      const snap = getContainersService()?.snapshot() ?? null
      const prompt = containersConfirmPrompt(op, args, snap)
      return { prompt, permissionMode: 'default', nonDefaultFlags: [], commands: [] }
    }
    case 'delete_worker': {
      // T316: unlike update_worker (silent-allowed), this verb ALWAYS reaches
      // this confirm — the only safety net before an irreversible delete that
      // also drops the worker's run history and kills a live tick.
      const id = strField(args, 'id') ?? '(unknown)'
      const prompt =
        `Permanently delete Scheduler worker ${id} in:\n  ${folder}\n\n` +
        `This removes its definition and run history for good, and stops a live tick if one is running — there is no undo. Disable it instead (update_worker) if you might want it back.`
      return { prompt, permissionMode: 'default', nonDefaultFlags: [], commands: [] }
    }
    default:
      return {
        prompt: `MCP agent requests "${op}"${folder ? ` in ${folder}` : ''}`,
        permissionMode: 'default',
        nonDefaultFlags: [],
        commands: []
      }
  }
}

// ---- T93: durable "always allow this verb here" (settings.local.json) --------

/** Absolute path to a folder's `.claude/settings.local.json`. */
function settingsLocalPath(folder: string): string {
  return path.join(folder, '.claude', 'settings.local.json')
}

/** Read + parse a folder's `settings.local.json`, or `undefined` if missing/corrupt. */
async function readSettingsLocal(folder: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(settingsLocalPath(folder), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Persist a durable `mcp__harnu__<verb>` allow rule into the folder's
 * `.claude/settings.local.json` (read-merge-write, dedup, preserve unrelated keys),
 * creating the `.claude` dir if missing. Best-effort: a write failure logs and is
 * swallowed — it never fails the mutation the operator already allowed. Guarded to
 * the allowable verbs so `plan_mission` can never be durably auto-allowed.
 */
async function persistVerbAllowRule(folder: string, def: McpToolDef): Promise<void> {
  if (!folder || !def.alwaysAllowable) return
  try {
    const merged = mergeVerbAllowRule(await readSettingsLocal(folder), verbAllowRule(def.op))
    await fs.mkdir(path.dirname(settingsLocalPath(folder)), { recursive: true })
    await fs.writeFile(settingsLocalPath(folder), JSON.stringify(merged, null, 2) + '\n', 'utf8')
  } catch (err) {
    console.error('[mcp] persist always-allow rule failed:', err)
  }
}

/** Whether the folder's `settings.local.json` durably allows Harnu verb `op` (T93). */
async function folderSettingsAllowsVerb(folder: string, op: McpOp): Promise<boolean> {
  return settingsAllowsVerb(await readSettingsLocal(folder), op)
}

/**
 * The single composition point: gate one inbound tool call through the cores in
 * the mandated order (audit → permission → confirm-for-mutations → actuate),
 * then disclose / actuate / deny accordingly. Every exit is audited.
 */

/**
 * T120: the ONE call site that runs a tool's actuation — `def.handler`, wired
 * onto every entry of {@link WIRED_TOOLS} by `tool-handlers.ts`. Replaces the
 * old `runRead`/`runMutation` op-name switches: every dispatch path below
 * (read, grant-allow, silent-allow, inherit-once, settings-local always-allow,
 * confirm-allow) now funnels through this one function.
 *
 * T123 W5 (AC12/AC13): the handler promise is raced against
 * {@link TOOL_CALL_DEADLINE_MS}. A trip returns a structured `TOOL_TIMEOUT`
 * error and audits the timeout instead of leaving the caller hanging — this
 * is the ONE place a deadline needs wiring precisely because it is the ONE
 * call site for `def.handler` (see the T120 note above). Node cannot cancel
 * `def.handler`'s own in-flight work, but once this function returns,
 * `handleToolCall`'s `folders`/`policy` locals and this function's own `ctx`
 * go out of scope — nothing on the server's side keeps holding them past the
 * deadline.
 *
 * BUG-33 (§3.1/§3.2/§3.3): a call that trips the deadline may still complete
 * its mutation after the caller already got `TOOL_TIMEOUT` and retried — this
 * function is ALSO where that gets reconciled:
 *  - A mutating call derives a stable `callId` (idempotency-registry.ts) and
 *    consults the registry BEFORE actuating. A retry that lands while the
 *    original is still in flight, or after it already applied, replays the
 *    recorded outcome instead of running `def.handler` a second time (AC1) —
 *    this happens before the grant-allow branch's `reserve`, so a deduped
 *    retry never spends a second budget unit. A retry of a call that
 *    genuinely FAILED does not dedupe (BUG-57) — it re-actuates like a fresh
 *    call, audited distinctly (`verdict: 're-actuate-after-failure'`) from a
 *    `duplicate-replay` so the trail shows a real second attempt, not a
 *    cache hit.
 *  - The synthetic timeout record and the handler's eventual late-completion
 *    record are stamped with the SAME `callId` (AC2).
 *  - A mutable `deadlineFlag` is threaded into the handler's `ctx` so a
 *    verb whose shape allows it can check "did the response already go out?"
 *    before its own final commit step (AC5 — see tool-handlers.ts /
 *    create-session-core.ts).
 *  - A timed-out mutation writes a distinct `:timeout` shadow entry instead
 *    of the success entry it would otherwise never reach (AC4).
 */
async function actuate(
  def: McpToolDef,
  args: Record<string, unknown>,
  ctx: ToolHandlerCtx
): Promise<CallToolResult> {
  if (!def.handler) return errorResult('NO_HANDLER')

  // Reads never mutate, so they never derive a callId and skip the registry
  // entirely — dedup only ever applies to a MUTATING verb's retry.
  let callId: string | undefined
  if (def.mutates) {
    callId = deriveCallId(def.op, ctx.folder, args, strField(args, 'idempotencyKey'))
    // Peek BEFORE beginCall — beginCall re-arms a live 'failed' entry to
    // 'in-flight' as a side effect, so the "this is a retry-after-failure"
    // signal only exists to read right now.
    const retriedAfterFailure = wasRecentlyFailed(callId)
    const existing = beginCall(callId)
    if (existing) {
      // Only 'in-flight' and 'applied' land here now — 'failed' never blocks.
      appendAudit({
        ts: Date.now(),
        tool: def.name,
        folder: ctx.folder,
        verdict: existing.status === 'in-flight' ? 'duplicate-in-flight' : 'duplicate-replay',
        disclosedPayloadSummary: 'none',
        result: existing.status,
        callId
      })
      auditPersister.schedule()
      return existing.status === 'in-flight'
        ? errorResult('CALL_IN_FLIGHT')
        : (existing.result ?? errorResult('CALL_ALREADY_APPLIED'))
    }
    if (retriedAfterFailure) {
      appendAudit({
        ts: Date.now(),
        tool: def.name,
        folder: ctx.folder,
        verdict: 're-actuate-after-failure',
        disclosedPayloadSummary: 'none',
        result: 'retrying',
        callId
      })
      auditPersister.schedule()
    }
  }

  const deadlineFlag = createDeadlineFlag()
  const work = def.handler(args, { ...ctx, deadlineFlag })
  const raced = await withDeadline(
    work,
    TOOL_CALL_DEADLINE_MS,
    setTimeout,
    clearTimeout,
    deadlineFlag
  )
  if (raced.timedOut) {
    // The response already timed out; trace the late settlement instead of
    // letting it vanish silently, and reconcile the idempotency registry so a
    // retry that lands after this settles gets the real outcome (AC1/AC2).
    // Captures only the tool name/folder — never args/ctx (no scope retention).
    const tool = def.name
    const folder = ctx.folder
    const op = def.op
    work
      .then((value) => {
        if (!callId) return
        const ok = ackIsSuccess(value)
        completeCall(callId, ok ? 'applied' : 'failed', value)
        appendAudit({
          ts: Date.now(),
          tool,
          folder,
          verdict: 'late-completion',
          disclosedPayloadSummary: 'none',
          result: ok ? 'ok' : 'error',
          callId
        })
        auditPersister.schedule()
        pushShadowEntry({
          sessionId: '',
          event: `mcp:${op}:${ok ? 'late-success' : 'late-failure'}`,
          by: 'system',
          summary: `${op} ${folder} completed after its TOOL_TIMEOUT already returned`,
          ts: Date.now()
        })
      })
      .catch((e) => {
        console.debug(`[mcp] ${tool} rejected after TOOL_TIMEOUT:`, e)
        if (!callId) return
        const failResult = errorResult(`late failure: ${(e as Error).message}`)
        completeCall(callId, 'failed', failResult)
        appendAudit({
          ts: Date.now(),
          tool,
          folder,
          verdict: 'late-completion',
          disclosedPayloadSummary: 'none',
          result: 'error',
          callId
        })
        auditPersister.schedule()
      })
    appendAudit({
      ts: Date.now(),
      tool: def.name,
      folder: ctx.folder,
      verdict: 'timeout',
      disclosedPayloadSummary: 'none',
      result: 'TOOL_TIMEOUT',
      callId
    })
    auditPersister.schedule()
    // AC4: a distinct timeout shadow entry so the operator sees the ambiguity
    // rather than a false success — the outer grant/silent-allow branches'
    // success-only pushShadowEntry never runs for this non-success ACK.
    if (callId) {
      pushShadowEntry({
        sessionId: strField(args, 'sessionId') ?? '',
        event: `mcp:${def.op}:timeout`,
        by: 'system',
        summary: `${def.op} ${ctx.folder} timed out — may still be applying`,
        ts: Date.now()
      })
    }
    return errorResult('TOOL_TIMEOUT')
  }
  if (callId) completeCall(callId, ackIsSuccess(raced.value) ? 'applied' : 'failed', raced.value)
  return raced.value
}

async function handleToolCall(def: McpToolDef, rawArgs: unknown): Promise<CallToolResult> {
  const args = asRecord(rawArgs)
  const now = Date.now()

  // T63/BUG-10: validate + normalize create_session's bootOverride at the border,
  // BEFORE the gate parks a confirm or dispatches — a schema-shape check precedes
  // authorization. A JSON-string form is parsed tolerantly (so `'{"model":"sonnet"}'`
  // still applies); a bad shape / forbidden key returns a structured
  // INVALID_BOOT_OVERRIDE steer instead of the old silent drop (agent asked for
  // sonnet, operator's global opus launched, no error, no echo). Normalizing to
  // the canonical object here means the disclosure + actuation read the SAME
  // validated value. (buildPlanInput drops bootOverride before the gate's
  // validator, so this is the only place it is checked.)
  if (def.op === 'create_session') {
    const parsedBoot = parseAgentBootOverride(args.bootOverride)
    if (!parsedBoot.ok) return invalidBootOverrideError(parsedBoot.reason)
    if (Object.keys(parsedBoot.value).length > 0) args.bootOverride = parsedBoot.value
    else delete args.bootOverride
  }

  // Assemble the live policy snapshot: kill switch + the `ask` friction opt-in +
  // the pinned folders' BLOCK flags + scanned roots. There is no allowlist to
  // assemble any more — a folder is reachable unless the operator blocked it.
  const enabled = await readMcpEnabled()
  const ask = await readMcpAsk()
  const projectsFile = await readUserProjects()
  const folders = await scanFolders()
  const policy = assemblePolicy(
    { serverEnabled: enabled, ask },
    projectsFile.projects.map((p) => ({ path: p.path, agentDenied: p.agentDenied === true })),
    folders.map((f) => f.path)
  )

  // Resolve the target folder for the gate. A get_session call carries only an
  // id, so its owning folder is resolved from the scan (else the transcript gate
  // fails CLOSED with FOLDER_NOT_ALLOWED).
  let gateFolder = strField(args, 'folder')
  if (def.op === 'get_session') {
    gateFolder = findSessionFolder(folders, strField(args, 'sessionId') ?? '')
  } else if (
    def.op === 'message_session' ||
    def.op === 'orchestrator_arm' ||
    def.op === 'orchestrator_disarm'
  ) {
    // T215 §2.5/§3.6: the RECIPIENT's folder is the gate anchor — the risk is
    // what a message causes in the recipient's working tree, not where the
    // (unidentifiable) sender sits. Unlike `get_session` this consults the
    // in-flight registries too, so a live born-synthetic recipient is
    // reachable instead of dying as FOLDER_NOT_ALLOWED.
    //
    // T309 (ADR-0013): `orchestrator_arm`/`orchestrator_disarm` target a
    // session the SAME way `message_session` targets a recipient — the TARGET's
    // owning folder is the anchor, never a caller-supplied one.
    gateFolder = resolveSessionGateFolder(folders, strField(args, 'sessionId') ?? '')
  } else if (def.op === 'update_worker' || def.op === 'delete_worker') {
    // T316: same reasoning as the block above, applied to a worker instead of
    // a session — the verb carries only `id`, so the gate anchor is the
    // worker's OWN folder, resolved from the Scheduler's in-memory cache. An
    // unknown id resolves to `undefined` and fails CLOSED (FOLDER_NOT_ALLOWED),
    // the same as an unknown sessionId does for get_session/message_session.
    gateFolder = folderForWorkerId(strField(args, 'id') ?? '')
  }

  const plan = planToolCall({
    tool: def.name,
    input: buildPlanInput(def.op, args, gateFolder),
    policy,
    now,
    grants: snapshotGrants(), // T44 S5: live mission grants may auto-allow in scope
    inheritOnce: snapshotInheritOnce(), // T72: worktrees allowed "Only this" this session
    homeDir: os.homedir()
  })
  appendAudit(plan.auditRecord)
  auditPersister.schedule()

  // Reads: dispatch-on-allow. A dispatched MUTATION (grant-allowed T44 S5, or
  // inherit-once-allowed T72) is handled by the branches below, so gate this on the
  // read classification — reads are the only `!mutates` dispatch.
  if (plan.shouldDispatch && !def.mutates) {
    return await actuate(def, args, {
      folder: gateFolder ?? '',
      folders,
      denyFolders: policy.denyFolders ?? [],
      bridge: deps?.bridge
    })
  }

  // T44 S5: a grant-allowed mutation. Reserve one unit of budget ATOMICALLY;
  // actuate + shadow-log on success (spend committed only then). A lost race
  // (exhausted/expired) or a failed actuation escalates to the human park.
  if (plan.shouldDispatch && plan.grantAllow) {
    const { grantId } = plan.grantAllow
    const folder = gateFolder ?? ''
    if (reserve(grantId)) {
      // T77c: snapshot the mission's remaining budget SYNCHRONOUSLY — right after the
      // atomic reserve and before any await — so the ACK echoes THIS action's own
      // spend and no concurrent reserve can shift the figure under us.
      const grantBudgetRemaining = remainingFor(grantId)
      try {
        const res = await actuate(def, args, {
          folder,
          folders,
          denyFolders: policy.denyFolders ?? [],
          bridge: deps?.bridge
        })
        // This card (AC2/ADR-0003): refund on ANY non-success outcome, not only a
        // throw. A handler that resolves with `ok:false` (e.g. create_session's
        // spawn never materialized) previously spent the budget unit regardless —
        // a phantom session burned a real approval. `ackIsSuccess` is the same
        // predicate a handler uses to shape its own ACK, so "the action happened"
        // can never drift between the two. The shadow log is gated the same way
        // (invariant 4): it must never claim an action that did not happen.
        if (!ackIsSuccess(res)) {
          release(grantId)
          return res
        }
        // Invariant 4 (audited): the base audit was written above; add a live
        // shadow-log entry so the operator sees what the mission did under the grant.
        pushShadowEntry({
          sessionId: strField(args, 'sessionId') ?? '',
          event: `mcp:${def.op}`,
          by: 'mission-grant',
          summary: `${def.op} ${folder} (grant ${grantId})`,
          ts: Date.now()
        })
        // D3: a worktree the mission just created joins its scope.
        if (def.op === 'create_worktree') {
          const p = resultPayload(res) as { path?: unknown } | undefined
          if (p && typeof p.path === 'string') addDynamicFolder(grantId, p.path)
        }
        // T77c: echo the mission's grantId + remaining budget in the SUCCESS ACK so
        // the agent knows how much of the grant is left (mission proprioception) —
        // an error/non-ACK result passes through untouched (augment returns it by ref).
        const payload = resultPayload(res)
        const merged = augmentAckWithGrant(payload, { grantId, grantBudgetRemaining })
        return merged === payload ? res : textResult(merged)
      } catch (e) {
        release(grantId) // refund — spend commits only on success
        return errorResult(`grant actuation failed: ${(e as Error).message}`)
      }
    }
    // Reserve lost the race (budget/TTL gone) → escalate to a human park (inv. 6).
    return parkMutationConfirm(def, args, folder)
  }

  // T84/T96: a `silentAllowInAgentFolder` verb (open_file's read-only viewer, a
  // board verb's `.md` write) in an agent-allowed folder — silent allow (no
  // per-call confirm; the folder allowlist already permits strictly stronger
  // mutations). Still a mutation for the audit trail; add a shadow-log entry
  // (NO budget — this is not a mission grant) so the operator still sees the
  // action under the folder's standing consent.
  if (plan.shouldDispatch && plan.silentAllowInAgentFolder) {
    const folder = gateFolder ?? ''
    const res = await actuate(def, args, {
      folder,
      folders,
      denyFolders: policy.denyFolders ?? [],
      bridge: deps?.bridge
    })
    pushShadowEntry({
      sessionId: strField(args, 'sessionId') ?? '',
      event: `mcp:${def.op}`,
      by: 'agent-allowed',
      summary: `${def.op} ${folder} (agent-allowed folder)`,
      ts: Date.now()
    })
    return res
  }

  // T72: an inherit-once-allowed mutation ("Only this" earlier this app session).
  // Actuate directly — no budget, no confirm: the prior Allow already authorized
  // this worktree for the session (covers the intra-worktree fan-out). Reached only
  // under the plan's deny+FOLDER_NOT_ALLOWED hardening, never above the kill switch.
  if (plan.shouldDispatch && plan.inheritOnceAllow) {
    return await actuate(def, args, {
      folder: gateFolder ?? '',
      folders,
      denyFolders: policy.denyFolders ?? [],
      bridge: deps?.bridge
    })
  }

  // T93: a durable "always allow this verb here" the operator persisted earlier.
  // Honor the folder's `.claude/settings.local.json` (adopting CC's native
  // permission persistence) so the verb runs WITHOUT re-confirming. Scoped tightly:
  // only for the allowable verbs (excludes plan_mission), only on the normal
  // allowed-folder confirm (NOT the T72 discovery path, whose worktree isn't directly
  // allowlisted), and only when the pure gate already wanted a confirm (so it can
  // only ever downgrade confirm→allow inside an allowed folder, never widen it).
  if (
    plan.shouldConfirm &&
    !plan.inheritDiscovery &&
    gateFolder &&
    def.alwaysAllowable &&
    (await folderSettingsAllowsVerb(gateFolder, def.op))
  ) {
    const res = await actuate(def, args, {
      folder: gateFolder,
      folders,
      denyFolders: policy.denyFolders ?? [],
      bridge: deps?.bridge
    })
    pushShadowEntry({
      sessionId: strField(args, 'sessionId') ?? '',
      event: `mcp:${def.op}`,
      by: 'settings-local',
      summary: `${def.op} ${gateFolder} (always-allowed in settings.local.json)`,
      ts: Date.now()
    })
    return res
  }

  // Mutations needing a human: park the fail-closed confirm (T44 S4 — async). T72:
  // a discovery confirm carries `inheritDiscovery` so the park builds the contextual
  // disclosure and actuates the operator's scope choice.
  if (plan.shouldConfirm) {
    return parkMutationConfirm(def, args, gateFolder ?? '', plan.inheritDiscovery)
  }

  // Denied / malformed / unknown-tool: already audited above. Gate denials with
  // an actionable affordance steer the agent (T44 S1); the rest stay bare.
  return steerError(plan.auditRecord.result, gateFolder)
}

/**
 * The S4 async confirm/park path for a mutation that needs a human (a base
 * `confirm`, or a grant escalation/lost-race). Focused-modal fast path when
 * answered within the window; otherwise parks in the Approval Inbox and returns a
 * pending handle (the human's Allow actuates it). Fail-closed on every non-allow.
 */
async function parkMutationConfirm(
  def: McpToolDef,
  args: Record<string, unknown>,
  folder: string,
  /** T72: set when this is an inheritance-discovery confirm (see planToolCall). */
  inheritDiscovery?: { repoRoot: string; worktree: string }
): Promise<CallToolResult> {
  if (!deps) return errorResult('NOT_READY')
  const disclosure: ConfirmDisclosure = await buildConfirmDisclosure(
    def.op,
    args,
    folder,
    inheritDiscovery
  )
  // T93: offer "always allow this verb here" for an allowable mutation (excludes
  // plan_mission) on the normal confirm path — NOT the T72 discovery variant, which
  // owns its own scope selector. The checkbox defaults unchecked for the dangerous
  // verbs. Independent of the T61/T72 offers, so it may co-render with them.
  if (!inheritDiscovery && def.alwaysAllowable) {
    disclosure.alwaysAllowOffer = true
    disclosure.alwaysAllowDefault = !def.dangerousAlwaysAllow
  }
  const parked = deps.confirm.park(disclosure)

  // Immediate fail-closed (no operator surface / saturated) — nothing parked.
  if (parked.kind === 'denied') {
    auditConfirmDeny(def.name, folder, parked.outcome.reason)
    return errorResult(`denied (${parked.outcome.reason})`)
  }

  // T61: for a create_worktree allow, carry the operator's inherit-checkbox choice
  // (false = they unchecked "inherit agent control") to the actuator. createWorktree
  // still re-gates on the setting + parent-allowed, so this only ever REDUCES.
  // T104: for a submit_manifest allow, carry the SAME resolved disclosure rows
  // `parked` above (never re-read from disk) + the operator's checked-at-Allow
  // slugs, so the actuation can only ever stamp what was actually disclosed.
  const runOptsFor = (
    outcome: ConfirmOutcome
  ):
    | {
        worktreeInherit?: { optedOut: boolean }
        manifest?: {
          resolved: ManifestCardDisclosure[]
          selectedSlugs: string[]
          substrateOverrides: Record<string, string>
        }
      }
    | undefined => {
    if (def.op === 'create_worktree') {
      return { worktreeInherit: { optedOut: outcome.inheritWorktreeControl === false } }
    }
    if (def.op === 'submit_manifest') {
      return {
        manifest: {
          resolved: disclosure.manifestCards ?? [],
          selectedSlugs: outcome.manifestSelectedSlugs ?? [],
          substrateOverrides: outcome.manifestSubstrateOverrides ?? {}
        }
      }
    }
    return undefined
  }

  // The Allow actuation, shared by the inline + parked paths. T72: for a discovery
  // confirm, FIRST apply the operator's scope side-effect (persist opt-in + mark, or
  // register the once-allow), THEN actuate the mutation itself in the worktree. AC5:
  // an absent scope (a parked surface with no selector) defaults to 'once' — least
  // privilege; a surface that could not show the selector NEVER turns on the global
  // capability.
  const actuateAllow = async (outcome: ConfirmOutcome): Promise<CallToolResult> => {
    if (inheritDiscovery) {
      await applyInheritDiscoveryScope(outcome.inheritScope ?? 'once', inheritDiscovery)
    }
    // T93: persist the durable "always allow this verb here" rule BEFORE actuating —
    // the operator's explicit durable intent shouldn't hinge on this one call
    // succeeding. Best-effort + guarded to the allowable verbs (persistVerbAllowRule).
    if (outcome.alwaysAllow === true) {
      await persistVerbAllowRule(folder, def)
    }
    return actuate(def, args, {
      folder,
      folders: [],
      denyFolders: [],
      bridge: deps?.bridge,
      opts: runOptsFor(outcome)
    })
  }

  // Race the human's answer against the inline window (focused-modal fast path).
  const raced = await raceSettle(parked.settled, CONFIRM_WINDOW_MS)
  if (raced !== 'PENDING') {
    if (raced.verdict !== 'allow') {
      auditConfirmDeny(def.name, folder, raced.reason)
      return errorResult(`denied by operator (${raced.reason})`)
    }
    return actuateAllow(raced)
  }

  // Unanswered after the window: the confirm STAYS live (parked, no 30s deny —
  // BUG-5). Return a pending handle; actuate on the human's eventual Allow.
  stashApproval(parked.id, { status: 'pending', tool: def.name, folder, ts: Date.now() })
  void parked.settled.then(async (outcome) => {
    let mapped: ApprovalStatusResult
    if (outcome.verdict === 'allow') {
      try {
        const res = await actuateAllow(outcome)
        mapped = outcomeToStatus(outcome, resultPayload(res))
      } catch (e) {
        mapped = { status: 'denied', reason: `actuation failed: ${(e as Error).message}` }
        auditConfirmDeny(def.name, folder, 'ACTUATION_FAILED')
      }
    } else {
      mapped = outcomeToStatus(outcome)
      auditConfirmDeny(def.name, folder, outcome.reason)
    }
    stashApproval(parked.id, { ...mapped, tool: def.name, folder, ts: Date.now() })
  })
  return textResult({
    status: 'pending',
    approvalId: parked.id,
    message:
      'Parked in the Approval Inbox — the operator was away. It will actuate when they Allow.',
    nextActions: [
      {
        do: `call get_approval({ approvalId: "${parked.id}" }) to poll the operator's decision`,
        why: 'the confirm resolves when the operator answers in the Approval Inbox'
      }
    ]
  })
}

/**
 * T72: apply the operator's inheritance-discovery scope choice, server-side, BEFORE
 * the mutation actuates. Two disjoint side effects (never gates the mutation itself —
 * the Allow already authorized it):
 *
 *  - `'always'` → persistent + revocable-in-block. Turn on the global opt-in AND mark
 *    THIS worktree with the birth marker. BOTH are required: `assemblePolicy` only
 *    honors a MARKED worktree, so flipping the global flag alone would NOT allow this
 *    unmarked worktree (the discovery scenario is opt-in-OFF → no marker) — the mark
 *    is load-bearing. The mark is scoped by prefix: revoking the repo drops it.
 *    D1 (locked): only the CURRENT worktree is marked — pre-existing sibling worktrees
 *    each get their own discovery confirm (per-worktree consent, smallest blast radius).
 *  - `'once'` → ephemeral, process-lifetime. Register the worktree in the in-memory
 *    inherit-once registry (covers the intra-worktree fan-out; gone on restart).
 */
async function applyInheritDiscoveryScope(
  scope: 'always' | 'once',
  d: { repoRoot: string; worktree: string }
): Promise<void> {
  if (scope === 'always') {
    await writeWorktreeInheritControl(true)
    await setUserProjectInheritAgentControl(d.worktree, true)
  } else {
    addInheritOnce(d.worktree)
  }
}

// ---- SDK server + transport wiring ------------------------------------------

/** Register every catalog tool on a fresh {@link McpServer}. Dispatches through {@link WIRED_TOOLS} — the `handler`-enriched array — never the raw `MCP_TOOLS`. */
function registerTools(server: McpServer): void {
  for (const def of WIRED_TOOLS) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
        // T93: opt a core verb out of `claude`'s default MCP-tool deferral so the
        // session sees it on turn 1 (no ToolSearch round-trip). The rest stay
        // deferred — the client reads this `_meta` key off the tools/list entry.
        ...(def.alwaysLoad ? { _meta: { 'anthropic/alwaysLoad': true } } : {})
      },
      (rawArgs: unknown): Promise<CallToolResult> => handleToolCall(def, rawArgs)
    )
  }
}

/** Open a fresh MCP session: a transport + a tool-registered server, connected. */
async function openSession(): Promise<StreamableHTTPServerTransport> {
  if (!TransportCtor || !McpServerCtor) throw new Error('mcp sdk not loaded')
  const transport: StreamableHTTPServerTransport = new TransportCtor({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sid: string) => {
      transports.set(sid, transport)
    }
  })
  transport.onclose = (): void => {
    const sid = transport.sessionId
    if (sid) transports.delete(sid)
  }
  // T93: serve the compact self-awareness digest as InitializeResult.instructions.
  // `claude` auto-injects it as `## harnu` into the session context — the native
  // channel that reaches even sessions Harnu did NOT spawn (user-configured server),
  // where the T55 append-system-prompt prepend never runs. The T85 language line is
  // resolved from the live Settings locale at initialize time.
  const server = new McpServerCtor(
    { name: MCP_SERVER_NAME, version: '1' },
    { instructions: buildHarnuMcpInstructions(memoryLanguageLine(appLocale())) }
  )
  registerTools(server)
  await server.connect(transport)
  return transport
}

/** Parse a `Content-Length` header value to a number (or `undefined`). */
function contentLengthOf(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** Read the request body (capped at {@link BODY_MAX}) and JSON-parse it. */
function readBody(
  req: IncomingMessage
): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
  return new Promise((resolve) => {
    let raw = ''
    let tooLarge = false
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > BODY_MAX) {
        tooLarge = true
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) return resolve({ ok: false, status: 413 })
      if (raw.length === 0) return resolve({ ok: true, body: undefined })
      try {
        resolve({ ok: true, body: JSON.parse(raw) })
      } catch {
        resolve({ ok: false, status: 400 })
      }
    })
    req.on('error', () => resolve({ ok: false, status: 400 }))
  })
}

/** The loopback request handler: guard → route to a (new or existing) transport. */
async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const guard = parseMcpRequest({
    method: req.method,
    url: req.url,
    headers: req.headers,
    token,
    contentLength: contentLengthOf(req.headers['content-length'])
  })
  if (!guard.ok) {
    res.writeHead(guard.status)
    res.end()
    return
  }

  const parsed = await readBody(req)
  if (!parsed.ok) {
    res.writeHead(parsed.status)
    res.end()
    return
  }
  const body = parsed.body

  const sidHeader = req.headers['mcp-session-id']
  const sessionId = Array.isArray(sidHeader) ? sidHeader[0] : sidHeader
  let transport = sessionId ? transports.get(sessionId) : undefined
  if (!transport) {
    if (!isInitializeRequestFn(body)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'No valid session id' },
          id: null
        })
      )
      return
    }
    transport = await openSession()
  }
  await transport.handleRequest(req, res, body)
}

// ---- Start / stop -----------------------------------------------------------

/** Bind `server` to `port` (`0` for an OS-assigned ephemeral port); resolve the bound port. */
function listenOnce(server: Server, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })
}

/**
 * Start the listener: read the persisted token (minting one on first run —
 * {@link readOrCreateToken}, ADR-0004 / BUG-35), attempt to re-bind the
 * previously stored port, write the config file AT the resolved port, then
 * flip `running` (the pty-provider gate) ONLY after all of that succeeds.
 * Idempotent — a no-op when already listening.
 */
async function start(): Promise<void> {
  if (httpServer) return
  const userDataDir = app.getPath('userData')
  token = await readOrCreateToken(userDataDir)
  const storedPort = await readStoredPort(userDataDir)
  const server = createServer((req, res) => {
    void handleHttp(req, res)
  })
  let fellBack = false
  let boundPort: number
  if (storedPort) {
    try {
      boundPort = await listenOnce(server, storedPort)
    } catch {
      // Stored port is taken (or any other bind error) — fall back to a fresh
      // ephemeral port (D2). A session spawned before this restart holds the
      // old port and is unavoidably orphaned; D3 discloses that rather than
      // failing silently.
      fellBack = true
      boundPort = await listenOnce(server, 0)
    }
  } else {
    boundPort = await listenOnce(server, 0)
  }
  listeningPort = boundPort
  httpServer = server
  portFallbackWarning = fellBack
    ? `Stored MCP port ${storedPort} was unavailable — bound a new ephemeral port instead. Sessions spawned before this restart cannot reach the control server; resume them to reconnect.`
    : null
  if (fellBack) console.warn(`[mcp] ${portFallbackWarning}`)
  // Config is written AFTER the port is known but BEFORE `running` flips, so the
  // pty provider never injects a config the server isn't yet serving.
  await writeConfigFile(listeningPort, token)
  await writeStore(userDataDir, { token, port: listeningPort })
  running = true
}

/**
 * Stop the listener: close every per-session transport (a plain `http` close
 * hangs on a live SSE stream), drop all keep-alive sockets, close the server,
 * and delete the config file. Lowers `running` FIRST so no spawn injects mid-stop.
 * Deliberately does NOT touch the token store (`<userData>/mcp-token.json`) —
 * only `harnu.mcp.json` is per-boot disposable; the persisted token/port must
 * survive so the next `start()` can reuse them (ADR-0004 / BUG-35).
 */
async function stop(): Promise<void> {
  running = false
  portFallbackWarning = null
  // Flush any debounced audit write before the listener closes so the tail of
  // the ring is never lost on disable/quit (T26).
  await auditPersister.flush()
  const all = [...transports.values()]
  transports.clear()
  for (const t of all) {
    try {
      await t.close()
    } catch {
      /* best-effort */
    }
  }
  if (httpServer) {
    const server = httpServer
    httpServer = null
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  listeningPort = 0
  await deleteConfigFile()
}

// ---- Registration + teardown ------------------------------------------------

/**
 * Construct and register the Harnu MCP server. Loads the SDK dynamically, wires
 * the pty `--mcp-config` provider, registers the `mcp:*` IPC, and starts the
 * listener ONLY when the persisted enable flag is `true` (OFF by default).
 *
 * @param _getWindow - reserved window resolver (the confirm + bridge shells own
 *   the renderer surface; the server itself needs no direct window handle today).
 * @param injected - the live command bridge + confirm gate.
 */
export async function registerMcpServer(
  _getWindow: () => BrowserWindow | null,
  injected: McpServerDeps
): Promise<void> {
  deps = injected

  // T44 S5: broadcast grant changes (create/spend/revoke/expire) so the UI's live
  // mission list stays current.
  setGrantChangeListener(() => {
    const win = _getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('mcp:grants:changed', listGrants())
  })

  // Dynamic SDK load (T1 spike): keeps the externalized-main bundle free of a
  // static require for `@modelcontextprotocol/sdk`.
  const mcpMod = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const httpMod = await import('@modelcontextprotocol/sdk/server/streamableHttp.js')
  const typesMod = await import('@modelcontextprotocol/sdk/types.js')
  McpServerCtor = mcpMod.McpServer
  TransportCtor = httpMod.StreamableHTTPServerTransport
  isInitializeRequestFn = typesMod.isInitializeRequest

  await loadAudit()

  // T93: hydrate the auto-register cache so the sync pty provider reads a fresh
  // value from the first spawn (default ON until disk says otherwise).
  autoRegisterEnabled = await readMcpAutoRegister()

  // The pty provider injects `--mcp-config` + `--allowedTools mcp__harnu,mcp__capy` ONLY while
  // truly listening, the operator has not opted out of auto-register (T93), AND
  // the config file actually exists on disk right now — a fresh `fs.existsSync`
  // check made AT SPAWN TIME (T123 §3.1 AC14 / BUG-32). `running` can be stale by
  // the time a session boots/resumes (the operator flipped the toggle in the
  // gap), so re-checking the file itself NARROWS the race: absent file ⇒ `[]` ⇒
  // `--mcp-config` omitted entirely, instead of pointing `claude` at a file that
  // isn't there ("MCP config file not found"). It does NOT eliminate the race —
  // the file can still vanish between THIS `existsSync` call and the spawned
  // `claude` process's own read of `--mcp-config`; see `shouldInjectMcpConfig`'s
  // docstring in `config-file.ts` for that residual TOCTOU window.
  setMcpArgsProvider(() =>
    appManagedMcpArgs(
      shouldInjectMcpConfig(running, autoRegisterEnabled, existsSync(configPath())),
      configPath()
    )
  )

  ipcMain.handle('mcp:status', async () => ({
    enabled: await readMcpEnabled(),
    port: listeningPort,
    connected: transports.size > 0,
    autoRegister: autoRegisterEnabled,
    // D3 (ADR-0004 / BUG-35): non-null only when this boot had to fall back
    // to a fresh port because the previously-stored one was taken.
    portFallbackWarning
  }))

  // T93: auto-register opt-out toggle (default ON). Refreshes the sync cache so the
  // NEXT spawn honors the new value immediately.
  ipcMain.handle('mcp:autoRegister:get', async () => {
    autoRegisterEnabled = await readMcpAutoRegister()
    return autoRegisterEnabled
  })
  ipcMain.handle('mcp:autoRegister:set', async (_e, enabled: boolean) => {
    await writeMcpAutoRegister(enabled === true)
    autoRegisterEnabled = enabled === true
    return autoRegisterEnabled
  })

  ipcMain.handle('mcp:setEnabled', async (_e, enabled: boolean) => {
    await writeMcpEnabled(enabled)
    try {
      if (enabled) await start()
      else await stop()
    } catch (err) {
      console.error('[mcp] toggle failed:', err)
    }
    return { enabled, port: listeningPort }
  })

  ipcMain.handle('mcp:getAudit', () => getAuditLog())

  // The friction opt-in ("Ask before agent actions"). Default OFF — agents act
  // without confirms. Turning it ON puts the per-action human confirm back in front
  // of EVERY mutating verb (and re-arms the containment check). Read live at every
  // gate assembly, so it takes effect on the next tool call, no restart.
  ipcMain.handle('mcp:ask:get', () => readMcpAsk())
  ipcMain.handle('mcp:ask:set', async (_e, ask: boolean) => {
    await writeMcpAsk(ask === true)
    return readMcpAsk()
  })

  // T44 S5: mission-grant management — list live grants + revoke.
  ipcMain.handle('mcp:grants:list', () => listGrants())
  ipcMain.handle('mcp:grants:revoke', (_e, { id }: { id: string }) => ({ ok: revokeGrant(id) }))

  // OFF by default — only start when the user has explicitly opted in.
  if (await readMcpEnabled()) {
    try {
      await start()
    } catch (err) {
      console.error('[mcp] start failed:', err)
    }
  }
}

/**
 * Tear the server down on disable / window unload / app quit: close every
 * per-session transport, the HTTP listener, and delete the config file. Safe to
 * call when never started. (The confirm gate's parked promises are denied by the
 * confirm shell's own `closeMcpConfirm`.)
 */
export async function closeMcpServer(): Promise<void> {
  await stop()
  closeGrants() // T44 S5: a grant never outlives the server (in-memory only)
  closeInheritOnce() // T72: an inherit-once allow never outlives the server either
  deps = null
}
