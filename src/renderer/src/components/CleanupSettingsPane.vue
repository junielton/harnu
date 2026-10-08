<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingHint from './ui/SettingHint.vue'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import { useGcStore } from '../stores/gc'
import type { GcPrefs } from '../../../main/gc/gc-prefs'
import type { ReaperPrefs } from '../../../preload'

/**
 * Settings → Cleanup tab (T443, design.md "Workspace GC — unified Cleanup / Settings → Cleanup").
 * ONE pane for the whole cleanup engine:
 *
 * - the Workspace GC prefs (`<userData>/gc-prefs.json`, `src/main/gc/gc-prefs.ts`), read through
 *   `window.api.gcPrefs` and written, whole object, through the GC store's `savePrefs` →
 *   `window.api.gcSetPrefs`. Main fills any missing field with its default, so a partial object would
 *   silently reset the rest: every write carries every field.
 * - the Reaper-only prefs (`reaper-prefs.json`) that GC does not cover: the background-scan switch, the
 *   harvestable notification, the remote-delete kill switch, protected branches and minimum age.
 *   The scan interval is NOT among them — it is `GcPrefs.intervalMs`, one timer, one control.
 *
 * `version`, `keep` and `firstReportAcknowledged` are internal (Keep marks and the first-report
 * acknowledgement are set from the Cleanup screen), so they have no control here.
 */

const { t } = useI18n()
const gc = useGcStore()

const loading = ref(true)
const prefs = ref<GcPrefs | null>(null)
const reaper = ref<ReaperPrefs | null>(null)
const protectedBranchesText = ref('')
const newPath = ref('')
const pathError = ref(false)
/** Each numeric input's text, so an unfinished edit ("", "0") is not overwritten while typing. */
const numText = ref<Record<NumField, string>>({
  graceDays: '',
  maxItemsPerCycle: '',
  cacheMaxAgeDays: '',
  minAgeDays: ''
})

type NumField = 'graceDays' | 'maxItemsPerCycle' | 'cacheMaxAgeDays' | 'minAgeDays'

/** Mirrors the bounds in `src/main/gc/gc-prefs.ts`; main clamps again, so these only keep the UI honest. */
const BOUNDS: Record<Exclude<NumField, 'minAgeDays'>, { min: number; max: number }> = {
  graceDays: { min: 0, max: 30 },
  maxItemsPerCycle: { min: 1, max: 200 },
  cacheMaxAgeDays: { min: 1, max: 365 }
}

const DEBOUNCE_MS = 400

function intervalOptions(): Array<{ value: number; label: string }> {
  return [
    { value: 1_800_000, label: t('cleanup.settings.interval30m') },
    { value: 3_600_000, label: t('cleanup.settings.interval1h') },
    { value: 21_600_000, label: t('cleanup.settings.interval6h') },
    { value: 86_400_000, label: t('cleanup.settings.intervalDaily') }
  ]
}

function applyGc(p: GcPrefs): void {
  prefs.value = p
  numText.value.graceDays = String(p.graceDays)
  numText.value.maxItemsPerCycle = String(p.maxItemsPerCycle)
  numText.value.cacheMaxAgeDays = String(p.cacheMaxAgeDays)
  // The Reaper timer is the one clock: keep our copy of its prefs from reverting a new interval.
  if (reaper.value) reaper.value = { ...reaper.value, intervalMs: p.intervalMs }
}

function applyReaper(p: ReaperPrefs): void {
  reaper.value = p
  protectedBranchesText.value = p.protectedBranches.join(', ')
  numText.value.minAgeDays = String(p.minAgeDays)
}

onMounted(async () => {
  try {
    const [g, r] = await Promise.all([window.api.gcPrefs(), window.api.reaperPrefs()])
    applyReaper(r)
    applyGc(g)
    // Warm the store too, so `savePrefs` starts from the same object this pane shows.
    void gc.init()
  } finally {
    loading.value = false
  }
})

// ---- writes ---------------------------------------------------------------------------------

/** Saves run one after another: a second edit must start from the answer to the first. */
let chain: Promise<unknown> = Promise.resolve()

function saveGc(patch: Partial<GcPrefs>): Promise<void> {
  if (!prefs.value) return Promise.resolve()
  prefs.value = { ...prefs.value, ...patch } // optimistic
  const run = chain.then(async () => {
    applyGc(await gc.savePrefs(patch))
  })
  chain = run.catch(() => undefined)
  return run
}

function saveReaper(patch: Partial<ReaperPrefs>): Promise<void> {
  if (!reaper.value) return Promise.resolve()
  const next = {
    ...reaper.value,
    ...patch,
    intervalMs: prefs.value?.intervalMs ?? reaper.value.intervalMs
  }
  reaper.value = next // optimistic
  const run = chain.then(async () => {
    applyReaper(await window.api.reaperSetPrefs(next))
  })
  chain = run.catch(() => undefined)
  return run
}

