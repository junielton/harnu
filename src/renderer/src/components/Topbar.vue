<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionsStore } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import { useUiStore } from '../stores/ui'
import { useKeybindingsStore } from '../stores/keybindings'
import { useHelpersStore } from '../stores/helpers'
import { useLayoutStore } from '../stores/layout'
import { useSettingsStore } from '../stores/settings'
import { useClaudeBootStore } from '../stores/claudeBoot'
import { useFolderActions } from '../composables/useFolderActions'
import { useEditorButton } from '../composables/useEditorButton'
import EditorIcon from './EditorIcon.vue'
import { macWindowControlsInset } from '../lib/platform'
import ActivityBell from './ActivityBell.vue'
import MissionPill from './MissionPill.vue'
import TopbarOverflowMenu from './TopbarOverflowMenu.vue'
import {
  TOPBAR_BAR_ORDER,
  TOPBAR_BRANCH_MIN_PX,
  TOPBAR_MIN_TITLE_PX,
  clusterBudget,
  planTopbarOverflow,
  type TopbarActionId,
  type TopbarActionView
} from '../lib/topbar-overflow'
import type { ShortcutActionId } from '../../../main/keybindings-core'
import {
  Terminal,
  Globe,
  Folder as FolderIcon,
  FolderOpen,
  FolderTree,
  CheckSquare,
  Crown,
  Server,
  GitBranch,
  KanbanSquare,
  GitPullRequest,
  Github,
  Plus,
  Columns2,
  Rows2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen
} from 'lucide-vue-next'

const sessions = useSessionsStore()
const ui = useUiStore()
const keybindings = useKeybindingsStore()
const helpers = useHelpersStore()
const layout = useLayoutStore()
const settings = useSettingsStore()
const boot = useClaudeBootStore()
const { t } = useI18n()

/** T627: "Split layout: Auto (stacked)" / "Split layout: Side by side" — the title and aria-label of the toggle. */
const splitLayoutLabel = computed(() => {
  const name = (o: 'side-by-side' | 'stacked'): string =>
    t(
      o === 'stacked'
        ? 'settings.appearance.splitLayout.stacked'
        : 'settings.appearance.splitLayout.sideBySide'
    )
  const mode =
    settings.splitLayout === 'auto'
      ? t('topbar.splitLayoutAuto', { layout: name(layout.splitOrientation).toLowerCase() })
      : name(settings.splitLayout)
  return t('topbar.splitLayout', { mode })
})
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
 *
 * `flush: 'post'`: run from the command palette, the palette closes in the
 * same tick and its focus trap restores the previously focused element in a
 * pre-flush watcher. Focusing after that flush keeps the title focused.
 */
