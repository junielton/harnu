/**
 * keybindings-file.ts — the pure-node (fs + path only, no `electron`) half of
 * the `keybindings.json` override layer (T1 P2).
 *
 * Split from `src/main/keybindings.ts` (which owns the electron glue: IPC, the
 * chokidar watch, and the settings-relocation-aware path) so the read/parse/write
 * behavior is unit-testable against real temp files without an Electron runtime
 * — the same `*-core` / `*-file` seam as `pr-stack-core.ts` / `review-core.ts`.
 *
 * The resolution itself lives in the fully-pure `keybindings-core.ts`
 * (`parseKeybindingsFile`); this module only adds "read the file, tolerate it
 * being absent".
 */

import { readFileSync } from 'fs'
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { parseKeybindingsFile, type ResolvedKeybindings } from './keybindings-core'

/** The fixed basename. Lives next to `settings.json` (T1, Q3). */
export const KEYBINDINGS_FILENAME = 'keybindings.json'

/** `<dir>/keybindings.json`. `dir` is the settings directory (`settingsDir()`). */
export function keybindingsPathIn(dir: string): string {
  return join(dir, KEYBINDINGS_FILENAME)
}

/**
 * Read the file body, or `''` when it does not exist yet. A missing file is
 * the normal first-run state — VS Code likewise does not create `keybindings.json`
 * until the user edits it. Any non-ENOENT read error is rethrown (a real I/O
 * fault should not masquerade as "no overrides").
 */
export async function readKeybindingsBody(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

/**
 * Whether `Ctrl` and `Cmd` are folded when resolving (see
 * `resolveKeybindings`' `opts.mac`). Defaulted from `process.platform` here so
 * the electron glue in `keybindings.ts` doesn't have to pass it, while tests
 * can still pin either platform.
 */
const IS_MAC = process.platform === 'darwin'

/**
 * Read + resolve in one step. Never throws on a malformed file — a bad JSON
 * body resolves to the defaults with a single `not-array` warning (see
 * `parseKeybindingsFile`), which is what keeps a broken file from bricking the
 * app (Q5).
 */
export async function loadResolvedKeybindings(
  filePath: string,
  mac: boolean = IS_MAC
): Promise<ResolvedKeybindings> {
  return parseKeybindingsFile(await readKeybindingsBody(filePath), { mac })
}

/**
 * Synchronous {@link loadResolvedKeybindings}, for the one caller that needs the
 * resolved table *before* it yields the event loop: `registerKeybindings` seeds
 * the native menu from it at startup, ahead of `registerAppMenu` (T1, Q3).
 *
 * Unlike the async path this never rethrows an I/O fault — it runs during
 * startup, before the window exists, and must not be able to brick the app
 * (Q5). An absent file (the first-run norm) or an unreadable one both resolve
 * to the built-in defaults; the chokidar watch re-reads on the next change.
 */
export function loadResolvedKeybindingsSync(
  filePath: string,
  mac: boolean = IS_MAC
): ResolvedKeybindings {
  let body = ''
  try {
    body = readFileSync(filePath, 'utf8')
  } catch {
    /* absent or unreadable — start from defaults */
  }
  return parseKeybindingsFile(body, { mac })
}

/**
 * Write the file body verbatim (creating the directory if needed). The caller
 * owns the content — the Settings pane (P4) serializes the override array; a
 * hand-edit round-trips through the editor pane (P5). We never reformat here.
 *
 * Atomic: write a sibling `.tmp` then `rename` over the target (same shape as
 * `markdown-write.ts` / `helpers-store`). A crash — or a second `keybindings:save`
 * racing this one — can then only ever leave a fully-written file, never a
 * half-truncated one that resolves to defaults on the next read.
 *
 * A symlink at `filePath` is followed to its target, so a user who symlinks
 * `keybindings.json` into a dotfiles repo keeps the link — a bare `rename` onto
 * `filePath` would replace it with a plain file on the first save. This is the
 * one place that follows it: `writeMarkdownFile` (the editor-pane path, a
 * renderer/agent-facing confined channel) still refuses a symlink at the same
 * exact-path exception, on purpose.
 */
export async function writeKeybindingsBody(filePath: string, body: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  let target = filePath
  try {
    target = await realpath(filePath)
  } catch {
    /* not created yet — no link to preserve, write straight to filePath */
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, target)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}
