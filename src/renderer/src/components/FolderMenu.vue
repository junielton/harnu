<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue'
import {
  Bot,
  ChevronRight,
  Crown,
  Eye,
  EyeOff,
  FolderCog,
  FileCog,
  FolderPlus,
  FolderSearch,
  GitBranch,
  GitFork,
  GraduationCap,
  LayoutList,
  NotebookText,
  KanbanSquare,
  PencilLine,
  Puzzle,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  SquareTerminal,
  Tag,
  Trash2,
  Unlink,
  GitPullRequest
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { useHelpersStore } from '../stores/helpers'
import { useModesStore } from '../stores/modes'

/**
 * Lucide glyph by icon name (T138: the documented subset an extension's
 * `contributes.modes` entry may pick from) — the registry (main) only ever
 * names the icon as a string, the renderer resolves the component. Unknown
 * (or absent) falls back to `GraduationCap`, same as before T138.
 */
const MODE_ICONS: Record<string, typeof EyeOff> = {
  'graduation-cap': GraduationCap,
  bot: Bot,
  sparkles: Sparkles,
  'shield-check': ShieldCheck
}

/**
 * Right-click context menu for sidebar project rows. Mirrors `SessionMenu`'s
 * structure (Teleport to body, viewport edge-clamping, Esc/outside-click/
 * wheel dismissal, arrow-key navigation) but targets a project by absolute
 * path rather than a session by id.
 *
 * The single action toggles between **Hide** and **Unhide** based on
 * whether the target project is currently in the store's
 * `manuallyHiddenPaths`. The store handles the IPC round-trip; this
 * component only orchestrates dismissal + activation. Future actions
 * (Rename, Remove, Show in Finder, …) can extend the `entries` array below.
 *
 * State lives in `ui.folderMenu`. Mounted once at the App level so the
 * Teleport target (`body`) is stable across sidebar re-renders.
 */

const ui = useUiStore()
const sessions = useSessionsStore()
const helpers = useHelpersStore()
const modes = useModesStore()
const { t } = useI18n()

/**
 * Open the folder's project memory (T79 S3) as a Memory pane in the split. It
 * attaches to the currently-selected worktree's stack (so it shows in the visible
 * split immediately) when one is selected; otherwise it attaches to the target
 * folder's own stack and appears the next time a session there is opened. `folder`
 * (the menu target) is what the pane resolves memory for — the repo's shared
 * `.harnu/memory/`.
 */
function onProjectMemory(folderPath: string): void {
  const worktree = sessions.selectedSession?.projectPath || folderPath
  helpers.addMemoryHelper(worktree, folderPath)
}

/**
 * WORKTREE.md creator (T87). Probed when the menu opens so the item reads
 * "Create" (no manifest) vs "Open" (one exists) — the label is cosmetic; the
 * create IPC is idempotent, so acting on a stale "Create" only opens the existing
 * manifest, never clobbers it. `null` = not-yet-probed (default to Create).
 */
const worktreeMdState = ref<{ path: string; exists: boolean; repoRoot: string } | null>(null)

/** Probe the target folder for an existing manifest (drives the item label). */
async function probeWorktreeMd(folderPath: string): Promise<void> {
  worktreeMdState.value = null
  if (!folderPath) return
  try {
    const res = await window.api.worktreeMdProbe(folderPath)
    // Ignore a stale response if the menu re-targeted or closed meanwhile.
    if (menuState.value.projectPath !== folderPath) return
    worktreeMdState.value = { path: res.manifestPath, exists: res.exists, repoRoot: res.repoRoot }
  } catch {
    worktreeMdState.value = null
  }
}

/**
 * Create-or-open the repo's WORKTREE.md and open it in the markdown pane. The
 * create IPC is idempotent (an existing manifest is opened, never overwritten) so
 * this one handler serves both the Create and Open labels. A freshly-written
 * proposal opens in EDIT mode for review; a pre-existing manifest opens in view.
 */
async function onWorktreeMd(folderPath: string): Promise<void> {
  const worktree = sessions.selectedSession?.projectPath || folderPath
  try {
    const res = await window.api.worktreeMdCreate(folderPath)
    if (!res.ok || !res.path) {
      ui.pushToast({
        kind: 'danger',
        title: t('folderMenu.worktreeMdFailed'),
        description: res.error ?? ''
      })
      return
    }
    helpers.addMarkdownHelper(
      worktree,
      res.path,
      worktree,
      res.created ? { initialMode: 'edit' } : undefined
    )
  } catch (e) {
    ui.pushToast({
      kind: 'danger',
      title: t('folderMenu.worktreeMdFailed'),
      description: e instanceof Error ? e.message : String(e)
    })
  }
}

/**
 * Secondary (option C): dispatch a session in the folder whose boot prompt asks an
 * agent to study the repo and PROPOSE a WORKTREE.md. Reuses the T80 card-dispatch
 * engine (`dispatchCardSession`) — a plain, human-initiated synthetic session with
 * the prompt injected once the REPL is ready. The human still reviews + commits.
 */
function onWorktreeMdAgent(folderPath: string): void {
  sessions.dispatchCardSession(folderPath, t('folderMenu.worktreeMdAgentPrompt'))
}

/**
 * T191: sibling worktrees of the target's repo, eligible as a manual
 * `bornFrom` target — probed when the menu opens (mirrors `probeWorktreeMd`).
 * Empty when the target isn't a git folder or has no siblings; drives whether
 * "Set parent folder" appears at all (an empty flyout is worse than no entry).
 */
const bornFromCandidates = ref<Array<{ path: string; alias: string }>>([])

async function probeBornFromCandidates(folderPath: string): Promise<void> {
  bornFromCandidates.value = []
  if (!folderPath) return
  try {
    const list = await sessions.listBornFromCandidates(folderPath)
    // Ignore a stale response if the menu re-targeted or closed meanwhile.
    if (menuState.value.projectPath !== folderPath) return
    bornFromCandidates.value = list
  } catch {
    bornFromCandidates.value = []
  }
}

/** T191: set (or clear, when `bornFrom` is `null`) the target's lineage mother. */
async function onSetParentFolder(folderPath: string, bornFrom: string | null): Promise<void> {
  try {
    await sessions.setFolderBornFrom(folderPath, bornFrom)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    ui.pushToast({
      kind: 'danger',
      title: t('folderMenu.setParentFolderFailed'),
      description: message
    })
  }
}

const menuState = computed(() => ui.folderMenu)

const rootRef = ref<HTMLElement | null>(null)
const focusedIndex = ref(0)
const measuredSize = ref<{ width: number; height: number } | null>(null)

interface MenuItem {
  id: string
  label: string
  icon: typeof EyeOff
  /** Render a 1px divider above this row (groups it into its own block). */
  separatorBefore?: boolean
  /** Destructive action — rendered in `--red` with a red hover (design.md §6). */
  destructive?: boolean
  /** T123: a row with children opens a flyout instead of executing (design.md §6). */
  children?: MenuItem[]
  /**
   * T138: origin badge — a small icon + tooltip rendered after the label.
   * Used to mark an extension-contributed mode so it's never indistinguishable
   * from a builtin one (ADR-0002 §2.2).
   */
  badge?: { icon: typeof EyeOff; title: string }
  /** Absent when the row only opens a flyout (`children`). */
  onSelect?: (projectPath: string) => void | Promise<void>
}

/** Id of the row whose flyout is open (T123). Only one at a time. */
const openFlyout = ref<string | null>(null)
/** Roving-focus index WITHIN the open flyout's children (fix: keyboard trap). */
const flyoutFocusedIndex = ref(0)
/** DOM node of the currently-open flyout, set via the `setFlyoutRef` function ref. */
const flyoutRootRef = ref<HTMLElement | null>(null)
/** Measured flyout size, used by `flyoutMirrored` below (viewport-edge mirroring). */
const flyoutMeasuredSize = ref<{ width: number; height: number } | null>(null)

/** Whether the menu's target project is currently manually hidden. */
const isHidden = computed<boolean>(() => {
  const path = menuState.value.projectPath
  return path ? sessions.manuallyHiddenPaths.has(path) : false
})

/**
 * The folder this menu targets, resolved by absolute path. Additive git
 * metadata (`repoId`/`isMainWorktree`/`gitBranch`) is what gates the
 * "Remove worktree" entry below.
 */
const targetFolder = computed(() => {
  const path = menuState.value.projectPath
  return path ? sessions.findFolderByPath(path) : null
})

/**
 * Whether the target is a **linked** git worktree — i.e. it belongs to a repo
 * (`repoId` set) but does NOT own that repo's common-dir (`isMainWorktree !==
 * true`). Removing a worktree only makes sense for a linked one; the main
 * worktree is the repo itself and is never offered for removal (AC-T32.2).
 */
const isLinkedWorktree = computed<boolean>(() => {
  const f = targetFolder.value
  return !!f && typeof f.repoId === 'string' && f.repoId.length > 0 && f.isMainWorktree !== true
})

/**
 * Whether the target is a git folder at all — i.e. it belongs to a repo
 * (`repoId` set) OR the git probe resolved a branch for it (`gitBranch`
 * non-empty). Gates the non-destructive "New worktree…" entry, which only
 * makes sense inside a git repo (any worktree of it can spawn siblings).
 */
const isGitFolder = computed<boolean>(() => {
  const f = targetFolder.value
  if (!f) return false
  const hasRepoId = typeof f.repoId === 'string' && f.repoId.length > 0
  const hasBranch = typeof f.gitBranch === 'string' && f.gitBranch.length > 0
  return hasRepoId || hasBranch
})

/**
 * T191: the target's currently recorded lineage mother (if any). Gates
 * whether "Clear parent folder" appears — a folder with no mother has nothing
 * to clear.
 */
const currentBornFrom = computed<string | undefined>(() => targetFolder.value?.bornFrom)

/**
 * Whether the menu's target folder is BLOCKED for agents. Agents may act in every
 * folder by default, so this is the exception, not the rule — it mirrors
 * `agentDeniedPaths`, the same source as the Settings → Control server list.
 */
const isAgentDenied = computed<boolean>(() => {
  const path = menuState.value.projectPath
  return path ? sessions.agentDeniedPaths.has(path) : false
})

/** Block (or unblock) agents in the target folder. Non-destructive. */
async function onToggleAgent(folderPath: string): Promise<void> {
  try {
    await sessions.setFolderAgentDenied(folderPath, !sessions.agentDeniedPaths.has(folderPath))
  } catch {
    /* Swallow: the denylist mirror simply won't flip — no destructive state to undo. */
  }
}

/**
 * Whether the menu's target folder is on the Approval Inbox trust ramp (T30).
 * Mirrors `interceptFolders`, the same source as the Settings → responder ramp.
 */
const isInterceptActive = computed<boolean>(() => {
  const path = menuState.value.projectPath
  return path ? sessions.interceptFolders.has(path) : false
})

/** Toggle the `interceptActive` ramp flag for the target folder. Non-destructive. */
async function onToggleIntercept(folderPath: string): Promise<void> {
  try {
    await sessions.setFolderInterceptActive(folderPath, !sessions.interceptFolders.has(folderPath))
  } catch {
    /* Swallow: the ramp mirror simply won't flip — no destructive state to undo. */
  }
}

/**
 * Whether the menu's target folder currently has "auto-organize conversation
 * into draft cards" ON (T106/D6 — default ON, see `autoOrganizeOffPaths`'s
 * own doc comment). Per REPO only — a linked worktree never gets this entry
 * (see `isLinkedWorktree` gating the entries array below); it inherits its
 * main worktree's value server-side.
 */
const isAutoOrganizeOn = computed<boolean>(() => {
  const path = menuState.value.projectPath
  return path ? sessions.isFolderAutoOrganizeOn(path) : true
})

/** Toggle the `autoOrganizeCards` flag for the target folder. Non-destructive. */
async function onToggleAutoOrganize(folderPath: string): Promise<void> {
  try {
    await sessions.setFolderAutoOrganize(folderPath, !isAutoOrganizeOn.value)
  } catch {
    /* Swallow: the mirror simply won't flip — no destructive state to undo. */
  }
}

/**
 * Whether the menu's target folder currently has "new sessions start as
 * Orchestrator" ON (T344 — default OFF, per exact folder, no worktree
 * inheritance — see `orchestratorDefaultPaths`'s own doc comment).
 */
const isOrchestratorDefaultOn = computed<boolean>(() => {
  const path = menuState.value.projectPath
  return path ? sessions.orchestratorDefaultPaths.has(path) : false
})

/** Toggle the `orchestratorDefault` flag for the target folder. Non-destructive. */
async function onToggleOrchestratorDefault(folderPath: string): Promise<void> {
  try {
    await sessions.setFolderOrchestratorDefault(folderPath, !isOrchestratorDefaultOn.value)
  } catch {
    /* Swallow: the mirror simply won't flip — no destructive state to undo. */
  }
}

/**
 * Whether the target folder has the auto-alias opt-in on (T52) — its label falls
 * back to the git branch when the dir-name differs. Mirrors `aliasFromBranchPaths`.
 */
const isAliasFromBranch = computed<boolean>(() => {
  const path = menuState.value.projectPath
  return path ? sessions.aliasFromBranchPaths.has(path) : false
})

/** Toggle the `aliasFromBranch` opt-in for the target folder. Non-destructive. */
async function onToggleAliasFromBranch(folderPath: string): Promise<void> {
  try {
    await sessions.setFolderAliasFromBranch(
      folderPath,
      !sessions.aliasFromBranchPaths.has(folderPath)
    )
  } catch {
    /* Swallow: the mirror simply won't flip — no destructive state to undo. */
  }
}

async function onHide(folderPath: string): Promise<void> {
  try {
    await sessions.dismissFolder(folderPath)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    ui.pushToast({
      kind: 'danger',
      title: t('folderMenu.hideFailed'),
      description: message
    })
  }
}

async function onUnhide(folderPath: string): Promise<void> {
  try {
    await sessions.unhideFolder(folderPath)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    ui.pushToast({
      kind: 'danger',
      title: t('folderMenu.unhideFailed'),
      description: message
    })
  }
}

/** A folder's display label (alias, else basename) — the board header title. */
function folderLabel(path: string): string {
  const f = sessions.findFolderByPath(path)
  return f?.alias || path.replace(/\/+$/, '').split('/').pop() || path
}

const entries = computed<MenuItem[]>(() => [
  {
    id: 'new-terminal',
    label: t('folderMenu.newTerminal'),
    icon: SquareTerminal,
    onSelect: (projectPath: string) => {
      sessions.createFolderTerminal(projectPath)
    }
  },
  // T123: boots a session ALREADY carrying a role's contract (Modes ▸ Learning).
  // Sibling of "New terminal" — both create a session; this one picks WHICH KIND
  // of session is born. T138: the list itself (builtins ∪ extension-contributed
  // modes) comes from `modes:list` via the modes store, not a compile-time import.
  {
    id: 'modes',
    label: t('folderMenu.modes.label'),
    icon: GraduationCap,
    children: modes.modes.map((m) => ({
      id: `mode-${m.id}`,
      label: m.labelKey ? t(m.labelKey) : (m.label ?? m.id),
      icon: MODE_ICONS[m.icon] ?? GraduationCap,
      // T138: origin badge — an extension-contributed mode must never be
      // indistinguishable from a builtin one (ADR-0002 §2.2).
      badge:
        m.origin === 'extension'
          ? { icon: Puzzle, title: t('folderMenu.modes.customBadge', { name: m.extensionLabel }) }
          : undefined,
      onSelect: (projectPath: string) => {
        sessions.createNewSession(projectPath, undefined, m.id)
      }
    }))
  },
  // T52 identity: rename the sidebar label + opt into branch-as-label. Always
  // available (every folder can have an alias), just below New terminal.
  {
    id: 'rename',
    label: t('folderMenu.rename'),
    icon: PencilLine,
    onSelect: (projectPath: string): void => ui.openRenameFolder(projectPath)
  },
  {
    id: 'alias-from-branch',
    label: isAliasFromBranch.value ? t('folderMenu.useFolderName') : t('folderMenu.useBranchName'),
    icon: Tag,
    onSelect: onToggleAliasFromBranch
  },
  {
    id: 'boot',
    label: t('folderMenu.bootOptions'),
    icon: SlidersHorizontal,
    onSelect: (projectPath: string) => ui.openClaudeBoot(projectPath)
  },
  // T79 S3: open this repo's project memory (hot/decisions/timeline) in the split.
  // Always available — every folder has memory (repo-shared, or folder-local when
  // outside a git repo, §3.1).
  {
    id: 'project-memory',
    label: t('folderMenu.projectMemory'),
    icon: NotebookText,
    onSelect: onProjectMemory
  },
  // T89: per-project override for WHERE this repo's memory is stored (in-project
  // vs a central root), with the assisted "move existing memory now" migration.
  // The override lives only in Harnu's config, never in the repo.
  {
    id: 'memory-location',
    label: t('folderMenu.memoryLocation'),
    icon: FolderCog,
    onSelect: (projectPath: string): void => ui.openMemoryLocation(projectPath)
  },
  // T80 S1: open the per-repo Roadmap Kanban board (a wide main-pane view over
  // `.harnu/memory/roadmap/`). Its own block; available for any folder (the memory
  // resolves to the repo's main checkout, or folder-local outside a repo).
  {
    id: 'roadmap',
    label: t('folderMenu.roadmapBoard'),
    icon: KanbanSquare,
    separatorBefore: true,
    onSelect: (projectPath: string): void => ui.openRoadmap(projectPath, folderLabel(projectPath))
  },
  // T198: the PR Stack Canvas — the merge chain of this repo's open PRs. Sits
  // with the board because both are per-repo main-pane views over the same
  // project, read from opposite ends: the board is what we intend to do, the
  // canvas is what is already in flight on GitHub.
  {
    id: 'prStack',
    label: t('folderMenu.prStack'),
    icon: GitPullRequest,
    onSelect: (projectPath: string): void => ui.openPrStack(projectPath, folderLabel(projectPath))
  },
  // T69: create-or-open a subfolder + pin it, replacing the "leave Harnu and run
  // `harnu .`" round-trip. Their own block (separator above), always available
  // (any folder can host subfolders). Both open a non-destructive dialog.
  {
    id: 'new-folder',
    label: t('folderMenu.newFolder'),
    icon: FolderPlus,
    separatorBefore: true,
    onSelect: (projectPath: string): void => ui.openNewFolder(projectPath)
  },
  {
    id: 'open-subfolder',
    label: t('folderMenu.openSubfolder'),
    icon: FolderSearch,
    onSelect: (projectPath: string): void => ui.openOpenSubfolder(projectPath)
  },
  // Non-destructive: only inside a git repo. Its own block (separator above),
  // opens the plan/preview dialog (`NewWorktreeDialog`) — never runs anything
  // itself. See design.md §6 → "New worktree".
  ...(isGitFolder.value
    ? [
        {
          id: 'new-worktree',
          label: t('folderMenu.newWorktree'),
          icon: GitBranch,
          separatorBefore: true,
          onSelect: (projectPath: string): void => ui.openNewWorktree(projectPath)
        } satisfies MenuItem
      ]
    : []),
  // T87: create/open the repo's WORKTREE.md manifest (option B heuristic scaffold),
  // plus the option-C "ask an agent" secondary. Its own block, git-only. The
  // primary label flips Create↔Open on the existence probe; the create IPC is
  // idempotent so it never clobbers an existing manifest.
  ...(isGitFolder.value
    ? [
        {
          id: 'worktree-md',
          label: worktreeMdState.value?.exists
            ? t('folderMenu.openWorktreeMd')
            : t('folderMenu.createWorktreeMd'),
          icon: FileCog,
          separatorBefore: true,
          onSelect: onWorktreeMd
        } satisfies MenuItem,
        {
          id: 'worktree-md-agent',
          label: t('folderMenu.askAgentWorktreeMd'),
          icon: Sparkles,
          onSelect: onWorktreeMdAgent
        } satisfies MenuItem
      ]
    : []),
  // T191: manual override for the `bornFrom` lineage edge — a submenu of
  // sibling worktrees in the same repo (empty candidates ⇒ no entry, never an
  // empty flyout), plus "Clear parent folder" only when one is already set.
  ...(isGitFolder.value && bornFromCandidates.value.length > 0
    ? [
        {
          id: 'set-parent-folder',
          label: t('folderMenu.setParentFolder'),
          icon: GitFork,
          children: bornFromCandidates.value.map((c) => ({
            id: `parent-${c.path}`,
            label: c.alias,
            icon: GitBranch,
            onSelect: (projectPath: string): Promise<void> => onSetParentFolder(projectPath, c.path)
          }))
        } satisfies MenuItem
      ]
    : []),
  ...(isGitFolder.value && currentBornFrom.value
    ? [
        {
          id: 'clear-parent-folder',
          label: t('folderMenu.clearParentFolder'),
          icon: Unlink,
          onSelect: (projectPath: string): Promise<void> => onSetParentFolder(projectPath, null)
        } satisfies MenuItem
      ]
    : []),
  {
    id: 'agent-control',
    label: isAgentDenied.value ? t('folderMenu.unblockAgent') : t('folderMenu.blockAgent'),
    icon: Bot,
    separatorBefore: true,
    onSelect: onToggleAgent
  },
  {
    id: 'intercept',
    label: isInterceptActive.value ? t('folderMenu.stopIntercept') : t('folderMenu.interceptHere'),
    icon: ShieldCheck,
    onSelect: onToggleIntercept
  },
  // T106 (D6): per-repo only — a linked worktree inherits its main worktree's
  // value server-side and never gets this entry (no re-asking per worktree).
  ...(!isLinkedWorktree.value
    ? [
        {
          id: 'auto-organize',
          label: isAutoOrganizeOn.value
            ? t('folderMenu.autoOrganizeOff')
            : t('folderMenu.autoOrganizeOn'),
          icon: LayoutList,
          onSelect: onToggleAutoOrganize
        } satisfies MenuItem
      ]
    : []),
  // T344: per EXACT folder, never inherited — shown for every folder,
  // worktree or not (see `orchestratorDefaultPaths`'s own doc comment).
  {
    id: 'orchestrator-default',
    label: isOrchestratorDefaultOn.value
      ? t('folderMenu.orchestratorDefaultOff')
      : t('folderMenu.orchestratorDefaultOn'),
    icon: Crown,
    onSelect: onToggleOrchestratorDefault
  },
  isHidden.value
    ? {
        id: 'unhide',
        label: t('folderMenu.unhide'),
        icon: Eye,
        onSelect: onUnhide
      }
    : {
        id: 'hide',
        label: t('folderMenu.hide'),
        icon: EyeOff,
        onSelect: onHide
      },
  // Destructive: only for a LINKED worktree (never the main worktree). Its own
  // block, separated above, styled in `--red` (design.md §6 — Item destrutivo).
  ...(isLinkedWorktree.value
    ? [
        {
          id: 'remove-worktree',
          label: t('folderMenu.removeWorktree'),
          icon: Trash2,
          separatorBefore: true,
          destructive: true,
          onSelect: (projectPath: string): void =>
            ui.openRemoveWorktree(projectPath, targetFolder.value?.gitBranch ?? '')
        } satisfies MenuItem
      ]
    : [])
])

/**
 * Computed `left` / `top` re-clamped using the measured menu size once
 * the DOM is laid out. Before measurement, fall back to the store's raw
 * `x` / `y` — the `SidebarFolder.vue` callsite already clamps them via
 * `useFolderContextMenu` against an approximate size.
 */
const clamped = computed<{ left: number; top: number }>(() => {
  const { x, y } = menuState.value
  if (!measuredSize.value) return { left: x, top: y }
  const vw = window.innerWidth
  const vh = window.innerHeight
  const margin = 8
  let left = x
  let top = y
  if (left + measuredSize.value.width > vw - margin) {
    left = Math.max(margin, x - measuredSize.value.width)
  }
  if (top + measuredSize.value.height > vh - margin) {
    top = Math.max(margin, y - measuredSize.value.height)
  }
  return { left, top }
})

async function measureAndClamp(): Promise<void> {
  await nextTick()
  if (!rootRef.value) return
  const rect = rootRef.value.getBoundingClientRect()
  measuredSize.value = { width: rect.width, height: rect.height }
}

/**
 * Whether the open flyout should mirror to the LEFT of the parent row instead of
 * opening to the right (design.md §6: "if it does not fit in the viewport, it mirrors to
 * the left"). Adapts the same measure-then-clamp pattern as `clamped` above: the
 * row that owns a flyout always spans the menu's full width, so the menu's own
 * measured right edge (`rootRef`) doubles as the row's right edge. Before the
 * flyout's real size is measured, default to unmirrored — matches how `clamped`
 * falls back to the raw, unclamped position pre-measurement.
 */
const flyoutMirrored = computed<boolean>(() => {
  if (!flyoutMeasuredSize.value || !rootRef.value) return false
  const margin = 8
  const parentRight = rootRef.value.getBoundingClientRect().right
  return parentRight + 2 + flyoutMeasuredSize.value.width > window.innerWidth - margin
})

/** Function ref for the currently-open flyout's DOM node (only one open at a time). */
function setFlyoutRef(el: Element | ComponentPublicInstance | null): void {
  flyoutRootRef.value = (el as HTMLElement | null) ?? null
}

async function measureFlyout(id: string): Promise<void> {
  await nextTick()
  if (openFlyout.value !== id || !flyoutRootRef.value) return
  const rect = flyoutRootRef.value.getBoundingClientRect()
  flyoutMeasuredSize.value = { width: rect.width, height: rect.height }
}

function onWindowMousedown(e: MouseEvent): void {
  if (!menuState.value.open) return
  if (!rootRef.value) return
  if (rootRef.value.contains(e.target as Node)) return
  ui.closeFolderMenu()
}

function onWindowKeydown(e: KeyboardEvent): void {
  if (!menuState.value.open) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    ui.closeFolderMenu()
    return
  }

  // T123 fix: while a flyout is open, Down/Up/Enter/Left drive ITS children
  // instead of the parent menu's roving focus — the top-level `entries` nav
  // below is paused until the flyout closes (`ArrowLeft`) or a child activates
  // (`Enter`, which also closes the whole menu via `activate`).
  if (openFlyout.value) {
    const openEntry = entries.value.find((it) => it.id === openFlyout.value)
    const children = openEntry?.children ?? []
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (children.length === 0) return
      const dir = e.key === 'ArrowDown' ? 1 : -1
      flyoutFocusedIndex.value =
        (flyoutFocusedIndex.value + dir + children.length) % children.length
      focusFlyoutItem()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const child = children[flyoutFocusedIndex.value]
      const projectPath = menuState.value.projectPath
      if (child && projectPath) activate(child, projectPath)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      closeFlyout()
    }
    return
  }

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    const n = entries.value.length
    if (n === 0) return
    focusedIndex.value = (focusedIndex.value + 1) % n
    focusItem()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    const n = entries.value.length
    if (n === 0) return
    focusedIndex.value = (focusedIndex.value - 1 + n) % n
    focusItem()
  } else if (e.key === 'ArrowRight') {
    const item = entries.value[focusedIndex.value]
    if (item?.children) {
      e.preventDefault()
      openFlyoutForKeyboard(item.id)
    }
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const item = entries.value[focusedIndex.value]
    if (!item) return
    // T123 fix: Enter on a row with `children` used to silently no-op (no
    // `onSelect`) — it must open the flyout, mirroring `ArrowRight`.
    if (item.children) {
      openFlyoutForKeyboard(item.id)
      return
    }
    const projectPath = menuState.value.projectPath
    if (projectPath) activate(item, projectPath)
  }
}

