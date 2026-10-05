/**
 * Harnu-managed orchestrator guard (T109 — rescope of Q22, harness-owned). Today's
 * enforcement is 100% artisanal on the operator's machine (`~/.claude/hooks/
 * orchestrator-guard.sh` + `~/.claude/orchestrator-mode.flags` + a hand-added
 * settings entry). This module gives every folder the same effect with zero user
 * setup: install the guard script, arm/disarm a session, and sweep orphans on boot.
 *
 * Nature (spec §0): a behavioral-drift brake, not a security boundary — the real
 * doors are server-side (T104/T80, fail-CLOSED). This guard fails OPEN by design:
 * a broken guard degrades to "normal session", never to a bricked Claude Code.
 *
 * Components (spec §1):
 *  - The hook SCRIPT lives in the repo at `resources/orchestrator-guard/guard.mjs`
 *    (plain Node, zero deps) and is rewritten into `<userData>/orchestrator-guard/
 *    guard.mjs` on every app boot ({@link installOrchestratorGuard}) — versioned by
 *    the app, never hand-edited on disk.
 *  - The FLAG file `<userData>/orchestrator-guard/armed.json` is Harnu's own
 *    `{ sessionId: { folder, armedAt } }` map — deliberately a different file from
 *    the operator's personal `~/.claude/orchestrator-mode.flags` (zero collision).
 *  - The REGISTRATION is a `hooks.PreToolUse` command entry (matcher
 *    `Edit|Write|NotebookEdit`) written into the FOLDER's `.claude/settings.local.json`
 *    — the same channel Harnu already uses for always-allow grants
 *    ({@link ./mcp/settings-local}) — never the user's global `~/.claude/settings.json`.
 *
 * Lifecycle (spec §3): `arm()` writes the armed.json entry AND ensures the hook is
 * registered (idempotent); `disarm()` removes only the armed.json entry — the hook
 * registration is folder-scoped and stays for the folder's next armed session
 * (removed only by an explicit uninstall, {@link removeGuardHookRegistration}, not
 * built into a UI yet — T98). `sweepOnBoot()` drops entries whose session no
 * longer exists (a transcript-file check), so a crashed prior boot never leaves an
 * orphaned id armed forever. `registerOrchestratorGuard()` wires install + sweep +
 * a disarm-on-`SessionEnd` subscription into the in-main hook task-state edge
 * ({@link addTaskEventObserver}) that `hook-bridge.ts` already exposes — Harnu
 * already observes session lifecycle there (T79 S2's digest engine uses the same
 * observer), so no new watcher is needed.
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { addTaskEventObserver, type HookTaskEvent } from './hook-bridge'
import { hasHookEntry, mergeHookEntry, removeHookEntry } from './mcp/settings-local'

/** The hook event + matcher the guard registers under (spec §1.3). */
export const GUARD_HOOK_EVENT = 'PreToolUse'
export const GUARD_HOOK_MATCHER = 'Edit|Write|NotebookEdit'

// ---- Paths --------------------------------------------------------------------

function guardDir(): string {
  return path.join(app.getPath('userData'), 'orchestrator-guard')
}

/** `<userData>/orchestrator-guard/guard.mjs` — the installed copy of the hook script. */
export function guardScriptPath(): string {
  return path.join(guardDir(), 'guard.mjs')
}

function armedPath(): string {
  return path.join(guardDir(), 'armed.json')
}

/**
 * `resources/orchestrator-guard/` — the checked-in guard script source, a
 * human-owned product asset (never bundled into the JS). Mirrors
 * `mcp/server.ts`'s `boardTemplatesDir()` (T105 §3): dev runs read straight from
 * the repo, a packaged build ships it unpacked via `extraResources`.
 */
function guardResourceDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'orchestrator-guard')
    : path.join(app.getAppPath(), 'resources', 'orchestrator-guard')
}

function settingsLocalPath(folder: string): string {
  return path.join(folder, '.claude', 'settings.local.json')
}

// ---- Install/refresh (spec §1.1) -----------------------------------------------

/**
 * Rewrite `<userData>/orchestrator-guard/guard.mjs` from the checked-in resource,
 * so every app boot ships whatever version of the guard shipped with the app.
 * Best-effort: a read/write failure logs and never throws — a missing script just
 * means the (not-yet-existing) hook registration would fail too, which is itself
 * fail-open (Claude Code treats an unreadable hook command as a no-op).
 */
