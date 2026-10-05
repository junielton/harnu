/**
 * Generic atomic file write: write to a sibling temp file in the SAME
 * directory, then `rename()` over the target. On POSIX, `rename()` within one
 * filesystem is atomic — a concurrent reader that opens the target path
 * mid-write either sees the complete PRIOR content (the temp file hasn't been
 * renamed yet) or the complete NEW content (the rename already landed); it can
 * never observe a partial/truncated file.
 *
 * Extracted out of `mcp/server.ts` (T123 §3.1 AC15 / BUG-32) so the atomicity
 * itself is unit-testable without electron. Kept framework-free (node fs +
 * path + crypto only, no electron) so it runs in the `node` vitest env
 * (`tests/mcp-atomic-write.test.ts`), per ADR-0001 (pure-core / thin-shell) —
 * this module is the "near-pure" shell half: it does touch the filesystem,
 * but nothing electron- or app-state-dependent.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Write `body` to `targetPath` atomically. The temp file is created with
 * `mode` BEFORE the rename, so the target never exists — even momentarily —
 * with looser permissions than requested (the rename preserves the temp
 * file's own mode bits; it does not re-apply the destination's prior mode).
 * The `mode` passed to `writeFile` is masked by the process umask on POSIX
 * (same caveat the original non-atomic writer worked around), so an explicit
 * `chmod` re-asserts the exact bits on the temp file before it's renamed into
 * place — the target is never briefly world/group-readable.
 *
 * @param targetPath - absolute path of the final file.
 * @param body - full file content to write.
 * @param mode - POSIX file mode applied to the temp file (e.g. `0o600`).
 */
export async function atomicWriteFile(
  targetPath: string,
  body: string,
  mode: number
): Promise<void> {
  const dir = path.dirname(targetPath)
  const tmp = path.join(dir, `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`)
  // The initial write itself is inside the try — a hard failure partway
  // through (ENOSPC, EACCES, a killed write) can still leave a partial temp
  // file on disk, and that leak must be cleaned up exactly like a failed
  // chmod/rename below. Only a failure BEFORE any bytes landed (e.g. the
  // directory doesn't exist) makes the unlink a no-op, which `.catch(() => {})`
  // already tolerates.
  try {
    await fs.writeFile(tmp, body, { mode })
    await fs.chmod(tmp, mode)
    await fs.rename(tmp, targetPath)
  } catch (err) {
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}
