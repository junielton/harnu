<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ExternalLink, RotateCcw, TriangleAlert } from 'lucide-vue-next'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import SettingHint from './ui/SettingHint.vue'
import type { ClaudeSettingsRead } from '../../../preload'
import {
  SETTINGS_CATALOG,
  SETTING_GROUPS,
  knownTopLevelKeys,
  catalogPaths,
  getAtPath,
  type SettingDef,
  type SettingGroup
} from './claude-config-catalog'

/**
 * "Claude config" Settings tab (issue #16, Phases 1–2; design §6 → Settings
 * dialog → Claude config). Loads the GLOBAL `~/.claude/settings.json`, renders
 * the curated catalog as typed controls with Set/Default markers, and writes
 * edits back through the hardened patch layer (`claudeSettingsPatch`). Unknown
 * on-disk keys + the Harnu-managed `hooks`/`statusLine` subtrees are shown
 * read-only in an Advanced block — a stale catalog degrades to "less pretty,"
 * never "lost setting." v1 edits the global file only and says so.
 */

const { t } = useI18n()

/** Draft sentinel: this field is queued for deletion (reset to default). */
const UNSET = Symbol('draft-unset')
type DraftValue = unknown | typeof UNSET

const read = ref<ClaudeSettingsRead | null>(null)
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)

/** Pending edits, keyed by dot-path. Empty ⇒ no unsaved changes. */
const draft = reactive<Record<string, DraftValue>>({})

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    read.value = await window.api.claudeSettingsRead()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
  for (const k of Object.keys(draft)) delete draft[k]
}
onMounted(load)

const settings = computed<Record<string, unknown>>(() => read.value?.settings ?? {})
const dirty = computed(() => Object.keys(draft).length > 0)

/** On-disk value at a dot-path (undefined if absent). */
function diskValue(path: string): unknown {
  return getAtPath(settings.value, path)
}

/** Effective value after pending edits: draft wins, then disk. */
function effective(path: string): unknown {
  if (path in draft) return draft[path] === UNSET ? undefined : draft[path]
  return diskValue(path)
}

/** True when the option has a concrete value on disk OR in the pending draft. */
function isSet(path: string): boolean {
  if (path in draft) return draft[path] !== UNSET
  return diskValue(path) !== undefined
}

function setField(path: string, value: unknown): void {
  draft[path] = value
}

/** Reset to Claude's default: queue a delete if it lives on disk, else drop the draft. */
function resetField(path: string): void {
  if (diskValue(path) !== undefined) draft[path] = UNSET
  else delete draft[path]
}

function fieldsFor(group: SettingGroup): SettingDef[] {
  return SETTINGS_CATALOG.filter((d) => d.group === group)
}

// --- control helpers -------------------------------------------------------

function toggleValue(def: SettingDef): boolean {
  const v = effective(def.path)
  if (typeof v === 'boolean') return v
  return def.default === true
}
function selectValue(def: SettingDef): string {
  const v = effective(def.path)
  if (typeof v === 'string') return v
  return typeof def.default === 'string' ? def.default : ''
}

function numberValue(def: SettingDef): string {
  const v = effective(def.path)
  if (typeof v === 'number') return String(v)
  return ''
}
function onNumber(def: SettingDef, raw: string): void {
  if (raw.trim() === '') {
    resetField(def.path)
    return
  }
  const n = Number(raw)
  if (Number.isFinite(n)) setField(def.path, n)
}

function textValue(def: SettingDef): string {
  const v = effective(def.path)
  return typeof v === 'string' ? v : ''
}
function onText(def: SettingDef, raw: string): void {
  if (raw === '') resetField(def.path)
  else setField(def.path, raw)
}

/** Human-readable default hint for the Set/Default marker. */
function defaultHint(def: SettingDef): string {
  if (def.default === undefined) return t('claudeConfig.unset')
  if (typeof def.default === 'boolean') {
    return def.default ? t('claudeConfig.on') : t('claudeConfig.off')
  }
  return String(def.default)
}

function optionLabel(opt: { value: string; labelKey?: string }): string {
  return opt.labelKey ? t(opt.labelKey) : opt.value
}