export async function installOrchestratorGuard(): Promise<void> {
  try {
    const src = await fs.readFile(path.join(guardResourceDir(), 'guard.mjs'), 'utf8')
    await fs.mkdir(guardDir(), { recursive: true })
    await fs.writeFile(guardScriptPath(), src, 'utf8')
  } catch (err) {
    console.error('[orchestrator-guard] install failed', err)
  }
}

// ---- armed.json (spec §1.2) ----------------------------------------------------

export interface ArmedEntry {
  folder: string
  armedAt: number
  /**
   * T344: how this session got armed. `'manual'` (default, back-compat with
   * every pre-T344 entry that has no `source` at all) is the SessionMenu
   * "Promote to orchestrator" gesture — disarms on a real `SessionEnd` like
   * always. `'default'` is the per-folder "new sessions start as
   * Orchestrator" toggle — {@link disarm}'s `'sessionEnd'` reason
   * deliberately SKIPS these (see {@link shouldDisarmEntry}), so a hibernate
   * (kill + later `claude --resume`) never silently demotes it (AC-4). Only
   * an explicit `'demote'` reason ever removes a `'default'` entry.
   */
  source?: 'manual' | 'default'
}

export type ArmedMap = Record<string, ArmedEntry>

/** Read + parse `armed.json`; `{}` when missing/corrupt (never throws). */
async function readArmed(): Promise<ArmedMap> {
  try {
    const parsed = JSON.parse(await fs.readFile(armedPath(), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as ArmedMap)
      : {}
  } catch {
    return {}
  }
}

async function writeArmed(map: ArmedMap): Promise<void> {
  await fs.mkdir(guardDir(), { recursive: true })
  await fs.writeFile(armedPath(), JSON.stringify(map, null, 2) + '\n', 'utf8')
}

/**
 * Arm a session (spec §3): record `{ folder, armedAt, source }` in `armed.json`
 * and ensure the folder's `.claude/settings.local.json` carries the guard's
 * hook entry (idempotent — a present entry is left untouched). Called by
 * T98's promote (default `source: 'manual'`) with the REAL session id
 * (synthetic→real already resolved by the caller), and by T344's
 * folder-default arm-at-spawn (`source: 'default'`, `pty.ts`).
 */
export async function arm(
  sessionId: string,
  folder: string,
  source: 'manual' | 'default' = 'manual'
): Promise<void> {
  const map = await readArmed()
  map[sessionId] = { folder, armedAt: Date.now(), source }
  await writeArmed(map)
  await ensureGuardHookRegistration(folder)
}

/**
 * PURE (T344 AC-4): should a `disarm(id, reason)` call actually remove the
 * `armed.json` entry? An explicit `'demote'` (the operator's own gesture —
 * SessionMenu toggle-off) always wins, regardless of how the session got
 * armed — "the operator explicitly demoted must NOT be re-armed on resume".
 * A `'sessionEnd'` (today's automatic disarm-on-hook, including a hibernate
 * kill) only disarms a `'manual'`/legacy entry — a `'default'`-sourced entry
 * (the per-folder toggle) is left alone so a park/resume cycle never
 * silently demotes it.
 */
export function shouldDisarmEntry(
  reason: 'demote' | 'sessionEnd',
  source: 'manual' | 'default' | undefined
): boolean {
  return reason === 'demote' || source !== 'default'
}

/**
 * Disarm a session (spec §3, extended by T344 AC-4): remove its `armed.json`
 * entry — UNLESS {@link shouldDisarmEntry} says this `reason` must leave it
 * alone (a `'sessionEnd'` against a folder-default-armed session). The
 * folder's hook registration is left in place either way — it's shared
 * infrastructure for the folder's NEXT armed session, removed only by an
 * explicit uninstall ({@link removeGuardHookRegistration}).
 *
 * `reason` defaults to `'demote'` (an explicit operator action) — the
 * pre-T344 call shape (`disarm(sessionId)`, e.g. the SessionMenu toggle-off)
 * keeps removing unconditionally. Only the boot wiring's SessionEnd
 * subscriber passes `'sessionEnd'`.
 */
export async function disarm(
  sessionId: string,
  reason: 'demote' | 'sessionEnd' = 'demote'
): Promise<void> {
  const map = await readArmed()
  const entry = map[sessionId]
  if (!entry) return
  if (!shouldDisarmEntry(reason, entry.source)) return
  delete map[sessionId]
  await writeArmed(map)
}

/** Whether `sessionId` currently has an armed.json entry. */
export async function isArmed(sessionId: string): Promise<boolean> {
  const map = await readArmed()
  return sessionId in map
}

/**
 * Every currently-armed session id (T98 — the renderer's visible-role source
 * of truth: hydrated once at store init and mirrored locally thereafter, the
 * same shape as `userProjectsList()` seeding `agentAllowedPaths`). Order is
 * whatever `Object.keys` yields — callers that need a stable order sort it.
 */
export async function listArmedSessionIds(): Promise<string[]> {
  const map = await readArmed()
  return Object.keys(map)
}

// ---- Hook registration (spec §1.3, §3 uninstall) -------------------------------

async function readFolderSettingsLocal(folder: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(settingsLocalPath(folder), 'utf8'))
  } catch {
    return undefined
  }
}

