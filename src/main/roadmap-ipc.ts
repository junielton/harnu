/**
 * Roadmap Kanban IPC (T80 S1 §3.2/§3.3). The env-bound shell that backs the
 * board: resolves a folder to the repo checkout that owns its
 * `.harnu/memory/roadmap/` (reusing the T79 memory keying, so every worktree of a
 * repo shares ONE board), scans + watches the cards, and owns the SERIALIZED,
 * atomic frontmatter writes that move a card between columns or bind it to a
 * dispatched session.
 *
 * Security posture (T80 §0/§6, amended T96 §0):
 *  - `status` / `session` are CONTROLLED fields written through the ONE
 *    serialized path here (`writeCardFields` → `updateFrontmatterFields` →
 *    `atomicWrite`). The human IPC (`roadmap:setStatus`/`roadmap:bindSession`)
 *    can write any of the five columns. Since T96, the MCP board verbs
 *    (`create_card`/`update_card`/`move_card`, in `mcp/server.ts`) ALSO write
 *    through this exact path — but `move_card`'s schema enum only admits
 *    `backlog|ready|review`, so `done` and `in-progress` remain reachable from
 *    NO verb: `done` is human-IPC-only (this file), `in-progress` is
 *    dispatch-bind-only (`roadmap:bindSession`, this file). The invariant this
 *    file still protects is "an agent never moves a card to Done, and never
 *    fakes in-progress" — not "an agent never touches status at all".
 *  - The boot prompt is generated SERVER-SIDE from the on-disk card (authoritative,
 *    not a renderer-supplied copy), secret-linted + length-capped BEFORE it can
 *    become a prompt, and returned verbatim for the operator's confirm (§6.3/§6.4).
 *  - Auto-dispatch (S2, `roadmap:planDispatch`) is fail-closed: it may skip the
 *    per-card confirm ONLY for a `provenance.author === 'human'` card AND when the
 *    live T44 grant registry (consulted via the SAME pure `grantDecision` the MCP
 *    gate uses) covers (folder, create_session). Agent provenance, or a
 *    dead/exhausted/out-of-scope grant, always falls back to the human confirm —
 *    it never extends or denies in silence (invariant 6). One budget unit is
 *    reserved here and refunded via `roadmap:releaseDispatch` if the spawn fails.
 *
 * Env-bound (fs + grant registry + chokidar) ⇒ e2e-only per ADR-0001; the decisions
 * (parse / column / write / boot-prompt / dispatch-gate) live in pure `roadmap-core.ts`.
 */

import { ipcMain, app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveMemoryLocation, appendMemoryEntry } from './mcp/memory-store'
import { formatMemoryDate, lintSecrets } from './mcp/memory-core'
import { grantDecision } from './mcp/grant-core'
import { snapshotGrants, reserve, release, remainingFor } from './mcp/grant-registry'
import { readMcpAsk } from './mcp/prefs'
import { registerRoutingPolicyHandlers } from './routing-policy'
import {
  approvalHashMatches,
  ARTIFACT_CONVENTION_DIRS,
  buildBootPrompt,
  buildGeneratorPrompt,
  buildNewCardContent,
  CARD_KINDS,
  childrenOf,
  compareCards,
  computeCardApprovalHash,
  decideDispatchGate,
  diffApprovalFields,
  formatCardCloseEntry,
  formatEpicCloseEntry,
  isArtifactKey,
  isCardKind,
  isCardComplexity,
  isCardSubstrate,
  isColumnStatus,
  lintCardReadiness,
  mintNextCardId,
  parseCard,
  COLUMN_ORDER,
  replaceCardBody,
  resolveUniqueSlug,
  serializeByKey,
  shouldSeedTemplate,
  slugifyTitle,
  toFlowList,
  updateFrontmatterFields,
  type ApprovalStaleField,
  type ArtifactKey,
  type BootPromptLabels,
  type CardKind,
  type CardStatus,
  type CardSubstrate,
  type ColumnKey,
  type DispatchConfirmReason,
  type GeneratorPromptLabels,
  type ManifestStampVerdict,
  type RoadmapCard
} from './roadmap-core'
import { createRoadmapWatcher, scanRoadmapDir, type RoadmapWatcherHandle } from './roadmap-watcher'
import { pokeManifestDrain } from './manifest-drain'
import { pushShadowEntry } from './responder-registry'
import { getExtensionBoardTemplatePath } from './extensions/extensions-loader'
import { DATA_DIR, mkdirDataDir, onDataDirMigrated } from './data-dir'

const runGit = promisify(execFile)

/** A card-name segment: filesystem-safe, no traversal, no separators. */
const SAFE_SLUG = /^[A-Za-z0-9._-]+$/

/** Machine-readable failure codes — the renderer maps each to a localized steer. */
export type RoadmapWriteCode =
  'bad-args' | 'not-found' | 'bad-status' | 'write-failed' | 'contains-secret' | 'card-done'

/**
 * The result of `roadmap:planDispatch` (T80 S2 §3.4): whether moving a card into
 * Ready auto-runs under a live mission grant (`mode:'auto'`, one budget unit
 * already RESERVED server-side — the renderer must `releaseDispatch(grantId)` if
 * the spawn fails) or falls back to the per-card human confirm (`mode:'confirm'`,
 * carrying WHY so the disclosure explains it). Both carry the same server-side
 * boot prompt (linted + capped + framed) the confirm would show — the auto path
 * still built it, so the shadow log / audit has the exact prompt. `provenanceAuthor`
 * lets the UI badge an agent-authored card. `grantId: null` (BUG-43) means the
 * dispatch was authorized by the ask-off posture, not a mission grant — nothing
 * was reserved, so there is nothing to `releaseDispatch`.
 */
export type RoadmapDispatchPlan =
  | {
      ok: true
      mode: 'auto'
      prompt: string
      provenanceAuthor: RoadmapCard['provenance']['author']
      grantId: string | null
      grantBudgetRemaining: number | null
    }
  | {
      ok: true
      mode: 'confirm'
      prompt: string
      provenanceAuthor: RoadmapCard['provenance']['author']
      reason: DispatchConfirmReason
      /** T104: set only for `reason: 'manifest-stale'` — the "summarized diff". */
      staleFields?: ApprovalStaleField[]
    }
  | { ok: false; code: RoadmapWriteCode }

/**
 * Merge-evidence for a card's branch (T80 S3 §3.5): how many commits it carries
 * that are not yet on `origin/main` (the "there is landed work here" signal), plus
 * a few short refs to attach as evidence. `ahead: 0` also means "no repo / no
 * upstream / probe failed" — the board just shows no suggestion, never an error.
 */
export interface RoadmapMergeEvidence {
  ahead: number
  refs: string[]
}

let watcher: RoadmapWatcherHandle | null = null
let tmpCounter = 0

/** Short timeout for the merge-evidence git probes (never block the board). */
const GIT_PROBE_TIMEOUT_MS = 800

/** Whether a git ref resolves in `folder` (never throws). */
async function gitRefExists(folder: string, ref: string): Promise<boolean> {
  try {
    await runGit('git', ['-C', folder, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      timeout: GIT_PROBE_TIMEOUT_MS,
      windowsHide: true
    })
    return true
  } catch {
    return false
  }
}

/**
 * Probe how far a card's branch is ahead of `origin/main` (fallback `main`) and
 * grab up to 5 short commit hashes as evidence (§3.5). Env-bound (execFile git),
 * hardened like `folder-git-status.ts`: short timeout, `windowsHide`, never throws
 * — a non-repo / no-upstream / detached folder just returns `{ ahead: 0, refs: [] }`.
 */
async function probeMergeEvidence(folder: string, branch: string): Promise<RoadmapMergeEvidence> {
  const empty: RoadmapMergeEvidence = { ahead: 0, refs: [] }
  if (!folder) return empty
  const base = (await gitRefExists(folder, 'origin/main'))
    ? 'origin/main'
    : (await gitRefExists(folder, 'main'))
      ? 'main'
      : null
  if (!base) return empty
  const tip = branch && (await gitRefExists(folder, branch)) ? branch : 'HEAD'
  const range = `${base}..${tip}`
  try {
    const { stdout } = await runGit('git', ['-C', folder, 'rev-list', '--count', range], {
      timeout: GIT_PROBE_TIMEOUT_MS,
      windowsHide: true
    })
    const ahead = Number(stdout.trim())
    if (!Number.isFinite(ahead) || ahead <= 0) return empty
    let refs: string[] = []
    try {
      const list = await runGit(
        'git',
        ['-C', folder, 'rev-list', '--abbrev-commit', '--max-count=5', range],
        { timeout: GIT_PROBE_TIMEOUT_MS, windowsHide: true }
      )
      refs = list.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    } catch {
      /* count succeeded but the ref list didn't — keep the count, drop refs */
    }
    return { ahead, refs }
  } catch {
    return empty
  }
}

