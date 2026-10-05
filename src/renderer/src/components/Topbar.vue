<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionsStore } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import { useUiStore } from '../stores/ui'
import { useHelpersStore } from '../stores/helpers'
import { useLayoutStore } from '../stores/layout'
import { useClaudeBootStore } from '../stores/claudeBoot'
import { macWindowControlsInset } from '../lib/platform'
import ActivityBell from './ActivityBell.vue'
import MissionPill from './MissionPill.vue'
import {
  Terminal,
  Folder as FolderIcon,
  FolderOpen,
  FolderTree,
  Code,
  CheckSquare,
  Crown,
  Server,
  GitBranch,
  KanbanSquare,
  GitPullRequest,
  GitPullRequestArrow,
  Plus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen
} from 'lucide-vue-next'

const sessions = useSessionsStore()
const ui = useUiStore()
const helpers = useHelpersStore()
const layout = useLayoutStore()
const boot = useClaudeBootStore()
const { t } = useI18n()
const titleEl = ref<HTMLSpanElement | null>(null)

/**
 * Provenance badge (local-provider-endpoints spec, D6). When the selected
 * session runs against a non-default custom endpoint, show a distinct pill with
 * the endpoint name — no silent quality downgrade. The effective provider is the
 * session's one-shot `bootOverride.provider` (synthetic launches), else the
 * resolved global ⊕ folder provider for its folder. Resolved async on selection.
 */
const providerName = ref<string | null>(null)
watch(
  () => sessions.selectedSession?.sessionId,
  async () => {
    providerName.value = null
    const s = sessions.selectedSession
    if (!s) return
    // Folder terminals run a plain shell — no Claude provider to surface.
    if (s.isShellTerminal) return
    await boot.init()
    let providerId = s.bootOverride?.provider
    if (!providerId) {
      const resolved = await boot.getResolved(s.projectPath)
      providerId = resolved.provider
    }
    // Guard against a stale resolution if the selection changed mid-await.
    if (sessions.selectedSession?.sessionId !== s.sessionId) return
    providerName.value = boot.endpointById(providerId)?.name ?? null
  },
  { immediate: true }
)

/** Orchestrator role pill (T98) — reactive off the store's armed-session mirror. */
const isOrchestrator = computed<boolean>(() => {
  const id = sessions.selectedSession?.sessionId
  return id ? sessions.isSessionOrchestratorOn(id) : false
})

/**
 * One-shot rename-focus channel. The `session.rename` shortcut in App.vue
 * calls `ui.triggerRenameFocus()`, which flips `ui.requestRenameFocus` to
 * `true`. We focus the contenteditable title and immediately reset the flag
 * — the signal is single-shot, not a sticky toggle. See T-4.4 spec + the
 * Pinia ref pattern documented in `stores/ui.ts`.
 */
watch(
  () => ui.requestRenameFocus,
  (focus) => {
    if (!focus) return
    titleEl.value?.focus()
    ui.requestRenameFocus = false
  }
)

// Display title: the shared `sessionTitle` (BUG-78) — the same name the sidebar
// row shows, so the two can never diverge again. Editing in place mutates the
// local `summary` field only (not persisted to the CLI).
/** The selected session is a folder terminal (plain shell, not a Claude run). */
const isTerminal = computed(() => sessions.selectedSession?.isShellTerminal === true)

const displayTitle = computed(() => {
  const s = sessions.selectedSession
  if (!s) return ''
  // Folder terminals have no editable title — show a fixed "Terminal" label.
  if (s.isShellTerminal) return t('topbar.terminal')
  return sessionTitle(s, sessions.allSessions, t)
})

watch(
  displayTitle,
  (n) => {
    if (titleEl.value && titleEl.value.textContent !== n) {
      titleEl.value.textContent = n
    }
  },
  { immediate: true }
)

function commitTitle(e: FocusEvent): void {
  const target = e.target as HTMLElement
  const text = target.textContent?.trim() || ''
  target.style.border = '1px solid transparent'
  target.style.background = 'transparent'
  // Folder terminals carry a fixed label — never persist an edit onto them. An
  // unchanged title is not an edit: committing it would write a placeholder
  // ("New session", "Fork of …") or a fallback into `summary` on a mere blur.
  if (
    sessions.selectedSession &&
    !sessions.selectedSession.isShellTerminal &&
    text &&
    text !== displayTitle.value
  ) {
    sessions.selectedSession.summary = text
  }
}

