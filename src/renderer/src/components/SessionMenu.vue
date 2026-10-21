<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  Crown,
  Edit3,
  ExternalLink,
  Eye,
  FileText,
  Hash,
  KanbanSquare,
  RotateCcw,
  Smartphone,
  SquareTerminal,
  Trash2,
  X
} from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { useKeybindingsStore } from '../stores/keybindings'
import { useSessionActions, type SessionAction } from '../composables/useSessionActions'
import { DESCRIPTOR_BY_ID, renderKeysString } from '../../../main/keybindings-core'
import { isMac } from '../lib/platform'

/**
 * Session right-click context menu — see `design.md` §3.8 (anatomy) and §6
 * (Context menu) for the visual spec.
 *
 * State source: `ui.menu`. Rendered only when `ui.menu.open === true`.
 * Mounted once at the App level via `<Teleport to="body">` so the menu can
 * float above the sidebar's `overflow: hidden` boundary.
 *
 * Behaviors:
 *  - Esc closes
 *  - outside `mousedown` closes
 *  - any `wheel` event closes (mirrors native macOS context menus)
 *  - arrow keys move focus between items (skipping the separator)
 *  - Enter activates the focused item
 *  - left/top are re-clamped against the menu's *measured* bounding rect
 *    after mount, so the initial coords from `useContextMenu` are an
 *    approximation that becomes exact once the menu is in the DOM
 *
 * The item handlers live in `composables/useSessionActions.ts`, shared with
 * the keyboard bindings. Delete keeps its synchronous `window.confirm`.
 */

const ui = useUiStore()
const sessions = useSessionsStore()
const keybindings = useKeybindingsStore()
// The menu items and their keyboard bindings (App.vue) run the same functions.
const actions = useSessionActions()
const { t } = useI18n()

const menuState = computed(() => ui.menu)

const rootRef = ref<HTMLElement | null>(null)

/**
 * Index in `interactiveItems` of the currently focused row. The separator
 * is excluded — keyboard navigation skips it automatically.
 */
const focusedIndex = ref(0)

/**
 * Measured size of the menu after mount. Used to re-clamp `left` / `top`
 * against the real DOM size (the `useContextMenu` composable only knows an
 * approximation). Updated by `measureAndClamp` after `nextTick`.
 */
const measuredSize = ref<{ width: number; height: number } | null>(null)

interface MenuItem {
  id: string
  kind: 'item'
  label: string
  icon: typeof Edit3
  shortcut?: string
  destructive?: boolean
  onSelect: (sessionId: string) => void
}

/**
 * Toggle item — renders a check on the trailing side when `isOn(sessionId)`
 * returns true, and **does NOT close the menu on click**. The user can flip
 * it on/off in place and then dismiss the menu via Esc, outside click, or
 * picking another item. See `onToggle` for the no-flicker spawn-time caveat.
 */
interface MenuToggle {
  id: string
  kind: 'toggle'
  label: string
  icon: typeof Edit3
  hint?: string
  /**
   * When set, the `hint` renders as a wrapped block beneath the label instead of
   * a single truncated line — used for the Remote Control disclosure, a full
   * trust-model paragraph that must be readable before the user enables it.
   */
  hintWrap?: boolean
  isOn: (sessionId: string) => boolean
  onToggle: (sessionId: string) => void
}

interface MenuSeparator {
  id: string
  kind: 'separator'
}

type MenuEntry = MenuItem | MenuToggle | MenuSeparator

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function onRename(sessionId: string): void {
  // The inline-edit surface is the Topbar title, which always reflects the
  // SELECTED session — so select the target first (if needed), then focus it
  // for editing on the next tick, once the Topbar has rendered the new title.
  // Mirrors the `session.rename` shortcut (App.vue), which edits the
  // already-selected session. Folder terminals render a read-only title, so
  // the Topbar simply won't enter edit mode for them.
  if (sessions.selectedSession?.sessionId === sessionId) {
    ui.triggerRenameFocus()
    return
  }
  sessions.select(sessionId)
  void nextTick(() => ui.triggerRenameFocus())
}

