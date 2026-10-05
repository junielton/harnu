<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { TriangleAlert, Server } from 'lucide-vue-next'
import SegmentedControl from './ui/SegmentedControl.vue'
import { useClaudeBootStore } from '../stores/claudeBoot'
import { useUiStore } from '../stores/ui'
import type { ClaudeBootConfig } from '../../../preload'

/**
 * Scope-agnostic "Claude Boot" launch-options form (design.md §6 — Claude Boot).
 * Controlled component: it renders `modelValue` and emits a fresh, pruned config
 * on every change. Used in BOTH scopes — the global Settings → Startup tab and
 * the per-folder dialog — with `scope` only changing copy (folder fields read as
 * "inherit global", global fields as "Claude default").
 *
 * No persistence here: the parent (store / dialog) owns the IPC write. The argv
 * is built authoritatively in the main process (`claude-args.ts`); the only
 * logic duplicated here is the denylist mirror used for the live `extraArgs`
 * warning — keep it in sync with `claude-args.ts#DENYLISTED_FLAGS`.
 */

const props = defineProps<{
  modelValue: ClaudeBootConfig
  scope: 'global' | 'folder' | 'session'
  /**
   * Resolved config from the levels ABOVE this one (global for a folder; global
   * ⊕ folder for a session; nothing for global). Shown as the effective value on
   * un-overridden fields so the user SEES what they inherit — without it being
   * stored at this level. Live inheritance: storage stays the per-level delta.
   */
  inherited?: ClaudeBootConfig
}>()
const emit = defineEmits<{ (e: 'update:modelValue', value: ClaudeBootConfig): void }>()

const { t } = useI18n()
const boot = useClaudeBootStore()
const ui = useUiStore()

// The provider picker + badge read the global endpoint registry. Idempotent —
// `init()` guards on `started`, so this is a no-op when a parent already loaded.
onMounted(() => void boot.init())

type FieldType = 'text' | 'textarea' | 'list' | 'select' | 'bool' | 'extra'
interface Field {
  key: keyof ClaudeBootConfig
  type: FieldType
  /** select-only: the concrete CLI values (shown as raw mono tokens). */
  options?: string[]
  /** text-only: datalist suggestions. */
  suggestions?: string[]
  /** bool-only: has an explicit `--no-X` negation (chrome). */
  negatable?: boolean
  danger?: boolean
}
interface Section {
  eyebrow: string
  fields: Field[]
}

const SECTIONS: Section[] = [
  {
    eyebrow: 'model',
    fields: [
      { key: 'model', type: 'select', options: ['opus', 'sonnet', 'haiku', 'fable'] },
      { key: 'effort', type: 'select', options: ['low', 'medium', 'high', 'xhigh', 'max'] },
      {
        // `--permission-mode` choices, mirrored from the installed `claude --help`
        // (v2.1.x): acceptEdits · auto · bypassPermissions · manual · dontAsk · plan.
        // No `default` — the neutral "Default" pill (SegmentedControl `allow-default`,
        // maps to undefined) already means "pass no flag, use Claude's default".
        key: 'permissionMode',
        type: 'select',
        options: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']
      }
    ]
  },
  {
    eyebrow: 'integrations',
    fields: [
      { key: 'chrome', type: 'bool', negatable: true },
      { key: 'ide', type: 'bool' }
    ]
  },
  {
    eyebrow: 'context',
    fields: [
      { key: 'appendSystemPrompt', type: 'textarea' },
      { key: 'systemPrompt', type: 'textarea' },
      { key: 'prePrompt', type: 'textarea' },
      { key: 'addDirs', type: 'list' }
    ]
  },
  {
    eyebrow: 'tools',
    fields: [
      { key: 'allowedTools', type: 'list' },
      { key: 'disallowedTools', type: 'list' }
    ]
  },
  {
    eyebrow: 'mcp',
    fields: [
      { key: 'mcpConfig', type: 'list' },
      { key: 'strictMcpConfig', type: 'bool' }
    ]
  },
  {
    eyebrow: 'session',
    fields: [
      { key: 'agent', type: 'text' },
      { key: 'name', type: 'text' },
      { key: 'fromPr', type: 'text' },
      { key: 'settings', type: 'text' },
      { key: 'settingSources', type: 'text' }
    ]
  },
  {
    eyebrow: 'advanced',
    fields: [
      { key: 'verbose', type: 'bool' },
      { key: 'bare', type: 'bool' },
      { key: 'safeMode', type: 'bool' },
      { key: 'extraArgs', type: 'extra' }
    ]
  },
  {
    eyebrow: 'danger',
    fields: [{ key: 'dangerouslySkipPermissions', type: 'bool', danger: true }]
  }
]

