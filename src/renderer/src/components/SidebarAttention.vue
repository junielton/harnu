<script setup lang="ts">
/**
 * Needs attention (design.md §6 "Needs attention"): the strip pinned between the toolbar and the
 * list, one 28px row per session that needs input or has failed, from every folder. It renders only
 * when there is one. The list and its order come from `sessions.attentionSessions`.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from 'lucide-vue-next'
import { useSessionsStore, type AttentionEntry } from '../stores/sessions'
import { useLayoutStore } from '../stores/layout'
import { sessionTitle } from '../lib/session-label'
import { failureBadge } from './failure-badge'

const sessions = useSessionsStore()
const layout = useLayoutStore()
const { t } = useI18n()

/** Why the row is there: the pending command, the question context or the failure. */
function reasonFor(entry: AttentionEntry): string {
  const s = sessions.findSessionById(entry.sessionId)
  if (entry.state === 'failed') {
    const badge = s && failureBadge(s.failureReason, s.resetsAt, Date.now())
    return badge ? t(badge.labelKey) : t('session.statusFailed')
  }
  const pending = sessions.pendingApprovalList.find((a) => a.sessionId === entry.sessionId)
  return pending?.summary || s?.whatsHappening || t('session.statusNeedsInput')
}

const rows = computed(() =>
  sessions.attentionSessions.map((entry) => {
    const s = sessions.findSessionById(entry.sessionId)
    const title = (s && sessionTitle(s, sessions.allSessions, t)) || t('session.newPlaceholder')
    const folder = sessions.folderAliasOf(entry.sessionId)
    const state = t(entry.state === 'failed' ? 'session.statusFailed' : 'session.statusNeedsInput')
    return {
      ...entry,
      title,
      folder,
      label: `${title}, ${state}, ${folder}`,
      reason: reasonFor(entry)
    }
  })
)
</script>

<template>
  <section
    v-if="rows.length > 0"
    data-attention
    data-dsqa-part="attention"
    class="shrink-0 border-b border-border"
    style="padding: 6px 0 4px"
  >
    <button
      type="button"
      data-attention-head
      class="flex w-full cursor-pointer items-center whitespace-nowrap text-left text-warning"
      style="
        gap: 6px;
        padding: 5px 12px;
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        line-height: 14px;
      "
      :aria-expanded="layout.attentionOpen"
      @click="layout.attentionOpen = !layout.attentionOpen"
    >
      <ChevronRight
        :size="12"
        :stroke-width="1.8"
        class="shrink-0 transition-transform"
        :class="layout.attentionOpen && 'rotate-90'"
        aria-hidden="true"
      />
      <span class="min-w-0 truncate">{{ $t('sidebar.attention.title') }}</span>
      {{ ' ' }}
      <span class="shrink-0 tabular-nums text-text-3">{{ rows.length }}</span>
    </button>
    <!-- At most six rows (168px), then the rows scroll; the head stays put. -->
    <div
      v-show="layout.attentionOpen"
      data-attention-body
      class="scrollable overflow-y-auto"
      style="max-height: 168px"
    >
      <button
        v-for="row in rows"
        :key="row.sessionId"
        type="button"
        :data-attention-session="row.sessionId"
        class="flex w-full cursor-pointer items-center text-left transition hover:bg-surface-2"
        style="height: 28px; padding: 0 12px; gap: 8px; font-size: 12.5px"
        :title="row.reason"
        :aria-label="row.label"
        @click="sessions.activateSession(row.sessionId)"
      >
        <span
          class="fleet-ring shrink-0"
          :class="row.state === 'failed' ? 'fleet-ring--errored' : 'fleet-ring--needs-input'"
          aria-hidden="true"
        >
          <span class="fleet-ring-track" />
          <span class="fleet-ring-dot" />
        </span>
        <span class="flex min-w-0 flex-1 items-baseline" style="gap: 8px">
          <span data-attention-title class="min-w-0 flex-1 truncate text-text">{{
            row.title
          }}</span>
          <span
            data-attention-folder
            class="shrink-0 truncate text-text-4"
            style="font-size: 11px; max-width: 96px"
            >{{ row.folder }}</span
          >
        </span>
      </button>
    </div>
  </section>
</template>
