import { computed, type ComputedRef, type Ref } from 'vue'
import Fuse from 'fuse.js'
import { useSessionsStore, type Folder, type Session } from '../stores/sessions'
import { isFolderGroup, type FolderGroup } from '../stores/folder-zones'
import { i18n } from '../i18n'
import { sessionTitle } from '../lib/session-label'

/**
 * Shared fuzzy matching for both palettes (T288).
 *
 * `CommandPalette.vue` owned the only fuse.js wiring in the renderer; the
 * sidebar jump palette needs the same matcher over a wider record (a folder's
 * path and branch, a session's first prompt). Rather than stand up a second,
 * subtly-different Fuse configuration, the threshold, the search call and the
 * highlight splitter live here and BOTH palettes drive off them.
 *
 * Renderer-side only — pure data in, pure data out, no IPC.
 */

/**
 * Fuse's leniency. `0.4` is the value `CommandPalette.vue` shipped with
 * (design.md §6 — Command palette): lenient enough to survive a transposed
 * letter, strict enough that a three-character query doesn't return the world.
 */
export const JUMP_SEARCH_THRESHOLD = 0.4

/**
 * Fuzzy-filter `items` by `query` over `keys`, preserving Fuse's relevance
 * order. An empty query returns the input untouched (the caller decides
 * whether "everything" or "nothing" is the right empty-query answer).
 *
 * One-shot: it builds a Fuse index per call. Fine for a fixed, small collection
 * or a single search; a live palette typing over a user-data-sized collection
 * must use {@link useFuzzyMatcher} instead, or every keystroke re-indexes the
 * whole list.
 */
export function fuzzySearch<T>(
  items: readonly T[],
  query: string,
  keys: string[] = ['label']
): T[] {
  const q = query.trim()
  if (q.length === 0) return [...items]
  const fuse = new Fuse(items as T[], { keys, threshold: JUMP_SEARCH_THRESHOLD })
  return fuse.search(q).map((r) => r.item)
}

/**
 * The memoized form of {@link fuzzySearch}, for a palette that searches as the
 * operator types. `new Fuse(...)` builds its whole index eagerly in the
 * constructor, so the index is cached in a `computed` over the COLLECTION and
 * rebuilt only when that collection changes — never per keystroke. A single
 * install can hold thousands of sessions (see the bounded-fan-out lesson on
 * `~/.claude/projects/`), so this is the difference between one index build and
 * one per character typed.
 *
 * Call it from a component/composable `setup` — it owns a `computed`.
 */
export function useFuzzyMatcher<T>(
  items: () => readonly T[],
  keys: string[] = ['label']
): (query: string) => T[] {
  const index = computed(() => new Fuse(items() as T[], { keys, threshold: JUMP_SEARCH_THRESHOLD }))
  return (query: string): T[] => {
    const q = query.trim()
    if (q.length === 0) return [...items()]
    return index.value.search(q).map((r) => r.item)
  }
}

/** One run of a label, flagged as a query match or not. See {@link matchSegments}. */
export interface MatchSegment {
  text: string
  match: boolean
}

/**
 * Split `label` around the first case-insensitive occurrence of `query`, so a
 * row can bold exactly the substring the operator typed (spec: `<b>www</b> ·
 * org-a`).
 *
 * Deliberately substring-only: a fuzzy hit whose characters are scattered
 * across the label yields ONE unmatched segment rather than a confetti of bold
 * letters. Fuse decides what matches; this only decides what to embolden.
 */
export function matchSegments(label: string, query: string): MatchSegment[] {
  const q = query.trim()
  if (q.length === 0) return [{ text: label, match: false }]
  const at = label.toLowerCase().indexOf(q.toLowerCase())
  if (at === -1) return [{ text: label, match: false }]
  const out: MatchSegment[] = []
  if (at > 0) out.push({ text: label.slice(0, at), match: false })
  out.push({ text: label.slice(at, at + q.length), match: true })
  if (at + q.length < label.length) out.push({ text: label.slice(at + q.length), match: false })
  return out
}

