<script setup lang="ts">
/**
 * "Harnu mod outside Harnu" (design §6 → "Harnu mod outside Harnu (T389)"): the one switch of
 * the Mods tab's settings region (`#mods-companion`). It lets `claude` sessions started in the
 * operator's own terminal load the Harnu mod, by adding one folder to
 * `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (main does the write and the exact
 * undo). Default OFF, and never the Skills tab's "Also outside Harnu" switch.
 *
 * Turning it ON always opens the confirm dialog first, and nothing is written before **Turn on**.
 * Turning it OFF needs no dialog. A refusal is a `danger` toast with one sentence; the switch
 * stays where it was. Reuses existing components only: `ToggleSwitch`, `SettingHint`, `Button`,
 * and the confirm-dialog anatomy of `MissionCloseConfirmDialog`.
 *
 * Every `window.api` call is optional-chained: a preload without the channel (and every test
 * double of `window.api`) simply renders nothing.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronRight, X } from 'lucide-vue-next'
import { useFocusTrap } from '../composables/useFocusTrap'
import { lastSeenText, refusalToast } from '../lib/external-view'
import { useUiStore } from '../stores/ui'
import type { ExternalPaneState } from '../../../main/companion/external-host'
import Button from './ui/Button.vue'
import SettingHint from './ui/SettingHint.vue'
import ToggleSwitch from './ui/ToggleSwitch.vue'

const { t, locale } = useI18n()
const ui = useUiStore()

const state = ref<ExternalPaneState | null>(null)
const advancedOpen = ref(false)
const confirming = ref(false)
const busy = ref(false)
const now = ref(Date.now())
let off: (() => void) | null = null

const translate = (key: string, params?: Record<string, unknown>): string =>
  t(key, params ?? {}) as string

async function refresh(): Promise<void> {
  const next = (await window.api.companionExternalGet?.().catch(() => null)) ?? null
  if (next) {
    state.value = next
    now.value = Date.now()
  }
}

onMounted(() => {
  void refresh()
  off = window.api.onCompanionUpdated?.(() => void refresh()) ?? null
})
onBeforeUnmount(() => off?.())

const lastSeen = computed(() =>
  lastSeenText(state.value?.lastSeenAt ?? null, now.value, translate, locale.value)
)

async function apply(on: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const r = await window.api.companionExternalSet?.(on)
    if (r) {
      const toast = refusalToast(r, translate)
      if (toast) ui.pushToast({ kind: 'danger', ...toast })
    }
  } finally {
    busy.value = false
    await refresh()
  }
}

function onToggle(next: boolean): void {
  if (next) confirming.value = true
  else void apply(false)
}

function onAccept(): void {
  confirming.value = false
  void apply(true)
}

// ---- the confirm dialog's focus and keys (anatomy of MissionCloseConfirmDialog) -----------------

const dialogRef = ref<HTMLElement | null>(null)
const cancelRef = ref<InstanceType<typeof Button> | null>(null)
/** Initial focus is Cancel: the dialog exists to stop a stray click or Enter. */
const cancelEl = computed<HTMLElement | null>(() => (cancelRef.value?.$el as HTMLElement) ?? null)

useFocusTrap({
  active: confirming,
  containerRef: dialogRef,
  initialFocusRef: cancelEl
})

function onKeydown(e: KeyboardEvent): void {
  if (confirming.value && e.key === 'Escape') {
    e.stopPropagation()
    confirming.value = false
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

function onBackdropMousedown(e: MouseEvent): void {
  if (e.target === e.currentTarget) confirming.value = false
}

const eyebrowStyle =
  'font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 8px'
</script>

<template>
  <section v-if="state" data-testid="mods-external">
    <button
      type="button"
      class="flex items-center text-text-3 transition hover:text-text-2"
      style="gap: 5px"
      :style="eyebrowStyle"
      :aria-expanded="advancedOpen"
      data-testid="mods-external-advanced"
      @click="advancedOpen = !advancedOpen"
    >
      <component :is="advancedOpen ? ChevronDown : ChevronRight" :size="12" :stroke-width="2" />
      {{ $t('harnuMod.external.title') }}
    </button>

    <div v-if="advancedOpen">
      <SettingHint style="margin-bottom: 8px">{{ $t('harnuMod.external.hint') }}</SettingHint>
      <div
        class="flex items-center justify-between border border-border bg-surface"
        style="gap: 12px; padding: 8px 10px; border-radius: 6px"
      >
        <div style="flex: 1; min-width: 0">
          <div class="truncate text-text-2" style="font-size: 12px">
            {{ $t('harnuMod.external.label') }}
          </div>
          <div class="truncate font-mono text-text-4" style="font-size: 11px">
            {{ $t('harnuMod.external.path') }}
          </div>
        </div>
        <ToggleSwitch
          :model-value="state.on"
          :disabled="busy || (!state.on && !state.companionOn)"
          :aria-label="$t('harnuMod.external.label')"
          data-testid="mods-external-toggle"
          @update:model-value="onToggle"
        />
      </div>
      <SettingHint v-if="!state.companionOn && !state.on" style="margin-top: 6px">
        {{ $t('harnuMod.external.needsMod') }}
      </SettingHint>
      <SettingHint style="margin-top: 6px" data-testid="mods-external-last-seen">
        {{ lastSeen }}
      </SettingHint>
    </div>
  </section>

  <Teleport to="body">
    <div
      v-if="confirming"
      class="anim-overlay-fade fixed inset-0 flex items-center justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 60"
      role="presentation"
      @mousedown="onBackdropMousedown"
    >
      <div
        ref="dialogRef"
        class="anim-fade-in-scale flex flex-col border border-border-2 bg-surface text-text"
        style="
          width: min(440px, 90vw);
          max-height: 80vh;
          border-radius: 9px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        aria-labelledby="mods-external-confirm-title"
        data-testid="mods-external-confirm"
        @mousedown.stop
      >
        <header
          class="flex shrink-0 items-center justify-between border-b border-border"
          style="padding: 14px 18px 10px"
        >
          <h2
            id="mods-external-confirm-title"
            class="text-text"
            style="font-size: 13.5px; line-height: 20px; font-weight: 600"
          >
            {{ $t('harnuMod.external.confirm.title') }}
          </h2>
          <button
            class="flex items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-text"
            style="width: 24px; height: 24px"
            :aria-label="$t('harnuMod.external.confirm.cancel')"
            @click="confirming = false"
          >
            <X :size="14" :stroke-width="1.5" />
          </button>
        </header>

        <div
          class="scrollable overflow-y-auto text-text-2"
          style="padding: 14px 18px; font-size: 12.5px; line-height: 19px"
        >
          <p>{{ $t('harnuMod.external.confirm.body') }}</p>
          <div style="margin-top: 10px">
            <span class="block text-text-3" style="font-size: 11px; margin-bottom: 3px">{{
              $t('harnuMod.external.confirm.entry')
            }}</span>
            <span
              class="block break-all font-mono text-text-3"
              style="font-size: 11px"
              data-testid="mods-external-entry"
              >{{ state?.candidate ?? '…' }}</span
            >
          </div>
        </div>

        <footer
          class="flex shrink-0 items-center justify-end border-t border-border"
          style="padding: 12px 18px; gap: 8px"
        >
          <Button ref="cancelRef" variant="ghost" @click="confirming = false">
            {{ $t('harnuMod.external.confirm.cancel') }}
          </Button>
          <Button data-testid="mods-external-accept" @click="onAccept">
            {{ $t('harnuMod.external.confirm.accept') }}
          </Button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