/** A folder's display label (alias, else basename) — the board header title. */
function folderLabel(path: string): string {
  const f = sessions.findFolderByPath(path)
  return f?.alias || path.replace(/\/+$/, '').split('/').pop() || path
}

/**
 * Open the per-repo Roadmap board scoped to the MENU'S TARGET session's own
 * folder — not `sessions.selectedSession`. The whole point of this entry is
 * that it must work from a right-click on a session that isn't the currently
 * active one (T149), so we resolve `target.projectPath` fresh here, same as
 * the shared session actions do.
 */
function onRoadmap(sessionId: string): void {
  const target = sessions.allSessions.find((s) => s.sessionId === sessionId)
  if (!target || !target.projectPath) return
  ui.openRoadmap(target.projectPath, folderLabel(target.projectPath))
}

function isNoFlickerOn(sessionId: string): boolean {
  return sessions.getPrefs(sessionId).noFlicker === true
}

/**
 * Flip Claude Code's own Remote Control (`--remote-control`, the phone bridge)
 * for this session. Enabling marks the session's boot config with the
 * operator-only flag and RESTARTS it (kill + `claude --resume`), exactly the
 * Restart-session mechanism, so it relaunches with the flag — see
 * `setSessionRemoteControl` in the store. The disclosure paragraph
 * (`remoteControl.disclosure`) renders inline as the toggle's wrapped hint so
 * the trust model is visible BEFORE the user enables it: reads (chat + tool
 * results) can be pulled off-device to the phone, but mutations still require
 * the desk confirm overlay (which never reaches the phone → unanswered denies).
 * The restart is non-destructive (the conversation resumes from the JSONL), so
 * we surface the same `restarted` toast as Restart-session — the only otherwise
 * invisible signal that the relaunch took effect.
 */
function onToggleRemoteControl(sessionId: string): void {
  const next = !sessions.isSessionRemoteControlOn(sessionId)
  sessions.setSessionRemoteControl(sessionId, next)
  ui.pushToast({ kind: 'success', title: t('sessionMenu.restarted') })
}

function isRemoteControlOn(sessionId: string): boolean {
  return sessions.isSessionRemoteControlOn(sessionId)
}

/**
 * Promote/demote this session to Orchestrator (T98). Enabling ARMS the
 * Harnu-managed guard (`orchestrator-guard.ts#arm`, T109) for the session's
 * real id + folder and RESTARTS it (kill + `claude --resume`), exactly the
 * Restart-session mechanism, so it relaunches with `docs/harnu-orchestrator.md`
 * prepended to its `--append-system-prompt` — the T55 preamble mechanism,
 * resolved fresh from the guard's armed state at every spawn (`pty.ts`). The
 * disclosure paragraph (`orchestrator.disclosure`) renders inline as the
 * toggle's wrapped hint so the role is visible BEFORE the user promotes.
 * Disabling disarms the guard and restarts again to drop the contract. The
 * restart is non-destructive, so we surface the same `restarted` toast as
 * Restart-session / Remote Control.
 */
function onToggleOrchestrator(sessionId: string): void {
  const next = !sessions.isSessionOrchestratorOn(sessionId)
  void sessions.toggleOrchestrator(sessionId, next)
  ui.pushToast({ kind: 'success', title: t('sessionMenu.restarted') })
}

