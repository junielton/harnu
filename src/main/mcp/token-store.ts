/**
 * Persists the MCP control server's bearer token — and the last port it
 * bound — across restarts (ADR-0004 / BUG-35). `server.ts`'s `start()` used
 * to mint a fresh `randomUUID()` token AND re-bind a fresh ephemeral port on
 * every boot, so restarting the control server permanently broke every
 * already-running session's Harnu tool calls (the spawned `claude` read
 * `--mcp-config` once and held the old, now-invalid, credential/endpoint for
 * its whole life). `start()` now reads through this store instead: the same
 * token survives a restart, and the previously-bound port is re-attempted
 * before falling back to a fresh ephemeral one.
 *
 * Pure node fs + path + crypto (no electron), per ADR-0001 pure-core/thin-shell
 * — the caller passes in the userData directory rather than this module
 * resolving it itself, so it's unit-testable against a real tmpdir
 * (`tests/mcp-token-store.test.ts`), exactly like the sibling
 * {@link atomicWriteFile} it's built on.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './atomic-write'

/** `<userData>/mcp-token.json`. */
const STORE_FILE = 'mcp-token.json'
/** Same mode as `harnu.mcp.json` — 0600 in the already-0700 userData dir. */
const STORE_MODE = 0o600

/** The persisted shape: the bearer secret, and the last port `start()` bound. */
interface StoredState {
  token: string
  port?: number
}

/** Injectable read/write seams (default to the real filesystem). */
export interface TokenStoreDeps {
  writeFile: (targetPath: string, body: string, mode: number) => Promise<void>
  readFile: (targetPath: string) => Promise<string>
}

const DEFAULT_DEPS: TokenStoreDeps = {
  writeFile: atomicWriteFile,
  readFile: (targetPath) => fs.readFile(targetPath, 'utf8')
}

function storePath(dir: string): string {
  return path.join(dir, STORE_FILE)
}

/**
 * Read the store; `null` for anything that isn't a valid `{ token: string }`
 * document — missing file, unreadable, corrupt JSON, or a wrong shape (D5).
 * Never throws: a broken store must never prevent the server from starting.
 */
async function readStore(dir: string, deps: TokenStoreDeps): Promise<StoredState | null> {
  let raw: string
  try {
    raw = await deps.readFile(storePath(dir))
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const rec = parsed as Record<string, unknown>
    if (typeof rec.token !== 'string' || rec.token.length === 0) return null
    const port = typeof rec.port === 'number' && Number.isFinite(rec.port) ? rec.port : undefined
    return { token: rec.token, port }
  } catch {
    return null
  }
}

async function persistStore(dir: string, state: StoredState, deps: TokenStoreDeps): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const body = JSON.stringify(state, null, 2) + '\n'
  await deps.writeFile(storePath(dir), body, STORE_MODE)
}

/**
 * Return the persisted bearer token, minting and persisting a fresh one the
 * first time (or if the store is missing/corrupt — D5). A call that finds a
 * valid existing token is a pure read: it does NOT write.
 *
 * @param dir - the userData directory (caller resolves it; this module has no
 *   electron dependency).
 * @param deps - injectable read/write seams, defaulting to the real filesystem.
 */
export async function readOrCreateToken(
  dir: string,
  deps: TokenStoreDeps = DEFAULT_DEPS
): Promise<string> {
  const existing = await readStore(dir, deps)
  if (existing) return existing.token
  const token = randomUUID()
  await persistStore(dir, { token }, deps)
  return token
}

/**
 * The port `writeStore` last recorded, or `undefined` if none has ever been
 * stored (first run) or the store is unreadable/corrupt.
 */
export async function readStoredPort(
  dir: string,
  deps: TokenStoreDeps = DEFAULT_DEPS
): Promise<number | undefined> {
  const existing = await readStore(dir, deps)
  return existing?.port
}

/** Persist `{ token, port }` atomically at 0600, replacing whatever was stored. */
export async function writeStore(
  dir: string,
  state: { token: string; port?: number },
  deps: TokenStoreDeps = DEFAULT_DEPS
): Promise<void> {
  await persistStore(dir, state, deps)
}

/**
 * Mint and persist a brand-new token (D4 — the explicit, operator-initiated
 * rotate action; never a side effect of a restart). The previously stored
 * port, if any, is preserved — rotation replaces the secret, not the
 * endpoint bookkeeping.
 */
export async function rotateToken(
  dir: string,
  deps: TokenStoreDeps = DEFAULT_DEPS
): Promise<string> {
  const existing = await readStore(dir, deps)
  const token = randomUUID()
  await persistStore(dir, { token, port: existing?.port }, deps)
  return token
}
