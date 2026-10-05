<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ExternalLink } from 'lucide-vue-next'
import { useClaudeStatusStore } from '../stores/claude-status'
import { severityDotClass, severityTextClass, severityLabelKey } from './claude-status-format'
import type { StatusIncident } from '../../../preload'

/**
 * Claude service-status panel (issue #17; design.md §6 — Claude service status).
 * Lives in the footer popover (left of the fleet block), structurally a sibling
 * of `UsagePanel`. Renders: an overall banner (dot + page description), per-
 * component health rows, active-incident cards, scheduled maintenance, and the
 * external "view history" link. Presentational only — reads the store.
 */
const status = useClaudeStatusStore()
const { t } = useI18n()

const bannerDotClass = computed(() => severityDotClass(status.severity))
const bannerTextClass = computed(() => severityTextClass(status.severity))
const bannerLabel = computed(() => t(severityLabelKey(status.severity)))

/** Page description, falling back to the severity label when absent. */
const bannerDescription = computed(() => status.description || bannerLabel.value)

/** Map a raw incident status to a localized badge label, with a raw fallback. */
function incidentStatusLabel(inc: StatusIncident): string {
  const key = `claudeStatus.incidentStatus.${inc.status}`
  const translated = t(key)
  return translated === key ? inc.status : translated
}
</script>

<template>
  <div style="padding: 8px 12px" :aria-busy="false">
    <!-- Eyebrow -->
    <div
      class="text-text-3"
      style="
        font-size: 10.5px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 7px;
      "
    >
      {{ t('claudeStatus.title') }}
    </div>

    <!-- Overall banner -->
    <div class="flex items-center" style="gap: 8px; margin-bottom: 10px">
      <span
        class="shrink-0 rounded-full"
        :class="bannerDotClass"
        style="width: 9px; height: 9px"
        aria-hidden="true"
      />
      <span class="truncate" :class="bannerTextClass" style="font-size: 12px; font-weight: 500">
        {{ bannerDescription }}
      </span>
    </div>

    <!-- Offline / stale note -->
    <div
      v-if="status.stale"
      class="text-text-3"
      style="font-size: 11px; line-height: 1.5; margin-bottom: 10px"
    >
      {{ t('claudeStatus.stale') }}
    </div>

    <!-- Active incidents -->
    <template v-if="status.hasIncidents">
      <div
        class="text-text-3"
        style="
          font-size: 10px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-bottom: 6px;
        "
      >
        {{ t('claudeStatus.incidentsTitle') }}
      </div>
      <div class="flex flex-col" style="gap: 6px; margin-bottom: 10px">
        <div
          v-for="inc in status.incidents"
          :key="inc.id"
          class="rounded border border-border bg-surface"
          style="padding: 7px 8px"
        >
          <div class="flex items-start" style="gap: 6px">
            <span
              class="mt-1 shrink-0 rounded-full"
              :class="severityDotClass(inc.severity)"
              style="width: 7px; height: 7px"
              aria-hidden="true"
            />
            <div style="flex: 1; min-width: 0">
              <div class="text-text-2" style="font-size: 11.5px; line-height: 1.4">
                {{ inc.name }}
              </div>
              <div
                class="tabular-nums"
                :class="severityTextClass(inc.severity)"
                style="font-size: 10.5px; margin-top: 2px; text-transform: capitalize"
              >
                {{ incidentStatusLabel(inc) }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Per-component health -->
    <div
      class="text-text-3"
      style="
        font-size: 10px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        margin-bottom: 6px;
      "
    >
      {{ t('claudeStatus.componentsTitle') }}
    </div>
    <div v-if="status.components.length" class="flex flex-col" style="gap: 5px">
      <div
        v-for="c in status.components"
        :key="c.id"
        class="flex items-center justify-between"
        style="gap: 8px"
      >
        <span class="truncate text-text-2" style="font-size: 11.5px">{{ c.name }}</span>
        <span class="flex shrink-0 items-center" style="gap: 5px">
          <span
            class="text-text-3"
            style="font-size: 10.5px"
            :class="severityTextClass(c.severity)"
            >{{ t(severityLabelKey(c.severity)) }}</span
          >
          <span
            class="rounded-full"
            :class="severityDotClass(c.severity)"
            style="width: 7px; height: 7px"
            aria-hidden="true"
          />
        </span>
      </div>
    </div>
    <div v-else class="text-text-3" style="font-size: 11px">
      {{ t('claudeStatus.noComponents') }}
    </div>

    <!-- Scheduled maintenance -->
    <template v-if="status.maintenances.length">
      <div
        class="text-text-3"
        style="
          font-size: 10px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin: 10px 0 6px;
        "
      >
        {{ t('claudeStatus.maintenanceTitle') }}
      </div>
      <div class="flex flex-col" style="gap: 4px">
        <div
          v-for="m in status.maintenances"
          :key="m.id"
          class="truncate text-text-3"
          style="font-size: 11px"
        >
          {{ m.name }}
        </div>
      </div>
    </template>

    <!-- History link -->
    <button
      type="button"
      class="mt-2 flex items-center text-text-3 transition-colors hover:text-text-2"
      style="gap: 5px; font-size: 11px"
      @click="status.openHistory()"
    >
      <ExternalLink :size="11" :stroke-width="1.6" class="shrink-0" />
      {{ t('claudeStatus.viewHistory') }}
    </button>
  </div>
</template>
