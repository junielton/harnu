<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Archive, ArchiveRestore, ChevronRight, Recycle } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'
import type { Folder, Session } from '../stores/sessions'
import type { FolderGroup, ShelvedMember } from '../stores/folder-zones'
import { useUiStore } from '../stores/ui'
import { useContextMenu } from '../composables/useContextMenu'
import { sessionTitle } from '../lib/session-label'
import { densityMetrics } from './sidebar-density'

/**
 * The "Shelved" section of a repo group (design.md §6 "Shelved section (repo group)", autonomous
 * cleanup U2.3b): the worktrees Harnu shelved leave the group's main list and wait here, collapsed by
 * default. The folder is gone on purpose, so a row is identified by its branch and clicking one of its
 * sessions restores the worktree first, then resumes (spec C3). Never a folder row, never a ghost.
 */
const props = defineProps<{ group: FolderGroup<Folder> }>()

const sessions = useSessionsStore()
const ui = useUiStore()
const contextMenu = useContextMenu()
const { t } = useI18n()

// The grouping hands the members over as `ShelvedMember<ZoneSession>`; the store built them from real
// sessions, so the title/archived lookups below can use the full `Session`.
const members = computed(() => (props.group.shelved ?? []) as ShelvedMember<Session>[])
const metrics = computed(() => densityMetrics(sessions.sidebarDensity))
const open = computed(() => sessions.shelvedSectionOpen(props.group.key))

/** Worktree rows whose session list is open (local: looking is free and not worth persisting). */
const openRows = ref<ReadonlySet<string>>(new Set())
function toggleRow(id: string): void {
  const next = new Set(openRows.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openRows.value = next
}

const restoringSession = (m: ShelvedMember<Session>): string | null | undefined =>
  sessions.shelvedRestoring.get(m.id)
const isRestoring = (m: ShelvedMember<Session>): boolean => sessions.shelvedRestoring.has(m.id)

function rowTooltip(m: ShelvedMember<Session>): string {
  return m.branch
    ? t('sidebar.shelved.rowTooltip', m.days, { named: { days: m.days, branch: m.branch } })
    : t('sidebar.shelved.rowTooltipDetached', m.days, { named: { days: m.days } })
}

function labelFor(s: Session): string {
  return sessionTitle(s, sessions.allSessions, t) || t('session.unnamed')
}

function onRestore(m: ShelvedMember<Session>): void {
  void sessions.restoreShelvedWorktree(m, null)
}

function onResume(m: ShelvedMember<Session>, s: Session): void {
  if (isRestoring(m)) return
  void sessions.restoreShelvedWorktree(m, s.sessionId)
}

// ── Context menu: a shelved worktree has no folder, so exactly two items ───────────────────────
const menu = ref<{ open: boolean; x: number; y: number; member: ShelvedMember<Session> | null }>({
  open: false,
  x: 0,
  y: 0,
  member: null
})
const menuRef = ref<HTMLElement | null>(null)

function openMenu(e: MouseEvent, m: ShelvedMember<Session>): void {
  e.preventDefault()
  if (isRestoring(m)) return
  const MENU_W = 184
  const MENU_H = 76
  const margin = 8
  const x = Math.min(e.clientX, window.innerWidth - MENU_W - margin)
  const y = Math.min(e.clientY, window.innerHeight - MENU_H - margin)
  menu.value = { open: true, x: Math.max(margin, x), y: Math.max(margin, y), member: m }
  window.addEventListener('mousedown', onDismiss, true)
  window.addEventListener('keydown', onMenuKeydown, true)
  window.addEventListener('wheel', closeMenu, { passive: true })
}

function closeMenu(): void {
  if (!menu.value.open) return
  menu.value = { open: false, x: 0, y: 0, member: null }
  window.removeEventListener('mousedown', onDismiss, true)
  window.removeEventListener('keydown', onMenuKeydown, true)
  window.removeEventListener('wheel', closeMenu)
}

function onDismiss(e: MouseEvent): void {
  if (menuRef.value?.contains(e.target as Node)) return
  closeMenu()
}

function onMenuKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    closeMenu()
  }
}

function menuRestore(): void {
  const m = menu.value.member
  closeMenu()
  if (m) onRestore(m)
}

function menuOpenInCleanup(): void {
  const m = menu.value.member
  closeMenu()
  if (m) ui.openCleanup(m.repoPath)
}

onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onDismiss, true)
  window.removeEventListener('keydown', onMenuKeydown, true)
  window.removeEventListener('wheel', closeMenu)
})
</script>

