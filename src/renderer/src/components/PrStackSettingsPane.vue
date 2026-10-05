<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingHint from './ui/SettingHint.vue'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import type { PrStackPrefs } from '../../../preload'
import { usePrStackStore } from '../stores/pr-stack'

/**
 * Settings → PR Stack (T198). Editor for the canvas' FOREGROUND refresh,
 * persisted at `<userData>/pr-stack-prefs.json` (`src/main/pr-stack-prefs.ts`)
 * and read/written whole-object through `window.api.prStackPrefs` /
 * `prStackSetPrefs` — the same contract shape as `CleanupSettingsPane`.
 *
 * This is NOT the background scan. That one belongs to the Reaper (Settings →
 * Cleanup, hourly by default) and the canvas rides it for topology and harvest
 * verdicts. What is tuned here is the faster poll that runs only while the
 * canvas is open, because readiness rots on a different clock than debris does.
 *
 * Discrete options rather than a free slider: nobody wants to dial in a number
 * for this, and four choices make the trade-off ("how much `gh` traffic am I
 * buying") legible in a way a continuous track does not.
 */

const { t } = useI18n()
const prStack = usePrStackStore()

const loading = ref(true)
const prefs = ref<PrStackPrefs | null>(null)

function intervalOptions(): Array<{ value: number; label: string }> {
  return [
    { value: 30_000, label: t('prStack.settings.interval30s') },
    { value: 90_000, label: t('prStack.settings.interval90s') },
    { value: 300_000, label: t('prStack.settings.interval5m') },
    { value: 600_000, label: t('prStack.settings.interval10m') }
  ]
}

onMounted(async () => {
  try {
    prefs.value = await window.api.prStackPrefs()
  } finally {
    loading.value = false
  }
})

async function save(patch: Partial<PrStackPrefs>): Promise<void> {
  if (!prefs.value) return
  const next = { ...prefs.value, ...patch }
  prefs.value = next // optimistic
  prefs.value = await window.api.prStackSetPrefs(next)
  // The canvas may be open behind this dialog — re-arm it now rather than at
  // the next open, so the change is observable where it matters.
  await prStack.reloadPrefs()
}

function onAutoRefreshChange(v: boolean): void {
  void save({ autoRefresh: v })
}

function onIntervalChange(v: number | string | boolean | undefined): void {
  if (typeof v !== 'number') return
  void save({ intervalMs: v })
}

/** T278 — label chips on the card. Off by default; see `PrStackPrefs.showLabels`. */
function onShowLabelsChange(v: boolean): void {
  void save({ showLabels: v })
}

/** Option+click an open-PR link in a transcript → show it on the canvas. */
function onOpenPrLinksChange(v: boolean): void {
  void save({ openPrLinksInCanvas: v })
}
</script>

<template>
  <div v-if="!loading && prefs">
    <section style="margin-bottom: 16px">
      <div
        class="text-text-3"
        style="
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 8px;
        "
      >
        {{ t('prStack.settings.eyebrow') }}
      </div>
      <p class="text-text-3" style="font-size: 11.5px; line-height: 1.5; margin-bottom: 14px">
        {{ t('prStack.settings.intro') }}
      </p>

      <div class="flex items-start justify-between" style="gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('prStack.settings.autoRefresh.label') }}
          </div>
          <SettingHint>{{ t('prStack.settings.autoRefresh.hint') }}</SettingHint>
        </div>
        <ToggleSwitch
          :model-value="prefs.autoRefresh"
          :aria-label="t('prStack.settings.autoRefresh.label')"
          @update:model-value="onAutoRefreshChange"
        />
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('prStack.settings.interval.label') }}
          </div>
          <SettingHint>{{ t('prStack.settings.interval.hint') }}</SettingHint>
        </div>
        <SegmentedControl
          :model-value="prefs.intervalMs"
          size="sm"
          :disabled="!prefs.autoRefresh"
          :options="intervalOptions()"
          :aria-label="t('prStack.settings.interval.label')"
          @update:model-value="onIntervalChange"
        />
      </div>
    </section>

    <section style="margin-bottom: 16px">
      <div
        class="text-text-3"
        style="
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 8px;
        "
      >
        {{ t('prStack.settings.cardsEyebrow') }}
      </div>

      <div class="flex items-start justify-between" style="gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('prStack.settings.showLabels.label') }}
          </div>
          <SettingHint>{{ t('prStack.settings.showLabels.hint') }}</SettingHint>
        </div>
        <ToggleSwitch
          :model-value="prefs.showLabels"
          :aria-label="t('prStack.settings.showLabels.label')"
          data-test="pr-stack-show-labels"
          @update:model-value="onShowLabelsChange"
        />
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('prStack.settings.openPrLinks.label') }}
          </div>
          <SettingHint>{{ t('prStack.settings.openPrLinks.hint') }}</SettingHint>
        </div>
        <ToggleSwitch
          :model-value="prefs.openPrLinksInCanvas"
          :aria-label="t('prStack.settings.openPrLinks.label')"
          data-test="pr-stack-open-pr-links"
          @update:model-value="onOpenPrLinksChange"
        />
      </div>
    </section>
  </div>
</template>
