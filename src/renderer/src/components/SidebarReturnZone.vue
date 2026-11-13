<script setup lang="ts">
/**
 * RETURN HERE zone (T37 — closure axis, slice 1c). A sidebar surface, at the
 * BOTTOM between the folder list and the dock (T660), that lists sessions the operator FORGOT: a `needs-input` session they haven't
 * viewed in ~10 min and aren't currently viewing (`sessions.forgottenSessions`,
 * already filtered + reactive). It exists so a blocked-and-abandoned session
 * doesn't get lost. Its height is capped and the rows scroll inside, so a long
 * list can never push the dock off-screen.
 *
 * Calm-tech: the whole zone (eyebrow + list + divider) renders ONLY when the
 * forgotten set is non-empty — no persistent empty chrome. Each row is per
 * session (this axis is flat, not per-folder): an amber `needs-input` dot, the
 * session summary, and a muted folder alias. Whole-row click jumps to the
 * session (`activateSession` — expands its folder + selects it, so it self-
 * clears from the zone); the × dismisses (`markSessionSeen` — stamps last-
 * viewed = now, dropping the row). Tokens only — Section-label eyebrow,
 * `--color-warning` dot, `--border` divider (design.md §6, folder-first).
 *
 * Your move (design.md §6 "RETURN HERE in Your move mode Live"): when the setting is Live the zone
 * lists the global queue of Your move cards instead (`YourMoveCard`), oldest first, with the count
 * and the oldest clock in the eyebrow. It is global on purpose: the zone sits outside the drill
 * view, so a card from another project shows whichever folder the sidebar is drilled into. In Off
 * and Observe nothing about the legacy rows changes. Cards have no ×: see `YourMoveCard.vue`.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'
import type { Session } from '../stores/sessions'
import { useYourMoveStore } from '../stores/your-move'
import { formatClock, pageOfQueue, QUEUE_PAGE } from '../lib/your-move-view'
import { sessionTitle } from '../lib/session-label'
import YourMoveCard from './YourMoveCard.vue'

const sessions = useSessionsStore()
const yourMove = useYourMoveStore()
const { t } = useI18n()

onMounted(() => void yourMove.init())

const live = computed(() => yourMove.mode === 'live')
const visible = computed(() =>
  live.value ? yourMove.count > 0 : sessions.forgottenSessions.length > 0
)
const count = computed(() => (live.value ? yourMove.count : sessions.forgottenSessions.length))
const oldestClock = computed(() =>
  yourMove.oldestAt === null ? '' : formatClock(yourMove.now - yourMove.oldestAt)
)

/**
 * The queue renders one page at a time (BUG-271): a real queue held 1,594 cards, and every one of
 * them was a live row in the sidebar. "More" reveals the next page after the ones already shown.
 */
const shown = ref(QUEUE_PAGE)
const page = computed(() => pageOfQueue(yourMove.queue, shown.value))
const showMore = (): void => {
  shown.value += QUEUE_PAGE
}

/** One card open at a time: the zone is a narrow strip, and a second one would crowd the list. */
const expandedId = ref<string | null>(null)
const toggle = (id: string): void => {
  expandedId.value = expandedId.value === id ? null : id
}

/** Row label — the shared session name (BUG-78, the sidebar row's own), else the
 *  "New session" placeholder. */
function labelFor(s: Session): string {
  return sessionTitle(s, sessions.allSessions, t) || t('session.newPlaceholder')
}
</script>

<template>
  <div
    v-if="visible"
    class="flex shrink-0 flex-col"
    :style="live ? 'max-height: min(380px, 45vh)' : 'max-height: 168px'"
    data-island="sidebar-return"
  >
    <!-- 1px zone divider (--border) separating the folder list from RETURN HERE. Off, it is the
         rule above the zone (the dock draws its own below); Floating panels hides it, the island
         gap does that job. -->
    <div data-return-divider class="shrink-0 border-t border-border" aria-hidden="true" />

    <!-- Section-label eyebrow (design.md §6) — uppercase 10.5px / 500 / 0.06em /
         --text-4, mirroring the FOLDERS / ACTIVE ELSEWHERE eyebrows. In Your move mode Live it is
         --color-warning and adds the oldest card's clock. Not collapsible: the zone is a
         transient nudge, gone the moment it's empty. -->
    <div
      class="flex shrink-0 items-center"
      :class="live ? 'text-warning' : 'text-text-4'"
      data-testid="your-move-eyebrow"
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
      <span class="tabular-nums">{{ count }}</span>
      <template v-if="live">
        <span aria-hidden="true">·</span>
        <span class="tabular-nums">{{ oldestClock }}</span>
      </template>
    </div>

    <!-- Your move cards: the only part that scrolls (the eyebrow stays put). -->
    <div
      v-if="live"
      class="scrollable min-h-0 flex-1 overflow-y-auto"
      style="padding-top: 2px; padding-bottom: 2px"
    >
      <YourMoveCard
        v-for="c in page.cards"
        :key="c.id"
        :card="c"
        :expanded="expandedId === c.id"
        @toggle="toggle(c.id)"
      />
      <button
        v-if="page.hidden > 0"
        type="button"
        class="block cursor-pointer text-left text-text-3 transition hover:text-text"
        style="
          font-size: 11.5px;
          border-radius: var(--radius-sm);
          padding: 4px 10px;
          margin: 0 8px 6px 8px;
        "
        data-testid="your-move-more"
        @click="showMore"
      >
        {{
          $t('yourMove.queue.more', {
            n: $n(page.next),
            left: $n(page.hidden)
          })
        }}
      </button>
    </div>

    <!-- Flat list of forgotten sessions: the only part that scrolls (the eyebrow stays put). -->
    <div v-else class="scrollable min-h-0 flex-1 overflow-y-auto" style="padding-bottom: 4px">
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
    </div>
  </div>
</template>