function isOrchestratorOn(sessionId: string): boolean {
  return sessions.isSessionOrchestratorOn(sessionId)
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * Rename accelerator hint, derived from the one canonical chord table
 * (`keybindings-core.ts`) and rendered for the current platform — `⌘R` on
 * macOS, `Ctrl+R` elsewhere. Reads the RESOLVED table from the keybindings
 * store (T1 P3), so a `keybindings.json` rebind updates it live; `''` when the
 * action is unbound (the hint is then hidden).
 */
const renameAccelerator = computed(() => {
  const rb = keybindings.resolved.byId['session.rename']
  const chord = rb ? rb.keys : DESCRIPTOR_BY_ID['session.rename'].defaultKeys
  return renderKeysString(chord, { mac: isMac }).join(isMac ? '' : '+')
})

/**
 * The items that are keybindable session actions, and the action each runs —
 * their visibility is `sessionActionVisible`, the one rule the bindings share.
 */
const ACTION_OF: Record<string, SessionAction> = {
  'retry-boot': 'retryBoot',
  'dismiss-synthetic': 'dismiss',
  fork: 'fork',
  restart: 'restart',
  'open-in-new-tab': 'openToSide',
  'copy-session-id': 'copyId',
  'copy-transcript-path': 'copyTranscriptPath',
  'copy-resume-command': 'copyResumeCommand',
  'copy-context-digest': 'copyContextDigest',
  'no-flicker': 'toggleNoFlicker',
  archive: 'toggleArchived',
  unarchive: 'toggleArchived',
  delete: 'delete'
}

/**
 * Entries that need the session's transcript on disk but have no keybinding:
 * a synthetic hides them (Remote Control and Orchestrator restart via
 * `claude --resume`; the separators would dangle).
 */
const NEEDS_TRANSCRIPT = new Set(['remote-control', 'orchestrator', 'sep-copy', 'sep-1'])

const entries = computed<MenuEntry[]>(() => {
  const id = menuState.value.sessionId
  if (!id) return []
  const isSynthetic = sessions.allSessions.find((s) => s.sessionId === id)?.synthetic === true
  const item = (
    itemId: string,
    label: string,
    icon: typeof Edit3,
    extra: Partial<MenuItem> = {}
  ): MenuItem => {
    const action = ACTION_OF[itemId]
    return { id: itemId, kind: 'item', label, icon, onSelect: actions.run[action], ...extra }
  }
  const all: MenuEntry[] = [
    // BUG-23/24: a dead synthetic (boot never produced a PTY, or the process
    // exited on its own) gets Retry + Dismiss — the only way out of a dead row.
    item('retry-boot', t('actions.retryBoot'), RotateCcw),
    item('dismiss-synthetic', t('actions.dismiss'), X, { destructive: true }),
    { id: 'sep-boot', kind: 'separator' },
    {
      id: 'rename',
      kind: 'item',
      label: t('actions.rename'),
      icon: Edit3,
      shortcut: renameAccelerator.value || undefined,
      onSelect: onRename
    },
    // No `shortcut` hint until U6 reads the resolved chord for every item.
    item('fork', t('actions.fork'), Copy),
    item('restart', t('actions.restart'), RotateCcw),
    item('open-in-new-tab', t('actions.openInNewTab'), ExternalLink),
    { id: 'sep-copy', kind: 'separator' },
    item('copy-session-id', t('actions.copySessionId'), Hash),
    item('copy-transcript-path', t('actions.copyTranscriptPath'), FileText),
    item('copy-resume-command', t('actions.copyResumeCommand'), SquareTerminal),
    item('copy-context-digest', t('actions.copyContextDigest'), Copy),
    { id: 'sep-roadmap', kind: 'separator' },
    {
      id: 'roadmap',
      kind: 'item',
      label: t('sessionMenu.roadmapBoard'),
      icon: KanbanSquare,
      onSelect: onRoadmap
    },
    {
      id: 'no-flicker',
      kind: 'toggle',
      label: t('actions.noFlicker'),
      icon: Eye,
      hint: t('sessionMenu.noFlickerRestartHint'),
      isOn: isNoFlickerOn,
      onToggle: actions.run.toggleNoFlicker
    },
    {
      id: 'remote-control',
      kind: 'toggle',
      label: t('remoteControl.toggle'),
      icon: Smartphone,
      // Full trust-model disclosure, rendered as a wrapped block so it's
      // readable BEFORE the user enables Remote Control (design.md §6).
      hint: t('remoteControl.disclosure'),
      hintWrap: true,
      isOn: isRemoteControlOn,
      onToggle: onToggleRemoteControl
    },
    {
      id: 'orchestrator',
      kind: 'toggle',
      label: t('sessionMenu.orchestrator'),
      icon: Crown,
      // Role disclosure, rendered as a wrapped block so it's readable BEFORE
      // the user promotes (design.md §6).
      hint: t('orchestrator.disclosure'),
      hintWrap: true,
      isOn: isOrchestratorOn,
      onToggle: onToggleOrchestrator
    },
    { id: 'sep-1', kind: 'separator' },
    sessions.isArchived(id)
      ? item('unarchive', t('actions.unarchive'), ArchiveRestore)
      : item('archive', t('actions.archive'), Archive),
    item('delete', t('actions.delete'), Trash2, { destructive: true })
  ]
  return all.filter((e) => {
    const action = ACTION_OF[e.id]
    if (action) return actions.visible(action, id)
    if (e.id === 'sep-boot') return actions.visible('retryBoot', id)
    if (NEEDS_TRANSCRIPT.has(e.id)) return !isSynthetic
    return true
  })
})

/**
 * Items the keyboard can land on. Both action items and toggles are
 * navigable; only separators are skipped.
 */
const interactiveItems = computed<Array<MenuItem | MenuToggle>>(() =>
  entries.value.filter((e): e is MenuItem | MenuToggle => e.kind === 'item' || e.kind === 'toggle')
)

// ---------------------------------------------------------------------------
// Position clamping
// ---------------------------------------------------------------------------

/**
 * Computed `left` / `top` that re-clamps using the measured menu size once
 * the DOM is laid out. Before measurement, falls back to the store's raw
 * `x` / `y` (which the composable already clamped against an approximate
 * size).
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

// ---------------------------------------------------------------------------
// Window listeners — outside click, Esc, wheel
// ---------------------------------------------------------------------------

function onWindowMousedown(e: MouseEvent): void {
  if (!menuState.value.open) return
  if (!rootRef.value) return
  if (rootRef.value.contains(e.target as Node)) return
  ui.closeMenu()
}

function onWindowKeydown(e: KeyboardEvent): void {
  if (!menuState.value.open) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    ui.closeMenu()
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    const n = interactiveItems.value.length
    if (n === 0) return
    focusedIndex.value = (focusedIndex.value + 1) % n
    focusItem()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    const n = interactiveItems.value.length
    if (n === 0) return
    focusedIndex.value = (focusedIndex.value - 1 + n) % n
    focusItem()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const item = interactiveItems.value[focusedIndex.value]
    const sessionId = menuState.value.sessionId
    if (item && sessionId) activate(item, sessionId)
  }
}

/**
 * Any wheel event dismisses the menu — both inside and outside, matching
 * native macOS context menu behavior (see finding 08 §5 / §10).
 */
function onWindowWheel(): void {
  if (menuState.value.open) ui.closeMenu()
}

function focusItem(): void {
  if (!rootRef.value) return
  const el = rootRef.value.querySelector<HTMLElement>(`[data-menu-index="${focusedIndex.value}"]`)
  el?.focus()
}

/**
 * Activate the focused or clicked entry.
 *
 * Items (`kind: 'item'`) fire their action AND dismiss the menu — the
 * established behavior for Rename/Fork/Archive/Delete/etc.
 *
 * Toggles (`kind: 'toggle'`) flip their state in place and **leave the menu
 * open**, so the user can see the check appear and continue to other items.
 * This mirrors native checkbox-in-menu patterns on macOS/GNOME.
 */
function activate(item: MenuItem | MenuToggle, sessionId: string): void {
  if (item.kind === 'toggle') {
    item.onToggle(sessionId)
    return
  }
  item.onSelect(sessionId)
  ui.closeMenu()
}

watch(
  () => menuState.value.open,
  async (open) => {
    if (open) {
      focusedIndex.value = 0
      measuredSize.value = null
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
      v-if="menuState.open && menuState.sessionId"
      ref="rootRef"
      class="anim-fade-in-scale fixed border border-border-2 bg-surface"
      style="
        min-width: 200px;
        padding: 4px;
        border-radius: 7px;
        box-shadow: var(--shadow-pop);
        z-index: 50;
        transform-origin: top left;
      "
      :style="{ left: clamped.left + 'px', top: clamped.top + 'px' }"
      role="menu"
      :aria-label="t('sessionMenu.label')"
    >
      <template v-for="entry in entries" :key="entry.id">
        <div
          v-if="entry.kind === 'separator'"
          aria-hidden="true"
          style="height: 1px; background: var(--color-border); margin: 4px 2px"
        />
        <button
          v-else-if="entry.kind === 'item'"
          role="menuitem"
          tabindex="-1"
          :data-menu-index="interactiveItems.indexOf(entry)"
          class="flex w-full items-center text-left transition focus:outline-none"
          :class="
            entry.destructive
              ? 'text-red hover:bg-red-soft hover:text-red focus:bg-red-soft focus:text-red'
              : 'text-text-2 hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text'
          "
          style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
          @click="menuState.sessionId && activate(entry, menuState.sessionId)"
        >
          <component :is="entry.icon" :size="13" :stroke-width="1.6" class="shrink-0" />
          <span class="flex-1 truncate">{{ entry.label }}</span>
          <span
            v-if="entry.shortcut"
            class="font-mono text-text-4 tabular-nums"
            style="font-size: 10.5px; letter-spacing: 0.02em"
            >{{ entry.shortcut }}</span
          >
        </button>
        <!--
          Toggle row — `kind === 'toggle'`. Clicking flips the per-session pref
          and intentionally KEEPS THE MENU OPEN (see `activate()` in the
          <script>), so the user can see the check appear in place. The hint
          text spells out that the env var (CLAUDE_CODE_NO_FLICKER) is only
          read by `claude` at spawn time — the running session is unaffected.
        -->
        <button
          v-else
          role="menuitemcheckbox"
          tabindex="-1"
          :aria-checked="menuState.sessionId ? entry.isOn(menuState.sessionId) : false"
          :data-menu-index="interactiveItems.indexOf(entry)"
          class="flex w-full text-left text-text-2 transition hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text focus:outline-none"
          :class="entry.hintWrap ? 'items-start' : 'items-center'"
          style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
          @click="menuState.sessionId && activate(entry, menuState.sessionId)"
        >
          <component
            :is="entry.icon"
            :size="13"
            :stroke-width="1.6"
            class="shrink-0"
            :style="entry.hintWrap ? 'margin-top: 1.5px' : undefined"
          />
          <span class="flex min-w-0 flex-1 flex-col" style="gap: 2px">
            <span class="flex min-w-0 items-baseline" style="gap: 6px">
              <span class="truncate">{{ entry.label }}</span>
              <span
                v-if="entry.hint && !entry.hintWrap"
                class="truncate text-text-3"
                style="font-size: 10.5px"
                >{{ entry.hint }}</span
              >
            </span>
            <!--
              Wrapped disclosure (Remote Control) — full trust-model paragraph,
              visible before the user enables the toggle (design.md §6).
            -->
            <span
              v-if="entry.hint && entry.hintWrap"
              class="text-text-3"
              style="font-size: 10.5px; line-height: 1.45; max-width: 240px"
              >{{ entry.hint }}</span
            >
          </span>
          <Check
            v-if="menuState.sessionId && entry.isOn(menuState.sessionId)"
            :size="13"
            :stroke-width="1.8"
            class="shrink-0 text-accent"
            :style="entry.hintWrap ? 'margin-top: 1.5px' : undefined"
          />
          <span v-else aria-hidden="true" class="shrink-0" style="width: 13px; height: 13px" />
        </button>
      </template>
    </div>
  </Teleport>
</template>
