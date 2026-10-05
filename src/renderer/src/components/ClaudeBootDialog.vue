<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import { useUiStore } from '../stores/ui'
import { useClaudeBootStore } from '../stores/claudeBoot'
import { useRoutingPolicyStore } from '../stores/routingPolicy'
import { useFocusTrap } from '../composables/useFocusTrap'
import ClaudeBootForm from './ClaudeBootForm.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import type { ClaudeBootConfig, RoutingTable, RoutingEntry } from '../../../preload'

/**
 * Per-folder "Claude Boot" dialog (design.md §6 — Claude Boot). A `Dialog`
 * variant that scopes the launch-options form to one folder path. Loads that
 * folder's overrides on open, edits a local copy, and debounced-persists via the
 * store. Empty fields inherit the global config. Structure mirrors
 * `SettingsDialog.vue` (Teleport, backdrop, focus trap, Esc + backdrop close).
 *
 * T97: also hosts the minimal per-repo MODEL ROUTING editor — deliberately
 * folded into this SAME folder-settings surface rather than a new dialog/menu
 * entry. Human-only by construction: no MCP verb touches `routing-policy.json`,
 * so this dialog + `stores/routingPolicy.ts` are the ONLY writers.
 */

const ui = useUiStore()
const boot = useClaudeBootStore()
const routingPolicy = useRoutingPolicyStore()
const { t } = useI18n()

/** Mirror of `roadmap-core.CARD_KINDS` (T105) — the routing table's per-kind rows. */
const ROUTING_KINDS = ['scout', 'bug', 'feature', 'review', 'chore'] as const
type RoutingKind = (typeof ROUTING_KINDS)[number]

/**
 * Mirror of `routing-policy.HARDCODED_ROUTING_DEFAULTS` (T97 §10.1 Q12) — the
 * operator-approved defaults shown as the "inherited" placeholder on an
 * un-overridden per-kind row (main is a node module; the renderer mirrors the
 * wire shape rather than cross-import, same convention as `stores/roadmap.ts`).
 */
const HARDCODED_ROUTING_DEFAULTS: Record<RoutingKind, RoutingEntry> = {
  scout: { model: 'haiku', effort: 'low' },
  bug: { model: 'sonnet', effort: 'high' },
  feature: { model: 'sonnet', effort: 'high' },
  review: { model: 'opus', effort: 'high' },
  chore: { model: 'sonnet', effort: 'high' }
}

const ROUTING_MODEL_OPTIONS = ['opus', 'sonnet', 'haiku', 'fable']
const ROUTING_EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max']

const routingTable = ref<RoutingTable>({})
let routingSaveTimer: ReturnType<typeof setTimeout> | null = null

function routingEntry(kind: RoutingKind | 'default'): RoutingEntry {
  if (kind === 'default') return routingTable.value.default ?? {}
  return routingTable.value.byKind?.[kind] ?? {}
}

/** Patch one field of one row, prune empties, and debounced-persist. */
function setRoutingField(
  kind: RoutingKind | 'default',
  field: keyof RoutingEntry,
  value: string | undefined
): void {
  const next: RoutingTable = {
    ...(routingTable.value.byKind ? { byKind: { ...routingTable.value.byKind } } : {}),
    ...(routingTable.value.default ? { default: { ...routingTable.value.default } } : {})
  }
  const target: RoutingEntry = { ...(kind === 'default' ? next.default : next.byKind?.[kind]) }
  if (value) target[field] = value
  else delete target[field]

  if (kind === 'default') {
    if (Object.keys(target).length > 0) next.default = target
    else delete next.default
  } else {
    if (Object.keys(target).length > 0) {
      next.byKind = { ...next.byKind, [kind]: target }
    } else if (next.byKind) {
      const { [kind]: _dropped, ...rest } = next.byKind
      next.byKind = rest
    }
    if (next.byKind && Object.keys(next.byKind).length === 0) delete next.byKind
  }

  routingTable.value = next
  if (routingSaveTimer) clearTimeout(routingSaveTimer)
  routingSaveTimer = setTimeout(() => {
    routingSaveTimer = null
    void routingPolicy.saveFolder(folderPath.value, routingTable.value)
  }, 200)
}

function flushRoutingSave(): void {
  if (!routingSaveTimer) return
  clearTimeout(routingSaveTimer)
  routingSaveTimer = null
  void routingPolicy.saveFolder(folderPath.value, routingTable.value)
}

const isOpen = computed(() => ui.dialog === 'claudeBoot')
const folderPath = computed(() => ui.claudeBootPath ?? '')
const folderName = computed(() => {
  const p = folderPath.value.replace(/[/\\]+$/, '')
  const base = p.split(/[/\\]/).pop()
  return base || p
})

const config = ref<ClaudeBootConfig>({})
// The global config this folder inherits, read main-side (single source of truth
// shared with the session dialog — T57 #2) and kept reactive (T57 #4): re-resolved
// on open and whenever the global config changes while the dialog is open.
const inherited = ref<ClaudeBootConfig>({})
let saveTimer: ReturnType<typeof setTimeout> | null = null

async function refreshInherited(): Promise<void> {
  inherited.value = await boot.getResolved(undefined)
}

