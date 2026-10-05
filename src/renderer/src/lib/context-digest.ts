/**
 * Pure context-digest formatter (T38). Turns a session's metadata + the tail of
 * its transcript into a portable markdown block the operator can paste into a
 * fresh session, a doc, an issue — the "reuse context without hunting the JSONL"
 * primitive. Framework-free (no fs/electron/DOM) so it's unit-tested in isolation
 * (`tests/context-digest.test.ts`), matching the repo's pure-core discipline
 * (`closure-core` / `grant-core` / `sentinel-core`).
 *
 * NOT localized: the digest is COPIED CONTENT (like the resume-command / transcript
 * path the menu already copies), technical + structural — the labels are fixed so
 * a pasted digest reads the same everywhere. The MENU label + toast are i18n'd.
 */

/** One conversation turn from the transcript tail (already de-wrappered + flattened). */
export interface DigestTurn {
  role: 'user' | 'assistant'
  text: string
}

/** The renderer-side session metadata a digest carries. */
export interface DigestMeta {
  /** Folder alias (basename) the session belongs to. */
  folderAlias: string
  /** Short branch name, when the session's folder has one. */
  branch?: string
  /** The session summary / title, when set. */
  summary?: string
  /** The opening prompt, when captured. */
  firstPrompt?: string
  /** Total message count, when known. */
  messageCount?: number
}

/** Cap on a single turn's text in the digest so one giant paste can't blow it up. */
export const DIGEST_TURN_MAX = 800

function clampTurn(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > DIGEST_TURN_MAX ? `${t.slice(0, DIGEST_TURN_MAX)}…` : t
}

/**
 * Build the portable context digest. Deterministic + pure. Sections are omitted
 * when their source is empty, so a metadata-only session still yields a clean
 * (if thin) block.
 */
export function buildContextDigest(meta: DigestMeta, turns: readonly DigestTurn[]): string {
  const lines: string[] = []
  lines.push(`# Context digest — ${meta.summary?.trim() || meta.folderAlias}`)

  const facts: string[] = [`Folder: ${meta.folderAlias}`]
  if (meta.branch?.trim()) facts.push(`Branch: ${meta.branch.trim()}`)
  if (typeof meta.messageCount === 'number' && meta.messageCount > 0) {
    facts.push(`Messages: ${meta.messageCount}`)
  }
  lines.push('', ...facts)

  if (meta.firstPrompt?.trim()) {
    lines.push('', 'First prompt:', meta.firstPrompt.trim())
  }

  const usable = turns.filter((t) => t.text.trim().length > 0)
  if (usable.length > 0) {
    lines.push('', 'Recent conversation:')
    for (const t of usable) {
      lines.push('', `${t.role === 'user' ? 'User' : 'Assistant'}: ${clampTurn(t.text)}`)
    }
  }

  return lines.join('\n')
}