// Mirror of `claude-args.ts#ACCUMULATE_KEYS` — fields whose value is ADDED to the
// inherited one (append-text concat / list union) instead of replacing it (T57 #1).
// Drives the "added to inherited" note so the additive semantics are visible; the
// merge itself is authoritative in the main process. Keep in sync with claude-args.
const ACCUMULATE_TEXT = new Set<keyof ClaudeBootConfig>(['appendSystemPrompt', 'prePrompt'])
const ACCUMULATE_LIST = new Set<keyof ClaudeBootConfig>([
  'addDirs',
  'allowedTools',
  'disallowedTools',
  'mcpConfig'
])

// Mirror of `claude-args.ts#DENYLISTED_FLAGS` — used ONLY for the live extraArgs
// warning. Main strips these authoritatively; this is just UX.
const DENYLISTED = new Set([
  '--print',
  '-p',
  '--help',
  '-h',
  '--version',
  '-v',
  '--continue',
  '-c',
  '--fork-session',
  '--no-session-persistence',
  '--replay-user-messages',
  '--include-partial-messages',
  '--include-hook-events',
  '--resume',
  '-r',
  '--session-id',
  '--output-format',
  '--input-format'
])

// ── value plumbing ──────────────────────────────────────────────────────────
function update(patch: Partial<ClaudeBootConfig>): void {
  const next: ClaudeBootConfig = { ...props.modelValue, ...patch }
  for (const k of Object.keys(next) as (keyof ClaudeBootConfig)[]) {
    const v = next[k]
    if (v === undefined || v === null) delete next[k]
    else if (typeof v === 'string' && v === '') delete next[k]
    else if (Array.isArray(v) && v.length === 0) delete next[k]
  }
  emit('update:modelValue', next)
}

function strVal(key: keyof ClaudeBootConfig): string {
  const v = props.modelValue[key]
  return typeof v === 'string' ? v : ''
}
function boolVal(key: keyof ClaudeBootConfig): boolean | undefined {
  const v = props.modelValue[key]
  return typeof v === 'boolean' ? v : undefined
}

// List fields keep a local text buffer so blank lines while typing don't get
// eaten; the committed model value is the cleaned array.
const listText = reactive<Record<string, string>>({})
function listVal(key: keyof ClaudeBootConfig): string {
  if (key in listText) return listText[key as string]
  const v = props.modelValue[key]
  return Array.isArray(v) ? v.join('\n') : ''
}
function onListInput(key: keyof ClaudeBootConfig, text: string): void {
  listText[key as string] = text
  const cleaned = text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  update({ [key]: cleaned.length ? cleaned : undefined } as Partial<ClaudeBootConfig>)
}

// Tri-state helpers for booleans. Only the global scope has nothing to inherit
// from — folder and session both layer on top of it, so their neutral = inherit.
const triNeutralLabel = computed(() =>
  props.scope === 'global' ? t('claudeBoot.tri.default') : t('claudeBoot.tri.inherit')
)
const introText = computed(() => {
  if (props.scope === 'folder') return t('claudeBoot.folderIntro')
  if (props.scope === 'session') return t('claudeBoot.sessionIntro')
  return t('claudeBoot.globalIntro')
})
const fieldPlaceholder = computed(() =>
  props.scope === 'global' ? t('claudeBoot.unsetPlaceholder') : t('claudeBoot.inheritPlaceholder')
)

// Inherited (effective-from-above) values, surfaced on un-overridden fields.
const inh = computed<ClaudeBootConfig>(() => props.inherited ?? {})
function inheritedStr(key: keyof ClaudeBootConfig): string {
  const v = inh.value[key]
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.join(', ')
  return ''
}
function inheritedBool(key: keyof ClaudeBootConfig): boolean | undefined {
  const v = inh.value[key]
  return typeof v === 'boolean' ? v : undefined
}
/** Placeholder for a text/list field: the inherited value (if any) wins. */
function placeholderFor(key: keyof ClaudeBootConfig): string {
  const i = inheritedStr(key)
  if (!strVal(key) && i) return t('claudeBoot.inheritedHint', { value: i })
  return fieldPlaceholder.value
}