function onTitleFocus(e: FocusEvent): void {
  const target = e.target as HTMLElement
  target.style.border = '1px solid var(--color-accent-line)'
  target.style.background = 'var(--color-surface-2)'
}

function onTitleEnter(e: MouseEvent): void {
  // A terminal title is read-only — don't hint editability with a hover border.
  if (isTerminal.value) return
  const target = e.target as HTMLElement
  if (document.activeElement !== target) {
    target.style.border = '1px solid var(--color-border)'
  }
}

function onTitleLeave(e: MouseEvent): void {
  const target = e.target as HTMLElement
  if (document.activeElement !== target) {
    target.style.border = '1px solid transparent'
    target.style.background = 'transparent'
  }
}

/**
 * Topbar Split button → spawn a fresh shell pane in the active session's split
 * stack. Clicking acts immediately (no dropdown): the only split action is
 * "new shell", so the menu was redundant. The shell's cwd is the selected
 * session's worktree path. No-op when nothing is selected.
 */
function onSplitClick(): void {
  const wt = sessions.activeFolderPath
  if (!wt) return
  // T212 — with a folder selected there is no session split stack to attach to;
  // `createFolderTerminal` is the folder-level equivalent and already exists.
  if (!sessions.selectedSession) {
    sessions.createFolderTerminal(wt)
    return
  }
  helpers.addShellHelper(wt, wt)
}

/**
 * Topbar "Browse files" (Cluster D/E) → open the in-app project file-tree pane in
 * the active worktree's split stack, confined to that worktree's root. Dedup by
 * root means clicking again focuses the existing pane. No-op when nothing is
 * selected. This is the sole entry to markdown files now: clicking a `.md` row in
 * the pane opens it (Cluster E), and the pane's `+` creates a new one — both
 * replace the retired native OS dialogs (unusable on Linux/Wayland, where the XDG
 * portal ignores defaultPath and opens far from the project).
 */
function onOpenExplorerClick(): void {
  const wt = sessions.activeFolderPath
  if (!wt) return
  helpers.addExplorerHelper(wt, wt)
}

/**
 * The label the per-repo takeovers carry in their header — the folder's alias
 * when the operator set one, else its basename. Same resolution `FolderMenu`
 * uses, so both entry points title the view identically.
 */
function folderLabel(path: string): string {
  const f = sessions.findFolderByPath(path)
  return f?.alias || path.replace(/\/+$/, '').split('/').pop() || path
}

/**
 * Topbar "Roadmap board" / "PR Stack" / "Review" → the three per-repo main-pane
 * takeovers, scoped to the SELECTED session's folder (design.md §6 "Topbar
 * per-repo view buttons"). Same views the folder's context menu opens; this only
 * removes the right-click-the-correct-row detour.
 *
 * These are TOGGLES (`ui.toggle*`, not `ui.open*`): the button that opened the
 * view closes it again, and while it's open the button carries an active state.
 * The context-menu entries stay `open*` — a menu item must open, never close.
 */
function onRoadmapClick(): void {
  const wt = sessions.activeFolderPath
  if (!wt) return
  ui.toggleRoadmap(wt, folderLabel(wt))
}

function onPrStackClick(): void {
  const wt = sessions.activeFolderPath
  if (!wt) return
  ui.togglePrStack(wt, folderLabel(wt))
}

/**
 * T164 / PRD §9 Q3 — the review pane's first affordance outside `Cmd+Shift+D`.
 *
 * No `cardSlug`: the Topbar knows a folder, not which card is bound to it, and
 * the pane is anchored on the branch precisely so it still works with no card
 * (PRD D2). A card-bound review is what the PR Stack card and the board reach.
 */
function onReviewClick(): void {
  const wt = sessions.activeFolderPath
  if (!wt) return
  ui.toggleReview(wt)
}

/**
 * The takeover open for the ACTIVE FOLDER — drives the buttons' active state.
 * T212: resolved from `activeFolderPath`, not from the selected session. With a
 * folder selected there is no session, so keying this off `selectedSession`
 * would leave the button dark while its own board is open right there.
 */
const roadmapActive = computed(
  () => ui.roadmap.open && ui.roadmap.folderPath === sessions.activeFolderPath
)
const prStackActive = computed(
  () => ui.prStack.open && ui.prStack.folderPath === sessions.activeFolderPath
)
const reviewActive = computed(
  () => ui.review.open && ui.review.folderPath === sessions.activeFolderPath
)

/**
 * T212 — the Topbar has three states now: a session, a folder, or nothing. The
 * folder branch carries the same action cluster (every one of those actions only
 * ever needed a folder path) minus the session-only affordances.
 */
