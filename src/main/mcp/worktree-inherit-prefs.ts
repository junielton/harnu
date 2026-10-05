/**
 * T61 global opt-in: "worktrees created by an agent inherit agent control from
 * the repo." Stored SEPARATELY from `mcp-prefs.json` (`{ enabled }`) so the two
 * write paths never clobber each other — this file owns
 * `<userData>/worktree-inherit.json` as `{ "enabled": boolean }`.
 *
 * MOSTLY VESTIGIAL since the free-by-default reversal. This setting existed to
 * DERIVE a worktree's place on the agent allowlist from its parent repo's grant.
 * There is no allowlist any more: a worktree is reachable by agents like every
 * other folder, so inheritance governs nothing about access. The module is kept
 * (the T72 discovery path, the `inheritAgentControl` birth marker, and their tests
 * still reference it) and it now reads as a plain, harmless "mark new worktrees as
 * inheriting" provenance flag.
 *
 * The old header said "SECURITY — defaults **OFF** … the allowlist must never
 * silently widen to inherited worktrees". That is REPEALED: there is nothing to
 * widen. It now defaults **ON** for a missing file (never configured), which is the
 * only honest default once every folder is reachable anyway. A corrupt/unreadable
 * file still resolves `false` — not for safety (there is no grant at stake) but
 * because a torn pref should not be read as an operator decision.
 *
 * env-bound (electron `app` + `node:fs`) ⇒ e2e-only per ADR-0001 (coverage.exclude).
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/** On-disk file name under `app.getPath('userData')`. */
const FILE_NAME = 'worktree-inherit.json'

function prefsPath(): string {
  return path.join(app.getPath('userData'), FILE_NAME)
}

/**
 * Whether agent-created worktrees are marked as inheriting their repo's agent
 * control. Defaults to **`true`** when the file does not exist (never configured):
 * agents are free by default, so there is no grant for a worktree to be excluded
 * from. An explicit `{ "enabled": false }` still wins; a corrupt or unreadable file
 * resolves `false` (a torn pref is not an operator decision).
 */
export async function readWorktreeInheritControl(): Promise<boolean> {
  let raw: string
  try {
    raw = await fs.readFile(prefsPath(), 'utf8')
  } catch (err) {
    // ENOENT — never configured. Default ON (see the doc above). Any OTHER read
    // error (EACCES, EIO) is a real failure, not a default: resolve false.
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
  }
  try {
    // Strict `!== false`: only an explicit `{ "enabled": false }` opts out.
    return JSON.parse(raw)?.enabled !== false
  } catch {
    return false // corrupt JSON — not an operator decision
  }
}

/** Persist the inheritance flag, creating the userData dir if missing. */
export async function writeWorktreeInheritControl(enabled: boolean): Promise<void> {
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(prefsPath(), JSON.stringify({ enabled }, null, 2) + '\n', 'utf8')
}