async function writeFolderSettingsLocal(folder: string, obj: unknown): Promise<void> {
  await fs.mkdir(path.dirname(settingsLocalPath(folder)), { recursive: true })
  await fs.writeFile(settingsLocalPath(folder), JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

/** The exact `command` string the guard registers — `node "<installed guard.mjs>"`. */
export function guardHookCommand(): string {
  return `node ${JSON.stringify(guardScriptPath())}`
}

/** Any guard command a Capy/Harnu build ever registered, matched by its EXACT shape —
 *  `node "<userData>/orchestrator-guard/guard.mjs"` (what {@link guardHookCommand}
 *  emits) — where `<userData>` ends in OUR app dir (`Capy`, `capy`, `Harnu`, `harnu`).
 *  Anchored on purpose: a user's own `orchestrator-guard/guard.mjs` elsewhere, or ours
 *  with extra args, must never be rewritten or deduped away. Separators are `+`
 *  because `JSON.stringify` doubles Windows backslashes inside the command. */
const GUARD_SCRIPT_RE =
  /^node "(?:[^"]*[\\/])?(?:Capy|capy|Harnu|harnu)[\\/]+orchestrator-guard[\\/]+guard\.mjs"$/

/**
 * PURE: rewrite every guard command under `hooks.PreToolUse` (matcher
 * {@link GUARD_HOOK_MATCHER}) that points at an OLD userData path to `command`
 * (the current one), then collapse duplicates of `command` so a folder armed both
 * before and after the rename ends with ONE guard handler. A guard command is
 * recognized by {@link GUARD_SCRIPT_RE} (or by being `command` itself); every other
 * hook (and every other key) is left verbatim. `changed` is false — and `next` is
 * the input — when nothing needed rewriting. Never throws.
 */
export function refreshGuardHookCommand(
  existing: unknown,
  command: string
): { next: unknown; changed: boolean } {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing))
    return { next: existing, changed: false }
  const hooks = (existing as { hooks?: unknown }).hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
    return { next: existing, changed: false }
  const entries = (hooks as Record<string, unknown>)[GUARD_HOOK_EVENT]
  if (!Array.isArray(entries)) return { next: existing, changed: false }

  let changed = false
  let seenCurrent = false // across ALL guard-matcher entries: one current handler total
  const nextEntries: unknown[] = []
  for (const entry of entries as unknown[]) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      (entry as { matcher?: unknown }).matcher !== GUARD_HOOK_MATCHER ||
      !Array.isArray((entry as { hooks?: unknown }).hooks)
    ) {
      nextEntries.push(entry)
      continue
    }
    const handlers: unknown[] = []
    let dropped = false
    for (const h of (entry as { hooks: unknown[] }).hooks) {
      const c = h && typeof h === 'object' ? (h as { command?: unknown }).command : undefined
      if (typeof c !== 'string' || (c !== command && !GUARD_SCRIPT_RE.test(c))) {
        handlers.push(h)
        continue
      }
      if (c !== command) changed = true
      if (seenCurrent) {
        changed = true // duplicate of the current command: drop it
        dropped = true
        continue
      }
      seenCurrent = true
      handlers.push(c === command ? h : { ...(h as object), command })
    }
    // An entry whose only handler was a duplicate has nothing left to run.
    if (dropped && handlers.length === 0) continue
    nextEntries.push({ ...(entry as object), hooks: handlers })
  }
  if (!changed) return { next: existing, changed: false }
  return {
    next: {
      ...(existing as object),
      hooks: { ...(hooks as object), [GUARD_HOOK_EVENT]: nextEntries }
    },
    changed: true
  }
}

/**
 * Idempotently add the guard's `PreToolUse` hook entry to a folder's
 * `.claude/settings.local.json`, preserving every unrelated key (via
 * {@link mergeHookEntry}). A guard hook left by a pre-rename build (old userData
 * path) is rewritten to the current one first, never left beside it. Best-effort:
 * a write failure logs and never throws.
 */
