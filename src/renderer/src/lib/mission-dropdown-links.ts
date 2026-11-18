/**
 * Mission dropdown — the "Links" block of an open step (S-4, card BUG-288; design.md §6 "Mission dropdown" →
 * "What it draws" 4). Pure rules, no Vue and no clock: what each link of a step is called, where a click goes,
 * and which links are not drawn at all because they would open nothing.
 *
 * Every link opens something real:
 * - the pull request opens its address (it has no path, so no copy button);
 * - a worktree reads as its BRANCH NAME, resolved from the folders the sidebar already knows (the folder at
 *   that path and its branch; the last path segment when no folder is known). A click selects that folder in
 *   the sidebar, or offers to add it when it is not pinned. A path that no longer exists says so and opens
 *   nothing, but stays readable;
 * - the evidence is ONE "Evidence" link that opens its README in the viewer pane (the file itself when the
 *   path is a file);
 * - an address on this machine, or any other address, opens in the browser as before.
 *
 * A path link (a worktree or the evidence) carries `path`, which only the copy button reads: no label, text or
 * tooltip ever holds an absolute path (`relPath` is repo-relative, for a tooltip). A link that opens nothing
 * (a pull request with no address, a repo path that is not evidence, an evidence folder with no README, a
 * session) is not drawn, and a step with no drawn link has no heading.
 */
import { httpAddress, type StepLinkRow } from './mission-pane-view'

/** What the disk says about a path (`mission:pathKinds`). */
export type PathKind = 'file' | 'dir' | 'missing'

/** The part of a sidebar folder this reads. */
export interface KnownFolder {
  path: string
  /** The branch the folder is on, when git said so. */
  gitBranch?: string | null
  /** The folder is pinned to the sidebar (the operator added it). */
  pinned: boolean
}

/** A link as the record holds it. */
export interface RawLink {
  kind: string
  ref: string
}

/** What a click on a worktree does. */
export type WorktreeAction = 'select' | 'offer-add' | 'none'

export interface DropdownLink {
  key: string
  kind: 'pr' | 'worktree' | 'evidence' | 'page' | 'link'
  /** What is drawn. Never a path; a `page`'s is the bare `host/path` and the renderer words it. */
  label: string
  /** An address to open in the browser (`pr`, `page`, `link`). */
  url?: string
  /** The path the copy button copies (`worktree`, `evidence`). It is never drawn. */
  path?: string
  /** The path relative to the folder the step belongs to, for a tooltip; `null` when it is not under it. */
  relPath?: string | null
  /** `worktree`: what a click does. */
  action?: WorktreeAction
  /** `worktree`: the path no longer exists on disk ("removed — branch kept"). */
  removed?: boolean
  /** `evidence`: the file the viewer opens (the README of a folder, or the file itself). */
  target?: string
}

/** The name of the file an evidence folder opens. */
export const EVIDENCE_README = 'README.md'

/** `/…` or `C:\…`: a path on this machine. Nothing else is ever read as one. */
export function isAbsolutePath(ref: string): boolean {
  return /^\//.test(ref) || /^[A-Za-z]:[\\/]/.test(ref)
}

const trimEnd = (p: string): string => (p.length > 1 ? p.replace(/[\\/]+$/, '') : p)
const lastSegment = (p: string): string => trimEnd(p).split(/[\\/]/).pop() ?? p

/** `path` relative to `root`, or `null` when it is not under it (or either is unknown). */
function relativeTo(path: string, root: string | null): string | null {
  if (!root) return null
  const base = trimEnd(root)
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null
}

/** An evidence ref as an absolute path: itself, or read against `root`; `null` when it cannot be placed. */
function evidencePath(ref: string, root: string | null): string | null {
  const r = ref.trim()
  if (r === '' || httpAddress(r) !== null) return null
  if (isAbsolutePath(r)) return trimEnd(r)
  if (!root || r.split('/').includes('..')) return null
  return `${trimEnd(root)}/${r.replace(/^\.\//, '')}`
}

const worktreePath = (l: RawLink): string | null =>
  l.kind === 'worktree' && isAbsolutePath(l.ref.trim()) ? trimEnd(l.ref.trim()) : null

const evidencePaths = (raw: readonly RawLink[], root: string | null): string[] => [
  ...new Set(
    raw
      .filter((l) => l.kind === 'doc')
      .map((l) => evidencePath(l.ref, root))
      .filter((p): p is string => p !== null)
  )
]

/**
 * The paths to ask the disk about: each worktree, each evidence path and the README an evidence folder may
 * hold. Empty when no link is a path (nothing is asked).
 */
export function pathsToProbe(raw: readonly RawLink[], root: string | null): string[] {
  const out = new Set<string>()
  for (const l of raw) {
    const wt = worktreePath(l)
    if (wt) out.add(wt)
  }
  for (const p of evidencePaths(raw, root)) {
    out.add(p)
    out.add(`${p}/${EVIDENCE_README}`)
  }
  return [...out]
}

/** The ONE file the evidence opens: the first path that is a file, or a folder that holds a README. */
function evidenceLink(
  raw: readonly RawLink[],
  kinds: Readonly<Record<string, PathKind>>,
  root: string | null
): DropdownLink | null {
  for (const p of evidencePaths(raw, root)) {
    const readme = `${p}/${EVIDENCE_README}`
    const target =
      kinds[p] === 'file' ? p : kinds[p] === 'dir' && kinds[readme] === 'file' ? readme : null
    if (target === null) continue
    return {
      key: `evidence:${p}`,
      kind: 'evidence',
      label: 'Evidence',
      path: p,
      relPath: relativeTo(p, root),
      target
    }
  }
  return null
}

/**
 * What an open step's "Links" block draws, in order: the pull request, the worktrees, the evidence, then the
 * addresses. `rows` are the step's links as `stepLinkRows` read them (the pull request's address is looked up
 * there, in the links the session wrote); `raw` are the record's own (the paths are read from them).
 */
export function dropdownLinks(a: {
  rows: readonly StepLinkRow[]
  raw: readonly RawLink[]
  folders: readonly KnownFolder[]
  kinds: Readonly<Record<string, PathKind>>
  /** The folder the step belongs to: it places a repo-relative evidence path and makes a tooltip's path. */
  root: string | null
}): DropdownLink[] {
  const out: DropdownLink[] = []

  for (const r of a.rows) {
    if (r.kind === 'pr' && r.url) out.push({ key: r.key, kind: 'pr', label: r.label, url: r.url })
  }

  const seen = new Set<string>()
  for (const l of a.raw) {
    const path = worktreePath(l)
    if (!path || seen.has(path)) continue
    seen.add(path)
    const folder = a.folders.find((f) => trimEnd(f.path) === path) ?? null
    const removed = a.kinds[path] === 'missing'
    out.push({
      key: `worktree:${path}`,
      kind: 'worktree',
      label: folder?.gitBranch || lastSegment(path),
      path,
      relPath: relativeTo(path, a.root),
      removed,
      action: removed ? 'none' : folder?.pinned ? 'select' : 'offer-add'
    })
  }

  const evidence = evidenceLink(a.raw, a.kinds, a.root)
  if (evidence) out.push(evidence)

  for (const r of a.rows) {
    if (r.kind === 'pr' || r.kind === 'file' || !r.url) continue
    out.push({ key: r.key, kind: r.kind === 'page' ? 'page' : 'link', label: r.label, url: r.url })
  }
  return out
}