watch(
  () => ui.requestRenameFocus,
  (focus) => {
    if (!focus) return
    titleEl.value?.focus()
    ui.requestRenameFocus = false
  },
  { flush: 'post' }
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
 * The per-folder actions behind the right-cluster buttons (Split, Browse files,
 * Roadmap board, PR Stack, Open folder, Open in {editor}). Shared with their
 * keyboard shortcuts in `App.vue` so both routes run the same code.
 */
const folderActions = useFolderActions()
const editorButton = useEditorButton()
const { folderLabel } = folderActions

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

/**
 * BUG-252 — the right cluster as data: one descriptor per action, drawn by the bar and (when it does not
 * fit) by the `…` menu, so the icon, label, chord, state and handler can never differ between the two.
 * Which ones leave, and in what order, is `TOPBAR_OVERFLOW_ORDER` (design.md §6 "Topbar overflow").
 */
const CHORD_OF: Partial<Record<TopbarActionId, ShortcutActionId>> = {
  'new-session': 'session.newInFolder',
  roadmap: 'view.roadmap',
  'pr-stack': 'view.prStack',
  review: 'view.review',
  'open-folder': 'folder.openInFileManager',
  editor: 'folder.openInEditor',
  'github-pulls': 'folder.openGithubPulls',
  explorer: 'folder.browseFiles',
  terminal: 'folder.newTerminal',
  'split-layout': 'layout.cycleSplitOrientation',
  'panel-right': 'view.toggleHelper'
}

/** `data-test` of each bar button (kept as they were; `panel-right` gained one). */
const TEST_ID: Record<TopbarActionId, string> = {
  'new-session': 'topbar-new-session',
  roadmap: 'topbar-roadmap',
  'pr-stack': 'topbar-pr-stack',
  review: 'topbar-review',
  'open-folder': 'topbar-open-folder',
  editor: 'topbar-editor',
  'github-pulls': 'topbar-github-pulls',
  explorer: 'topbar-explorer',
  terminal: 'topbar-split',
  browser: 'topbar-browser',
  'split-layout': 'topbar-split-layout',
  'panel-right': 'topbar-panel-right'
}

const LUCIDE = { size: 14, strokeWidth: 1.5 }

/** Every action that exists right now, in bar order. */
const allActions = computed<TopbarActionView[]>(() => {
  if (!sessions.activeFolderPath) return []
  const view = (
    id: TopbarActionId,
    label: string,
    rest: Pick<TopbarActionView, 'icon' | 'run'> &
      Partial<Pick<TopbarActionView, 'iconProps' | 'state' | 'toggle'>>
  ): TopbarActionView => {
    const chord = CHORD_OF[id]
    return {
      id,
      label,
      title: chord ? keybindings.withChord(label, chord) : label,
      hint: chord ? keybindings.chordLabel(chord) : '',
      iconProps: LUCIDE,
      state: 'idle',
      toggle: false,
      ...rest
    }
  }
  const on = (open: boolean): 'on' | 'idle' => (open ? 'on' : 'idle')
  const list: TopbarActionView[] = []
  if (folderOnly.value) {
    list.push(
      view('new-session', t('topbar.newSessionHere'), { icon: Plus, run: onNewSessionClick })
    )
  }
  list.push(
    view('roadmap', t('topbar.roadmapBoard'), {
      icon: KanbanSquare,
      toggle: true,
      state: on(roadmapActive.value),
      run: () => folderActions.toggleRoadmap()
    }),
    view('pr-stack', t('topbar.prStack'), {
      icon: GitPullRequest,
      toggle: true,
      state: on(prStackActive.value),
      run: () => folderActions.togglePrStack()
    }),
    // `CheckSquare` is the icon `ReviewPane` already wears in its own header, so the button and the
    // view it opens agree.
    view('review', t('topbar.review'), {
      icon: CheckSquare,
      toggle: true,
      state: on(reviewActive.value),
      run: onReviewClick
    }),
    view('open-folder', t('topbar.openFolder'), {
      icon: FolderOpen,
      run: () => folderActions.openInFileManager()
    }),
    view('editor', editorButton.label.value, {
      icon: EditorIcon,
      iconProps: { editorId: editorButton.editorId.value, size: 14 },
      run: () => void folderActions.openInEditor()
    })
  )
  // Only when the folder's `origin` is on github.com — hidden, not disabled, otherwise (nothing to open).
  if (githubPullsUrl.value) {
    list.push(
      view('github-pulls', t('topbar.githubPulls'), { icon: Github, run: onGithubPullsClick })
    )
  }
  list.push(
    view('explorer', t('topbar.openExplorer'), {
      icon: FolderTree,
      run: () => folderActions.browseFiles()
    }),
    view('terminal', t('topbar.split'), { icon: Terminal, run: () => folderActions.newTerminal() }),
    // T630: Browser sits right next to Terminal — one click, the same operator pane the old Split
    // dropdown item opened.
    view('browser', t('topbar.browser'), { icon: Globe, run: () => folderActions.newBrowser() })
  )
  if (helpers.hasHelpersForCurrentWorktree) {
    // T627: split-layout toggle (design.md §6 "Split orientation"). The glyph is the layout in force;
    // accent ink = an explicit choice overrides `auto`.
    list.push(
      view('split-layout', splitLayoutLabel.value, {
        icon: layout.splitOrientation === 'stacked' ? Rows2 : Columns2,
        state: settings.splitLayout === 'auto' ? 'idle' : 'ink',
        run: () => settings.cycleSplitLayout()
      }),
      // Right helper-panel toggle (design.md §6 — Colapsar sidebars): stays visible while collapsed so
      // the panel is always reopenable.
      view('panel-right', layout.helperCollapsed ? t('helperStack.show') : t('helperStack.hide'), {
        icon: layout.helperCollapsed ? PanelRightOpen : PanelRightClose,
        run: () => layout.toggleHelper()
      })
    )
  }
  return list.sort((a, b) => TOPBAR_BAR_ORDER.indexOf(a.id) - TOPBAR_BAR_ORDER.indexOf(b.id))
})

const headerEl = ref<HTMLElement | null>(null)
/** The ids the last plan moved into the `…` menu. Nothing is hidden before the first measure. */
const hiddenIds = ref<TopbarActionId[]>([])
const barActions = computed(() => allActions.value.filter((a) => !hiddenIds.value.includes(a.id)))
const menuActions = computed(() => allActions.value.filter((a) => hiddenIds.value.includes(a.id)))

/** The session view has a breadcrumb before the title; the folder view does not. */
const hasCrumb = computed(() => !!sessions.selectedSession && !folderOnly.value)

/**
 * Measure the header and re-plan. Called from the ResizeObserver and, after the DOM settled, when the
 * actions that exist, the badges after the title or the padding change. It commits only a changed hidden
 * set, so a steady width does no work after the read.
 */
function planOverflow(): void {
  const header = headerEl.value
  // Width 0 = not laid out (hidden, or a test renderer): nothing to measure, so nothing is hidden.
  if (!header || header.clientWidth === 0) return
  const style = getComputedStyle(header)
  let extrasWidth = 0
  header.querySelectorAll<HTMLElement>('[data-topbar-extra]').forEach((el) => {
    // A badge that can shrink reserves only its minimum; a fixed one reserves its width. Both with the
    // `gap-2` before them.
    const min = Number(el.dataset.topbarExtraMin)
    extrasWidth += (min > 0 ? min : el.offsetWidth) + 8
  })
  const available = clusterBudget({
    headerWidth: header.clientWidth,
    paddingX: (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0),
    hasCrumb: hasCrumb.value,
    extrasWidth
  })
  const plan = planTopbarOverflow({
    present: allActions.value.map((a) => a.id),
    available,
    previousHiddenCount: hiddenIds.value.length
  })
  const same =
    plan.hidden.length === hiddenIds.value.length &&
    plan.hidden.every((id, i) => id === hiddenIds.value[i])
  if (!same) hiddenIds.value = plan.hidden
}

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  planOverflow() // before the first paint: no frame with the title over the actions
  if (typeof ResizeObserver !== 'undefined' && headerEl.value) {
    resizeObserver = new ResizeObserver(planOverflow)
    resizeObserver.observe(headerEl.value)
  }
})
onBeforeUnmount(() => resizeObserver?.disconnect())
watch(
  [
    () => allActions.value.map((a) => a.id).join(),
    hasCrumb,
    providerName,
    isOrchestrator,
    activeFolderBranch,
    () => layout.sidebarCollapsed
  ],
  planOverflow,
  { flush: 'post' }
)