<template>
  <div v-if="members.length > 0" data-shelved-section :data-group-key="group.key">
    <!-- Disclosure row: folder-row geometry, Eyebrow type. The count is always visible — collapsed it is
         the only clue to what is hidden. -->
    <button
      class="sidebar-row flex w-full cursor-pointer items-center text-left text-text-4 transition hover:bg-surface hover:text-text-3"
      :style="{
        height: `${metrics.folderRowHeight}px`,
        padding: '0 12px 0 28px',
        gap: '4px',
        fontSize: '12.5px',
        marginTop: '2px'
      }"
      :aria-expanded="open"
      :title="t('sidebar.shelved.tooltip', members.length, { named: { n: members.length } })"
      :data-sidebar-row="`shelved:${group.key}`"
      @click="sessions.toggleShelvedSection(group.key)"
    >
      <span class="flex shrink-0 items-center justify-center" style="width: 16px; height: 16px">
        <ChevronRight
          :size="12"
          :stroke-width="1.8"
          class="transition-transform"
          :style="{
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transitionDuration: 'var(--dur)',
            transitionTimingFunction: 'var(--ease)'
          }"
        />
      </span>
      <Archive :size="12" :stroke-width="1.6" class="shrink-0" style="margin-right: 2px" />
      <span class="eyebrow">{{ t('sidebar.shelved.label') }}</span>
      <span class="eyebrow" aria-hidden="true">·</span>
      <span class="tabular-nums" style="font-size: 10.5px">{{ members.length }}</span>
    </button>

    <template v-if="open">
      <div v-for="m in members" :key="m.id" :data-shelved-id="m.id">
        <!-- Worktree row: compact single line (variant B). Content dims, the row does not, so hover and
             the menu target paint a crisp surface. -->
        <div
          class="sidebar-row group relative flex w-full cursor-pointer items-center text-text transition hover:bg-surface"
          :class="menu.open && menu.member?.id === m.id ? 'bg-surface' : ''"
          :style="{
            height: `${metrics.childRowHeight}px`,
            padding: '0 12px 0 28px',
            gap: '4px',
            fontSize: '12.5px'
          }"
          role="button"
          tabindex="0"
          :aria-expanded="openRows.has(m.id)"
          :title="rowTooltip(m)"
          :data-restoring="isRestoring(m) ? 'true' : null"
          @click="toggleRow(m.id)"
          @keydown.enter.prevent="toggleRow(m.id)"
          @keydown.space.prevent="toggleRow(m.id)"
          @contextmenu="(e) => openMenu(e, m)"
        >
          <span
            class="flex min-w-0 flex-1 items-center transition-opacity"
            :style="{
              gap: '4px',
              opacity: isRestoring(m) ? 1 : 0.62,
              transitionDuration: 'var(--dur)',
              transitionTimingFunction: 'var(--ease)'
            }"
          >
            <span
              class="flex shrink-0 items-center justify-center text-text-4"
              style="width: 16px; height: 16px"
            >
              <ChevronRight
                :size="11"
                :stroke-width="1.8"
                class="transition-transform"
                :style="{
                  transform: openRows.has(m.id) ? 'rotate(90deg)' : 'rotate(0deg)',
                  transitionDuration: 'var(--dur)',
                  transitionTimingFunction: 'var(--ease)'
                }"
              />
            </span>
            <ArchiveRestore
              v-if="isRestoring(m)"
              :size="11"
              :stroke-width="1.6"
              class="anim-shimmer-dot shrink-0 text-text-3"
              style="margin-right: 1px"
            />
            <Archive
              v-else
              :size="11"
              :stroke-width="1.6"
              class="shrink-0 text-text-4"
              style="margin: 0 1px"
            />
            <span class="min-w-0 flex-1 truncate font-mono text-text-3" style="font-size: 11px">{{
              m.label
            }}</span>
            <span
              v-if="isRestoring(m)"
              class="anim-shimmer-dot shrink-0 text-text-3 tabular-nums"
              style="font-size: 10.5px"
              >{{ t('sidebar.shelved.restoring') }}</span
            >
            <span v-else class="shrink-0 text-text-4 tabular-nums" style="font-size: 10.5px">{{
              t('sidebar.shelved.daysShort', { days: m.days })
            }}</span>
          </span>
          <!-- Hover-only restore action; its space is reserved so nothing shifts (T118). -->
          <span
            class="flex shrink-0 items-center text-text-4 transition hover:text-accent"
            :class="
              isRestoring(m)
                ? 'pointer-events-none opacity-0'
                : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
            "
            style="margin-left: 5px"
            role="button"
            tabindex="-1"
            :title="t('sidebar.shelved.restore')"
            :aria-label="t('sidebar.shelved.restore')"
            @click.stop="onRestore(m)"
          >
            <ArchiveRestore :size="11" :stroke-width="1.6" />
          </span>
        </div>

        <!-- Sessions of the worktree: ordinary rows, dimmed. Clicking one restores, then resumes. -->
        <template v-if="openRows.has(m.id)">
          <button
            v-for="s in m.sessions"
            :key="s.sessionId"
            data-session-row
            class="sidebar-row relative flex w-full cursor-pointer items-center text-left transition"
            :class="
              restoringSession(m) === s.sessionId ? 'text-text' : 'text-text-2 hover:text-text'
            "
            :data-session-id="s.sessionId"
            :data-sidebar-row="`session:${s.sessionId}`"
            :data-selected="restoringSession(m) === s.sessionId ? 'true' : null"
            :title="t('sidebar.shelved.sessionTooltip')"
            :style="{
              height: `${metrics.sessionRowHeight}px`,
              paddingLeft: `${metrics.sessionIndent.nested}px`,
              paddingRight: '12px',
              gap: `${metrics.gap}px`,
              fontSize: '12.5px',
              fontWeight: restoringSession(m) === s.sessionId ? 500 : 400,
              background:
                restoringSession(m) === s.sessionId ? 'var(--color-accent-soft)' : 'transparent'
            }"
            @click="onResume(m, s)"
            @contextmenu="(e) => contextMenu.open(e, s.sessionId)"
            @mouseenter="
              (e) => {
                if (restoringSession(m) !== s.sessionId)
                  (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.025)'
              }
            "
            @mouseleave="
              (e) => {
                if (restoringSession(m) !== s.sessionId)
                  (e.currentTarget as HTMLElement).style.background = 'transparent'
              }
            "
          >
            <span
              v-if="restoringSession(m) === s.sessionId"
              class="absolute left-0 top-0 bg-accent"
              style="width: 2px; height: 100%; border-radius: 0 2px 2px 0"
              aria-hidden="true"
            />
            <span class="shrink-0" style="width: 12px; height: 12px" aria-hidden="true" />
            <span
              class="flex shrink-0 items-center justify-center"
              style="width: 14px; height: 14px"
              :style="{ opacity: restoringSession(m) === s.sessionId ? 1 : 0.62 }"
            >
              <span
                v-if="restoringSession(m) === s.sessionId"
                class="anim-shimmer-dot shrink-0 rounded-full bg-text-3"
                style="width: 6px; height: 6px"
                :aria-label="t('sidebar.shelved.restoring')"
              />
              <span
                v-else-if="sessions.isArchived(s.sessionId)"
                class="shrink-0 rounded-full border border-text-4"
                style="width: 6px; height: 6px; opacity: 0.55"
                :aria-label="t('session.statusArchived')"
              />
              <span
                v-else
                class="shrink-0 rounded-full bg-text-4"
                style="width: 6px; height: 6px"
                :aria-label="t('session.statusIdle')"
              />
            </span>
            <span
              class="min-w-0 flex-1 truncate"
              :style="{ opacity: restoringSession(m) === s.sessionId ? 1 : 0.62 }"
              >{{ labelFor(s) }}</span
            >
          </button>
        </template>
      </div>
    </template>
  </div>

  <!-- Context menu: Restore worktree / Open in Cleanup (design.md §6 "Context menu"). -->
  <Teleport to="body">
    <div
      v-if="menu.open"
      ref="menuRef"
      class="anim-fade-in-scale fixed border border-border-2 bg-surface"
      style="
        min-width: 184px;
        padding: 4px;
        border-radius: 7px;
        box-shadow: var(--shadow-pop);
        z-index: 50;
        transform-origin: top left;
      "
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      role="menu"
      :aria-label="t('sidebar.shelved.menuLabel')"
    >
      <button
        role="menuitem"
        class="flex w-full items-center text-left text-text-2 transition hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text focus:outline-none"
        style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
        @click="menuRestore"
      >
        <ArchiveRestore :size="13" :stroke-width="1.6" class="shrink-0" />
        <span class="flex-1 truncate">{{ t('sidebar.shelved.restore') }}</span>
      </button>
      <button
        role="menuitem"
        class="flex w-full items-center text-left text-text-2 transition hover:bg-surface-2 hover:text-text focus:bg-surface-2 focus:text-text focus:outline-none"
        style="gap: 9px; padding: 6px 8px; font-size: 12px; border-radius: 4px; outline: none"
        @click="menuOpenInCleanup"
      >
        <Recycle :size="13" :stroke-width="1.6" class="shrink-0" />
        <span class="flex-1 truncate">{{ t('sidebar.shelved.openInCleanup') }}</span>
      </button>
    </div>
  </Teleport>
</template>
