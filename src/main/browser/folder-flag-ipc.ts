/**
 * The two operator-only folder settings of the browser pane (T571, spec §7.1, §7.2): "Let agents read browser panes I
 * open" and the trusted dev hosts. They widen what an agent may do, so the IPC that writes them must (a) come from the
 * app window's own webContents, never from a guest page or anything else, and (b) carry a payload that is exactly
 * what the editor could have produced: a known folder, a boolean, and a short list of hosts that each pass the same
 * rule the dialog applies. Pure (ADR-0001): the window and the known folders are injected.
 */
import { resolveKnownFolder } from '../mcp/permission-core'
import { MAX_TRUSTED_HOSTS, parseTrustedHost } from '../../shared/browser-trusted-hosts'

/** Whether `sender` is the app window's webContents (and the window is alive). */
export function isFromAppWindow(
  sender: unknown,
  win: { isDestroyed(): boolean; webContents: unknown } | null
): boolean {
  return win !== null && !win.isDestroyed() && sender === win.webContents
}

export type FolderFlagError = 'BAD_ARGS' | 'UNKNOWN_FOLDER' | 'BAD_HOSTS'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The folder as Harnu knows it, or `undefined`. A path that is not a folder Harnu tracks is not accepted. */
function knownFolder(raw: unknown, known: readonly string[], home: string): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096 || raw.includes('\0')) {
    return undefined
  }
  return resolveKnownFolder(raw, [...known], home) !== undefined ? raw : undefined
}

export function parseBrowserReadPayload(
  raw: unknown,
  known: readonly string[],
  home: string
): { ok: true; targetPath: string; enabled: boolean } | { ok: false; error: FolderFlagError } {
  if (!isRecord(raw) || typeof raw.enabled !== 'boolean') return { ok: false, error: 'BAD_ARGS' }
  const targetPath = knownFolder(raw.targetPath, known, home)
  if (targetPath === undefined) {
    return { ok: false, error: typeof raw.targetPath === 'string' ? 'UNKNOWN_FOLDER' : 'BAD_ARGS' }
  }
  return { ok: true, targetPath, enabled: raw.enabled }
}

export function parseTrustedHostsPayload(
  raw: unknown,
  known: readonly string[],
  home: string
): { ok: true; targetPath: string; hosts: string[] } | { ok: false; error: FolderFlagError } {
  if (!isRecord(raw) || !Array.isArray(raw.hosts)) return { ok: false, error: 'BAD_ARGS' }
  const targetPath = knownFolder(raw.targetPath, known, home)
  if (targetPath === undefined) {
    return { ok: false, error: typeof raw.targetPath === 'string' ? 'UNKNOWN_FOLDER' : 'BAD_ARGS' }
  }
  if (raw.hosts.length > MAX_TRUSTED_HOSTS) return { ok: false, error: 'BAD_HOSTS' }
  const hosts: string[] = []
  for (const item of raw.hosts) {
    if (typeof item !== 'string') return { ok: false, error: 'BAD_HOSTS' }
    const parsed = parseTrustedHost(item)
    // One bad entry refuses the whole call: the editor never sends one, so this is not the operator's edit.
    if (!parsed.ok) return { ok: false, error: 'BAD_HOSTS' }
    if (!hosts.includes(parsed.host)) hosts.push(parsed.host)
  }
  return { ok: true, targetPath, hosts }
}
