/**
 * What Harnu's own watchers know about a session id (T389 P4W3 §7.5): the corroboration an outside
 * binding needs before it is shown. Two sources, either is enough:
 *
 *  - the PID registry, `~/.claude/sessions/<pid>.json`, an entry with that `sessionId` AND the
 *    hello's `cwd` (the registry may not carry `cwd` on every build: such an entry proves nothing
 *    here, Q-P4W3-g, and the transcript covers it);
 *  - the transcript, `<projects>/<slug of cwd>/<sid>.jsonl`.
 *
 * It reads the same two places the registry watcher and the transcript watcher read, on demand,
 * so a session that was already running when its mod said hello is corroborated at once, with no
 * dependence on when the watcher happened to fire. The mod's own words are never an input.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface CorroborationDeps {
  /** `~/.claude/projects` */
  projectsDir(): string
  /** `~/.claude/sessions` */
  registryDir(): string
}

/** Claude Code names a project directory after its cwd with every non-alphanumeric as `-`. */
export function slugOfCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

const trimTrailingSep = (p: string): string => (p.length > 1 ? p.replace(/[/\\]+$/, '') : p)

/** A `<pid>.json` entry's `sessionId` and `cwd`, or null. Pure. */
export function parseRegistryCwd(raw: string): { sessionId: string; cwd: string | null } | null {
  try {
    const o = JSON.parse(raw) as Record<string, unknown> | null
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    if (typeof o.sessionId !== 'string' || o.sessionId === '') return null
    return { sessionId: o.sessionId, cwd: typeof o.cwd === 'string' ? o.cwd : null }
  } catch {
    return null
  }
}

export function createCorroborator(deps: CorroborationDeps): {
  corroborates(sid: string, cwd: string): Promise<boolean>
} {
  async function viaTranscript(sid: string, cwd: string): Promise<boolean> {
    // Both spellings: the slug of the cwd as sent, and of its trailing-separator-free form.
    const slugs = new Set([slugOfCwd(cwd), slugOfCwd(trimTrailingSep(cwd))])
    for (const slug of slugs) {
      try {
        const st = await fs.stat(join(deps.projectsDir(), slug, `${sid}.jsonl`))
        if (st.isFile()) return true
      } catch {
        // not there: try the next spelling
      }
    }
    return false
  }

  async function viaRegistry(sid: string, cwd: string): Promise<boolean> {
    let names: string[]
    try {
      names = await fs.readdir(deps.registryDir())
    } catch {
      return false // older CLI or BG_SESSIONS off: no registry
    }
    const want = trimTrailingSep(cwd)
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      try {
        const entry = parseRegistryCwd(await fs.readFile(join(deps.registryDir(), name), 'utf8'))
        if (
          entry &&
          entry.sessionId === sid &&
          entry.cwd !== null &&
          trimTrailingSep(entry.cwd) === want
        ) {
          return true
        }
      } catch {
        // a file that vanished between readdir and read
      }
    }
    return false
  }

  return {
    async corroborates(sid, cwd) {
      if (sid === '' || cwd === '') return false
      return (await viaTranscript(sid, cwd)) || (await viaRegistry(sid, cwd))
    }
  }
}