function onWindowWheel(): void {
  if (menuState.value.open) ui.closeFolderMenu()
}

function focusItem(): void {
  if (!rootRef.value) return
  const el = rootRef.value.querySelector<HTMLElement>(`[data-menu-index="${focusedIndex.value}"]`)
  el?.focus()
}

/** Roving-focus counterpart of `focusItem`, scoped to the open flyout's children. */
function focusFlyoutItem(): void {
  if (!flyoutRootRef.value) return
  const el = flyoutRootRef.value.querySelector<HTMLElement>(
    `[data-flyout-index="${flyoutFocusedIndex.value}"]`
  )
  el?.focus()
}

/**
 * Open a row's flyout via the keyboard (`ArrowRight` or `Enter` on a row with
 * `children` — fix: Enter used to silently no-op on such a row) and move DOM
 * focus onto its first child, so the very next keypress already lands inside it.
 */
function openFlyoutForKeyboard(id: string): void {
  openFlyout.value = id
  void nextTick(() => focusFlyoutItem())
}

/** Close the open flyout and return focus to its parent row (`ArrowLeft`). */
function closeFlyout(): void {
  openFlyout.value = null
  focusItem()
}

function activate(item: MenuItem, projectPath: string): void {
  if (!item.onSelect) return
  void item.onSelect(projectPath)
  ui.closeFolderMenu()
}

