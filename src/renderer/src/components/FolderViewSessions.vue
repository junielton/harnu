<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from 'lucide-vue-next'
import type { Folder, Session } from '../stores/sessions'
import { useSessionsStore } from '../stores/sessions'
import { useUiStore } from '../stores/ui'
import { sessionTitle } from '../lib/session-label'
import { relativeTime } from '../composables/useRelativeTime'
import ScopeTag from './ui/ScopeTag.vue'
import { dotFor } from './session-dot'
import { activityBucket, bucketSessions, scopeOf, type ActivityBucket } from './folder-view-format'

/**
 * T212 — the Folder View's session spine: the working set, plus the two
 * disclosure sections ("Older", "Archived") that until now were only reachable
 * from the hover-gated peek icons on the sidebar row. Clicking a row is the same
 * `sessions.select` the sidebar makes, so the two entry points can never drift.
 *
 * T285 — the only Folder View block that is genuinely about the folder you
 * clicked, and the reason the scope tags are worth having: everything beside it
 * in the rail is repo-wide.
 */

const props = defineProps<{ folder: Folder }>()

const sessions = useSessionsStore()
const ui = useUiStore()
const { t } = useI18n()

const buckets = computed(() =>
  bucketSessions(props.folder.sessions, (id) => sessions.isArchived(id))
)

const olderOpen = ref(false)
const archivedOpen = ref(false)

function title(s: Session): string {
  return sessionTitle(s, sessions.allSessions, t) || s.sessionId
}

/**
 * T285 — the same status the sidebar row paints, resolved the same way: archive
 * is the explicit user state that overrides everything, then the canonical
 * `dotFor` over `activityOf` (which reads `nowTick`, so a row ages into `stuck`
 * on the clock tick). Copying `SidebarFolder`'s `statusDot` recipe rather than
 * inventing a second one is the point — a session must not read `working` in the
 * sidebar and `idle` here. `activityBucket` then folds the seven dots onto the
 * three this view distinguishes, sharing that fold with `countActivity`.
 */
function statusOf(s: Session): ActivityBucket {
  const dot = sessions.isArchived(s.sessionId)
    ? 'archived'
    : dotFor(s.taskState, s.status, sessions.activityOf(s, sessions.nowTick), s.transcriptState)
  return activityBucket(dot)
}

/** design.md §6 — the sidebar's own dot colours, per bucket. No raw hex. */
const DOT_CLASS: Record<ActivityBucket, string> = {
  working: 'anim-pulse-dot bg-green',
  'needs-input': 'anim-attention-dot bg-warning',
  idle: 'bg-text-4'
}

/** Reuses the status labels the sidebar already ships — no new i18n keys. */
const DOT_LABEL: Record<ActivityBucket, string> = {
  working: 'session.statusActive',
  'needs-input': 'session.statusNeedsInput',
  idle: 'session.statusIdle'
}

function onNewSession(): void {
  ui.openNewSession(props.folder.path)
}
</script>

