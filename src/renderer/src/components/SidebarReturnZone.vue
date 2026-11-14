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
 * Since T702 the shell (eyebrow + chevron, scrolling body, resize handle, persisted size and
 * collapsed state) is the generic `SidebarSection`; this file only decides WHEN the zone shows and
 * WHAT is in it. Nothing in the shell knows about Return here.
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
import SidebarSection from './SidebarSection.vue'
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
  <!-- The whole zone renders only when there is something to show (calm-tech); its size and
       collapsed state live in the section store, so they survive it hiding and coming back.
       Height: until dragged, content-sized and capped (Live `min(380px, 45vh)`, legacy 168px). -->
  <SidebarSection
    v-if="visible"
    id="return"
    :label="$t('sidebar.returnHere.title')"
    :tone="live ? 'warning' : 'default'"
    :auto-max-height="live ? 'min(380px, 45vh)' : '168px'"
    data-island="sidebar-return"
  >
    <!-- Title · count (· oldest clock in Your move mode Live). `contents` keeps the three spans
         flex children of the eyebrow while giving the tests one node to read the whole line from. -->
    <template #eyebrow>
      <span class="contents" data-testid="your-move-eyebrow">
        <span>{{ $t('sidebar.returnHere.title') }}</span>
        <span aria-hidden="true">·</span>
        <span class="tabular-nums">{{ count }}</span>
        <template v-if="live">
          <span aria-hidden="true">·</span>
          <span class="tabular-nums">{{ oldestClock }}</span>
        </template>
      </span>
    </template>

    <!-- Your move cards -->
    <div v-if="live" style="padding-top: 2px; padding-bottom: 2px">
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

    <!-- Flat list of forgotten sessions -->
    <div v-else style="padding-bottom: 4px">
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
  </SidebarSection>
</template>