/** The three result groups, in the order the spec renders them. */
export type JumpGroupKind = 'folders' | 'hidden' | 'sessions'

/** A jump target: a folder (visible or hidden) or a session. */
export interface JumpResult {
  /** Stable id — `folder:<path>` / `hidden:<path>` / `session:<id>`. */
  id: string
  group: JumpGroupKind
  /** The row's label — also the string the match is emboldened in. */
  label: string
  /** Dim trailing hint: the owning repo label, or a repo group's path. */
  hint: string
  /** Render `hint` in the mono face (a filesystem path, not a label). */
  hintMono: boolean
  /** Folder rows: `true` when the folder is a repo group's main worktree. */
  isRepoGroup: boolean
  /** Folder path for folder/hidden rows; the owning folder's path for a session. */
  path: string
  /** Session rows only. */
  sessionId?: string
  /** Session rows only — drives the status dot. */
  session?: Session
}

/** One rendered section: an eyebrow, its count, and its rows. */
export interface JumpGroup {
  kind: JumpGroupKind
  results: JumpResult[]
}

/** The searchable projection of a folder — every field AC-4 requires. */
interface FolderRecord {
  folder: Folder
  label: string
  branch: string
  path: string
}

/** The searchable projection of a session. */
interface SessionRecord {
  session: Session
  folder: Folder
  label: string
  firstPrompt: string
}

/**
 * A session's display label: the shared session name (BUG-78 — the same one
 * the sidebar row shows), else its id.
 */
export function sessionJumpLabel(s: Session, all: readonly Session[]): string {
  return sessionTitle(s, all, i18n.global.t) || s.sessionId
}

/**
 * Resolve the repo-group label a folder renders under, so a result row can say
 * WHERE the target lives ("PROJ-347-wave-2 · under www · org-a"). Returns an
 * empty string for a standalone folder — the spec omits the hint entirely
 * rather than inventing one.
 */
function groupLabelFor(
  folder: Folder,
  groups: ReadonlyArray<FolderGroup<Folder>>
): { label: string; isMain: boolean } {
  for (const g of groups) {
    if (!g.folders.some((f) => f.path === folder.path)) continue
    const label = g.parentHint ? `${g.label} · ${g.parentHint}` : g.label
    // The group's MAIN worktree is the one whose alias names the group — that
    // row represents the repo itself, so it gets `git-branch` + a mono path.
    return { label, isMain: folder.isMainWorktree === true }
  }
  return { label: '', isMain: false }
}

/**
 * The sidebar jump palette's search (T288). Results are TARGETS, never a
 * filter: nothing here touches `filterQuery`, so the tree behind the palette
 * stays exactly where the operator left it.
 *
 * Coverage (AC-4): folder alias, git branch and PATH; session summary and first
 * prompt. Dismissed folders are searched too and land in their own "Hidden"
 * group — the whole point being that a hidden folder is findable without first
 * remembering it is hidden.
 */
