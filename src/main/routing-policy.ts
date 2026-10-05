import { app, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { folderKey } from './claude-config'
import { CARD_KINDS, isCardKind, type CardKind } from './roadmap-core'

/**
 * Per-repo model routing policy (T97, T82 epic Slice 3): a human-owned table
 * mapping a card's `kind` to the `{ model, effort }` a dispatch should launch
 * with. Mirrors the Claude Boot per-folder store (`claude-config.ts`) — same
 * `<userData>` JSON file shape, same deterministic {@link folderKey}, same
 * whole-object read-modify-write — but lives in its OWN file, deliberately
 * separate from `claude-boot.json`.
 *
 * Security posture (T82 spec §10.1 Q12/Q13, T97 addendum): the routing table is
 * NEVER agent-writable. No MCP verb reads or writes `routing-policy.json` — the
 * ONLY writers are the human-facing IPC handlers registered here, called from
 * the folder-settings editor. Resolution (`resolveRouting`) is applied at
 * dispatch time by the renderer's board/session code, never by an agent tool
 * call. Keeping this in its own file (rather than folded into `claude-boot.json`)
 * keeps that boundary structurally obvious in review.
 */

/** One routing entry: both fields optional — a partial entry never resolves. */
export interface RoutingEntry {
  model?: string
  effort?: string
}

/** A folder's routing table: per-kind entries plus a fallback default. */
export interface RoutingTable {
  byKind?: Partial<Record<CardKind, RoutingEntry>>
  default?: RoutingEntry
}

/** A fully-resolved routing decision — always concrete (never partial). */
export interface ResolvedRouting {
  model: string
  effort: string
}

/**
 * Operator-approved hardcoded defaults (T82 spec §10.1 Q12), the routing
 * table's fallback when a folder has no stored table, or a kind/default entry
 * is absent/partial: scout = cheap triage, bug/feature/chore = the standard
 * workhorse tier, review = the highest-trust tier.
 */
export const HARDCODED_ROUTING_DEFAULTS: Record<CardKind, ResolvedRouting> = {
  scout: { model: 'haiku', effort: 'low' },
  bug: { model: 'sonnet', effort: 'high' },
  feature: { model: 'sonnet', effort: 'high' },
  review: { model: 'opus', effort: 'high' },
  chore: { model: 'sonnet', effort: 'high' }
}

/** A card with no `kind` resolves as if it were `feature` (T82 §10.2 Q14). */
const FALLBACK_KIND: CardKind = 'feature'

function isComplete(e: RoutingEntry | undefined): e is ResolvedRouting {
  return Boolean(e?.model?.trim() && e?.effort?.trim())
}

/**
 * Resolve the model+effort a dispatch should launch with: `kind` → the table's
 * per-kind entry → the table's `default` → the hardcoded default for the
 * (possibly folded-back) kind. Pure, so the precedence is unit-testable without
 * touching disk (`tests/routing-policy.test.ts`) — the four cases the card asks
 * for map directly onto this function: a kind with a `byKind` hit, a card with
 * no `kind` (folds to `feature`), and an empty/absent table (falls through to
 * the hardcoded defaults).
 */
export function resolveRouting(
  table: RoutingTable | undefined,
  kind: string | undefined
): ResolvedRouting {
  const effectiveKind: CardKind = kind && isCardKind(kind) ? kind : FALLBACK_KIND
  const byKind = table?.byKind?.[effectiveKind]
  if (isComplete(byKind)) return byKind
  const def = table?.default
  if (isComplete(def)) return def
  return HARDCODED_ROUTING_DEFAULTS[effectiveKind]
}

/** The `dispatched-with` audit line recorded on a card body (T82 §10.1 Q13). */
export function formatDispatchedWith(r: ResolvedRouting): string {
  return `dispatched-with: ${r.model}·${r.effort}`
}

// ---- Persistence (mirrors claude-config.ts) --------------------------------

const FILE_NAME = 'routing-policy.json'
const TMP_SUFFIX = '.tmp'

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

interface RoutingPolicyFile {
  version: 1
  folders: Record<string, RoutingTable>
}

function emptyFile(): RoutingPolicyFile {
  return { version: 1, folders: {} }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Coerce a raw entry into a sanitized `RoutingEntry` (string fields only). */
function sanitizeEntry(raw: unknown): RoutingEntry {
  if (!isPlainObject(raw)) return {}
  const model = raw.model
  const effort = raw.effort
  return {
    ...(typeof model === 'string' && model.trim() ? { model: model.trim() } : {}),
    ...(typeof effort === 'string' && effort.trim() ? { effort: effort.trim() } : {})
  }
}

/** Coerce a raw table into a sanitized `RoutingTable`, dropping empty entries. */
function sanitizeTable(raw: unknown): RoutingTable {
  if (!isPlainObject(raw)) return {}
  const out: RoutingTable = {}
  if (isPlainObject(raw.byKind)) {
    const byKind: Partial<Record<CardKind, RoutingEntry>> = {}
    for (const kind of CARD_KINDS) {
      const entry = sanitizeEntry(raw.byKind[kind])
      if (Object.keys(entry).length > 0) byKind[kind] = entry
    }
    if (Object.keys(byKind).length > 0) out.byKind = byKind
  }
  const def = sanitizeEntry(raw.default)
  if (Object.keys(def).length > 0) out.default = def
  return out
}

/** Read + parse. Never throws — a missing/corrupt file degrades to empty. */
async function readPolicyFile(): Promise<RoutingPolicyFile> {
  let raw: string
  try {
    raw = await fs.readFile(filePath(), 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.warn('[routing-policy] read failed:', err)
    return emptyFile()
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return emptyFile()
    const folders: Record<string, RoutingTable> = {}
    if (isPlainObject(parsed.folders)) {
      for (const [key, value] of Object.entries(parsed.folders)) {
        const table = sanitizeTable(value)
        if (Object.keys(table).length > 0) folders[key] = table
      }
    }
    return { version: 1, folders }
  } catch (err) {
    console.warn('[routing-policy] corrupt JSON:', err)
    return emptyFile()
  }
}

/** Atomic write (tmp + rename). */
async function writePolicyFile(file: RoutingPolicyFile): Promise<void> {
  const fp = filePath()
  await fs.mkdir(path.dirname(fp), { recursive: true })
  const tmp = fp + TMP_SUFFIX
  await fs.writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, fp)
}

/** A folder's stored routing table (empty object when it has none). */
export async function getFolderRoutingTable(folderPath: string): Promise<RoutingTable> {
  const file = await readPolicyFile()
  return file.folders[folderKey(folderPath)] ?? {}
}

/** Persist a folder's routing table (whole-object write; empty prunes the entry). */
export async function setFolderRoutingTable(
  folderPath: string,
  table: RoutingTable
): Promise<RoutingTable> {
  const file = await readPolicyFile()
  const key = folderKey(folderPath)
  const sanitized = sanitizeTable(table)
  if (Object.keys(sanitized).length === 0) delete file.folders[key]
  else file.folders[key] = sanitized
  await writePolicyFile(file)
  return file.folders[key] ?? {}
}

/**
 * Resolve the dispatch routing for a folder + card kind: reads the folder's
 * stored table fresh (edits take effect on the next dispatch) and applies
 * {@link resolveRouting}. The one function both dispatch paths (manual confirm
 * and the T104 manifest drain) call through, so a routing-table edit and a
 * hardcoded-default fallback are computed identically on both.
 */
export async function resolveFolderRouting(
  folderPath: string,
  kind: string | undefined
): Promise<ResolvedRouting> {
  const table = await getFolderRoutingTable(folderPath)
  return resolveRouting(table, kind)
}

/**
 * Register the routing-policy IPC. Called from `registerRoadmapHandlers`
 * (`roadmap-ipc.ts`) rather than wired independently in `src/main/index.ts` —
 * the routing table is dispatch-adjacent plumbing, and this keeps its
 * registration next to the dispatch code that consumes it.
 */
export function registerRoutingPolicyHandlers(): void {
  ipcMain.handle('routingPolicy:getFolder', (_e, folderPath: string) =>
    getFolderRoutingTable(folderPath)
  )
  ipcMain.handle('routingPolicy:setFolder', (_e, folderPath: string, table: RoutingTable) =>
    setFolderRoutingTable(folderPath, table)
  )
  ipcMain.handle('routingPolicy:resolve', (_e, args: { folder: string; kind?: string }) =>
    resolveFolderRouting(args?.folder ?? '', args?.kind)
  )
}