/**
 * Resolve the roadmap dir + a stable repo key for a folder (§3.1 keying).
 * Exported (T96): the MCP board verbs (`mcp/server.ts`) reuse this SAME
 * resolution — never their own path math — to reach the one board a folder
 * owns.
 */
export async function resolveRoadmap(
  folder: string
): Promise<{ roadmapDir: string; repoKey: string }> {
  const { memoryDir } = await resolveMemoryLocation(folder)
  return { roadmapDir: path.join(memoryDir, 'roadmap'), repoKey: memoryDir }
}

/** A card-id-shaped segment: filesystem-safe, no traversal, no separators. */
const SAFE_CARD_ID = /^[A-Za-z0-9._-]+$/

/** The first `<dir>/<id>-*.md` match (repo-relative), or null if the dir/file is absent. */
async function findConventionFile(
  checkout: string,
  dir: string,
  id: string
): Promise<string | null> {
  try {
    const names = await fs.readdir(path.join(checkout, dir))
    const match = names.find((n) => n.startsWith(`${id}-`) && n.endsWith('.md'))
    return match ? `${dir}/${match}` : null
  } catch {
    return null
  }
}

/**
 * Convention-scan for a card's `prd`/`adr` artifact (T130 S3, PRD §2-S3
 * deliverable 2): looks for `docs/prds/<id>-*.md` / `docs/adr/<id>-*.md` under
 * the repo checkout (the same root `boardTemplatesDir`-style conventions live
 * under — never the caller's worktree, so a scan from any worktree of the same
 * repo sees the same docs). DISPLAY-only: the result is shown in the modal's
 * Docs row as a hint, but it is NEVER written back — only an explicit
 * `prd:`/`adr:` frontmatter field is durable.
 */
export async function scanArtifactConventions(
  folder: string,
  id: string
): Promise<{ prd: string | null; adr: string | null }> {
  if (!SAFE_CARD_ID.test(id)) return { prd: null, adr: null }
  const { checkout } = await resolveMemoryLocation(folder)
  const [prd, adr] = await Promise.all([
    findConventionFile(checkout, ARTIFACT_CONVENTION_DIRS.prd, id),
    findConventionFile(checkout, ARTIFACT_CONVENTION_DIRS.adr, id)
  ])
  return { prd, adr }
}

/**
 * Resolve a card slug to its absolute file, refusing traversal / escape.
 * Exported (T96) for the board verbs' shared path-jail.
 */
