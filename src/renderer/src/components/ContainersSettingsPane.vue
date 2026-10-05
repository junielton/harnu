<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingHint from './ui/SettingHint.vue'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import type { ContainersPrefs } from '../../../preload'

/**
 * Settings → Containers tab (T332, PRD T320 §6). Editor for the prefs persisted
 * at `<userData>/containers-prefs.json` (`src/main/containers/containers-prefs.ts`),
 * read/written whole-object through `window.api.containersPrefs`/
 * `containersSetPrefs` (`containers-ipc.ts`). Same anatomy as
 * `CleanupSettingsPane.vue`: eyebrow, intro, label-left/control-right rows.
 *
 * Main clamps every write (`normalizePrefs`), and the pane re-syncs from its
 * answer, so a field always shows what was persisted. A new "Zombie after"
 * re-sorts the stacks right away: main rescans when the threshold changes.
 */

const { t } = useI18n()

const loading = ref(true)
const prefs = ref<ContainersPrefs | null>(null)
/** The input's text, so an unfinished edit ("", "0") is not overwritten while typing. */
const zombieAfterText = ref('')

function intervalOptions(): Array<{ value: number; label: string }> {
  return [
    { value: 1_800_000, label: t('containers.settings.interval30m') },
    { value: 3_600_000, label: t('containers.settings.interval1h') },
    { value: 21_600_000, label: t('containers.settings.interval6h') },
    { value: 86_400_000, label: t('containers.settings.intervalDaily') }
  ]
}

function applyPrefs(p: ContainersPrefs): void {
  prefs.value = p
  zombieAfterText.value = String(p.zombieAfterDays)
}

onMounted(async () => {
  try {
    applyPrefs(await window.api.containersPrefs())
  } finally {
    loading.value = false
  }
})

async function save(patch: Partial<ContainersPrefs>): Promise<void> {
  if (!prefs.value) return
  const next = { ...prefs.value, ...patch }
  prefs.value = next // optimistic
  applyPrefs(await window.api.containersSetPrefs(next))
}

function onAutoScanChange(v: boolean): void {
  void save({ autoScan: v })
}
function onIntervalChange(v: number | string | boolean | undefined): void {
  if (typeof v !== 'number') return
  void save({ intervalMs: v })
}
function onNotifyChange(v: boolean): void {
  void save({ notifyOnNewZombies: v })
}

let zombieAfterTimer: ReturnType<typeof setTimeout> | null = null
function onZombieAfterInput(raw: string): void {
  zombieAfterText.value = raw
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(n)) return
  if (zombieAfterTimer) clearTimeout(zombieAfterTimer)
  zombieAfterTimer = setTimeout(() => {
    zombieAfterTimer = null
    void save({ zombieAfterDays: Math.max(1, Math.round(n)) })
  }, 400)
}

onBeforeUnmount(() => {
  if (zombieAfterTimer) clearTimeout(zombieAfterTimer)
})
</script>

<template>
  <div v-if="!loading && prefs" data-testid="containers-settings">
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
        {{ t('containers.settings.eyebrow') }}
      </div>
      <p class="text-text-3" style="font-size: 11.5px; line-height: 1.5; margin-bottom: 14px">
        {{ t('containers.settings.intro') }}
      </p>

      <div class="flex items-start justify-between" style="gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('containers.settings.autoScan.label') }}
          </div>
          <SettingHint>{{ t('containers.settings.autoScan.hint') }}</SettingHint>
        </div>
        <ToggleSwitch
          :model-value="prefs.autoScan"
          :aria-label="t('containers.settings.autoScan.label')"
          @update:model-value="onAutoScanChange"
        />
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('containers.settings.interval.label') }}
          </div>
          <SettingHint>{{ t('containers.settings.interval.hint') }}</SettingHint>
        </div>
        <SegmentedControl
          :model-value="prefs.intervalMs"
          size="sm"
          :disabled="!prefs.autoScan"
          :options="intervalOptions()"
          :aria-label="t('containers.settings.interval.label')"
          @update:model-value="onIntervalChange"
        />
      </div>
    </section>

    <section style="margin-bottom: 16px">
      <div class="flex items-start justify-between" style="gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('containers.settings.zombieAfter.label') }}
          </div>
          <SettingHint>{{ t('containers.settings.zombieAfter.hint') }}</SettingHint>
        </div>
        <div class="flex items-center" style="gap: 6px">
          <input
            type="number"
            min="1"
            step="1"
            class="bg-surface text-text"
            style="
              border: 1px solid var(--color-border);
              border-radius: 5px;
              padding: 5px 8px;
              font-size: 12px;
              width: 72px;
              font-family: var(--font-mono);
            "
            :value="zombieAfterText"
            :aria-label="t('containers.settings.zombieAfter.label')"
            @input="onZombieAfterInput(($event.target as HTMLInputElement).value)"
          />
          <span class="text-text-3" style="font-size: 11.5px">{{
            t('containers.settings.zombieAfter.daysSuffix')
          }}</span>
        </div>
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('containers.settings.notify.label') }}
          </div>
          <SettingHint>{{ t('containers.settings.notify.hint') }}</SettingHint>
        </div>
        <ToggleSwitch
          :model-value="prefs.notifyOnNewZombies"
          :aria-label="t('containers.settings.notify.label')"
          @update:model-value="onNotifyChange"
        />
      </div>
    </section>
  </div>
</template>