<template>
  <section data-test="folder-view-sessions-section">
    <div class="flex items-center justify-between" style="gap: 8px; margin-bottom: 8px">
      <span class="eyebrow text-text-4">
        {{ $t('folderView.sessions') }}
        <span class="tabular-nums">({{ buckets.current.length }})</span>
      </span>
      <ScopeTag :scope="scopeOf('sessions')" />
    </div>

    <!-- Empty state: the folder's whole point is that this is where you start. -->
    <div
      v-if="buckets.current.length === 0"
      class="flex flex-col items-start border border-border bg-surface"
      style="gap: 10px; border-radius: var(--radius); padding: 16px"
    >
      <span class="text-text-3" style="font-size: 12.5px">{{ $t('folderView.noSessions') }}</span>
      <button
        class="cursor-pointer bg-accent text-accent-ink transition hover:opacity-90"
        style="
          border-radius: var(--radius-sm);
          padding: 6px 12px;
          font-size: 12px;
          font-weight: 500;
        "
        data-test="folder-view-empty-cta"
        @click="onNewSession"
      >
        {{ $t('folderView.newSession') }}
      </button>
    </div>

    <div v-else class="flex flex-col" style="gap: 2px">
      <button
        v-for="s in buckets.current"
        :key="s.sessionId"
        class="flex w-full cursor-pointer items-center text-left text-text-2 transition hover:bg-surface hover:text-text"
        style="gap: 10px; border-radius: var(--radius-sm); padding: 7px 10px; font-size: 12.5px"
        data-test="folder-view-session"
        @click="sessions.select(s.sessionId)"
      >
        <span
          class="shrink-0 rounded-full"
          :class="DOT_CLASS[statusOf(s)]"
          style="width: 6px; height: 6px"
          :aria-label="$t(DOT_LABEL[statusOf(s)])"
        />
        <span class="min-w-0 flex-1 truncate">{{ title(s) }}</span>
        <span
          v-if="s.messageCount > 0"
          class="tabular-nums shrink-0 text-text-4"
          style="font-size: 11px"
          :aria-label="$t('preview.messages', { count: s.messageCount })"
          data-test="folder-view-session-msgs"
          >{{ s.messageCount }}</span
        >
        <span class="tabular-nums shrink-0 text-text-4" style="font-size: 11px">{{
          relativeTime(s.modified)
        }}</span>
      </button>
    </div>

    <!-- Older / Archived: counts always visible, rows on demand. -->
    <div class="flex items-center" style="gap: 16px; margin-top: 12px">
      <button
        v-if="buckets.older.length > 0"
        class="flex cursor-pointer items-center text-text-4 transition hover:text-text-2"
        style="gap: 4px; font-size: 11px"
        data-test="folder-view-older-toggle"
        @click="olderOpen = !olderOpen"
      >
        <ChevronRight
          :size="11"
          :stroke-width="1.8"
          class="transition-transform"
          :style="{ transform: olderOpen ? 'rotate(90deg)' : 'rotate(0deg)' }"
        />
        {{ $t('folderView.older', { n: buckets.older.length }) }}
      </button>
      <button
        v-if="buckets.archived.length > 0"
        class="flex cursor-pointer items-center text-text-4 transition hover:text-text-2"
        style="gap: 4px; font-size: 11px"
        data-test="folder-view-archived-toggle"
        @click="archivedOpen = !archivedOpen"
      >
        <ChevronRight
          :size="11"
          :stroke-width="1.8"
          class="transition-transform"
          :style="{ transform: archivedOpen ? 'rotate(90deg)' : 'rotate(0deg)' }"
        />
        {{ $t('folderView.archived', { n: buckets.archived.length }) }}
      </button>
    </div>

    <div v-if="olderOpen" class="flex flex-col" style="gap: 2px; margin-top: 6px">
      <button
        v-for="s in buckets.older"
        :key="s.sessionId"
        class="flex w-full cursor-pointer items-center text-left text-text-3 transition hover:bg-surface hover:text-text"
        style="gap: 10px; border-radius: var(--radius-sm); padding: 6px 10px; font-size: 12px"
        data-test="folder-view-session"
        @click="sessions.select(s.sessionId)"
      >
        <span
          class="shrink-0 rounded-full"
          :class="DOT_CLASS[statusOf(s)]"
          style="width: 6px; height: 6px"
          :aria-label="$t(DOT_LABEL[statusOf(s)])"
        />
        <span class="min-w-0 flex-1 truncate">{{ title(s) }}</span>
        <span
          v-if="s.messageCount > 0"
          class="tabular-nums shrink-0 text-text-4"
          style="font-size: 11px"
          :aria-label="$t('preview.messages', { count: s.messageCount })"
          data-test="folder-view-session-msgs"
          >{{ s.messageCount }}</span
        >
        <span class="tabular-nums shrink-0 text-text-4" style="font-size: 11px">{{
          relativeTime(s.modified)
        }}</span>
      </button>
    </div>

    <div v-if="archivedOpen" class="flex flex-col" style="gap: 2px; margin-top: 6px">
      <button
        v-for="s in buckets.archived"
        :key="s.sessionId"
        class="flex w-full cursor-pointer items-center text-left text-text-4 transition hover:bg-surface hover:text-text-2"
        style="gap: 10px; border-radius: var(--radius-sm); padding: 6px 10px; font-size: 12px"
        data-test="folder-view-session"
        @click="sessions.select(s.sessionId)"
      >
        <span
          class="shrink-0 rounded-full"
          :class="DOT_CLASS[statusOf(s)]"
          style="width: 6px; height: 6px"
          :aria-label="$t(DOT_LABEL[statusOf(s)])"
        />
        <span class="min-w-0 flex-1 truncate">{{ title(s) }}</span>
        <span
          v-if="s.messageCount > 0"
          class="tabular-nums shrink-0 text-text-4"
          style="font-size: 11px"
          :aria-label="$t('preview.messages', { count: s.messageCount })"
          data-test="folder-view-session-msgs"
          >{{ s.messageCount }}</span
        >
        <span class="tabular-nums shrink-0 text-text-4" style="font-size: 11px">{{
          relativeTime(s.modified)
        }}</span>
      </button>
    </div>
  </section>
</template>