const timers = new Map<NumField, ReturnType<typeof setTimeout>>()

function onNumberInput(field: NumField, raw: string): void {
  numText.value[field] = raw
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(n)) return
  const prev = timers.get(field)
  if (prev) clearTimeout(prev)
  timers.set(
    field,
    setTimeout(() => {
      timers.delete(field)
      if (field === 'minAgeDays') {
        void saveReaper({ minAgeDays: Math.max(0, Math.round(n)) })
        return
      }
      const { min, max } = BOUNDS[field]
      void saveGc({ [field]: Math.min(max, Math.max(min, Math.round(n))) } as Partial<GcPrefs>)
    }, DEBOUNCE_MS)
  )
}

function onIntervalChange(v: number | string | boolean | undefined): void {
  if (typeof v !== 'number') return
  void saveGc({ intervalMs: v })
}

function onCategory(key: keyof GcPrefs['categories'], v: boolean): void {
  if (!prefs.value) return
  void saveGc({ categories: { ...prefs.value.categories, [key]: v } })
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
    void saveReaper({ protectedBranches: branches })
  }, DEBOUNCE_MS)
}

// ---- never-clean list -----------------------------------------------------------------------

/** POSIX absolute, a Windows drive path, or a UNC path. A relative path would protect nothing. */
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/

function addPath(): void {
  const path = newPath.value.trim()
  if (!path || !ABSOLUTE.test(path)) {
    pathError.value = true
    return
  }
  pathError.value = false
  newPath.value = ''
  const current = prefs.value?.neverClean ?? []
  if (current.includes(path)) return
  void saveGc({ neverClean: [...current, path] })
}

function removePath(path: string): void {
  void saveGc({ neverClean: (prefs.value?.neverClean ?? []).filter((p) => p !== path) })
}

onBeforeUnmount(() => {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  if (branchesSaveTimer) clearTimeout(branchesSaveTimer)
})

const INPUT_STYLE =
  'border: 1px solid var(--color-border); border-radius: 5px; padding: 5px 8px; font-size: 12px; font-family: var(--font-mono)'
const EYEBROW_STYLE =
  'font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 8px'
</script>

