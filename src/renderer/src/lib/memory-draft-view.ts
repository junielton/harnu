/**
 * Campaign ch.6 (T610) — how the end dialog's "Also record" panel shows a stored memory
 * draft: its heading, an excerpt of the rest, and its citations. Pure; the draft text is
 * the consolidator's, shown as written.
 */
import type { Citation, MemoryDraft } from '../../../main/consolidator-core'

/** A markdown line without its heading marks, list bullet or bold wrapper. */
function plain(line: string): string {
  return line
    .replace(/^\s*(#{1,6}\s+|[-*]\s+)/, '')
    .replace(/^\*\*(.+)\*\*:?\s*/, '$1 ')
    .trim()
}

/** The first non-empty line of the entry, as a title. */
export function draftHeading(draft: Pick<MemoryDraft, 'entry'>): string {
  const first = draft.entry.split('\n').find((l) => l.trim())
  return first ? plain(first) : ''
}

/** Everything after the heading line, joined into one paragraph; `''` when there is none. */
export function draftExcerpt(draft: Pick<MemoryDraft, 'entry'>): string {
  const lines = draft.entry.split('\n')
  const at = lines.findIndex((l) => l.trim())
  return lines
    .slice(at + 1)
    .map(plain)
    .filter(Boolean)
    .join(' ')
}

/** `stp-3`, `#175`, `a0fd969f` — the ref a citation carries, in the order the draft lists them. */
export function citationRefs(draft: Pick<MemoryDraft, 'cites'>): string[] {
  return draft.cites.map((c: Citation) => c.ref)
}