export async function ensureGuardHookRegistration(folder: string): Promise<void> {
  try {
    const command = guardHookCommand()
    const { next, changed } = refreshGuardHookCommand(
      await readFolderSettingsLocal(folder),
      command
    )
    if (hasHookEntry(next, GUARD_HOOK_EVENT, GUARD_HOOK_MATCHER, command)) {
      if (changed) await writeFolderSettingsLocal(folder, next)
      return
    }
    const merged = mergeHookEntry(next, GUARD_HOOK_EVENT, GUARD_HOOK_MATCHER, command)
    await writeFolderSettingsLocal(folder, merged)
  } catch (err) {
    console.error('[orchestrator-guard] hook registration failed', err)
  }
}

/**
 * Refresh-only sibling of {@link ensureGuardHookRegistration}: if the folder's
 * `.claude/settings.local.json` already carries a guard hook with a stale
 * (pre-rename) path, rewrite it; otherwise do NOTHING — never creates the file,
 * the folder (a deleted worktree must stay deleted) or a hook that was never
 * registered. Best-effort: never throws.
 */
export async function refreshGuardHookRegistration(folder: string): Promise<void> {
  try {
    const existing = await readFolderSettingsLocal(folder)
    if (existing === undefined) return
    const { next, changed } = refreshGuardHookCommand(existing, guardHookCommand())
    if (changed) await writeFolderSettingsLocal(folder, next)
  } catch (err) {
    console.error('[orchestrator-guard] hook refresh failed', err)
  }
}

/**
 * Remove the guard's hook entry from a folder's `.claude/settings.local.json`
 * (spec §3 uninstall — e.g. disabling agent-control for the folder). Not yet
 * wired to a UI action (T98); exported for that caller. Best-effort.
 */
export async function removeGuardHookRegistration(folder: string): Promise<void> {
  try {
    const existing = await readFolderSettingsLocal(folder)
    const next = removeHookEntry(existing, GUARD_HOOK_EVENT, GUARD_HOOK_MATCHER, guardHookCommand())
    await writeFolderSettingsLocal(folder, next)
  } catch (err) {
    console.error('[orchestrator-guard] hook removal failed', err)
  }
}

// ---- Sweep on boot (spec §3) ----------------------------------------------------

/**
 * PURE: keep only `armed.json` entries whose session id is in `existingSessionIds`.
 * Separated from the fs-bound existence check so the pruning rule itself is
 * unit-testable with plain data (ADR-0001 pure-core / thin-shell).
 */
export function pruneArmed(map: ArmedMap, existingSessionIds: ReadonlySet<string>): ArmedMap {
  const out: ArmedMap = {}
  for (const [sessionId, entry] of Object.entries(map)) {
    if (existingSessionIds.has(sessionId)) out[sessionId] = entry
  }
  return out
}

/**
 * Every session id with a transcript under `root` (one `<id>.jsonl` per session,
 * nested arbitrarily deep under per-project dirs). `null` when `root` can't be
 * read at all (missing/EACCES/…) — DISTINCT from an empty result: the caller
 * must not treat "couldn't scan" the same as "nothing is alive", or a transient
 * fs glitch would spuriously disarm every active orchestrator session.
 */
async function listExistingSessionIds(root: string): Promise<Set<string> | null> {
  try {
    const entries = await fs.readdir(root, { recursive: true })
    const ids = new Set<string>()
    for (const entry of entries) {
      if (typeof entry === 'string' && entry.endsWith('.jsonl')) {
        ids.add(path.basename(entry, '.jsonl'))
      }
    }
    return ids
  } catch {
    return null
  }
}

/**
 * Sweep `armed.json` on app boot (spec §3, AC-1): drop entries whose session no
 * longer has a transcript on disk, so a crashed prior boot (or a session the
 * operator deleted history for) never leaves an orphaned id armed across a
 * restart. A no-op when `armed.json` is already empty (skips the transcript
 * scan) OR when the transcript root can't be read at all — an unreadable root
 * means "can't verify", and disarming a still-active orchestrator session on a
 * mere scan failure would defeat the guard's whole purpose for no benefit.
 */
export async function sweepOnBoot(
  root: string = path.join(homedir(), '.claude', 'projects')
): Promise<void> {
  const map = await readArmed()
  if (Object.keys(map).length === 0) return
  const existing = await listExistingSessionIds(root)
  if (existing === null) return
  const pruned = pruneArmed(map, existing)
  if (Object.keys(pruned).length !== Object.keys(map).length) {
    await writeArmed(pruned)
  }
}

// ---- Coexistence with the operator's personal hook (spec §4) -------------------