export function useJumpSearch(query: Ref<string>): {
  groups: ComputedRef<JumpGroup[]>
  results: ComputedRef<JumpResult[]>
} {
  const sessions = useSessionsStore()

  /** Repo groups currently rendering, for hint resolution. */
  const repoGroups = computed<Array<FolderGroup<Folder>>>(() =>
    sessions.visibleFolders.filter((n): n is FolderGroup<Folder> => isFolderGroup(n))
  )

  const hiddenPaths = computed(() => new Set(sessions.dismissedFolders.map((f) => f.path)))

  function toFolderRecord(f: Folder): FolderRecord {
    return { folder: f, label: f.alias, branch: f.gitBranch ?? '', path: f.path }
  }

  const visibleRecords = computed<FolderRecord[]>(() =>
    sessions.folders.filter((f) => !hiddenPaths.value.has(f.path)).map(toFolderRecord)
  )

  const hiddenRecords = computed<FolderRecord[]>(() =>
    sessions.dismissedFolders.map(toFolderRecord)
  )

  const sessionRecords = computed<SessionRecord[]>(() => {
    const out: SessionRecord[] = []
    for (const f of sessions.folders) {
      // A dismissed folder is searched as a FOLDER (that is the Hidden group's
      // whole point) but its SESSIONS are not offered: the folder is classified
      // `hidden` and never renders in the tree, and nothing in the session-jump
      // path unhides it — `select()` carries the reveal contract, not an
      // unhide. Offering one would be the same dead target the archived guard
      // below rejects. Unhide the folder from the Hidden group first (one
      // keystroke, right there) and its sessions become jumpable.
      if (hiddenPaths.value.has(f.path)) continue
      for (const s of f.sessions) {
        if (s.isSidechain) continue
        // Archived is the second "don't show this" axis (the first is
        // `isSidechain`), and the tree honours it: `sessionsForDisplay` renders
        // an archived session only while its folder's archived peek is open,
        // and selecting one does NOT open that peek. Offering it as a jump
        // target would land the operator on a row that never appears —
        // no scroll, no flash. Hidden FOLDERS are different: they get their own
        // group and an explicit "Unhide & go".
        if (sessions.archivedIds.has(s.sessionId)) continue
        out.push({
          session: s,
          folder: f,
          label: sessionJumpLabel(s, sessions.allSessions),
          firstPrompt: s.firstPrompt ?? ''
        })
      }
    }
    return out
  })

  function folderResult(r: FolderRecord, group: JumpGroupKind): JumpResult {
    const { label: groupLabel, isMain } = groupLabelFor(r.folder, repoGroups.value)
    return {
      id: `${group === 'hidden' ? 'hidden' : 'folder'}:${r.folder.path}`,
      group,
      label: r.folder.alias,
      // A repo group's main worktree carries its own path (there is no parent
      // repo to point at); every other folder points at the repo it belongs to.
      hint: isMain ? r.folder.path : groupLabel,
      hintMono: isMain,
      isRepoGroup: isMain,
      path: r.folder.path
    }
  }

  // Memoized matchers — one index per collection, rebuilt only when that
  // collection changes. Building them per keystroke would re-index every folder
  // and every session on every character typed.
  const FOLDER_KEYS = ['label', 'branch', 'path']
  const matchVisible = useFuzzyMatcher(() => visibleRecords.value, FOLDER_KEYS)
  const matchHidden = useFuzzyMatcher(() => hiddenRecords.value, FOLDER_KEYS)
  const matchSessions = useFuzzyMatcher(() => sessionRecords.value, ['label', 'firstPrompt'])

  const groups = computed<JumpGroup[]>(() => {
    const q = query.value.trim()
    if (q.length === 0) return []

    const folders = matchVisible(q).map((r) => folderResult(r, 'folders'))
    const hidden = matchHidden(q).map((r) => folderResult(r, 'hidden'))
    const sessionHits = matchSessions(q).map<JumpResult>((r) => {
      // The hint names WHERE the session lives, at the finest grain that adds
      // information: the worktree's own label normally, and the repo-group
      // label only for a session in the group's MAIN worktree — there the
      // folder alias and the group label are the same word anyway, so the
      // group's disambiguating parent hint is the useful half.
      const { label: groupLabel, isMain } = groupLabelFor(r.folder, repoGroups.value)
      return {
        id: `session:${r.session.sessionId}`,
        group: 'sessions',
        label: r.label,
        hint: isMain && groupLabel ? groupLabel : r.folder.alias,
        hintMono: false,
        isRepoGroup: false,
        path: r.folder.path,
        sessionId: r.session.sessionId,
        session: r.session
      }
    })

    const out: JumpGroup[] = []
    if (folders.length > 0) out.push({ kind: 'folders', results: folders })
    if (hidden.length > 0) out.push({ kind: 'hidden', results: hidden })
    if (sessionHits.length > 0) out.push({ kind: 'sessions', results: sessionHits })
    return out
  })

  /** The flat cursor list — arrow keys cross group borders without noticing them. */
  const results = computed<JumpResult[]>(() => groups.value.flatMap((g) => g.results))

  return { groups, results }
}