export function resolveCardFile(roadmapDir: string, slug: unknown): string | null {
  if (typeof slug !== 'string' || !SAFE_SLUG.test(slug)) return null
  const abs = path.resolve(roadmapDir, `${slug}.md`)
  const rel = path.relative(roadmapDir, abs)
  if (rel.includes(path.sep) || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

/** Atomic write (temp + rename) — serialized by the single-threaded main loop. */
export async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.harnu-tmp-${process.pid}-${tmpCounter++}`
  await fs.writeFile(tmp, content, 'utf8')
  try {
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Rewrite a card's controlled frontmatter fields in place, preserving every
 * other key/comment/body (passthrough §3.1). Reads → edits one line via the pure
 * `updateFrontmatterFields` → atomic write. The watcher re-emits the change, so
 * the store updates from disk (the file stays the source of truth).
 *
 * Exported (T96): the MCP board verbs (`move_card`/`update_card`, `mcp/server.ts`)
 * call this SAME function — the single-writer guarantee is preserved because
 * every controlled-field write, human or agent, funnels through it.
 */
export async function writeCardFields(
  folder: string,
  slug: unknown,
  updates: Record<string, string | null>
): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> {
  const { roadmapDir } = await resolveRoadmap(folder)
  const file = resolveCardFile(roadmapDir, slug)
  if (!file) return { ok: false, code: 'bad-args' }
  let content: string
  try {
    content = await fs.readFile(file, 'utf8')
  } catch {
    return { ok: false, code: 'not-found' }
  }
  try {
    await atomicWrite(file, updateFrontmatterFields(content, updates))
    // T113: any controlled-field write can free a WIP slot or (un)queue a card —
    // nudge the background drain. Covers the human status IPCs AND the MCP board
    // verbs, which all funnel through here.
    pokeManifestDrain(folder)
    return { ok: true }
  } catch {
    return { ok: false, code: 'write-failed' }
  }
}

/**
 * Read + parse one card by slug (T96) — the shared read used by the board
 * verbs BEFORE they decide anything (closed-card / parent / substrate-lock
 * checks all need the on-disk card first). Reuses the same traversal-safe
 * {@link resolveCardFile} as every other read/write here.
 */
export async function readCard(
  folder: string,
  slug: unknown
): Promise<{ ok: true; card: RoadmapCard; file: string } | { ok: false; code: RoadmapWriteCode }> {
  const { roadmapDir } = await resolveRoadmap(folder)
  const file = resolveCardFile(roadmapDir, slug)
  if (!file) return { ok: false, code: 'bad-args' }
  let content: string
  try {
    content = await fs.readFile(file, 'utf8')
  } catch {
    return { ok: false, code: 'not-found' }
  }
  return { ok: true, card: parseCard(content, String(slug)), file }
}

/** The slugs (filenames sans `.md`) of every card on a folder's board (T96 — collision check). */
export async function listCardSlugs(folder: string): Promise<string[]> {
  const { roadmapDir } = await resolveRoadmap(folder)
  try {
    const names = await fs.readdir(roadmapDir)
    return names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -3))
  } catch {
    return []
  }
}

/**
 * The `id:` frontmatter value of every card on a folder's board — the scan
 * {@link mintNextCardId} needs. Reuses the watcher's own full scan
 * (`scanRoadmapDir`) rather than re-implementing a directory read, since the
 * mint needs the parsed `id`, not just the filename.
 */
export async function listCardIds(folder: string): Promise<string[]> {
  const { roadmapDir } = await resolveRoadmap(folder)
  const cards = await scanRoadmapDir(roadmapDir)
  return cards.map((c) => c.id)
}

/** Per-repo promise chain — serializes {@link withCardIdMintLock} calls. */
const cardIdMintLocks = new Map<string, Promise<unknown>>()

/**
 * Serialize `fn` against every other `withCardIdMintLock` call for the same
 * `repoKey`, via the pure {@link serializeByKey}: two concurrent `create_card`
 * calls scanning the same on-disk id set would otherwise both compute the
 * same `max + 1` and mint the same id — this guarantees only one call is ever
 * between "scan ids" and "write file" per board at a time.
 */
export function withCardIdMintLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  return serializeByKey(cardIdMintLocks, repoKey, fn)
}

/**
 * Create a new card file (T96 `create_card`) — fails (`write-failed`) rather
 * than silently overwriting if the slug already exists on disk (the caller
 * already resolved a unique slug via `listCardSlugs` + `resolveUniqueSlug`, so
 * an EEXIST here means a genuine race, not an expected collision).
 */
export async function createCardFile(
  folder: string,
  slug: string,
  content: string
): Promise<{ ok: true; file: string } | { ok: false; code: RoadmapWriteCode }> {
  const { roadmapDir } = await resolveRoadmap(folder)
  const file = resolveCardFile(roadmapDir, slug)
  if (!file) return { ok: false, code: 'bad-args' }
  try {
    await mkdirDataDir(roadmapDir)
    await fs.writeFile(file, content, { flag: 'wx', encoding: 'utf8' })
    return { ok: true, file }
  } catch {
    return { ok: false, code: 'write-failed' }
  }
}

/**
 * The sibling directory archived cards live in (T148) — never scanned by the
 * board (`scanRoadmapDir`/the chokidar watcher both only ever target
 * `roadmapDir` itself), so a card that lands here simply disappears from the
 * columns via the SAME `unlink` event the watcher emits for any file leaving
 * `roadmapDir`.
 */
function archiveDirFor(roadmapDir: string): string {
  return path.join(path.dirname(roadmapDir), 'roadmap-archive')
}

/** Per-destination promise chain — serializes {@link archiveCardFile} moves. */
const archiveLocks = new Map<string, Promise<unknown>>()

/**
 * Move `src` onto `dest` WITHOUT ever leaving zero valid copies on disk. On
 * POSIX `fs.rename` already replaces `dest` atomically, but that isn't
 * guaranteed cross-platform (Windows rejects a rename onto an existing path),
 * so an existing `dest` is first parked at a temp backup; the backup is removed
 * only after the move succeeds, and restored if the move throws. The net
 * invariant: a failed move can never destroy a valid copy that was already at
 * `dest`.
 */
async function safeReplace(src: string, dest: string): Promise<void> {
  let backup: string | null = null
  try {
    await fs.access(dest)
    backup = `${dest}.harnu-bak-${process.pid}-${tmpCounter++}`
    await fs.rename(dest, backup)
  } catch {
    backup = null // no existing dest to protect
  }
  try {
    await fs.rename(src, dest)
  } catch (err) {
    if (backup) await fs.rename(backup, dest).catch(() => {})
    throw err
  }
  if (backup) await fs.rm(backup, { force: true }).catch(() => {})
}

/**
 * Archive a card (T148): move its file out of the active board into
 * `roadmap-archive/`. Reversible — {@link restoreCardFile} is the undo the
 * board's toast action calls. Serialized per destination and moved via
 * {@link safeReplace}, so two concurrent archives of the same slug can't race,
 * and a failed move never destroys a previously-archived copy of the same slug.
 *
 * The `in-progress` refusal (a bound session shouldn't lose its card mid-flight)
 * is enforced at the IPC boundary (`ensureManageable` in the `roadmap:archiveCard`
 * handler) so no caller can bypass it, mirroring how `writeCardFields` leaves its
 * own callers to enforce `status`/parent invariants.
 */
export async function archiveCardFile(
  folder: string,
  slug: unknown
): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> {
  const { roadmapDir } = await resolveRoadmap(folder)
  const file = resolveCardFile(roadmapDir, slug)
  if (!file) return { ok: false, code: 'bad-args' }
  const archiveDir = archiveDirFor(roadmapDir)
  const dest = path.join(archiveDir, path.basename(file))
  return serializeByKey(archiveLocks, dest, async () => {
    try {
      await mkdirDataDir(archiveDir)
      await safeReplace(file, dest)
      return { ok: true }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      return { ok: false, code: err.code === 'ENOENT' ? 'not-found' : 'write-failed' }
    }
  })
}

/**
 * Undo for {@link archiveCardFile} — moves the card back into the active board.
 * Refuses to clobber a live card: if an active card already occupies this slug
 * (a new card minted onto the same name since the archive), the restore fails
 * rather than silently overwriting it — the archived copy stays put.
 */
export async function restoreCardFile(
  folder: string,
  slug: unknown
): Promise<{ ok: true; card: RoadmapCard } | { ok: false; code: RoadmapWriteCode }> {
  const { roadmapDir } = await resolveRoadmap(folder)
  const file = resolveCardFile(roadmapDir, slug)
  if (!file) return { ok: false, code: 'bad-args' }
  const src = path.join(archiveDirFor(roadmapDir), path.basename(file))
  let liveExists = false
  try {
    await fs.access(file)
    liveExists = true
  } catch {
    liveExists = false
  }
  if (liveExists) return { ok: false, code: 'write-failed' }
  try {
    await mkdirDataDir(roadmapDir)
    await fs.rename(src, file)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    return { ok: false, code: err.code === 'ENOENT' ? 'not-found' : 'write-failed' }
  }
  const read = await readCard(folder, slug)
  return read.ok ? { ok: true, card: read.card } : { ok: false, code: read.code }
}

/**
 * Permanently delete a card file (T148) — irreversible, unlike
 * {@link archiveCardFile}. ENOENT is treated as success (mirrors
 * `session:delete` in `session-ops.ts`): the caller's intent ("make this card
 * go away") is honored even if the file already vanished from a race with the
 * watcher or a manual `rm`. The `in-progress` refusal is caller-side — see the
 * note on {@link archiveCardFile}.
 */
export async function deleteCardFile(
  folder: string,
  slug: unknown
): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> {
  const { roadmapDir } = await resolveRoadmap(folder)
  const file = resolveCardFile(roadmapDir, slug)
  if (!file) return { ok: false, code: 'bad-args' }
  try {
    await fs.unlink(file)
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== 'ENOENT') return { ok: false, code: 'write-failed' }
  }
  return { ok: true }
}

/**
 * Gate for archive/delete (T148): a card that is actively dispatched
 * (`status: in-progress`) must not be pulled out from under its bound session,
 * so both destructive IPCs refuse it. Fails CLOSED — if the card can't be read
 * (bad slug / missing file), the operation is rejected rather than allowed
 * through. The renderer already disables the buttons for an in-progress card
 * (`canManage`), but enforcing it here means no caller (a stale renderer, a
 * direct IPC call) can bypass the invariant. `bad-status` reuses the existing
 * code the renderer already maps to a localized steer.
 */
export async function ensureManageable(
  folder: string,
  slug: unknown
): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> {
  const read = await readCard(folder, slug)
  if (!read.ok) return { ok: false, code: read.code }
  if (read.card.status === 'in-progress') return { ok: false, code: 'bad-status' }
  return { ok: true }
}

// ---- board template loading (T105 §3, moved here from tool-handlers.ts so the
// human `roadmap:createCard` IPC and the agent `create_card` verb reuse the
// EXACT same loader — see `createCardCore` below and `createCardHandler` in
// `mcp/tool-handlers.ts`) ------------------------------------------------------

/**
 * `resources/board-templates/` — the per-kind delegation-packet templates
 * (T105 §3), a human-owned product asset (never bundled into the JS). Dev runs
 * read straight from the repo; a packaged build ships them unpacked via
 * `extraResources` (see `electron-builder.yml`).
 */
function boardTemplatesDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'board-templates')
    : path.join(app.getAppPath(), 'resources', 'board-templates')
}

/**
 * Load a kind's board template, or `null` if the file is missing/unreadable.
 * An installed extension's `contributes.boardTemplates[kind]` (T137) is
 * checked FIRST — falling through to the bundled `resources/board-templates/`
 * file on a missing/unreadable extension file, so an extension that only
 * ships a malformed template never breaks card creation for that kind.
 */
export async function loadBoardTemplate(kind: CardKind): Promise<string | null> {
  const extPath = getExtensionBoardTemplatePath(kind)
  if (extPath) {
    try {
      return await fs.readFile(extPath, 'utf8')
    } catch {
      /* extension's template file missing/unreadable — fall through to the bundled one */
    }
  }
  try {
    return await fs.readFile(path.join(boardTemplatesDir(), `${kind}.md`), 'utf8')
  } catch {
    return null
  }
}

export interface RoadmapLoadResult {
  repoKey: string
  cards: RoadmapCard[]
}

/** One card as the Folder View names it — a title, not a board row. */
export interface RoadmapPeekCard {
  slug: string
  id: string
  title: string
  status: CardStatus
  blocked: boolean
  session?: string
  /**
   * T284: the card's OWNER branch as stamped at dispatch time
   * (`RoadmapCard.executedIn`) — present only when the card carries one, so a
   * consumer can tell a card that owns a branch from one that is merely active.
   * Distinct from `provenance.branch` (the origin), which the peek never names.
   */
  executedIn?: string
}

export interface RoadmapPeekResult {
  counts: Record<ColumnKey, number>
  active: RoadmapPeekCard[]
  /**
   * T284: the card whose `executedIn` is the branch the caller asked about —
   * "what is this branch FOR". Present ONLY when the peek was called with a
   * `branch` argument (key absent otherwise, so today's two-field callers are
   * byte-compatible); `null` when the branch is owned by no card.
   */
  owned?: RoadmapPeekCard | null
}

/** Columns whose cards the Folder View names, in the order it names them. */
const ACTIVE_COLUMNS: readonly ColumnKey[] = ['in-progress', 'review']

/**
 * T284 — how likely a column is to hold the branch's CURRENT owner, lowest
 * wins. A branch is normally named by exactly one card, but a re-dispatch into
 * the same worktree (or a card closed and a successor opened on the same
 * branch) can leave two: the live one is the answer, and a `done` card that
 * still names the branch is a finished predecessor, so it loses to everything.
 * `backlog`/`ready` sit between: dispatchable, but not yet running.
 */
const OWNERSHIP_RANK: Record<ColumnKey, number> = {
  'in-progress': 0,
  review: 1,
  ready: 2,
  backlog: 3,
  done: 4
}

/** Project a parsed card down to the fields the Folder View names. */
function toPeekCard(card: RoadmapCard): RoadmapPeekCard {
  return {
    slug: card.slug,
    id: card.id,
    title: card.title,
    status: card.status,
    blocked: card.blocked,
    ...(card.session ? { session: card.session } : {}),
    ...(card.executedIn ? { executedIn: card.executedIn } : {})
  }
}

/**
 * T284 — the card that owns `branch`, searched across ALL FIVE columns (not
 * just the two `ACTIVE_COLUMNS` the peek names): a branch whose card has
 * already been closed still deserves an answer.
 *
 * Tie-break, when more than one card names the same branch — deterministic, and
 * never readdir order:
 *   1. {@link OWNERSHIP_RANK} — the most live column wins.
 *   2. `compareCards` — the board's own within-column order (priority, then id),
 *      so a tie here resolves exactly the way the column would display it.
 *   3. `slug` — the filename, unique by construction. Only reachable when two
 *      cards share a priority AND an id (a hand-edited board), and the only
 *      reason the order is TOTAL rather than "deterministic unless duplicated":
 *      without it that last tie would fall back to readdir order.
 */
function findOwnedCard(cards: readonly RoadmapCard[], branch: string): RoadmapPeekCard | null {
  const wanted = branch.trim()
  if (!wanted) return null
  const owners = cards.filter((c) => c.executedIn?.trim() === wanted)
  if (owners.length === 0) return null
  const best = owners.reduce((a, b) => (compareOwners(a, b) <= 0 ? a : b))
  return toPeekCard(best)
}

/** The total order {@link findOwnedCard} picks its winner by (lowest wins). */
function compareOwners(a: RoadmapCard, b: RoadmapCard): number {
  const rank = OWNERSHIP_RANK[a.status] - OWNERSHIP_RANK[b.status]
  if (rank !== 0) return rank
  const board = compareCards(a, b)
  if (board !== 0) return board
  return a.slug.localeCompare(b.slug)
}

/**
 * T212 — bucket a card list into per-column counts plus the cards worth naming
 * ("what is running here"). Pure: the fs read lives in the `roadmap:peek`
 * handler, this is the part worth unit-testing.
 *
 * T284 — pass `branch` to also get `owned`: the card that branch is executing.
 * The `owned` key mirrors the argument's presence — omit `branch` and the
 * result is exactly the pre-T284 `{ counts, active }` shape.
 */
export function summarizeCards(cards: readonly RoadmapCard[], branch?: string): RoadmapPeekResult {
  const counts = Object.fromEntries(COLUMN_ORDER.map((c) => [c, 0])) as Record<ColumnKey, number>
  for (const card of cards) counts[card.status] += 1
  const active: RoadmapPeekCard[] = []
  for (const column of ACTIVE_COLUMNS) {
    for (const card of cards) {
      if (card.status !== column) continue
      active.push(toPeekCard(card))
    }
  }
  if (branch === undefined) return { counts, active }
  return { counts, active, owned: findOwnedCard(cards, branch) }
}

/** Open (or re-open) the board for a folder: resolve → scan → (re)watch. */
async function loadBoard(folder: string): Promise<RoadmapLoadResult> {
  const { roadmapDir, repoKey } = await resolveRoadmap(folder)
  const cards = watcher ? await watcher.retarget(roadmapDir, repoKey) : []
  return { repoKey, cards }
}

/**
 * After `root`'s legacy data dir was copied, refresh the open board if it is that repo's:
 * rebind the watcher (it may have been bound to a dir that did not exist yet) and push
 * every card to the renderer store. A no-op when the board is closed or belongs to
 * another repo.
 */
export async function refreshRoadmapAfterCopy(
  root: string,
  send: (channel: string, payload: unknown) => void
): Promise<void> {
  const key = watcher?.currentKey()
  if (!watcher || !key) return
  const dataDir = path.join(root, DATA_DIR)
  if (key !== dataDir && !key.startsWith(dataDir + path.sep)) return
  try {
    const cards = await watcher.retarget(path.join(key, 'roadmap'), key)
    for (const card of cards) send('roadmap:card:added', { repoKey: key, card })
  } catch {
    /* the board reloads on its next open */
  }
}

/**
 * Register the roadmap IPC + own the singleton (retargetable) watcher. Wired
 * from `src/main/index.ts` like the other `register*` shells. `closeRoadmapWatcher`
 * is called on `before-quit`.
 */
export function registerRoadmapHandlers(getWindow: () => Electron.BrowserWindow | null): void {
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    win.webContents.send(channel, payload)
  }
  watcher = createRoadmapWatcher(send)
  // A data dir copied AFTER the board was opened (a background copy past the boot
  // ceiling): re-point the watcher at the now-populated dir and push its cards.
  onDataDirMigrated((root) => void refreshRoadmapAfterCopy(root, send))

  // T97: the per-repo model routing table's IPC. Registered here (not from
  // `src/main/index.ts`) because it is dispatch-adjacent plumbing this file
  // already owns — see `routing-policy.ts` for the security posture (never
  // agent-writable, no MCP verb touches it).
  registerRoutingPolicyHandlers()

  // Open (or re-open) the board for a folder (§3.2). Thin wrapper over `loadBoard`.
  ipcMain.handle('roadmap:load', (_e, args: { folder: string }) => loadBoard(args?.folder ?? ''))

  // T212 — a READ-ONLY board summary for the Folder View. Deliberately NOT
  // `loadBoard`: that one calls `watcher.retarget(...)`, and there is only ONE
  // roadmap watcher, so peeking at folder B's counts would steal the watcher
  // backing folder A's open board. `scanRoadmapDir` reads the dir and watches
  // nothing; a missing dir already degrades to an empty board there.
  //
  // T284 — an optional `branch` also asks "which card owns this branch?"
  // (`owned`), searched across all five columns. Omitting it returns the
  // pre-T284 `{ counts, active }` shape unchanged.
  ipcMain.handle(
    'roadmap:peek',
    async (_e, args: { folder: string; branch?: string }): Promise<RoadmapPeekResult> => {
      const branch = args?.branch
      try {
        const { roadmapDir } = await resolveRoadmap(args?.folder ?? '')
        return summarizeCards(await scanRoadmapDir(roadmapDir), branch)
      } catch {
        return summarizeCards([], branch)
      }
    }
  )

  // Move a card between columns (drag / Close). The human-IPC status writer —
  // covers all FIVE columns, including `done`/`in-progress`, which no MCP verb
  // can ever reach. T96: the agent's `move_card` verb ALSO writes `status`,
  // through this exact SAME `writeCardFields` → `updateFrontmatterFields` path,
  // but its schema enum only admits `backlog|ready|review` — `done` and
  // `in-progress` stay reachable from nowhere but this IPC (`done`) and
  // `roadmap:bindSession` (`in-progress`) below. `status` is validated against
  // the five-column enum (§6.4 controlled field).
  ipcMain.handle(
    'roadmap:setStatus',
    async (
      _e,
      args: { folder: string; slug: string; status: string }
    ): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> => {
      if (!isColumnStatus(args?.status)) return { ok: false, code: 'bad-status' }
      return writeCardFields(args.folder, args.slug, { status: args.status })
    }
  )

  // Bind a dispatched session to a card + flip it to in-progress (§3.3 step 5).
  // T97: an optional `dispatchedWith` ("model·effort", from the routing-table
  // resolution) is appended as a provenance-stamped body line — the audit trail
  // for WHICH model/effort actually launched this dispatch (T82 §10.1 Q13).
  // Best-effort: a failed append never fails the bind (the session already
  // spawned; the audit line is a courtesy record, not a gate).
  // T102: an optional `substrate` records the RESOLVED substrate this dispatch
  // actually ran on (session/worktree/teammate/internal, post any per-card
  // operator override in the manual confirm) — the permanent, post-dispatch
  // record on the card, written in the SAME call as the session bind so the two
  // can never disagree. An unrecognized value is silently ignored.
  // T190: an optional `executedIn` (the SPAWN folder's short branch name, NOT
  // the card's own home folder — those can differ, e.g. `worktree` substrate)
  // is stamped as the card's durable OWNER, in the same write as `session` —
  // never cleared by a later `move_card`.
  ipcMain.handle(
    'roadmap:bindSession',
    (
      _e,
      args: {
        folder: string
        slug: string
        sessionId: string
        dispatchedWith?: string
        substrate?: string
        executedIn?: string
      }
    ) =>
      bindSessionCore(
        args?.folder ?? '',
        args?.slug,
        args?.sessionId,
        args?.dispatchedWith,
        args?.substrate,
        args?.executedIn
      )
  )

  // S2 (card-detail edit engine): replace a card's BODY only, frontmatter
  // untouched — the human counterpart to `update_card.replaceBody`. Both write
  // through `replaceCardBodyCore`, the same serialized `atomicWrite` door
  // `writeCardFields` uses for controlled frontmatter fields. `stampVoided`
  // tells the renderer whether the card carried a manifest `approved` stamp
  // BEFORE this write, so it can surface the "manifest ✓ was invalidated"
  // toast — the write itself never blocks on it (zero-friction, T104 §2.3).
  ipcMain.handle(
    'roadmap:replaceBody',
    (
      _e,
      args: { folder: string; slug: string; body: string }
    ): Promise<{ ok: true; stampVoided: boolean } | { ok: false; code: RoadmapWriteCode }> =>
      replaceCardBodyCore(args?.folder ?? '', args?.slug, args?.body)
  )

  // T130 S4 (E7): the human counterpart to `update_card.appendBody` — a
  // provenance-stamped body append (`author: 'human'`), the SAME
  // `appendMemoryEntry` write the agent verb uses. The card-detail modal's
  // Open-questions "Send" is the first caller (composes `> answers: …` via
  // `buildAnswerAppend`), but this is a general append door, not question-specific.
  ipcMain.handle(
    'roadmap:appendBody',
    (
      _e,
      args: { folder: string; slug: string; entry: string }
    ): Promise<{ ok: true; stampVoided: boolean } | { ok: false; code: RoadmapWriteCode }> =>
      appendCardBodyCore(args?.folder ?? '', args?.slug, args?.entry)
  )

  // S2: the title inline-edit affordance writes `title` through the SAME
  // serialized frontmatter writer every other controlled-field write uses
  // (§6.4) — a minimal, single-field sibling of `roadmap:setStatus`.
  ipcMain.handle(
    'roadmap:setTitle',
    (
      _e,
      args: { folder: string; slug: string; title: string }
    ): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> => {
      const title = typeof args?.title === 'string' ? args.title.trim() : ''
      if (!title) return Promise.resolve({ ok: false, code: 'bad-args' })
      return writeCardFields(args.folder, args.slug, { title })
    }
  )

  // T130 S3 (E6 — presence detection): convention-scan for a card's prd/adr,
  // shown in the modal's Docs row as a hint. Never writes anything — only the
  // explicit `prd:`/`adr:` frontmatter field is durable (PRD §2-S3).
  ipcMain.handle(
    'roadmap:scanArtifacts',
    (
      _e,
      args: { folder: string; id: string }
    ): Promise<{ prd: string | null; adr: string | null }> =>
      scanArtifactConventions(args?.folder ?? '', args?.id ?? '')
  )

  // Generate the dispatch boot prompt server-side from the on-disk card: secret-lint
  // the body, cap it, wrap it in the caller's localized framing/closure labels, and
  // return it verbatim for the operator's confirm (§6.3/§6.4). Kept as a primitive;
  // the board's dispatch flow goes through `roadmap:planDispatch` (below), which
  // adds the S2 grant gate on top of this same build.
  ipcMain.handle(
    'roadmap:bootPrompt',
    async (
      _e,
      args: { folder: string; slug: string; labels: BootPromptLabels }
    ): Promise<
      | { ok: true; prompt: string; provenanceAuthor: RoadmapCard['provenance']['author'] }
      | { ok: false; code: RoadmapWriteCode }
    > => {
      const built = await buildDispatchPrompt(args?.folder ?? '', args?.slug, args?.labels)
      if (!built.ok) return built
      return { ok: true, prompt: built.prompt, provenanceAuthor: built.card.provenance.author }
    }
  )

  // T80 S2 (⚠️ gated §0) — decide whether this dispatch auto-runs under a live
  // mission grant or must ask the human, then (for auto) RESERVE one unit of the
  // grant's budget before returning. This is the ONE place the roadmap board
  // touches the T44 grant machinery; it reuses the SAME registry + pure
  // `grantDecision` the MCP gate uses, so a board grant is just a T44 grant
  // scoped to the repo. The spawn stays a HUMAN full-permission session in the
  // renderer (never a downgraded agent session) — the grant only removes the
  // confirm CLICK for a human-authored card. Fail-closed: agent provenance,
  // an absent/dead grant, or a lost reserve all fall back to the confirm.
  ipcMain.handle(
    'roadmap:planDispatch',
    (_e, args: { folder: string; slug: string; labels: BootPromptLabels }) =>
      planDispatchCore(args?.folder ?? '', args?.slug, args?.labels)
  )

  // T130 S4 (M8-Generate, E8): the SAME auto-vs-confirm gate as planDispatch —
  // "no new free path" — but the built prompt is the 3-tier GENERATOR prompt
  // for the requested artifact, not the card's own boot prompt.
  ipcMain.handle(
    'roadmap:planGenerate',
    (_e, args: { folder: string; slug: string; artifact: string; labels: GeneratorPromptLabels }) =>
      planGenerateCore(args?.folder ?? '', args?.slug, args?.artifact, args?.labels)
  )

  // Refund a unit reserved by `planDispatch` when the renderer's spawn failed —
  // budget commits only for a session that actually launched (mirrors the MCP
  // gate's `release` on a failed actuation). Never-throw; unknown id is a no-op.
  ipcMain.handle('roadmap:releaseDispatch', (_e, args: { grantId: string }): { ok: true } => {
    const grantId = args?.grantId
    if (typeof grantId === 'string' && grantId) release(grantId)
    return { ok: true }
  })

  // Whether a live grant currently covers auto-dispatch (create_session) for the
  // board's folder — drives the grant strip at the top of the board. Returns the
  // covering grant's id so the renderer resolves its budget/TTL/revoke from the
  // canonical `useMissionGrants()` list (authoritative scope match stays here in
  // main, where the full paths live; the renderer only displays).
  ipcMain.handle(
    'roadmap:grantStatus',
    async (_e, args: { folder: string }): Promise<{ grantId: string | null }> => {
      const verdict = grantDecision(
        { folder: args?.folder ?? '', verb: 'create_session' },
        snapshotGrants(),
        Date.now(),
        homedir()
      )
      return { grantId: verdict.outcome === 'allow' ? verdict.grantId : null }
    }
  )

  // T80 S3: merge-evidence for a bound card's branch (commits ahead of origin/main
  // + a few refs). Read-only git probe; drives the "landed on main → suggest
  // Review" reconciliation the board renders. Never mutates a card.
  ipcMain.handle(
    'roadmap:mergeEvidence',
    (_e, args: { folder: string; branch?: string }): Promise<RoadmapMergeEvidence> =>
      probeMergeEvidence(args?.folder ?? '', args?.branch ?? '')
  )

  // T80 S3 (rule of gold §3.5): the HUMAN-approved move of a bound In Progress card
  // to Review, attaching evidence (commit refs merged with any already on the card).
  // Writes the controlled `status`/`evidence` fields via the SAME serialized IPC as
  // every status change — so this is a human channel, and it lands in Review, NEVER
  // Done (Done stays the human-only Close). Deduped so re-running never piles refs.
  ipcMain.handle(
    'roadmap:moveToReview',
    async (
      _e,
      args: { folder: string; slug: string; evidence?: string[] }
    ): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> => {
      const { roadmapDir } = await resolveRoadmap(args?.folder ?? '')
      const file = resolveCardFile(roadmapDir, args?.slug)
      if (!file) return { ok: false, code: 'bad-args' }
      let content: string
      try {
        content = await fs.readFile(file, 'utf8')
      } catch {
        return { ok: false, code: 'not-found' }
      }
      const card = parseCard(content, String(args.slug))
      const incoming = Array.isArray(args.evidence)
        ? args.evidence.filter((e): e is string => typeof e === 'string')
        : []
      const merged = [...new Set([...card.evidence, ...incoming])]
      const updates: Record<string, string | null> = { status: 'review' }
      if (merged.length) updates.evidence = toFlowList(merged)
      try {
        await atomicWrite(file, updateFrontmatterFields(content, updates))
        pokeManifestDrain(args.folder) // T113: in-progress → review frees a WIP slot
        return { ok: true }
      } catch {
        return { ok: false, code: 'write-failed' }
      }
    }
  )

  // T103 (done trigger, spec §5/§12.1 D3): the human Close (Review → Done).
  // Writes `status: done` through the SAME serialized `writeCardFields` path as
  // `roadmap:setStatus`, then appends a MECHANICAL, deterministic close entry to
  // the card itself (no model call — D3 rules out a close-time LLM summary) and,
  // when the card is an epic (other cards declare it as their `parent`), an
  // entry to `decisions.md` (§10.1 Q27 — full history lives on the card;
  // decisions.md is reserved for epic closes). Both memory writes are
  // best-effort: the status write IS the human action that matters — a
  // memory-append failure never fails the Close (mirrors `bindSession`'s
  // `dispatchedWith` append).
  ipcMain.handle(
    'roadmap:closeCard',
    async (
      _e,
      args: { folder: string; slug: string }
    ): Promise<{ ok: true; epic: boolean } | { ok: false; code: RoadmapWriteCode }> => {
      const folder = args?.folder ?? ''
      const { roadmapDir } = await resolveRoadmap(folder)
      const file = resolveCardFile(roadmapDir, args?.slug)
      if (!file) return { ok: false, code: 'bad-args' }
      let content: string
      try {
        content = await fs.readFile(file, 'utf8')
      } catch {
        return { ok: false, code: 'not-found' }
      }
      const card = parseCard(content, String(args.slug))

      const writeRes = await writeCardFields(folder, args.slug, { status: 'done' })
      if (!writeRes.ok) return writeRes

      const now = Date.now()
      const date = formatMemoryDate(now)
      const { memoryDir, branch } = await resolveMemoryLocation(folder)

      await appendMemoryEntry({
        memoryDir,
        page: `roadmap/${args.slug}`,
        entry: formatCardCloseEntry({ date, evidence: card.evidence }),
        author: 'human',
        ...(branch ? { branch } : {}),
        now
      }).catch((err) => console.warn('[roadmap-ipc] close entry append failed:', err))

      const allCards = await scanRoadmapDir(roadmapDir)
      const children = childrenOf(allCards, card.id, card.slug)
      const epic = children.length > 0
      if (epic) {
        await appendMemoryEntry({
          memoryDir,
          page: 'decisions',
          entry: formatEpicCloseEntry({
            date,
            title: card.title,
            id: card.id,
            children: children.map((c) => c.id)
          }),
          author: 'human',
          ...(branch ? { branch } : {}),
          now
        }).catch((err) => console.warn('[roadmap-ipc] epic close entry append failed:', err))
      }

      return { ok: true, epic }
    }
  )

  // T148: archive a card — move it out of the active board into
  // `roadmap-archive/` (reversible; the board's toast carries an Undo calling
  // `roadmap:restoreCard` below). Human-IPC only, same posture as
  // createCard/closeCard — no MCP verb reaches this. Fails CLOSED on an
  // in-progress (or unreadable) card via `ensureManageable`, so a bound
  // session can never lose its card mid-flight regardless of the caller.
  ipcMain.handle(
    'roadmap:archiveCard',
    async (
      _e,
      args: { folder: string; slug: string }
    ): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> => {
      const folder = args?.folder ?? ''
      const guard = await ensureManageable(folder, args?.slug)
      if (!guard.ok) return guard
      return archiveCardFile(folder, args?.slug)
    }
  )

  // T148: undo for `roadmap:archiveCard`.
  ipcMain.handle(
    'roadmap:restoreCard',
    (
      _e,
      args: { folder: string; slug: string }
    ): Promise<{ ok: true; card: RoadmapCard } | { ok: false; code: RoadmapWriteCode }> =>
      restoreCardFile(args?.folder ?? '', args?.slug)
  )

  // T148: permanently delete a card file. Irreversible — the renderer confirms
  // with the operator before ever calling this. Fails CLOSED on an in-progress
  // (or unreadable) card via `ensureManageable`, so a bound session can never
  // lose its card mid-flight regardless of the caller.
  ipcMain.handle(
    'roadmap:deleteCard',
    async (
      _e,
      args: { folder: string; slug: string }
    ): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> => {
      const folder = args?.folder ?? ''
      const guard = await ensureManageable(folder, args?.slug)
      if (!guard.ok) return guard
      return deleteCardFile(folder, args?.slug)
    }
  )

  // T80 S2 PR3 (M14/B8/E5): the board's `+ New card` — reuses `createCardCore`
  // (id-minting, slug rules, kind template seeding, `buildNewCardContent`) same
  // as the agent's `create_card` verb, with `provenance.author` stamped
  // `'human'`. Returns the freshly parsed card so the renderer can open its
  // detail modal immediately, without waiting on the watcher's own event.
  ipcMain.handle(
    'roadmap:createCard',
    (
      _e,
      args: { folder: string; title: unknown; kind: unknown; complexity: unknown; body: unknown }
    ): Promise<
      { ok: true; slug: string; card: RoadmapCard } | { ok: false; code: RoadmapWriteCode }
    > => createCardCore(args?.folder ?? '', args)
  )

  // T80 S2 PR3: the per-kind delegation-packet templates (T105 §3), fetched
  // once by the create-mode modal so switching the Kind picker can reseed the
  // body textarea client-side — the SAME files `loadBoardTemplate` reads for
  // the agent's `create_card` seeding.
  ipcMain.handle('roadmap:cardTemplates', async (): Promise<Record<CardKind, string>> => {
    const entries = await Promise.all(
      CARD_KINDS.map(async (k) => [k, (await loadBoardTemplate(k)) ?? ''] as const)
    )
    return Object.fromEntries(entries) as Record<CardKind, string>
  })
}

/**
 * Shared server-side boot-prompt build for both `roadmap:bootPrompt` and
 * `roadmap:planDispatch`: read the on-disk card (authoritative), secret-lint the
 * body (§6.4 — refuse to fold an obvious secret into a prompt; report the class,
 * never the value), and assemble the framed + capped prompt. Returns the parsed
 * card too, so the plan path can read its server-stamped provenance.
 */
async function buildDispatchPrompt(
  folder: string,
  slug: unknown,
  labels: BootPromptLabels
): Promise<
  { ok: true; prompt: string; card: RoadmapCard } | { ok: false; code: RoadmapWriteCode }
> {
  const { roadmapDir } = await resolveRoadmap(folder)
  const file = resolveCardFile(roadmapDir, slug)
  if (!file) return { ok: false, code: 'bad-args' }
  let content: string
  try {
    content = await fs.readFile(file, 'utf8')
  } catch {
    return { ok: false, code: 'not-found' }
  }
  const card = parseCard(content, String(slug))
  if (!lintSecrets(card.body).ok) return { ok: false, code: 'contains-secret' }
  return { ok: true, prompt: buildBootPrompt(card, labels), card }
}

/**
 * The dispatch gate + reserve — grant snapshot → gate → atomic reserve,
 * manifest fingerprint checked at gate time (T104 §2.3), shadow-logged on the
 * drain-relevant outcomes. Shared by `roadmap:planDispatch` (the card's own
 * boot prompt) and `roadmap:planGenerate` (T130 S4, E8, the Docs → Generate
 * prompt) so the background manifest drain, the board's own dispatch, AND a
 * Generate click all decide auto-vs-confirm through the exact same code.
 * Generate reuses this UNCHANGED (not a lighter gate): an agent-authored
 * card's manifest stamp already means the operator reviewed dispatching work
 * on it — extending that same trust to "also generate its missing docs" is
 * the same boundary, not a new one; a human-authored card's live grant alone
 * still suffices, exactly as it does for a normal dispatch.
 */
async function gateAndReserve(
  folder: string,
  card: RoadmapCard,
  prompt: string
): Promise<RoadmapDispatchPlan> {
  const provenanceAuthor = card.provenance.author
  // BUG-43: resolve the posture BEFORE the synchronous snapshot→decide→reserve
  // block so the atomic-reserve guarantee (grant-registry §reserve) still holds.
  const askOff = !(await readMcpAsk())
  // Consult the live registry with the same pure decision the http-guard gate
  // uses; snapshot → decide → reserve happen synchronously (no await between),
  // so the atomic-reserve guarantee (grant-registry §reserve) holds.
  const verdict = grantDecision(
    { folder, verb: 'create_session' },
    snapshotGrants(),
    Date.now(),
    homedir()
  )
  // T104 §2.3: the manifest stamp is checked HERE, at dispatch time, by
  // recomputing the fingerprint from the SAME on-disk card the prompt build
  // just read — never by the watcher, so there is no "edited after the watcher
  // but before the spawn" race. Irrelevant for a human-authored card (the pure
  // gate never consults it there), so only resolved when it might matter.
  const manifest = provenanceAuthor === 'human' ? undefined : resolveManifestVerdict(card)
  const gate = decideDispatchGate({ provenanceAuthor, grant: verdict, manifest, askOff })
  if (gate.mode === 'auto') {
    if (gate.grantId === null) {
      // Posture-authorized (ask off): no grant to reserve, nothing to refund.
      // Shadow-log the manifest-driven case exactly like the grant path so the
      // unattended drain keeps its audit trail (AC-6).
      if (manifest?.present && manifest.hashMatches) {
        pushShadowEntry({
          sessionId: card.session ?? '',
          event: 'roadmap:manifest-dispatch',
          by: 'manifest-drain',
          summary: `auto-dispatched ${card.slug} (agent autonomy — ask off)`,
          ts: Date.now()
        })
      }
      return {
        ok: true,
        mode: 'auto',
        prompt,
        provenanceAuthor,
        grantId: null,
        grantBudgetRemaining: null
      }
    }
    if (reserve(gate.grantId)) {
      // Snapshot the just-committed remaining budget synchronously (T77c) so
      // the ACK the renderer echoes reflects THIS spend, race-free.
      const grantBudgetRemaining = remainingFor(gate.grantId)
      // AC-6: a manifest-driven auto-dispatch is shadow-logged (the human-card
      // grant path already surfaces in the board UI itself; this is specifically
      // for the unattended drain, so the Inbox's shadow log has a trail of what
      // the drain did without a per-card confirm).
      if (manifest?.present && manifest.hashMatches) {
        pushShadowEntry({
          sessionId: card.session ?? '',
          event: 'roadmap:manifest-dispatch',
          by: 'manifest-drain',
          summary: `auto-dispatched ${card.slug} (grant ${gate.grantId})`,
          ts: Date.now()
        })
      }
      return {
        ok: true,
        mode: 'auto',
        prompt,
        provenanceAuthor,
        grantId: gate.grantId,
        grantBudgetRemaining
      }
    }
    // The grant died between snapshot and reserve (a concurrent spend drained
    // it) — never over-spend; escalate to the present human (invariant 6).
    return { ok: true, mode: 'confirm', prompt, provenanceAuthor, reason: 'grant-exhausted' }
  }
  // AC-6: a manifest stamp going stale at dispatch time is exactly the
  // anti-bypass case (§2.3) — log it so the operator can see WHEN and WHY a
  // card fell back to a confirm instead of draining silently.
  if (gate.reason === 'manifest-stale') {
    pushShadowEntry({
      sessionId: card.session ?? '',
      event: 'roadmap:manifest-invalidated',
      by: 'manifest-drain',
      summary: `${card.slug} manifest stamp invalidated — changed: ${(gate.staleFields ?? []).join(', ') || 'unknown'}`,
      ts: Date.now()
    })
  }
  return {
    ok: true,
    mode: 'confirm',
    prompt,
    provenanceAuthor,
    reason: gate.reason,
    ...(gate.staleFields ? { staleFields: gate.staleFields } : {})
  }
}

/**
 * The dispatch gate + reserve, extracted from the `roadmap:planDispatch`
 * handler UNCHANGED so the background manifest drain (T113,
 * `manifest-drain-shell.ts`) and the board's IPC decide through the exact same
 * code.
 */
export async function planDispatchCore(
  folder: string,
  slug: unknown,
  labels: BootPromptLabels
): Promise<RoadmapDispatchPlan> {
  const built = await buildDispatchPrompt(folder, slug, labels)
  if (!built.ok) return built
  return gateAndReserve(folder, built.card, built.prompt)
}

/**
 * Shared server-side Generate-prompt build for `roadmap:planGenerate` (T130
 * S4, E8): read the on-disk card (authoritative), secret-lint the body (§6.4,
 * same posture as the dispatch prompt), and assemble the framed + capped
 * generator prompt via the pure `buildGeneratorPrompt`.
 */
async function buildGeneratePrompt(
  folder: string,
  slug: unknown,
  artifact: ArtifactKey,
  labels: GeneratorPromptLabels
): Promise<
  { ok: true; prompt: string; card: RoadmapCard } | { ok: false; code: RoadmapWriteCode }
> {
  const { roadmapDir } = await resolveRoadmap(folder)
  const file = resolveCardFile(roadmapDir, slug)
  if (!file) return { ok: false, code: 'bad-args' }
  let content: string
  try {
    content = await fs.readFile(file, 'utf8')
  } catch {
    return { ok: false, code: 'not-found' }
  }
  const card = parseCard(content, String(slug))
  if (!lintSecrets(card.body).ok) return { ok: false, code: 'contains-secret' }
  return { ok: true, prompt: buildGeneratorPrompt(card, artifact, labels), card }
}

/**
 * `roadmap:planGenerate`'s engine (T130 S4, M8-Generate, E8): the Docs row's
 * Generate button asks main to plan a dispatch exactly like a card dispatch
 * (`planDispatchCore` above) — same grant/manifest gate, same auto-vs-confirm
 * shape (`RoadmapDispatchPlan`, reused verbatim) — but the prompt built is the
 * 3-tier GENERATOR prompt for the requested artifact, not the card's own boot
 * prompt. "No new free path" (PRD §2-S4 AC): this is the SAME gate, not a
 * lighter one.
 */
export async function planGenerateCore(
  folder: string,
  slug: unknown,
  artifact: unknown,
  labels: GeneratorPromptLabels
): Promise<RoadmapDispatchPlan> {
  if (!isArtifactKey(artifact)) return { ok: false, code: 'bad-args' }
  const built = await buildGeneratePrompt(folder, slug, artifact, labels)
  if (!built.ok) return built
  return gateAndReserve(folder, built.card, built.prompt)
}

/**
 * The card↔session bind, extracted from the `roadmap:bindSession` handler
 * UNCHANGED so the background drain (T113) binds through the same door: writes
 * `session` + `status: in-progress` (+ the resolved `substrate`, T102) via the
 * serialized writer, then best-effort appends the `dispatched-with` audit line
 * (T97) — an append failure never fails the bind.
 *
 * T190: `executedIn` (the short branch name of the SPAWN folder, distinct from
 * `folder` — the card's own home folder, used above only for the audit-line
 * branch/memory location) is stamped in the SAME write as `session`/`status` so
 * the two can never land separately. Omitted when the caller couldn't resolve a
 * branch (e.g. detached HEAD) — never writes an empty value.
 */
export async function bindSessionCore(
  folder: string,
  slug: unknown,
  sessionId: unknown,
  dispatchedWith?: string,
  substrate?: string,
  executedIn?: string
): Promise<{ ok: true } | { ok: false; code: RoadmapWriteCode }> {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return { ok: false, code: 'bad-args' }
  }
  const updates: Record<string, string> = {
    session: sessionId.trim(),
    status: 'in-progress'
  }
  if (substrate !== undefined && isCardSubstrate(substrate)) {
    updates.substrate = substrate
  }
  if (executedIn?.trim()) {
    updates.executedIn = executedIn.trim()
  }
  const res = await writeCardFields(folder, slug, updates)
  if (res.ok && dispatchedWith?.trim()) {
    const { memoryDir, branch } = await resolveMemoryLocation(folder)
    await appendMemoryEntry({
      memoryDir,
      page: `roadmap/${slug}`,
      entry: dispatchedWith.trim(),
      author: 'human',
      ...(branch ? { branch } : {}),
      now: Date.now()
    }).catch((err) => console.warn('[roadmap-ipc] dispatched-with append failed:', err))
  }
  return res
}

/**
 * The card body-replace, extracted from the `roadmap:replaceBody` handler
 * UNCHANGED so the human IPC and the `update_card.replaceBody` MCP verb
 * (`mcp/tool-handlers.ts`) write through the exact SAME serialized door: read →
 * pure `replaceCardBody` transform (`roadmap-core.ts`, frontmatter untouched) →
 * `atomicWrite` (temp+rename) — mirrors `writeCardFields`'s shape one level
 * down (body instead of frontmatter fields). Refuses a `done` card (immutable,
 * same posture as every other controlled write) and an obvious secret (§6.4,
 * the same lint the boot-prompt build already applies to the body). `stampVoided`
 * reports whether the card carried a manifest `approved` stamp BEFORE this
 * write — a body replace always changes the fingerprint, so the caller doesn't
 * need to recompute the hash to know the stamp is now void, only whether there
 * was one to void in the first place (the "should I warn?" question).
 */
export async function replaceCardBodyCore(
  folder: string,
  slug: unknown,
  body: unknown
): Promise<{ ok: true; stampVoided: boolean } | { ok: false; code: RoadmapWriteCode }> {
  if (typeof body !== 'string') return { ok: false, code: 'bad-args' }
  const { roadmapDir } = await resolveRoadmap(folder)
  const file = resolveCardFile(roadmapDir, slug)
  if (!file) return { ok: false, code: 'bad-args' }
  let content: string
  try {
    content = await fs.readFile(file, 'utf8')
  } catch {
    return { ok: false, code: 'not-found' }
  }
  const card = parseCard(content, String(slug))
  if (card.status === 'done') return { ok: false, code: 'card-done' }
  if (!lintSecrets(body).ok) return { ok: false, code: 'contains-secret' }
  try {
    await atomicWrite(file, replaceCardBody(content, body))
    pokeManifestDrain(folder)
    return { ok: true, stampVoided: Boolean(card.approved) }
  } catch {
    return { ok: false, code: 'write-failed' }
  }
}

/**
 * The `roadmap:appendBody` handler's engine (T130 S4, E7) — the human
 * counterpart to `update_card.appendBody`'s write in `mcp/tool-handlers.ts`:
 * SAME `appendMemoryEntry` call (`page: roadmap/<slug>`, which resolves to the
 * card file itself), only `author: 'human'` differs. Refuses a `done` card and
 * an obvious secret, same posture as every other body write. `stampVoided`
 * mirrors `replaceCardBodyCore`'s: any body append changes the manifest
 * fingerprint (title/spec/body), so a stamp present BEFORE the write is void
 * after it (PRD §4 OQ2 — accepted: answering a question voids a stamp by
 * mechanism, and a stamped card with open questions arguably shouldn't drain
 * unmodified anyway).
 */
export async function appendCardBodyCore(
  folder: string,
  slug: unknown,
  entry: unknown
): Promise<{ ok: true; stampVoided: boolean } | { ok: false; code: RoadmapWriteCode }> {
  if (typeof entry !== 'string' || !entry.trim()) return { ok: false, code: 'bad-args' }
  const { roadmapDir } = await resolveRoadmap(folder)
  const file = resolveCardFile(roadmapDir, slug)
  if (!file) return { ok: false, code: 'bad-args' }
  let content: string
  try {
    content = await fs.readFile(file, 'utf8')
  } catch {
    return { ok: false, code: 'not-found' }
  }
  const card = parseCard(content, String(slug))
  if (card.status === 'done') return { ok: false, code: 'card-done' }
  if (!lintSecrets(entry).ok) return { ok: false, code: 'contains-secret' }
  const { memoryDir, branch, mode, checkout } = await resolveMemoryLocation(folder)
  const res = await appendMemoryEntry({
    memoryDir,
    page: `roadmap/${String(slug)}`,
    entry,
    author: 'human',
    ...(branch ? { branch } : {}),
    ...(mode === 'central' ? { backlink: { sourcePath: checkout } } : {}),
    now: Date.now()
  })
  if (!res.ok) return { ok: false, code: 'write-failed' }
  pokeManifestDrain(folder)
  return { ok: true, stampVoided: Boolean(card.approved) }
}

/** The `roadmap:createCard` input, pre-validation (T80 S2 PR3 — the board's `+ New card`). */
export interface CreateCardInput {
  title: unknown
  kind: unknown
  complexity: unknown
  body: unknown
}

/**
 * The human create IPC's engine (T80 S2 PR3, M14/B8/E5) — reuses the EXACT
 * same id-minting, slug-uniqueness, and template-seeding machinery as the
 * agent's `create_card` handler (`mcp/tool-handlers.ts#createCardHandler`),
 * with `provenance.author` stamped `'human'` instead of `'agent'`. The card is
 * ALWAYS born `status: backlog` (`buildNewCardContent` hardcodes it) — status
 * is never an input here, mirroring the agent path's same invariant. Kind and
 * complexity are validated against the same enums the board's segmented
 * pickers render, so an out-of-enum value (a stale client, a bad IPC call)
 * fails `bad-args` rather than writing a malformed card.
 */
export async function createCardCore(
  folder: string,
  input: CreateCardInput
): Promise<{ ok: true; slug: string; card: RoadmapCard } | { ok: false; code: RoadmapWriteCode }> {
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!title) return { ok: false, code: 'bad-args' }
  const kind = typeof input.kind === 'string' ? input.kind : ''
  if (!isCardKind(kind)) return { ok: false, code: 'bad-args' }
  const complexity = typeof input.complexity === 'string' ? input.complexity : ''
  if (!isCardComplexity(complexity)) return { ok: false, code: 'bad-args' }
  const rawBody = typeof input.body === 'string' ? input.body : ''

  const { repoKey } = await resolveRoadmap(folder)
  const { branch } = await resolveMemoryLocation(folder)

  // Defense in depth: the create-mode modal always seeds the textarea itself
  // (`roadmap:cardTemplates`), but a near-empty body still falls back to the
  // kind's template here too — the SAME predicate the agent path uses.
  const templateBody = shouldSeedTemplate(rawBody, kind) ? await loadBoardTemplate(kind) : null
  const body = templateBody ?? rawBody

  type Minted = { ok: true; slug: string; content: string } | { ok: false; code: RoadmapWriteCode }
  const minted: Minted = await withCardIdMintLock(repoKey, async () => {
    const [existingIds, existingSlugs] = await Promise.all([
      listCardIds(folder),
      listCardSlugs(folder).then((s) => new Set(s))
    ])
    const id = mintNextCardId(existingIds, kind)
    const slug = resolveUniqueSlug(`${id}-${slugifyTitle(title)}`, existingSlugs)
    const content = buildNewCardContent({
      slug,
      id,
      title,
      body,
      kind,
      complexity,
      provenance: {
        author: 'human',
        at: new Date().toISOString(),
        ...(branch ? { branch } : {})
      }
    })
    const created = await createCardFile(folder, slug, content)
    return created.ok ? { ok: true, slug, content } : created
  })
  if (!minted.ok) return minted
  return { ok: true, slug: minted.slug, card: parseCard(minted.content, minted.slug) }
}

/**
 * Resolve the T104 manifest-stamp verdict for a card at dispatch time: no
 * stamp at all, a stamp whose fingerprint still matches the on-disk
 * title/spec/body, or a stamp that has gone stale (naming which fields
 * changed for the disclosure). A `approved` present without a parseable
 * `approvedBodyHash` is treated as absent (fail closed — a card can't be
 * "half-stamped").
 */
function resolveManifestVerdict(card: RoadmapCard): ManifestStampVerdict {
  if (!card.approved || !card.approvedBodyHash) return { present: false }
  if (approvalHashMatches(card, card.approvedBodyHash)) {
    return { present: true, hashMatches: true }
  }
  return {
    present: true,
    hashMatches: false,
    staleFields: diffApprovalFields(card, card.approvedBodyHash)
  }
}

/** One card's resolved row for the `submit_manifest` disclosure (T104 §2.1). */
export interface ManifestCardResolved {
  slug: string
  title: string
  kind?: string
  complexity?: string
  substrate?: string
  model?: string
  effort?: string
  gaps: string[]
  prompt: string
  bodyHash: string
}

/** One card entry as requested by `submit_manifest` — the per-card overrides. */
export interface ManifestCardRequest {
  slug: string
  substrate?: CardSubstrate
  model?: string
  effort?: string
}

/** Why `buildManifestDisclosure` refused to build a row for one card (T104 AC-1). */
export type ManifestBuildError = { ok: false; code: RoadmapWriteCode; slug: string }

/**
 * Build the `submit_manifest` disclosure SERVER-SIDE from disk (T104 §2.1) — the
 * agent's tool call only names slugs + per-card overrides; every other field
 * (title, kind/complexity, readiness gaps, the boot prompt, the approval
 * fingerprint) is resolved HERE from the on-disk card, never trusted from the
 * agent's text. Validates against disk first (AC-1): a card that doesn't exist
 * or is already `done` refuses the WHOLE batch (naming which slug), same as a
 * secret-bearing body (§6.4, mirrors `buildDispatchPrompt`) — no partial
 * disclosure of a batch the server couldn't fully resolve. Readiness gaps
 * (§2.1, T105 `lintCardReadiness`) are NEVER a refusal — they ride along as
 * disclosure content only.
 */
export async function buildManifestDisclosure(
  folder: string,
  cards: readonly ManifestCardRequest[],
  labels: BootPromptLabels
): Promise<{ ok: true; resolved: ManifestCardResolved[] } | ManifestBuildError> {
  const resolved: ManifestCardResolved[] = []
  for (const entry of cards) {
    const found = await readCard(folder, entry.slug)
    if (!found.ok) {
      return {
        ok: false,
        code: found.code === 'bad-args' ? 'bad-args' : 'not-found',
        slug: entry.slug
      }
    }
    const card = found.card
    if (card.status === 'done') return { ok: false, code: 'card-done', slug: entry.slug }
    if (!lintSecrets(card.body).ok) return { ok: false, code: 'contains-secret', slug: entry.slug }

    const row: ManifestCardResolved = {
      slug: card.slug,
      title: card.title,
      gaps: lintCardReadiness(card).map((g) => g.message),
      prompt: buildBootPrompt(card, labels),
      bodyHash: computeCardApprovalHash(card)
    }
    if (card.kind) row.kind = card.kind
    if (card.complexity) row.complexity = card.complexity
    const substrate = entry.substrate ?? card.substrate
    if (substrate) row.substrate = substrate
    if (entry.model) row.model = entry.model
    if (entry.effort) row.effort = entry.effort
    resolved.push(row)
  }
  return { ok: true, resolved }
}

/**
 * Stamp `approved` + `approvedBodyHash` on the checked cards ONLY (T104 §2.2 —
 * partial-go: unchecked cards are UNTOUCHED, not denied). The fingerprint
 * stamped is the ONE the operator actually saw in the disclosure (`row.bodyHash`,
 * built once by {@link buildManifestDisclosure} before the confirm parked) — NOT
 * re-read from disk here, so a body swapped between disclosure and Allow can
 * never get waved through on content the human never reviewed (a stale swap
 * still surfaces at dispatch time as `manifest-stale`, since the disk no longer
 * matches what was stamped). `approved` timestamps are STAGGERED by array index
 * (this array's order IS the declared drain order, §2.5) so the drain engine can
 * recover that order later by sorting on `approved` ascending — no new
 * controlled field needed just to remember the sequence.
 *
 * `substrateOverrides` (T102): the operator's per-card substrate pick at Allow
 * (the manifest checklist's selector), slug -> `session|worktree|teammate|internal`.
 * Written ALONGSIDE the approval stamp in the same call — a card at this point
 * has no `session` bound yet, so `substrate` is still writable (the agent-facing
 * lock only trips once a session binds, T96 planCardSet). An unrecognized value
 * is silently ignored (fail-safe: the card keeps whatever substrate was already
 * on disk / disclosed, never a malformed write).
 */
export async function stampManifestApprovals(
  folder: string,
  resolved: readonly ManifestCardResolved[],
  selectedSlugs: readonly string[],
  now: number,
  substrateOverrides: Readonly<Record<string, string>> = {}
): Promise<{ stamped: string[]; failed: string[] }> {
  const selected = new Set(selectedSlugs)
  const stamped: string[] = []
  const failed: string[] = []
  let offset = 0
  for (const row of resolved) {
    if (!selected.has(row.slug)) continue
    const approvedAt = new Date(now + offset).toISOString()
    offset += 1
    const override = substrateOverrides[row.slug]
    const updates: Record<string, string> = {
      approved: approvedAt,
      approvedBodyHash: row.bodyHash
    }
    if (override !== undefined && isCardSubstrate(override)) updates.substrate = override
    const res = await writeCardFields(folder, row.slug, updates)
    if (res.ok) stamped.push(row.slug)
    else failed.push(row.slug)
  }
  return { stamped, failed }
}

/** Teardown for `before-quit` — stop the chokidar instance. */
export async function closeRoadmapWatcher(): Promise<void> {
  if (watcher) {
    const w = watcher
    watcher = null
    await w.close()
  }
}
