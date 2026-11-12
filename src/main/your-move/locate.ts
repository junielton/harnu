/**
 * Finds a session's transcript by id: `~/.claude/projects/<slug>/<id>.jsonl`. The renderer never
 * names a path, so every Your move source resolves one through here.
 *
 * Pure node (no electron import) so the scale-fixture perf suite (`tests/perf/`) can run the real
 * thing against a generated home directory: it reads `os.homedir()` on every call, which follows
 * `$HOME`.
 */

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export async function locateTranscript(sessionId: string): Promise<string | null> {
  const root = path.join(os.homedir(), '.claude', 'projects')
  let slugs: string[]
  try {
    slugs = await fs.readdir(root)
  } catch {
    return null
  }
  for (const slug of slugs) {
    const candidate = path.join(root, slug, `${sessionId}.jsonl`)
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      /* not in this slug */
    }
  }
  return null
}
