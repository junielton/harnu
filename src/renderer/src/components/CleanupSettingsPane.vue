<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingHint from './ui/SettingHint.vue'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import type { ReaperPrefs } from '../../../preload'

/**
 * Settings → Cleanup tab (Reaper PR5 slice 2, plan Task 14,
 * `docs/plans/2026-07-15-reaper-cleanup.md`). Editor for the background-scan
 * prefs persisted at `<userData>/reaper-prefs.json`
 * (`src/main/reaper/prefs.ts`), read/written whole-object through
 * `window.api.reaperPrefs`/`reaperSetPrefs` (`src/main/reaper/reaper-ipc.ts`).
 *
 * Every control writes through immediately (whole-object PUT, optimistic UI —
 * mirrors `HibernationPolicyPane`'s debounced-patch pattern but PUTs the full
 * prefs object each time since the IPC contract has no partial-patch verb).
 * `neverDeleteRemote` is the kill switch: flipping it here hides the sweep
 * dialog's remote-delete toggle (`SweepConfirmDialog.vue`) AND is enforced
 * main-side in `reaper-ipc.ts`'s `reaper:clean`/`reaper:sweep` handlers, which
 * force `deleteRemote: false` whenever it's on — this pane only reflects that
 * state, it isn't the only thing enforcing it.
 */

const { t } = useI18n()

const loading = ref(true)
const prefs = ref<ReaperPrefs | null>(null)
const protectedBranchesText = ref('')

function intervalOptions(): Array<{ value: number; label: string }> {
  return [
    { value: 1_800_000, label: t('cleanup.settings.interval30m') },
    { value: 3_600_000, label: t('cleanup.settings.interval1h') },
    { value: 21_600_000, label: t('cleanup.settings.interval6h') },
    { value: 86_400_000, label: t('cleanup.settings.intervalDaily') }
  ]
}

function applyPrefs(p: ReaperPrefs): void {
  prefs.value = p
  protectedBranchesText.value = p.protectedBranches.join(', ')
}

onMounted(async () => {
  try {
    applyPrefs(await window.api.reaperPrefs())
  } finally {
    loading.value = false
  }
})

async function save(patch: Partial<ReaperPrefs>): Promise<void> {
  if (!prefs.value) return
  const next = { ...prefs.value, ...patch }
  prefs.value = next // optimistic
  applyPrefs(await window.api.reaperSetPrefs(next))
}

function onAutoScanChange(v: boolean): void {
  void save({ autoScan: v })
}
function onIntervalChange(v: number | string | boolean | undefined): void {
  if (typeof v !== 'number') return
  void save({ intervalMs: v })
}
function onNeverRemoteChange(v: boolean): void {
  void save({ neverDeleteRemote: v })
}
function onNotifyChange(v: boolean): void {
  void save({ notifyOnHarvestable: v })
}

let branchesSaveTimer: ReturnType<typeof setTimeout> | null = null
function onProtectedBranchesInput(raw: string): void {
  protectedBranchesText.value = raw
  if (branchesSaveTimer) clearTimeout(branchesSaveTimer)
  branchesSaveTimer = setTimeout(() => {
    branchesSaveTimer = null
    const branches = raw
      .split(',')
      .map((b) => b.trim())
      .filter((b) => b.length > 0)
    void save({ protectedBranches: branches })
  }, 400)
}

let minAgeSaveTimer: ReturnType<typeof setTimeout> | null = null
function onMinAgeInput(raw: string): void {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  if (minAgeSaveTimer) clearTimeout(minAgeSaveTimer)
  minAgeSaveTimer = setTimeout(() => {
    minAgeSaveTimer = null
    void save({ minAgeDays: Math.max(0, Math.round(n)) })
  }, 400)
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
        {{ t('cleanup.settings.eyebrow') }}
      </div>
      <p class="text-text-3" style="font-size: 11.5px; line-height: 1.5; margin-bottom: 14px">
        {{ t('cleanup.settings.intro') }}
      </p>

      <div class="flex items-start justify-between" style="gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.settings.autoScan.label') }}
          </div>
          <SettingHint>{{ t('cleanup.settings.autoScan.hint') }}</SettingHint>
        </div>
        <ToggleSwitch
          :model-value="prefs.autoScan"
          :aria-label="t('cleanup.settings.autoScan.label')"
          @update:model-value="onAutoScanChange"
        />
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.settings.interval.label') }}
          </div>
          <SettingHint>{{ t('cleanup.settings.interval.hint') }}</SettingHint>
        </div>
        <SegmentedControl
          :model-value="prefs.intervalMs"
          size="sm"
          :disabled="!prefs.autoScan"
          :options="intervalOptions()"
          :aria-label="t('cleanup.settings.interval.label')"
          @update:model-value="onIntervalChange"
        />
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.settings.notify.label') }}
          </div>
          <SettingHint>{{ t('cleanup.settings.notify.hint') }}</SettingHint>
        </div>
        <ToggleSwitch
          :model-value="prefs.notifyOnHarvestable"
          :aria-label="t('cleanup.settings.notify.label')"
          @update:model-value="onNotifyChange"
        />
      </div>
    </section>

    <section style="margin-bottom: 16px">
      <div class="flex items-start justify-between" style="gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.settings.neverRemote.label') }}
          </div>
          <SettingHint>{{ t('cleanup.settings.neverRemote.hint') }}</SettingHint>
        </div>
        <ToggleSwitch
          :model-value="prefs.neverDeleteRemote"
          :aria-label="t('cleanup.settings.neverRemote.label')"
          @update:model-value="onNeverRemoteChange"
        />
      </div>
    </section>

    <section>
      <div style="margin-bottom: 14px">
        <div class="text-text-2" style="font-size: 12px; margin-bottom: 4px">
          {{ t('cleanup.settings.protected.label') }}
        </div>
        <SettingHint>{{ t('cleanup.settings.protected.hint') }}</SettingHint>
        <input
          type="text"
          class="bg-surface text-text"
          style="
            border: 1px solid var(--color-border);
            border-radius: 5px;
            padding: 5px 8px;
            font-size: 12px;
            width: 100%;
            font-family: var(--font-mono);
            margin-top: 6px;
          "
          :value="protectedBranchesText"
          :placeholder="t('cleanup.settings.protected.placeholder')"
          :aria-label="t('cleanup.settings.protected.label')"
          @input="onProtectedBranchesInput(($event.target as HTMLInputElement).value)"
        />
      </div>

      <div class="flex items-start justify-between" style="gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.settings.minAge.label') }}
          </div>
          <SettingHint>{{ t('cleanup.settings.minAge.hint') }}</SettingHint>
        </div>
        <div class="flex items-center" style="gap: 6px">
          <input
            type="number"
            min="0"
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
            :value="prefs.minAgeDays"
            :aria-label="t('cleanup.settings.minAge.label')"
            @input="onMinAgeInput(($event.target as HTMLInputElement).value)"
          />
          <span class="text-text-3" style="font-size: 11.5px">{{
            t('cleanup.settings.minAge.daysSuffix')
          }}</span>
        </div>
      </div>
    </section>
  </div>
</template>