<template>
  <div v-if="!loading && prefs && reaper" data-testid="cleanup-settings">
    <!-- Autopilot -->
    <section style="margin-bottom: 16px" data-testid="cleanup-settings-autopilot">
      <div class="text-text-3" :style="EYEBROW_STYLE">
        {{ t('cleanup.gc.settings.autopilot.eyebrow') }}
      </div>
      <p class="text-text-3" style="font-size: 11.5px; line-height: 1.5; margin-bottom: 14px">
        {{ t('cleanup.gc.settings.autopilot.intro') }}
      </p>

      <div class="flex items-start justify-between" style="gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.gc.settings.autopilot.label') }}
          </div>
          <SettingHint>{{ t('cleanup.gc.settings.autopilot.hint') }}</SettingHint>
        </div>
        <ToggleSwitch
          data-testid="gc-autopilot"
          :model-value="prefs.autopilot"
          :aria-label="t('cleanup.gc.settings.autopilot.label')"
          @update:model-value="(v: boolean) => saveGc({ autopilot: v })"
        />
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.gc.settings.interval.label') }}
          </div>
          <SettingHint>{{ t('cleanup.gc.settings.interval.hint') }}</SettingHint>
        </div>
        <SegmentedControl
          data-testid="gc-interval"
          :model-value="prefs.intervalMs"
          size="sm"
          :options="intervalOptions()"
          :aria-label="t('cleanup.gc.settings.interval.label')"
          @update:model-value="onIntervalChange"
        />
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.gc.settings.grace.label') }}
          </div>
          <SettingHint>{{ t('cleanup.gc.settings.grace.hint') }}</SettingHint>
        </div>
        <div class="flex items-center" style="gap: 6px">
          <input
            type="number"
            min="0"
            max="30"
            step="1"
            class="bg-surface text-text"
            :style="`${INPUT_STYLE}; width: 72px`"
            data-testid="gc-grace"
            :value="numText.graceDays"
            :aria-label="t('cleanup.gc.settings.grace.label')"
            @input="onNumberInput('graceDays', ($event.target as HTMLInputElement).value)"
          />
          <span class="text-text-3" style="font-size: 11.5px">{{
            t('cleanup.gc.settings.daysSuffix')
          }}</span>
        </div>
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.gc.settings.cap.label') }}
          </div>
          <SettingHint>{{ t('cleanup.gc.settings.cap.hint') }}</SettingHint>
        </div>
        <div class="flex items-center" style="gap: 6px">
          <input
            type="number"
            min="1"
            max="200"
            step="1"
            class="bg-surface text-text"
            :style="`${INPUT_STYLE}; width: 72px`"
            data-testid="gc-cap"
            :value="numText.maxItemsPerCycle"
            :aria-label="t('cleanup.gc.settings.cap.label')"
            @input="onNumberInput('maxItemsPerCycle', ($event.target as HTMLInputElement).value)"
          />
          <span class="text-text-3" style="font-size: 11.5px">{{
            t('cleanup.gc.settings.cap.suffix')
          }}</span>
        </div>
      </div>
    </section>

    <!-- What it cleans -->
    <section style="margin-bottom: 16px" data-testid="cleanup-settings-categories">
      <div class="text-text-3" :style="EYEBROW_STYLE">
        {{ t('cleanup.gc.settings.clean.eyebrow') }}
      </div>
      <p class="text-text-3" style="font-size: 11.5px; line-height: 1.5; margin-bottom: 14px">
        {{ t('cleanup.gc.settings.clean.intro') }}
      </p>

      <div class="flex items-start justify-between" style="gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.gc.settings.categories.worktrees.label') }}
          </div>
          <SettingHint>{{ t('cleanup.gc.settings.categories.worktrees.hint') }}</SettingHint>
        </div>
        <ToggleSwitch
          data-testid="gc-cat-worktrees"
          :model-value="prefs.categories.worktrees"
          :aria-label="t('cleanup.gc.settings.categories.worktrees.label')"
          @update:model-value="(v: boolean) => onCategory('worktrees', v)"
        />
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.gc.settings.categories.dockerCache.label') }}
          </div>
          <SettingHint>{{ t('cleanup.gc.settings.categories.dockerCache.hint') }}</SettingHint>
        </div>
        <ToggleSwitch
          data-testid="gc-cat-docker-cache"
          :model-value="prefs.categories.dockerCache"
          :aria-label="t('cleanup.gc.settings.categories.dockerCache.label')"
          @update:model-value="(v: boolean) => onCategory('dockerCache', v)"
        />
      </div>

      <!-- The one rule about volumes, stated where the switches that look related used to be. -->
      <div
        style="margin-top: 14px; border-radius: 5px; padding: 8px 10px"
        class="border border-warning-line bg-warning-soft"
        data-testid="gc-volumes-rule"
      >
        <div class="text-text-2" style="font-size: 12px">
          {{ t('cleanup.gc.settings.volumesRule.title') }}
        </div>
        <p class="text-text-3" style="font-size: 11.5px; line-height: 1.5; margin-top: 2px">
          {{ t('cleanup.gc.settings.volumesRule.body') }}
        </p>
        <p
          class="text-warning"
          style="font-size: 11px; line-height: 1.4; margin-top: 4px"
          data-testid="gc-volumes-warning"
        >
          {{ t('cleanup.gc.settings.volumesRule.warning') }}
        </p>
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.gc.settings.cacheMaxAge.label') }}
          </div>
          <SettingHint>{{ t('cleanup.gc.settings.cacheMaxAge.hint') }}</SettingHint>
        </div>
        <div class="flex items-center" style="gap: 6px">
          <input
            type="number"
            min="1"
            max="365"
            step="1"
            class="bg-surface text-text"
            :style="`${INPUT_STYLE}; width: 72px`"
            data-testid="gc-cache-age"
            :value="numText.cacheMaxAgeDays"
            :aria-label="t('cleanup.gc.settings.cacheMaxAge.label')"
            @input="onNumberInput('cacheMaxAgeDays', ($event.target as HTMLInputElement).value)"
          />
          <span class="text-text-3" style="font-size: 11.5px">{{
            t('cleanup.gc.settings.daysSuffix')
          }}</span>
        </div>
      </div>
    </section>

    <!-- Never clean -->
    <section style="margin-bottom: 16px" data-testid="cleanup-settings-never">
      <div class="text-text-3" :style="EYEBROW_STYLE">
        {{ t('cleanup.gc.settings.never.eyebrow') }}
      </div>
      <p class="text-text-3" style="font-size: 11.5px; line-height: 1.5; margin-bottom: 10px">
        {{ t('cleanup.gc.settings.never.intro') }}
      </p>

      <ul
        v-if="prefs.neverClean.length > 0"
        class="scrollable"
        style="list-style: none; margin: 0 0 8px; padding: 0; max-height: 280px; overflow-y: auto"
        data-testid="gc-never-list"
      >
        <li
          v-for="path in prefs.neverClean"
          :key="path"
          class="flex items-center justify-between"
          style="gap: 8px; padding: 3px 0"
        >
          <span
            class="text-text-2 truncate"
            style="font-size: 12px; font-family: var(--font-mono)"
            :title="path"
            >{{ path }}</span
          >
          <button
            type="button"
            class="shrink-0 text-text-3 hover:text-text"
            style="font-size: 11.5px"
            data-testid="gc-never-remove"
            :aria-label="t('cleanup.gc.settings.never.remove', { path })"
            @click="removePath(path)"
          >
            {{ t('cleanup.gc.settings.never.removeLabel') }}
          </button>
        </li>
      </ul>
      <p v-else class="text-text-4" style="font-size: 11.5px; margin-bottom: 8px">
        {{ t('cleanup.gc.settings.never.empty') }}
      </p>

      <div class="flex items-center" style="gap: 8px">
        <input
          v-model="newPath"
          type="text"
          class="bg-surface text-text"
          :style="`${INPUT_STYLE}; flex: 1; min-width: 0`"
          data-testid="gc-never-input"
          :placeholder="t('cleanup.gc.settings.never.placeholder')"
          :aria-label="t('cleanup.gc.settings.never.label')"
          :aria-invalid="pathError"
          @input="pathError = false"
          @keydown.enter.prevent="addPath()"
        />
        <button
          type="button"
          class="bg-surface text-text-2 hover:text-text"
          style="
            border: 1px solid var(--color-border);
            border-radius: 5px;
            padding: 5px 12px;
            font-size: 12px;
          "
          data-testid="gc-never-add"
          @click="addPath()"
        >
          {{ t('cleanup.gc.settings.never.add') }}
        </button>
      </div>
      <p v-if="pathError" class="text-red" style="font-size: 11px; margin-top: 4px" role="alert">
        {{ t('cleanup.gc.settings.never.invalid') }}
      </p>
    </section>

    <!-- Scan: the Reaper-only fields. The interval is the Autopilot group's. -->
    <section data-testid="cleanup-settings-scan">
      <div class="text-text-3" :style="EYEBROW_STYLE">
        {{ t('cleanup.gc.settings.scan.eyebrow') }}
      </div>
      <p class="text-text-3" style="font-size: 11.5px; line-height: 1.5; margin-bottom: 14px">
        {{ t('cleanup.gc.settings.scan.intro') }}
      </p>

      <div class="flex items-start justify-between" style="gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.settings.autoScan.label') }}
          </div>
          <SettingHint>{{ t('cleanup.gc.settings.scan.autoScanHint') }}</SettingHint>
        </div>
        <ToggleSwitch
          data-testid="reaper-auto-scan"
          :model-value="reaper.autoScan"
          :aria-label="t('cleanup.settings.autoScan.label')"
          @update:model-value="(v: boolean) => saveReaper({ autoScan: v })"
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
          data-testid="reaper-notify"
          :model-value="reaper.notifyOnHarvestable"
          :aria-label="t('cleanup.settings.notify.label')"
          @update:model-value="(v: boolean) => saveReaper({ notifyOnHarvestable: v })"
        />
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('cleanup.settings.neverRemote.label') }}
          </div>
          <SettingHint>{{ t('cleanup.settings.neverRemote.hint') }}</SettingHint>
        </div>
        <ToggleSwitch
          data-testid="reaper-never-remote"
          :model-value="reaper.neverDeleteRemote"
          :aria-label="t('cleanup.settings.neverRemote.label')"
          @update:model-value="(v: boolean) => saveReaper({ neverDeleteRemote: v })"
        />
      </div>

      <div style="margin-top: 14px">
        <div class="text-text-2" style="font-size: 12px; margin-bottom: 4px">
          {{ t('cleanup.settings.protected.label') }}
        </div>
        <SettingHint>{{ t('cleanup.settings.protected.hint') }}</SettingHint>
        <input
          type="text"
          class="bg-surface text-text"
          :style="`${INPUT_STYLE}; width: 100%; margin-top: 6px`"
          data-testid="reaper-protected"
          :value="protectedBranchesText"
          :placeholder="t('cleanup.settings.protected.placeholder')"
          :aria-label="t('cleanup.settings.protected.label')"
          @input="onProtectedBranchesInput(($event.target as HTMLInputElement).value)"
        />
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
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
            :style="`${INPUT_STYLE}; width: 72px`"
            data-testid="reaper-min-age"
            :value="numText.minAgeDays"
            :aria-label="t('cleanup.settings.minAge.label')"
            @input="onNumberInput('minAgeDays', ($event.target as HTMLInputElement).value)"
          />
          <span class="text-text-3" style="font-size: 11.5px">{{
            t('cleanup.settings.minAge.daysSuffix')
          }}</span>
        </div>
      </div>
    </section>
  </div>
</template>
