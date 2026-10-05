<script setup lang="ts">
/**
 * RETURN HERE zone (T37 — closure axis, slice 1c). A top-of-sidebar surface
 * that lists sessions the operator FORGOT: a `needs-input` session they haven't
 * viewed in ~10 min and aren't currently viewing (`sessions.forgottenSessions`,
 * already filtered + reactive). It exists so a blocked-and-abandoned session
 * doesn't get lost below the fold.
 *
 * Calm-tech: the whole zone (eyebrow + list + divider) renders ONLY when the
 * forgotten set is non-empty — no persistent empty chrome. Each row is per
 * session (this axis is flat, not per-folder): an amber `needs-input` dot, the
 * session summary, and a muted folder alias. Whole-row click jumps to the
 * session (`activateSession` — expands its folder + selects it, so it self-
 * clears from the zone); the × dismisses (`markSessionSeen` — stamps last-
 * viewed = now, dropping the row). Tokens only — Section-label eyebrow,
 * `--color-warning` dot, `--border` divider (design.md §6, folder-first).
 */
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'
import type { Session } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'

const sessions = useSessionsStore()
const { t } = useI18n()

/** Row label — the shared session name (BUG-78, the sidebar row's own), else the
 *  "New session" placeholder. */
function labelFor(s: Session): string {
  return sessionTitle(s, sessions.allSessions, t) || t('session.newPlaceholder')
}
</script>

<template>
  <div v-if="sessions.forgottenSessions.length > 0">
    <!-- Section-label eyebrow (design.md §6) — uppercase 10.5px / 500 / 0.06em /
         --text-4, mirroring the FOLDERS / ACTIVE ELSEWHERE eyebrows. Not
         collapsible: the zone is a transient nudge, gone the moment it's empty. -->
    <div
      class="flex items-center text-text-4"
      style="
        padding: 8px 12px 4px 12px;
        gap: 4px;
        font-size: 10.5px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      "
    >
      <span>{{ $t('sidebar.returnHere.title') }}</span>
      <span aria-hidden="true">·</span>
      <span class="tabular-nums">{{ sessions.forgottenSessions.length }}</span>
    </div>

    <!-- Flat list of forgotten sessions -->
    <button
      v-for="s in sessions.forgottenSessions"
      :key="s.sessionId"
      class="group relative flex w-full cursor-pointer items-center text-left text-text-2 transition hover:bg-surface hover:text-text"
      style="height: 28px; padding-left: 12px; padding-right: 8px; gap: 8px; font-size: 12.5px"
      @click="sessions.activateSession(s.sessionId)"
    >
      <!-- Amber needs-input dot (--color-warning) -->
      <span
        class="anim-attention-dot shrink-0 rounded-full bg-warning"
        style="width: 6px; height: 6px"
        :aria-label="$t('session.statusNeedsInput')"
      />

      <!-- Session summary -->
      <span class="flex-1 truncate">{{ labelFor(s) }}</span>

      <!-- Muted folder alias -->
      <span class="shrink-0 truncate text-text-4" style="font-size: 10.5px; max-width: 96px">{{
        sessions.folderAliasOf(s.sessionId)
      }}</span>

      <!-- Dismiss (mark as seen) — role=button span so it isn't a <button>
           nested in the row <button>; stop propagation so it doesn't also jump. -->
      <span
        role="button"
        tabindex="0"
        class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
        style="width: 18px; height: 18px"
        :aria-label="$t('sidebar.returnHere.dismiss')"
        :title="$t('sidebar.returnHere.dismiss')"
        @click.stop="sessions.markSessionSeen(s.sessionId)"
        @keydown.enter.stop.prevent="sessions.markSessionSeen(s.sessionId)"
        @keydown.space.stop.prevent="sessions.markSessionSeen(s.sessionId)"
      >
        <X :size="12" :stroke-width="1.8" />
      </span>
    </button>

    <!-- 1px zone divider (--border) separating RETURN HERE from FOLDERS -->
    <div class="border-t border-border" style="margin: 6px 0" aria-hidden="true" />
  </div>
</template>