/** Map a select field's catalog options to SegmentedControl's shape. An
 *  out-of-catalog effective value (hand-edited settings.json, newer Claude) is
 *  surfaced by SegmentedControl itself (it appends a pill for an unknown
 *  model-value), so this only needs the catalog. */
function selectOptions(def: SettingDef): { value: string; label: string }[] {
  return (def.options ?? []).map((o) => ({ value: o.value, label: optionLabel(o) }))
}

// --- unknown / managed keys (Advanced block) -------------------------------

/** Drop the catalog-controlled leaves from a top-level value so the raw block
 *  shows ONLY the sub-keys no control covers (e.g. `permissions.allow`/`deny`),
 *  never a value the form already edits above. Returns `undefined` when nothing
 *  uncovered remains. Non-object / array values are shown whole. */
function uncoveredValue(key: string): unknown {
  const value = settings.value[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const covered = catalogPaths()
  const out: Record<string, unknown> = {}
  for (const sub of Object.keys(value as Record<string, unknown>)) {
    if (!covered.has(`${key}.${sub}`)) out[sub] = (value as Record<string, unknown>)[sub]
  }
  return Object.keys(out).length ? out : undefined
}

const unknownKeys = computed<string[]>(() => {
  const known = knownTopLevelKeys()
  return Object.keys(settings.value).filter((k) => !known.has(k) && uncoveredValue(k) !== undefined)
})
const hasManaged = computed(() => 'hooks' in settings.value || 'statusLine' in settings.value)
function rawValue(key: string): string {
  return JSON.stringify(uncoveredValue(key), null, 2)
}

// --- save ------------------------------------------------------------------

async function save(): Promise<void> {
  if (!dirty.value || saving.value) return
  saving.value = true
  error.value = null
  const set: Record<string, unknown> = {}
  const unset: string[] = []
  for (const [path, value] of Object.entries(draft)) {
    if (value === UNSET) unset.push(path)
    else set[path] = value
  }
  try {
    const res = await window.api.claudeSettingsPatch({ set, unset })
    if (!res.ok) {
      error.value = res.error ?? t('claudeConfig.saveError')
      return
    }
    await load()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

function discard(): void {
  for (const k of Object.keys(draft)) delete draft[k]
}

function openDocs(url?: string): void {
  if (url) window.open(url, '_blank')
}

// Save / Discard live in the SettingsDialog footer (next to Close) when this
// tab is active — the dialog reads live dirty/saving state and drives the
// actions through these. The pane keeps all the save/discard logic; the footer
// is just the surface for the buttons.
defineExpose({ dirty, saving, save, discard })
</script>

<template>
  <div>
    <!-- Scope note: v1 edits the global file only and says so. -->
    <p class="text-text-3" style="font-size: 12px; margin-bottom: 6px">
      {{ $t('claudeConfig.scopeNote') }}
    </p>
    <p
      v-if="read"
      class="text-text-4 truncate"
      style="font-family: var(--font-mono); font-size: 11px; margin-bottom: 14px"
      :title="read.path"
    >
      {{ read.path }}
    </p>

    <p v-if="loading" class="text-text-3" style="font-size: 12px">
      {{ $t('claudeConfig.loading') }}
    </p>

    <!-- Read error / corrupt-file guard: stay read-only, never offer edits. -->
    <div
      v-if="error || read?.corrupt"
      class="flex items-start gap-2"
      style="
        border: 1px solid var(--color-border-2);
        background: var(--color-red-soft);
        border-radius: var(--radius-sm);
        padding: 8px 10px;
        margin-bottom: 14px;
      "
    >
      <TriangleAlert
        :size="14"
        :stroke-width="1.6"
        class="text-warning shrink-0"
        style="margin-top: 1px"
      />
      <span class="text-text-2" style="font-size: 12px">
        {{ error || $t('claudeConfig.corrupt') }}
      </span>
    </div>

    <template v-if="read && !read.corrupt">
      <!-- Catalog groups -->
      <section v-for="group in SETTING_GROUPS" :key="group" style="margin-bottom: 18px">
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
          {{ $t(`claudeConfig.groups.${group}`) }}
        </div>

        <div
          v-for="def in fieldsFor(group)"
          :key="def.path"
          class="flex items-start justify-between gap-4"
          style="padding: 8px 0; border-bottom: 1px solid var(--color-border)"
        >
          <div style="min-width: 0; flex: 1">
            <div class="flex items-center gap-1.5">
              <span class="text-text-2" style="font-size: 12px; font-weight: 500">
                {{ $t(def.labelKey) }}
              </span>
              <a
                v-if="def.docs"
                :href="def.docs"
                target="_blank"
                class="text-text-3 hover:text-text transition"
                :aria-label="$t('claudeConfig.docs')"
                @click.prevent="openDocs(def.docs)"
              >
                <ExternalLink :size="11" :stroke-width="1.6" />
              </a>
            </div>
            <SettingHint>{{ $t(def.descKey) }}</SettingHint>
            <p class="text-text-3" style="font-size: 10.5px; margin-top: 3px">
              <span v-if="isSet(def.path)" class="text-accent">{{ $t('claudeConfig.set') }}</span>
              <span v-else>{{ $t('claudeConfig.usingDefault', { value: defaultHint(def) }) }}</span>
            </p>
          </div>

          <!-- Control -->
          <div class="flex items-center gap-2 shrink-0">
            <!-- toggle -->
            <ToggleSwitch
              v-if="def.type === 'toggle'"
              :model-value="toggleValue(def)"
              :aria-label="$t(def.labelKey)"
              @update:model-value="setField(def.path, $event)"
            />

            <!-- select → segmented buttons -->
            <SegmentedControl
              v-else-if="def.type === 'select'"
              :options="selectOptions(def)"
              :model-value="selectValue(def)"
              size="sm"
              :aria-label="$t(def.labelKey)"
              @update:model-value="setField(def.path, $event as string)"
            />

            <!-- number -->
            <input
              v-else-if="def.type === 'number'"
              type="number"
              :min="def.min"
              :max="def.max"
              class="bg-surface text-text"
              style="
                border: 1px solid var(--color-border);
                border-radius: 5px;
                padding: 5px 8px;
                font-size: 12px;
                width: 88px;
                font-family: var(--font-mono);
              "
              :value="numberValue(def)"
              @input="onNumber(def, ($event.target as HTMLInputElement).value)"
            />

            <!-- text -->
            <input
              v-else
              type="text"
              class="bg-surface text-text"
              style="
                border: 1px solid var(--color-border);
                border-radius: 5px;
                padding: 5px 8px;
                font-size: 12px;
                width: 150px;
              "
              :value="textValue(def)"
              :placeholder="$t('claudeConfig.defaultPlaceholder')"
              @input="onText(def, ($event.target as HTMLInputElement).value)"
            />

            <!-- reset-to-default -->
            <button
              type="button"
              class="text-text-3 hover:text-text transition disabled:opacity-30"
              :disabled="!isSet(def.path)"
              :aria-label="$t('claudeConfig.reset')"
              :title="$t('claudeConfig.reset')"
              @click="resetField(def.path)"
            >
              <RotateCcw :size="13" :stroke-width="1.6" />
            </button>
          </div>
        </div>
      </section>

      <!-- Advanced / raw: unknown on-disk keys + Harnu-managed subtrees (read-only) -->
      <section v-if="unknownKeys.length || hasManaged" style="margin-bottom: 6px">
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
          {{ $t('claudeConfig.groups.advanced') }}
        </div>
        <SettingHint style="margin-bottom: 8px">{{ $t('claudeConfig.advancedNote') }}</SettingHint>
        <SettingHint v-if="hasManaged" style="margin-bottom: 8px">
          {{ $t('claudeConfig.managedNote') }}
        </SettingHint>
        <div
          v-for="key in unknownKeys"
          :key="key"
          style="
            border: 1px solid var(--color-border);
            border-radius: var(--radius-sm);
            padding: 6px 8px;
            margin-bottom: 6px;
            background: var(--color-surface-2);
          "
        >
          <div class="text-text-2" style="font-size: 11.5px; font-weight: 500">{{ key }}</div>
          <pre
            class="text-text-4 scrollable"
            style="
              font-family: var(--font-mono);
              font-size: 11px;
              margin-top: 2px;
              white-space: pre-wrap;
              overflow-x: auto;
            "
            >{{ rawValue(key) }}</pre>
        </div>
      </section>
    </template>
  </div>
</template>
