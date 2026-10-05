<script setup lang="ts">
import { computed } from 'vue'
import { RefreshCw, ExternalLink } from 'lucide-vue-next'
import { useClaudeChangelogStore } from '../stores/claudeChangelog'

/**
 * Settings → "Claude Code" tab. Renders the Claude Code CLI release list the
 * main process fetches from GitHub (spec 2026-06-18). Mirrors ChangelogPane's
 * visual rhythm but keys sections by version (not date) and shows an accent
 * unread dot on releases above the read marker. Opening this tab marks them read
 * (handled in SettingsDialog), so the dot is transient.
 */
const store = useClaudeChangelogStore()
const releases = computed(() => store.releases)

function isUnread(index: number): boolean {
  return index < store.unreadCount
}

const lastChecked = computed(() =>
  store.lastFetchedAt ? new Date(store.lastFetchedAt).toLocaleString() : ''
)
</script>

<template>
  <div class="flex flex-col" style="gap: 18px">
    <div
      class="text-text-3"
      style="font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase"
    >
      {{ $t('settings.claudeCode.eyebrow') }}
    </div>
    <section v-for="(r, i) in releases" :key="r.version">
      <div class="flex items-center" style="gap: 8px; margin-bottom: 8px">
        <span
          v-if="isUnread(i)"
          class="bg-accent"
          style="width: 6px; height: 6px; border-radius: 100%"
          :aria-label="$t('settings.claudeCode.unread')"
        />
        <span class="text-text-2" style="font-size: 12px; font-weight: 600">{{ r.version }}</span>
      </div>
      <ul class="flex flex-col" style="gap: 4px">
        <li
          v-for="(item, j) in r.changes"
          :key="j"
          class="text-text-3"
          style="font-size: 12px; line-height: 1.5; padding-left: 14px; position: relative"
        >
          <span class="text-text-4" aria-hidden="true" style="position: absolute; left: 2px"
            >·</span
          >
          {{ item }}
        </li>
      </ul>
    </section>

    <div v-if="!releases.length" class="text-text-3" style="font-size: 12px">
      {{ $t('settings.claudeCode.empty') }}
    </div>

    <!-- Actions: official changelog (external) + manual refresh -->
    <div
      class="flex items-center justify-between border-t border-border"
      style="padding-top: 12px; gap: 8px"
    >
      <button
        class="flex items-center border border-border bg-surface text-text transition hover:bg-surface-2"
        style="padding: 7px 12px; font-size: 12.5px; border-radius: 5px; gap: 6px"
        type="button"
        @click="store.openExternal()"
      >
        <ExternalLink :size="13" :stroke-width="1.6" />
        {{ $t('settings.claudeCode.viewOfficial') }}
      </button>
      <button
        class="flex items-center text-text-3 transition hover:text-text"
        style="padding: 7px 12px; font-size: 12.5px; border-radius: 5px; gap: 6px"
        type="button"
        :title="lastChecked ? $t('settings.claudeCode.lastChecked', { when: lastChecked }) : ''"
        @click="store.refresh()"
      >
        <RefreshCw :size="13" :stroke-width="1.6" />
        {{ $t('settings.claudeCode.refresh') }}
      </button>
    </div>
  </div>
</template>