/**
 * PURE: does a parsed global `~/.claude/settings.json` object carry the
 * operator's personal `orchestrator-guard.sh` PreToolUse hook? Matched by the
 * command containing that script's basename — the personal setup is hand-rolled,
 * so there's no sentinel to key off (unlike Harnu's own global observer hooks).
 */
export function hasPersonalGuardHook(settings: unknown): boolean {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false
  const hooks = (settings as { hooks?: unknown }).hooks
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false
  const preTool = (hooks as Record<string, unknown>)[GUARD_HOOK_EVENT]
  if (!Array.isArray(preTool)) return false
  return preTool.some(
    (entry: unknown) =>
      entry &&
      typeof entry === 'object' &&
      Array.isArray((entry as { hooks?: unknown }).hooks) &&
      ((entry as { hooks: unknown[] }).hooks as unknown[]).some(
        (h) =>
          h &&
          typeof h === 'object' &&
          typeof (h as { command?: unknown }).command === 'string' &&
          (h as { command: string }).command.includes('orchestrator-guard.sh')
      )
  )
}

/** Shell: whether the operator's personal guard hook is registered globally
 *  right now. `false` on any read failure (no global settings, unreadable, …). */
export async function personalGuardHookActive(): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(homedir(), '.claude', 'settings.json'), 'utf8')
    return hasPersonalGuardHook(JSON.parse(raw))
  } catch {
    return false
  }
}

// ---- Boot wiring ----------------------------------------------------------------

/** PURE: which hook task-state edge disarms a session (only a real `SessionEnd`,
 *  not `Stop`/idle — a session ending is the unambiguous "closed" signal). */
export function shouldDisarmOnEvent(event: string): boolean {
  return event === 'SessionEnd'
}

/**
 * PURE (T344 AC-2/AC-3): should `pty.ts` arm a fresh `claude-new` spawn under
 * the per-folder "new sessions start as Orchestrator" default?
 *
 * Only a plain OPERATOR new session, in a folder with the flag ON: `kind`
 * must be `'claude-new'` (never a resume/fork/shell — a resume's armed state
 * is durable in `armed.json` already, see {@link shouldDisarmEntry}), and
 * NONE of `agentControlled` / `readOnly` / `spawnedBy === 'agent'` may hold —
 * AC-3's three agent-dispatch shapes (MCP `create_session` sets
 * `agentControlled`, board/manifest dispatch sets `spawnedBy: 'agent'`, a
 * T245 review companion sets `readOnly`) are each independently excluded, so
 * arming one is impossible regardless of the folder flag. A Scheduler tick
 * (`scheduler-shell.ts`) never reaches this function at all — it spawns
 * `claude -p` directly, bypassing `pty:create` entirely.
 */
export function shouldArmAtSpawn(input: {
  kind: 'shell' | 'claude-new' | 'claude-resume' | 'claude-fork'
  agentControlled: boolean
  readOnly: boolean
  spawnedBy?: 'operator' | 'agent'
  folderDefaultOn: boolean
}): boolean {
  return (
    input.kind === 'claude-new' &&
    input.folderDefaultOn &&
    !input.agentControlled &&
    !input.readOnly &&
    input.spawnedBy !== 'agent'
  )
}

/**
 * Install/refresh the guard script, sweep orphaned armed.json entries, and
 * subscribe to the in-main hook task-state edge so a session's `SessionEnd`
 * disarms it (Harnu already observes lifecycle there — T79 S2's digest engine
 * subscribes the same way). Called once from `index.ts`'s boot sequence.
 * `sweepRoot` overrides the transcript root for tests; production always sweeps
 * the real `~/.claude/projects`.
 */
export async function registerOrchestratorGuard(
  opts: { sweepRoot?: string } = {}
): Promise<{ close: () => void }> {
  await installOrchestratorGuard()
  await sweepOnBoot(opts.sweepRoot)
  // The rename moved userData, so a folder's registered `node "<old userData>/…/
  // guard.mjs"` now points at nothing. Rewrite it for every folder that still has
  // an armed session (the migrated armed.json names them) — NOT a repo-wide scan.
  const folders = new Set(Object.values(await readArmed()).map((e) => e.folder))
  await Promise.all([...folders].map((f) => refreshGuardHookRegistration(f)))
  const unsubscribe = addTaskEventObserver((ev: HookTaskEvent) => {
    // T344 AC-4: pass 'sessionEnd' explicitly (not the 'demote' default) so
    // `disarm`/`shouldDisarmEntry` can leave a folder-default-armed session
    // armed through a park (hibernate kill) + resume cycle.
    if (shouldDisarmOnEvent(ev.event)) void disarm(ev.sessionId, 'sessionEnd')
  })
  return { close: unsubscribe }
}