function runHidden(id: TopbarActionId): void {
  allActions.value.find((a) => a.id === id)?.run()
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
    ref="headerEl"
    class="flex shrink-0 select-none items-center gap-3 border-b border-border bg-bg"
    data-island="topbar"
    data-island-band
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
      :title="
        keybindings.withChord(
          layout.sidebarCollapsed ? $t('sidebar.show') : $t('sidebar.hide'),
          'view.toggleSidebar'
        )
      "
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
      <!-- No `min-w-0` on this region (BUG-252): it may not shrink below the title's floor plus the
           badges, or the title would poke out over the cluster. -->
      <div class="flex flex-1 items-center gap-2">
        <FolderIcon :size="12" :stroke-width="1.6" class="shrink-0 text-text-4" />
        <span
          class="truncate text-text"
          :style="`font-size: 13px; font-weight: 500; min-width: ${TOPBAR_MIN_TITLE_PX}px`"
          data-test="topbar-title"
          >{{ activeFolderLabel }}</span
        >
        <!-- BUG-252: the branch gives way after the title is at its floor, down to its icon, so a long
             branch name never takes the actions' room (the plan reserves the icon and the gap only). -->
        <span
          v-if="activeFolderBranch"
          data-topbar-extra
          :data-topbar-extra-min="TOPBAR_BRANCH_MIN_PX"
          class="flex min-w-0 shrink items-center font-mono text-text-4"
          style="gap: 4px; font-size: 11px"
        >
          <GitBranch :size="11" :stroke-width="1.6" class="shrink-0" /><span class="truncate">{{
            activeFolderBranch
          }}</span>
        </span>
      </div>
    </template>

    <template v-else>
      <!-- Breadcrumb -->
      <!-- BUG-252: the breadcrumb is the first thing to give way, down to its icon and the `›`. -->
      <div
        class="flex min-w-0 shrink items-center gap-1.5 text-text-3"
        style="font-size: 11.5px; font-weight: 450"
      >
        <FolderIcon :size="12" :stroke-width="1.6" class="shrink-0 text-text-4" />
        <span class="min-w-0 truncate text-text-3">{{ sessions.selectedPath?.folder }}</span>
        <span class="shrink-0 text-text-4">›</span>
      </div>

      <!-- Editable session title. The wrapping div stays a `flex-1` DRAG region
           (most of its width is empty space, not interactive) — only the
           contenteditable span itself opts out, so a click still places the
           caret instead of starting a window drag. -->
      <!-- No `min-w-0` here (BUG-252): this region may not shrink below the title's floor plus the
           badges. The title's `min-width` is its border box (padding and border included). -->
      <div class="flex flex-1 items-center gap-2">
        <span
          ref="titleEl"
          class="truncate rounded text-text outline-none transition"
          :class="isTerminal ? 'cursor-default' : 'cursor-text'"
          :style="`
            font-size: 13px;
            font-weight: 500;
            padding: 2px 5px;
            margin: -2px -5px;
            border: 1px solid transparent;
            box-sizing: border-box;
            min-width: ${TOPBAR_MIN_TITLE_PX}px;
            -webkit-app-region: no-drag;
          `"
          data-test="topbar-title"
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
          data-topbar-extra
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
          data-topbar-extra
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
      <!-- T212 — gated on the ACTIVE FOLDER, not on a selected session: every action below only
           ever needed a folder path, so a folder with no sessions used to be a dead end here.
           BUG-252: the buttons come from `barActions`; what the bar has no room for is in the `…`
           menu at the end of the cluster. The two per-repo takeovers sit before the external-tool
           openers: these act inside Harnu, the ones after them leave for the OS. -->
      <template v-if="sessions.activeFolderPath">
        <button
          v-for="a in barActions"
          :key="a.id"
          class="flex items-center justify-center rounded transition"
          :class="
            a.state === 'on'
              ? 'bg-accent-soft text-accent'
              : a.state === 'ink'
                ? 'text-accent hover:bg-surface'
                : 'text-text-3 hover:bg-surface hover:text-text'
          "
          style="width: 26px; height: 26px"
          :title="a.title"
          :aria-label="a.label"
          :aria-pressed="a.toggle ? a.state === 'on' : undefined"
          :data-test="TEST_ID[a.id]"
          @click="a.run()"
        >
          <component :is="a.icon" v-bind="a.iconProps" />
        </button>
        <TopbarOverflowMenu v-if="menuActions.length" :actions="menuActions" @select="runHidden" />
      </template>
    </div>
  </header>
</template>