// Fix (IMPORTANT 3): moving top-level focus away from a row must close its
// flyout — otherwise it's left floating open next to a row that no longer
// has focus. Covers every path that changes `focusedIndex` (ArrowDown/Up,
// menu reopen), not just the ArrowLeft/Enter cases handled inline above.
watch(focusedIndex, () => {
  openFlyout.value = null
})

// Reset the flyout's own roving focus on every open/close, and re-measure its
// size (for `flyoutMirrored`, CRITICAL 2) once it renders.
watch(openFlyout, (id) => {
  flyoutFocusedIndex.value = 0
  if (!id) {
    flyoutMeasuredSize.value = null
    flyoutRootRef.value = null
    return
  }
  void measureFlyout(id)
})

watch(
  () => menuState.value.open,
  async (open) => {
    if (open) {
      focusedIndex.value = 0
      openFlyout.value = null
      measuredSize.value = null
      // T87: probe for an existing WORKTREE.md so the item reads Create vs Open.
      // Git-only; harmless if it resolves after the menu closes (guarded inside).
      const gitPath = menuState.value.projectPath
      if (isGitFolder.value && gitPath) void probeWorktreeMd(gitPath)
      else worktreeMdState.value = null
      // T191: candidate mothers for "Set parent folder" — git-only, same gate.
      if (isGitFolder.value && gitPath) void probeBornFromCandidates(gitPath)
      else bornFromCandidates.value = []
      window.addEventListener('mousedown', onWindowMousedown, true)
      window.addEventListener('keydown', onWindowKeydown, true)
      window.addEventListener('wheel', onWindowWheel, { passive: true })
      await measureAndClamp()
      focusItem()
    } else {
      window.removeEventListener('mousedown', onWindowMousedown, true)
      window.removeEventListener('keydown', onWindowKeydown, true)
      window.removeEventListener('wheel', onWindowWheel)
    }
  }
)

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onWindowMousedown, true)
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('wheel', onWindowWheel)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="menuState.open && menuState.projectPath"
      ref="rootRef"
      class="anim-fade-in-scale fixed border border-border-2 bg-surface"
      style="
        min-width: 180px;
        padding: 4px;
        border-radius: 7px;
        box-shadow: var(--shadow-pop);
        z-index: 50;
        transform-origin: top left;
      "
      :style="{ left: clamped.left + 'px', top: clamped.top + 'px' }"
      role="menu"
      :aria-label="t('folderMenu.label')"
    >
      <template v-for="(entry, idx) in entries" :key="entry.id">
        <div
          v-if="entry.separatorBefore"
          class="border-t border-border"
          style="margin: 4px 0"
          role="separator"
        />
        <div
          v-if="entry.children"
          class="relative"
          @mouseenter="openFlyout = entry.id"
          @mouseleave="openFlyout = null"
        >
          <button
            role="menuitem"
            :aria-haspopup="true"
            :aria-expanded="openFlyout === entry.id"
            tabindex="-1"
            :data-menu-index="idx"
            class="flex w-full items-center text-left text-text-2 transition hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text focus:outline-none"
            style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
          >
            <component :is="entry.icon" :size="13" :stroke-width="1.6" class="shrink-0" />
            <span class="flex-1 truncate">{{ entry.label }}</span>
            <ChevronRight :size="12" :stroke-width="1.6" class="shrink-0 text-text-3" />
          </button>
          <!-- Flyout (design.md §6 — Submenu): mesmo card do menu pai. Mirrors to the
               LEFT when it wouldn't fit at the right viewport edge (`flyoutMirrored`,
               measured the same way the parent menu clamps itself via `clamped`). -->
          <div
            v-if="openFlyout === entry.id"
            :ref="setFlyoutRef"
            class="anim-fade-in absolute top-0 z-10 border border-border bg-surface"
            style="
              min-width: 160px;
              padding: 4px;
              border-radius: var(--radius);
              box-shadow: var(--shadow-pop);
            "
            :style="
              flyoutMirrored
                ? { right: '100%', marginRight: '2px' }
                : { left: '100%', marginLeft: '2px' }
            "
            role="menu"
          >
            <button
              v-for="(child, cidx) in entry.children"
              :key="child.id"
              role="menuitem"
              tabindex="-1"
              :data-flyout-index="cidx"
              class="flex w-full items-center text-left text-text-2 transition hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text focus:outline-none"
              style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px"
              @click="menuState.projectPath && activate(child, menuState.projectPath)"
            >
              <component :is="child.icon" :size="13" :stroke-width="1.6" class="shrink-0" />
              <span class="flex-1 truncate">{{ child.label }}</span>
              <span
                v-if="child.badge"
                class="flex shrink-0 items-center justify-center rounded-full bg-surface"
                style="width: 14px; height: 14px"
                :title="child.badge.title"
                :aria-label="child.badge.title"
              >
                <component :is="child.badge.icon" :size="9" :stroke-width="2" class="text-text-3" />
              </span>
            </button>
          </div>
        </div>
        <button
          v-else
          role="menuitem"
          tabindex="-1"
          :data-menu-index="idx"
          class="flex w-full items-center text-left transition focus:outline-none"
          :class="
            entry.destructive
              ? 'text-red hover:bg-red-soft hover:text-red focus:bg-red-soft focus:text-red'
              : 'text-text-2 hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text'
          "
          style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
          @click="menuState.projectPath && activate(entry, menuState.projectPath)"
        >
          <component :is="entry.icon" :size="13" :stroke-width="1.6" class="shrink-0" />
          <span class="flex-1 truncate">{{ entry.label }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>
