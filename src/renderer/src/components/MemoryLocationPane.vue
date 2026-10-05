<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { FolderOpen, TriangleAlert } from 'lucide-vue-next'
import SegmentedControl from './ui/SegmentedControl.vue'
import SettingHint from './ui/SettingHint.vue'
import type { MemoryLocationConfig } from '../../../preload'

/**
 * Settings → Memory (T89): the GLOBAL default for where Harnu stores project
 * memory — `in-project` (default) or a `central` root outside the repo (Drive /
 * Obsidian vault / external disk). Per-project overrides live in the folder menu;
 * this pane sets the app-wide default and offers the assisted batch migration
 * ("move existing memories to the new default"). design.md §6 "Memory (Settings)".
 */

const { t } = useI18n()

const mode = ref<'in-project' | 'central'>('in-project')
const root = ref('')
/** The config as last persisted — the migration `from` after a save. */
const saved = ref<MemoryLocationConfig>({ mode: 'in-project' })
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)

/** After a successful save that changed the location, offer the batch move. */
const migrateFrom = ref<MemoryLocationConfig | null>(null)
const migrating = ref(false)
const migrateSummary = ref<string | null>(null)

function toConfig(): MemoryLocationConfig {
  return mode.value === 'central'
    ? { mode: 'central', root: root.value.trim() }
    : { mode: 'in-project' }
}

function sameConfig(a: MemoryLocationConfig, b: MemoryLocationConfig): boolean {
  if (a.mode !== b.mode) return false
  return a.mode === 'central' && b.mode === 'central' ? a.root === b.root : true
}

const dirty = computed(() => !sameConfig(toConfig(), saved.value))
const canSave = computed(
  () =>
    !saving.value && dirty.value && (mode.value === 'in-project' || root.value.trim().length > 0)
)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const cfg = await window.api.memoryLocationGetGlobal()
    saved.value = cfg
    mode.value = cfg.mode
    root.value = cfg.mode === 'central' ? cfg.root : ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function choose(): Promise<void> {
  const { path } = await window.api.dialogOpenDirectory()
  if (path) root.value = path
}

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  error.value = null
  migrateSummary.value = null
  const prev = saved.value
  try {
    const res = await window.api.memoryLocationSetGlobal(toConfig())
    if (!res.ok) {
      error.value =
        res.code === 'invalid-root'
          ? t('memoryLocation.invalidRoot')
          : t('memoryLocation.saveFailed')
      return
    }
    saved.value = res.config
    mode.value = res.config.mode
    root.value = res.config.mode === 'central' ? res.config.root : ''
    // Offer to move existing memories only when the location actually changed.
    migrateFrom.value = sameConfig(prev, res.config) ? null : prev
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function migrateAll(): Promise<void> {
  if (!migrateFrom.value || migrating.value) return
  migrating.value = true
  try {
    const res = await window.api.memoryLocationMigrateKnown(migrateFrom.value, saved.value)
    const moved = res.reports.filter((r) => r.code === 'moved').length
    const skipped = res.reports.length - moved
    migrateSummary.value = t('memoryLocation.migrateDone', { moved, skipped })
    migrateFrom.value = null
  } catch (e) {
    migrateSummary.value = e instanceof Error ? e.message : String(e)
  } finally {
    migrating.value = false
  }
}

const modeOptions = computed(() => [
  { value: 'in-project', label: t('memoryLocation.modeInProject') },
  { value: 'central', label: t('memoryLocation.modeCentral') }
])
</script>

<template>
  <div>
    <p class="text-text-3" style="font-size: 11px; line-height: 1.5; margin-bottom: 16px">
      {{ t('memoryLocation.intro') }}
    </p>

    <p v-if="loading" class="text-text-3" style="font-size: 12px">
      {{ t('memoryLocation.loading') }}
    </p>

    <template v-else>
      <div
        class="text-text-3"
        style="
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 10px;
        "
      >
        {{ t('memoryLocation.globalEyebrow') }}
      </div>

      <div class="flex items-center justify-between" style="gap: 12px">
        <span class="text-text-2" style="font-size: 12px">{{ t('memoryLocation.modeLabel') }}</span>
        <SegmentedControl
          v-model="mode"
          :options="modeOptions"
          size="sm"
          :aria-label="t('memoryLocation.modeLabel')"
        />
      </div>
      <SettingHint>
        {{
          mode === 'central' ? t('memoryLocation.centralHint') : t('memoryLocation.inProjectHint')
        }}
      </SettingHint>

      <div v-if="mode === 'central'" style="margin-top: 12px">
        <label
          class="text-text-3"
          style="display: block; font-size: 11px; font-weight: 500; margin-bottom: 6px"
        >
          {{ t('memoryLocation.rootLabel') }}
        </label>
        <div class="flex items-center" style="gap: 8px">
          <input
            v-model="root"
            type="text"
            spellcheck="false"
            autocomplete="off"
            class="w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
            style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
            :placeholder="t('memoryLocation.rootPlaceholder')"
          />
          <button
            type="button"
            class="flex shrink-0 items-center border border-border bg-surface text-text transition hover:bg-surface-2"
            style="padding: 7px 12px; font-size: 12.5px; border-radius: 5px; gap: 6px"
            @click="choose()"
          >
            <FolderOpen :size="13" :stroke-width="1.7" />
            {{ t('memoryLocation.choose') }}
          </button>
        </div>
      </div>

      <div
        v-if="error"
        class="flex items-start border border-red text-warning"
        style="
          gap: 8px;
          padding: 9px 11px;
          margin-top: 12px;
          border-radius: 6px;
          background: var(--color-red-soft);
          font-size: 12px;
        "
      >
        <TriangleAlert :size="14" :stroke-width="1.7" style="margin-top: 1px; flex-shrink: 0" />
        <span>{{ error }}</span>
      </div>

      <div style="margin-top: 14px">
        <button
          type="button"
          class="bg-accent text-accent-ink transition disabled:opacity-40"
          style="
            padding: 7px 14px;
            font-size: 12.5px;
            font-weight: 500;
            border-radius: 5px;
            height: 28px;
            border: none;
          "
          :disabled="!canSave"
          @click="save()"
        >
          {{ saving ? t('memoryLocation.saving') : t('memoryLocation.save') }}
        </button>
      </div>

      <!-- Assisted migration after a location change (never silently orphan) -->
      <div
        v-if="migrateFrom"
        class="border border-border bg-bg"
        style="margin-top: 16px; border-radius: 7px; padding: 12px"
      >
        <div class="text-text-2" style="font-size: 12px; font-weight: 500; margin-bottom: 4px">
          {{ t('memoryLocation.migrateAllTitle') }}
        </div>
        <p class="text-text-3" style="font-size: 11px; line-height: 1.5; margin-bottom: 10px">
          {{ t('memoryLocation.migrateAllBody') }}
        </p>
        <button
          type="button"
          class="border border-border bg-surface text-text transition hover:bg-surface-2 disabled:opacity-40"
          style="padding: 7px 14px; font-size: 12.5px; border-radius: 5px"
          :disabled="migrating"
          @click="migrateAll()"
        >
          {{ migrating ? t('memoryLocation.migrating') : t('memoryLocation.migrateAll') }}
        </button>
      </div>

      <p
        v-if="migrateSummary"
        class="text-text-3"
        style="font-size: 11.5px; margin-top: 12px; line-height: 1.5"
      >
        {{ migrateSummary }}
      </p>
    </template>
  </div>
</template>