// Additive-field note (T57 #1): when an accumulate field has an inherited value,
// show a persistent note that this scope's value is ADDED to it (not replaced) —
// so the semantics stay visible even after the user starts typing (the placeholder
// disappears). Text fields concat, list fields union.
function accumulateNote(key: keyof ClaudeBootConfig): string {
  if (!inheritedStr(key)) return ''
  if (ACCUMULATE_TEXT.has(key)) return t('claudeBoot.appendNote')
  if (ACCUMULATE_LIST.has(key)) return t('claudeBoot.unionNote')
  return ''
}
// Per-field SegmentedControl options, memoized so labels aren't re-translated and
// fresh arrays aren't allocated on every render. Recomputes only when the boot
// config changes — which is also when the inherited-value tooltip needs to update.
// `title` carries the old per-pill "Inherited: <value>" hover hint.
type SegOpt = {
  value: boolean | string
  label: string
  mono?: boolean
  danger?: boolean
  title?: string
}
const fieldSegOptions = computed<Record<string, SegOpt[]>>(() => {
  const map: Record<string, SegOpt[]> = {}
  for (const sec of SECTIONS) {
    for (const f of sec.fields) {
      if (f.type === 'bool') {
        const overridden = boolVal(f.key) !== undefined
        const inh = inheritedBool(f.key)
        const titleFor = (val: boolean): string | undefined =>
          !overridden && inh === val
            ? t('claudeBoot.inheritedHint', {
                value: val ? t('claudeBoot.tri.on') : t('claudeBoot.tri.off')
              })
            : undefined
        const opts: SegOpt[] = [
          { value: true, label: t('claudeBoot.tri.on'), danger: f.danger, title: titleFor(true) }
        ]
        if (f.negatable || props.scope !== 'global') {
          opts.push({ value: false, label: t('claudeBoot.tri.off'), title: titleFor(false) })
        }
        map[f.key] = opts
      } else if (f.type === 'select') {
        const set = strVal(f.key)
        const inh = inheritedStr(f.key)
        map[f.key] = (f.options ?? []).map((opt) => ({
          value: opt,
          label: opt,
          mono: true,
          title: !set && inh === opt ? t('claudeBoot.inheritedHint', { value: opt }) : undefined
        }))
      }
    }
  }
  return map
})

function setBool(key: keyof ClaudeBootConfig, v: boolean | undefined): void {
  update({ [key]: v } as Partial<ClaudeBootConfig>)
}

// Select (effort / permissionMode) — neutral + the concrete values.
function setSelect(key: keyof ClaudeBootConfig, v: string | undefined): void {
  update({ [key]: v } as Partial<ClaudeBootConfig>)
}

// extraArgs live warning: which denylisted flags would be stripped.
const droppedExtra = computed<string[]>(() => {
  const raw = strVal('extraArgs')
  if (!raw.trim()) return []
  const out: string[] = []
  for (const tok of raw.split(/\s+/)) {
    const flag = tok.split('=')[0]
    if (DENYLISTED.has(flag)) out.push(flag)
  }
  return [...new Set(out)]
})

// ── provider (custom endpoint) ──────────────────────────────────────────────
// The endpoints list is global; this picker only references one by id. The
// neutral pill is "Anthropic default" (absence of a provider). An effective
// non-default provider (override here OR inherited) flips the Model control to
// free-text — the opus/sonnet/haiku/fable aliases don't map to a local id (D5).
const endpoints = computed(() => boot.endpoints)
const effectiveProvider = computed(() => strVal('provider') || inheritedStr('provider'))
const usingCustomProvider = computed(() => effectiveProvider.value !== '')

// Provider options for the shared <SegmentedControl> — each endpoint pill carries
// the Server icon + its base URL as the hover title.
const providerSegOptions = computed(() =>
  endpoints.value.map((ep) => ({ value: ep.id, label: ep.name, icon: Server, title: ep.baseUrl }))
)

function setProvider(id: string | undefined): void {
  update({ provider: id } as Partial<ClaudeBootConfig>)
}
function manageEndpoints(): void {
  // Jump to the global Endpoints registry editor (Settings → Endpoints).
  ui.openSettings('endpoints')
}

function label(key: keyof ClaudeBootConfig): string {
  return t(`claudeBoot.fields.${key}.label`)
}
function hint(key: keyof ClaudeBootConfig): string {
  return t(`claudeBoot.fields.${key}.hint`)
}
const eyebrowText = (k: string): string => t(`claudeBoot.sections.${k}`)
</script>

