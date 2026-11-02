/**
 * Campaign ch.6 part 2 (T610, spec §3.6) — the end door's "Also record": writes the memory
 * drafts the operator ticked, and only those. The renderer names drafts by id; the text,
 * page, citations and `supersedes` are read from the mission record the consolidator stored,
 * so a compromised renderer cannot write arbitrary memory. Each draft goes through the SAME
 * `appendMemoryEntry` a `memory_append` call uses (anti-secret lint, per-page serialisation,
 * supersede chain), with the operator as the author.
 */
import type { MemoryDraft } from './consolidator-core'
import { appendMemoryEntry, resolveMemoryLocation } from './mcp/memory-store'

export interface RecordResult {
  /** Draft ids that landed in memory, in the order the record stores them. */
  written: string[]
  /** Drafts the memory write refused, with its `CODE: detail` — the mission still closes. */
  failed: { id: string; error: string }[]
}

/** The ticked ids that name no stored draft (a stale dialog or a forged id), deduped. */
export function unknownDraftIds(
  drafts: readonly MemoryDraft[] | undefined,
  ids: readonly string[]
): string[] {
  const known = new Set((drafts ?? []).map((d) => d.id))
  return [...new Set(ids.filter((id) => !known.has(id)))]
}

/**
 * Write the ticked drafts to the project memory of `root`. Never throws on a refused
 * draft: it lands in `failed` and the rest are still written, because the end door that
 * calls this is irreversible and the draft stays on the closed mission's record.
 */
export async function recordMemoryDrafts(
  root: string,
  drafts: readonly MemoryDraft[] | undefined,
  ids: readonly string[],
  nowMs: number
): Promise<RecordResult> {
  const ticked = new Set(ids)
  const result: RecordResult = { written: [], failed: [] }
  const picked = (drafts ?? []).filter((d) => ticked.has(d.id))
  if (picked.length === 0) return result
  const { memoryDir, branch, mode, checkout } = await resolveMemoryLocation(root)
  for (const d of picked) {
    try {
      const res = await appendMemoryEntry({
        memoryDir,
        page: d.page,
        entry: d.entry,
        author: 'human',
        ...(branch ? { branch } : {}),
        ...(mode === 'central' ? { backlink: { sourcePath: checkout } } : {}),
        mission: d.mission,
        ...(d.watches?.length ? { watches: d.watches } : {}),
        // `hot` replaces the page: there is no entry to supersede.
        ...(d.supersedes && d.page === 'decisions' ? { supersedes: d.supersedes } : {}),
        now: nowMs
      })
      if (res.ok) result.written.push(d.id)
      else result.failed.push({ id: d.id, error: `${res.error}: ${res.detail}` })
    } catch (err) {
      result.failed.push({ id: d.id, error: (err as Error).message })
    }
  }
  return result
}