function onUpdate(next: ClaudeBootConfig): void {
  config.value = next
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void boot.saveFolder(folderPath.value, config.value)
  }, 200)
}

function reset(): void {
  onUpdate({})
}

function close(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
    void boot.saveFolder(folderPath.value, config.value)
  }
  flushRoutingSave()
  ui.closeDialog()
}

const dialogRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLElement | null>(null)
useFocusTrap({ active: isOpen, containerRef: dialogRef, initialFocusRef: closeButtonRef })

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) close()
}
function onKeydown(e: KeyboardEvent): void {
  if (!isOpen.value) return
  if (e.key === 'Escape') {
    e.stopPropagation()
    close()
  }
}

watch(isOpen, async (open) => {
  if (open) {
    void boot.init() // ensure the global config is loaded for the inherited pre-fill
    config.value = await boot.getFolder(folderPath.value)
    await refreshInherited()
    routingTable.value = await routingPolicy.getFolder(folderPath.value)
    window.addEventListener('keydown', onKeydown, true)
  } else {
    window.removeEventListener('keydown', onKeydown, true)
  }
})

// Live inheritance (T57 #4): re-resolve the inherited (global) config when it
// changes in-app while this dialog is open, so placeholders reflect it.
watch(
  () => boot.global,
  () => {
    if (isOpen.value) void refreshInherited()
  },
  { deep: true }
)

onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        style="
          width: min(560px, 90vw);
          max-height: 82vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="claude-boot-dialog-title"
        @mousedown.stop
      >
        <header
          class="flex shrink-0 items-start justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <div style="min-width: 0">
            <h2
              id="claude-boot-dialog-title"
              class="truncate text-text"
              style="font-size: 13.5px; line-height: 20px; font-weight: 600"
            >
              {{ t('claudeBoot.dialogTitle', { folder: folderName }) }}
            </h2>
            <div
              class="truncate font-mono text-text-4"
              style="font-size: 11px; margin-top: 2px"
              :title="folderPath"
            >
              {{ folderPath }}
            </div>
          </div>
          <button
            class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px; margin-left: 12px"
            type="button"
            :aria-label="t('settings.close')"
            @click="close()"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <div class="scrollable flex-1 overflow-y-auto" style="padding: 14px 18px">
          <ClaudeBootForm
            :model-value="config"
            :inherited="inherited"
            scope="folder"
            @update:model-value="onUpdate"
          />

          <!-- T97: per-repo model routing table — human-only, no MCP verb reads
               or writes this. Resolved at roadmap-board dispatch time (kind →
               row → hardcoded default); the neutral pill = "use the built-in
               default" (per-row) or "no override" (the fallback row). -->
          <section style="margin-top: 4px; padding-top: 14px" class="border-t border-border">
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
              {{ t('routingPolicy.sectionTitle') }}
            </div>
            <p class="text-text-4" style="font-size: 11px; line-height: 1.5; margin-bottom: 12px">
              {{ t('routingPolicy.sectionHint') }}
            </p>

            <div
              v-for="kind in [...ROUTING_KINDS, 'default' as const]"
              :key="kind"
              class="flex flex-wrap items-center"
              style="gap: 8px 12px; margin-bottom: 10px"
            >
              <span
                class="text-text-2"
                :class="kind !== 'default' ? 'font-mono' : ''"
                style="font-size: 12px; width: 62px; flex-shrink: 0"
              >
                {{ kind === 'default' ? t('routingPolicy.defaultRow') : kind }}
              </span>
              <SegmentedControl
                :options="ROUTING_MODEL_OPTIONS.map((m) => ({ value: m, label: m, mono: true }))"
                :model-value="routingEntry(kind).model"
                :inherited-value="
                  kind === 'default' ? undefined : HARDCODED_ROUTING_DEFAULTS[kind].model
                "
                allow-default
                :default-label="t('claudeBoot.tri.inherit')"
                size="sm"
                :aria-label="t('routingPolicy.modelLabel')"
                @update:model-value="setRoutingField(kind, 'model', $event as string | undefined)"
              />
              <SegmentedControl
                :options="ROUTING_EFFORT_OPTIONS.map((e) => ({ value: e, label: e, mono: true }))"
                :model-value="routingEntry(kind).effort"
                :inherited-value="
                  kind === 'default' ? undefined : HARDCODED_ROUTING_DEFAULTS[kind].effort
                "
                allow-default
                :default-label="t('claudeBoot.tri.inherit')"
                size="sm"
                :aria-label="t('routingPolicy.effortLabel')"
                @update:model-value="setRoutingField(kind, 'effort', $event as string | undefined)"
              />
            </div>
          </section>
        </div>

        <footer
          class="flex shrink-0 items-center justify-between border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <button
            type="button"
            class="border border-border bg-transparent text-text-3 transition hover:text-text"
            style="padding: 7px 14px; font-size: 12.5px; border-radius: 5px; height: 28px"
            @click="reset()"
          >
            {{ t('claudeBoot.resetFolder') }}
          </button>
          <button
            ref="closeButtonRef"
            type="button"
            class="border border-border bg-transparent text-text-2 transition hover:text-text"
            style="
              padding: 7px 14px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              height: 28px;
            "
            @click="close()"
          >
            {{ t('settings.close') }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