<template>
  <div>
    <!-- "applies to new sessions" note -->
    <p class="text-text-3" style="font-size: 11px; line-height: 1.5; margin-bottom: 14px">
      {{ introText }}
    </p>

    <!-- Provider (custom Anthropic-compatible endpoint) -->
    <section style="margin-bottom: 18px">
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
        {{ eyebrowText('provider') }}
      </div>
      <div class="text-text-2" style="font-size: 12px">{{ t('claudeBoot.provider.label') }}</div>
      <div class="text-text-3" style="font-size: 11px; line-height: 1.5; margin: 3px 0 7px">
        {{ t('claudeBoot.provider.hint') }}
      </div>
      <SegmentedControl
        :options="providerSegOptions"
        :model-value="strVal('provider') || undefined"
        :inherited-value="inheritedStr('provider') || undefined"
        allow-default
        :default-label="t('claudeBoot.provider.anthropic')"
        size="sm"
        :aria-label="t('claudeBoot.provider.label')"
        @update:model-value="setProvider($event as string | undefined)"
      >
        <template #trailing>
          <button
            type="button"
            class="border border-border text-text-3 transition hover:bg-surface-2 hover:text-text-2"
            style="padding: 5px 9px; font-size: 11.5px; border-radius: 5px; height: 26px"
            @click="manageEndpoints()"
          >
            {{ t('claudeBoot.provider.manage') }}
          </button>
        </template>
      </SegmentedControl>
      <p
        v-if="usingCustomProvider"
        class="text-warning"
        style="font-size: 11px; line-height: 1.5; margin-top: 8px"
      >
        {{ t('claudeBoot.provider.localNote') }}
      </p>
    </section>

    <section
      v-for="sec in SECTIONS"
      :key="sec.eyebrow"
      :style="{ marginBottom: '18px' }"
      :class="sec.eyebrow === 'danger' ? 'rounded' : ''"
    >
      <div
        :class="sec.eyebrow === 'danger' ? 'text-red' : 'text-text-3'"
        style="
          font-size: 11px;
          font-weight: 500;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          margin-bottom: 10px;
        "
      >
        {{ eyebrowText(sec.eyebrow) }}
      </div>

      <div v-for="f in sec.fields" :key="f.key" style="margin-bottom: 14px">
        <!-- boolean (tri-state) — label/hint left, segmented right -->
        <div v-if="f.type === 'bool'" class="flex items-start justify-between" style="gap: 12px">
          <div style="flex: 1; min-width: 0">
            <div :class="f.danger ? 'text-red' : 'text-text-2'" style="font-size: 12px">
              {{ label(f.key) }}
            </div>
            <div
              :class="f.danger ? 'text-warning' : 'text-text-3'"
              style="font-size: 11px; line-height: 1.5; margin-top: 3px"
            >
              {{ hint(f.key) }}
            </div>
          </div>
          <SegmentedControl
            class="shrink-0"
            :options="fieldSegOptions[f.key]"
            :model-value="boolVal(f.key)"
            :inherited-value="inheritedBool(f.key)"
            allow-default
            :default-label="triNeutralLabel"
            size="sm"
            :aria-label="label(f.key)"
            @update:model-value="setBool(f.key, $event as boolean | undefined)"
          />
        </div>

        <!-- model under a custom provider → free-text id (the aliases don't map) -->
        <template v-if="f.key === 'model' && usingCustomProvider">
          <label class="text-text-2" style="font-size: 12px">{{ label('model') }}</label>
          <div class="text-text-3" style="font-size: 11px; line-height: 1.5; margin: 3px 0 6px">
            {{ t('claudeBoot.provider.modelHint') }}
          </div>
          <input
            :value="strVal('model')"
            type="text"
            spellcheck="false"
            class="w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
            style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
            :placeholder="t('claudeBoot.provider.modelPlaceholder')"
            @input="update({ model: ($event.target as HTMLInputElement).value })"
          />
        </template>

        <!-- select (effort / permissionMode) — stacked, wrapped option pills -->
        <template v-else-if="f.type === 'select'">
          <div class="text-text-2" style="font-size: 12px">{{ label(f.key) }}</div>
          <div class="text-text-3" style="font-size: 11px; line-height: 1.5; margin: 3px 0 7px">
            {{ hint(f.key) }}
          </div>
          <SegmentedControl
            :options="fieldSegOptions[f.key]"
            :model-value="strVal(f.key) || undefined"
            :inherited-value="inheritedStr(f.key) || undefined"
            allow-default
            :default-label="triNeutralLabel"
            size="sm"
            :aria-label="label(f.key)"
            @update:model-value="setSelect(f.key, $event as string | undefined)"
          />
        </template>

        <!-- text (single line, optional suggestions) -->
        <template v-else-if="f.type === 'text'">
          <label class="text-text-2" style="font-size: 12px">{{ label(f.key) }}</label>
          <div class="text-text-3" style="font-size: 11px; line-height: 1.5; margin: 3px 0 6px">
            {{ hint(f.key) }}
          </div>
          <input
            :value="strVal(f.key)"
            :list="f.suggestions ? `cb-sugg-${f.key}` : undefined"
            type="text"
            spellcheck="false"
            class="w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
            style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
            :placeholder="placeholderFor(f.key)"
            @input="update({ [f.key]: ($event.target as HTMLInputElement).value })"
          />
          <datalist v-if="f.suggestions" :id="`cb-sugg-${f.key}`">
            <option v-for="s in f.suggestions" :key="s" :value="s" />
          </datalist>
        </template>

        <!-- textarea (multiline) -->
        <template v-else-if="f.type === 'textarea'">
          <label class="text-text-2" style="font-size: 12px">{{ label(f.key) }}</label>
          <div class="text-text-3" style="font-size: 11px; line-height: 1.5; margin: 3px 0 6px">
            {{ hint(f.key) }}
          </div>
          <textarea
            :value="strVal(f.key)"
            rows="3"
            spellcheck="false"
            class="scrollable w-full resize-y border border-border bg-bg text-text transition focus:border-accent-line focus:outline-none"
            style="padding: 6px 9px; font-size: 12px; border-radius: 5px; line-height: 1.5"
            :placeholder="placeholderFor(f.key)"
            @input="update({ [f.key]: ($event.target as HTMLTextAreaElement).value })"
          />
          <div
            v-if="accumulateNote(f.key)"
            class="text-text-3"
            style="font-size: 11px; line-height: 1.5; margin-top: 5px"
          >
            {{ accumulateNote(f.key) }}
          </div>
        </template>

        <!-- list (one entry per line) -->
        <template v-else-if="f.type === 'list'">
          <label class="text-text-2" style="font-size: 12px">{{ label(f.key) }}</label>
          <div class="text-text-3" style="font-size: 11px; line-height: 1.5; margin: 3px 0 6px">
            {{ hint(f.key) }}
          </div>
          <textarea
            :value="listVal(f.key)"
            rows="2"
            spellcheck="false"
            class="scrollable w-full resize-y border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
            style="padding: 6px 9px; font-size: 12px; border-radius: 5px; line-height: 1.6"
            :placeholder="
              inheritedStr(f.key)
                ? t('claudeBoot.inheritedHint', { value: inheritedStr(f.key) })
                : t('claudeBoot.listPlaceholder')
            "
            @input="onListInput(f.key, ($event.target as HTMLTextAreaElement).value)"
          />
          <div
            v-if="accumulateNote(f.key)"
            class="text-text-3"
            style="font-size: 11px; line-height: 1.5; margin-top: 5px"
          >
            {{ accumulateNote(f.key) }}
          </div>
        </template>

        <!-- extraArgs escape hatch -->
        <template v-else-if="f.type === 'extra'">
          <label class="text-text-2" style="font-size: 12px">{{ label(f.key) }}</label>
          <div class="text-text-3" style="font-size: 11px; line-height: 1.5; margin: 3px 0 6px">
            {{ hint(f.key) }}
          </div>
          <input
            :value="strVal('extraArgs')"
            type="text"
            spellcheck="false"
            class="w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
            style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
            :placeholder="t('claudeBoot.extraArgsPlaceholder')"
            @input="update({ extraArgs: ($event.target as HTMLInputElement).value })"
          />
          <div
            v-if="droppedExtra.length"
            class="flex items-start text-warning"
            style="gap: 6px; font-size: 11px; line-height: 1.5; margin-top: 6px"
          >
            <TriangleAlert
              :size="13"
              :stroke-width="1.7"
              class="shrink-0"
              style="margin-top: 1px"
            />
            <span>{{ t('claudeBoot.extraArgsDropped', { flags: droppedExtra.join(', ') }) }}</span>
          </div>
        </template>
      </div>
    </section>
  </div>
</template>