const folderOnly = computed(() => !sessions.selectedSession && !!sessions.selectedFolderPath)

const activeFolderLabel = computed(() =>
  sessions.activeFolderPath ? folderLabel(sessions.activeFolderPath) : ''
)

const activeFolderBranch = computed(
  () => sessions.findFolderByPath(sessions.activeFolderPath ?? '')?.gitBranch ?? ''
)

/** T212 — start a session in the selected folder, straight from the Topbar. */
function onNewSessionClick(): void {
  const wt = sessions.activeFolderPath
  if (!wt) return
  ui.openNewSession(wt)
}

/**
 * Topbar "Open folder" → reveal the selected session's worktree in the OS file
 * manager via the main process (`shell.openPath`). No-op when nothing is
 * selected. `openPath` resolves with an error string on failure (never throws).
 */
function onOpenFolderClick(): void {
  const wt = sessions.activeFolderPath
  if (!wt) return
  void window.api.openPath(wt)
}

/**
 * Topbar "Open in VS Code" → spawn `code <cwd>` in the main process. The IPC
 * resolves `{ ok, error? }` and never rejects; on failure (e.g. `code` isn't
 * resolvable anywhere the main process looks) we surface a toast instead of
 * failing silently. No-op when nothing is selected.
 */
async function onOpenInVSCodeClick(): Promise<void> {
  const wt = sessions.activeFolderPath
  if (!wt) return
  const res = await window.api.openInVSCode(wt)
  if (!res.ok) {
    ui.pushToast({
      kind: 'danger',
      title: t('topbar.openInVSCodeFailed'),
      description: res.error ?? ''
    })
  }
}

/**
 * Topbar "Pull requests on GitHub" → the active folder's `origin` as its
 * github.com `/pulls` page, resolved in main (`git remote get-url origin`).
 * `null` — no git, no origin, or an origin that isn't GitHub — hides the
 * button. Re-resolved on every folder switch (cheap, and picks up an origin
 * added since); a stale answer from a previous folder is dropped.
 */
const githubPullsUrl = ref<string | null>(null)
watch(
  () => sessions.activeFolderPath,
  async (wt) => {
    githubPullsUrl.value = null
    if (!wt) return
    const url = await window.api.githubPullsUrl(wt)
    if (sessions.activeFolderPath !== wt) return
    githubPullsUrl.value = url
  },
  { immediate: true }
)

function onGithubPullsClick(): void {
  if (githubPullsUrl.value) void window.api.shellOpenExternal(githubPullsUrl.value)
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    ;(e.target as HTMLElement).blur()
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    if (titleEl.value) titleEl.value.textContent = displayTitle.value
    ;(e.target as HTMLElement).blur()
  }
}
</script>

<template>
  <!-- On macOS, when the sidebar is collapsed this header becomes the leftmost
       element, so its left padding must clear the window controls (traffic
       lights) the `hiddenInset` title bar paints over the corner (design.md §4
       — "macOS window-controls inset"). While the sidebar is open it covers
       that corner and no inset is needed. -->
  <header
    class="flex shrink-0 select-none items-center gap-3 border-b border-border bg-bg"
    style="height: 42px; padding: 0 16px; -webkit-app-region: drag"
    :style="
      layout.sidebarCollapsed && macWindowControlsInset
        ? { paddingLeft: `${16 + macWindowControlsInset}px` }
        : undefined
    "
  >
    <!-- Left sidebar toggle (design.md §6 — Colapsar sidebars). Always visible
         so the collapsed sidebar is always reopenable without the keyboard. The
         icon reflects state: "close" arrow while open, "open" arrow while
         collapsed. `-webkit-app-region: no-drag` — the header above is a native
         drag region (macOS `hiddenInset` title bar has no OS-drawn drag strip of
         its own; the renderer must opt in), so every interactive element inside
         it needs an explicit no-drag override or it becomes unclickable. -->
    <button
      class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
      style="width: 26px; height: 26px; margin-left: -4px; -webkit-app-region: no-drag"
      :title="layout.sidebarCollapsed ? $t('sidebar.show') : $t('sidebar.hide')"
      :aria-label="layout.sidebarCollapsed ? $t('sidebar.show') : $t('sidebar.hide')"
      @click="layout.toggleSidebar()"
    >
      <component
        :is="layout.sidebarCollapsed ? PanelLeftOpen : PanelLeftClose"
        :size="14"
        :stroke-width="1.5"
      />
    </button>

    <!-- No selection at all: placeholder -->
    <template v-if="!sessions.selectedSession && !folderOnly">
      <span class="flex-1 text-text-3" style="font-size: 13px">{{ $t('topbar.noSelection') }}</span>
    </template>

    <!-- T212 — a FOLDER is selected: the same breadcrumb slot, carrying the
         folder's identity. No editable title, no provider/orchestrator pills —
         those describe a session, and there is none. -->
    <template v-else-if="folderOnly">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <FolderIcon :size="12" :stroke-width="1.6" class="shrink-0 text-text-4" />
        <span class="truncate text-text" style="font-size: 13px; font-weight: 500">{{
          activeFolderLabel
        }}</span>
        <span
          v-if="activeFolderBranch"
          class="flex shrink-0 items-center font-mono text-text-4"
          style="gap: 4px; font-size: 11px"
        >
          <GitBranch :size="11" :stroke-width="1.6" />{{ activeFolderBranch }}
        </span>
      </div>
    </template>

    <template v-else>
      <!-- Breadcrumb -->
      <div
        class="flex shrink-0 items-center gap-1.5 text-text-3"
        style="font-size: 11.5px; font-weight: 450"
      >
        <FolderIcon :size="12" :stroke-width="1.6" class="shrink-0 text-text-4" />
        <span class="text-text-3">{{ sessions.selectedPath?.folder }}</span>
        <span class="text-text-4">›</span>
      </div>

      <!-- Editable session title. The wrapping div stays a `flex-1` DRAG region
           (most of its width is empty space, not interactive) — only the
           contenteditable span itself opts out, so a click still places the
           caret instead of starting a window drag. -->
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span
          ref="titleEl"
          class="truncate rounded text-text outline-none transition"
          :class="isTerminal ? 'cursor-default' : 'cursor-text'"
          style="
            font-size: 13px;
            font-weight: 500;
            padding: 2px 5px;
            margin: -2px -5px;
            border: 1px solid transparent;
            -webkit-app-region: no-drag;
          "
          :contenteditable="isTerminal ? 'false' : 'true'"
          spellcheck="false"
          @blur="commitTitle"
          @focus="onTitleFocus"
          @mouseenter="onTitleEnter"
          @mouseleave="onTitleLeave"
          @keydown="onKeydown"
          >{{ displayTitle }}</span
        >
        <!-- Provenance badge — non-default (local/custom) provider -->
        <span
          v-if="providerName"
          class="flex shrink-0 items-center rounded border border-warning text-warning"
          style="gap: 4px; padding: 1px 7px; font-size: 10.5px; font-weight: 500; height: 18px"
          :title="$t('topbar.providerBadgeTitle', { name: providerName })"
        >
          <Server :size="10" :stroke-width="1.8" class="shrink-0" />
          {{ providerName }}
        </span>
        <!-- Orchestrator role pill (T98) -->
        <span
          v-if="isOrchestrator"
          class="flex shrink-0 items-center rounded border border-accent text-accent"
          style="gap: 4px; padding: 1px 7px; font-size: 10.5px; font-weight: 500; height: 18px"
          :title="$t('topbar.orchestratorBadgeTitle')"
        >
          <Crown :size="10" :stroke-width="1.8" class="shrink-0" />
          {{ $t('topbar.orchestratorBadge') }}
        </span>
        <!-- Mission "N of M done" pill (T370, Mission v2) — clickable, opens the progress
             popover; renders nothing when this session owns no open mission. -->
        <MissionPill
          v-if="!isTerminal && sessions.selectedSession"
          :session-id="sessions.selectedSession.sessionId"
        />
      </div>
    </template>

    <!-- Right cluster -->
    <div class="flex shrink-0 items-center gap-0.5" style="-webkit-app-region: no-drag">
      <!-- Activity bell (T152) — global, outside the selected-session guard
           below: reachable with no session selected. design.md — Fleet rail
           reorg §3 "Topbar: … [bell][acts]". -->
      <ActivityBell />
      <!-- T212 — gated on the ACTIVE FOLDER, not on a selected session: every
           action below only ever needed a folder path, so a folder with no
           sessions used to be a dead end here. -->
      <template v-if="sessions.activeFolderPath">
        <!-- Folder branch only: with a session selected, ⌘N and the sidebar `+`
             already cover starting one. -->
        <button
          v-if="folderOnly"
          class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
          style="width: 26px; height: 26px"
          :title="$t('topbar.newSessionHere')"
          :aria-label="$t('topbar.newSessionHere')"
          data-test="topbar-new-session"
          @click="onNewSessionClick"
        >
          <Plus :size="14" :stroke-width="1.5" />
        </button>
        <!-- The two per-repo takeovers, before the external-tool openers: these
             act inside Harnu, the ones after them leave for the OS. -->
        <button
          class="flex items-center justify-center rounded transition"
          :class="
            roadmapActive
              ? 'bg-accent-soft text-accent'
              : 'text-text-3 hover:bg-surface hover:text-text'
          "
          style="width: 26px; height: 26px"
          :title="$t('topbar.roadmapBoard')"
          :aria-label="$t('topbar.roadmapBoard')"
          :aria-pressed="roadmapActive"
          data-test="topbar-roadmap"
          @click="onRoadmapClick"
        >
          <KanbanSquare :size="14" :stroke-width="1.5" />
        </button>
        <button
          class="flex items-center justify-center rounded transition"
          :class="
            prStackActive
              ? 'bg-accent-soft text-accent'
              : 'text-text-3 hover:bg-surface hover:text-text'
          "
          style="width: 26px; height: 26px"
          :title="$t('topbar.prStack')"
          :aria-label="$t('topbar.prStack')"
          :aria-pressed="prStackActive"
          data-test="topbar-pr-stack"
          @click="onPrStackClick"
        >
          <GitPullRequest :size="14" :stroke-width="1.5" />
        </button>
        <!-- `CheckSquare` is the icon `ReviewPane` already wears in its own
             header, so the button and the view it opens agree. -->
        <button
          class="flex items-center justify-center rounded transition"
          :class="
            reviewActive
              ? 'bg-accent-soft text-accent'
              : 'text-text-3 hover:bg-surface hover:text-text'
          "
          style="width: 26px; height: 26px"
          :title="$t('topbar.review')"
          :aria-label="$t('topbar.review')"
          :aria-pressed="reviewActive"
          data-test="topbar-review"
          @click="onReviewClick"
        >
          <CheckSquare :size="14" :stroke-width="1.5" />
        </button>
        <button
          class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
          style="width: 26px; height: 26px"
          :title="$t('topbar.openFolder')"
          :aria-label="$t('topbar.openFolder')"
          data-test="topbar-open-folder"
          @click="onOpenFolderClick"
        >
          <FolderOpen :size="14" :stroke-width="1.5" />
        </button>
        <button
          class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
          style="width: 26px; height: 26px"
          :title="$t('topbar.openInVSCode')"
          :aria-label="$t('topbar.openInVSCode')"
          data-test="topbar-vscode"
          @click="onOpenInVSCodeClick"
        >
          <Code :size="14" :stroke-width="1.5" />
        </button>
        <!-- Only when the folder's `origin` is on github.com — hidden, not
             disabled, otherwise (nothing to open). -->
        <button
          v-if="githubPullsUrl"
          class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
          style="width: 26px; height: 26px"
          :title="$t('topbar.githubPulls')"
          :aria-label="$t('topbar.githubPulls')"
          data-test="topbar-github-pulls"
          @click="onGithubPullsClick"
        >
          <GitPullRequestArrow :size="14" :stroke-width="1.5" />
        </button>
        <button
          class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
          style="width: 26px; height: 26px"
          :title="$t('topbar.openExplorer')"
          :aria-label="$t('topbar.openExplorer')"
          data-test="topbar-explorer"
          @click="onOpenExplorerClick"
        >
          <FolderTree :size="14" :stroke-width="1.5" />
        </button>
        <button
          class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
          style="width: 26px; height: 26px"
          :title="$t('topbar.split')"
          :aria-label="$t('topbar.split')"
          data-test="topbar-split"
          @click="onSplitClick"
        >
          <Terminal :size="14" :stroke-width="1.5" />
        </button>
        <!-- Right helper-panel toggle (design.md §6 — Colapsar sidebars). Only
             shown when the worktree HAS panes (nothing to toggle otherwise); it
             stays visible while collapsed so the panel is always reopenable. -->
        <button
          v-if="helpers.hasHelpersForCurrentWorktree"
          class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface hover:text-text"
          style="width: 26px; height: 26px"
          :title="layout.helperCollapsed ? $t('helperStack.show') : $t('helperStack.hide')"
          :aria-label="layout.helperCollapsed ? $t('helperStack.show') : $t('helperStack.hide')"
          @click="layout.toggleHelper()"
        >
          <component
            :is="layout.helperCollapsed ? PanelRightOpen : PanelRightClose"
            :size="14"
            :stroke-width="1.5"
          />
        </button>
      </template>
    </div>
  </header>
</template>
