<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingHint from './ui/SettingHint.vue'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import type { ParkSettings, Policy } from '../../../preload'

/**
 * Settings → Hibernation policy tab (T127 S4, design.md §6 → "Hibernation policy
 * pane"). Editor for the T119 fleet-hibernation policy (`src/main/fleet-policy.ts`),
 * previously hardcoded as `DEFAULT_POLICY` and only changeable by editing source and
 * rebuilding. Backed by `monitor:policyGet`/`monitor:policySet`
 * (`src/main/monitor/policy-store.ts`), and `pty.ts`'s `runPolicy()` reads the
 * persisted value on every cap/sweep check — an edit here changes real hibernation
 * behavior on the very next check, no restart.
 *
 * `lruIdleMs`/`hardIdleMs` are stored in milliseconds but edited here as minutes —
 * nobody thinks in milliseconds. Each field debounces its write-through (mirrors
 * `PushChannelsPane`'s `patch` pattern) and re-syncs from the server's response,
 * which clamps/rounds (`policy-store.ts`'s `applyPatch`), so the displayed value
 * always reflects what was actually persisted.
 *
 * T456: the "Ask before parking" group below the three fields — the `park` switch and the three
 * bounds on a negotiated park (`monitor:negotiationGet`/`Set`, `negotiation-settings.ts`). Same
 * debounce and re-sync; pending edits to different rows merge into one write.
 */

const { t } = useI18n()

const loading = ref(true)
const maxLive = ref(5)
const lruMinutes = ref(15)
const hardMinutes = ref(60)

function applyPolicy(policy: Policy): void {
  maxLive.value = policy.maxLive
  lruMinutes.value = Math.round(policy.lruIdleMs / 60_000)
  hardMinutes.value = Math.round(policy.hardIdleMs / 60_000)
}

// ---- T456: Ask before parking ------------------------------------------------------------------
const parkMode = ref<ParkSettings['park']>('ask')
const maxDeclines = ref(8)
const deferMinutes = ref(120)
const floorMb = ref(1536)
/** `off` is the only "off"; `facts` (facts only, no question sent) still counts as on. */
const askEnabled = computed(() => parkMode.value !== 'off')

function applyAsk(s: ParkSettings): void {
  parkMode.value = s.park
  maxDeclines.value = s.maxDeclines
  deferMinutes.value = Math.round(s.maxDeferMs / 60_000)
  floorMb.value = s.pressureFloorMb
}

let askTimer: ReturnType<typeof setTimeout> | null = null
let askPending: Partial<ParkSettings> = {}
function saveAskDebounced(patch: Partial<ParkSettings>): void {
  askPending = { ...askPending, ...patch }
  if (askTimer) clearTimeout(askTimer)
  askTimer = setTimeout(() => {
    askTimer = null
    const out = askPending
    askPending = {}
    void window.api.monitorNegotiationSet(out).then(applyAsk)
  }, 300)
}

function onAskToggle(on: boolean): void {
  // On writes `ask`, off writes `off`. A stored `facts` is left alone until the operator toggles.
  parkMode.value = on ? 'ask' : 'off'
  saveAskDebounced({ park: parkMode.value })
}
function onMaxDeclinesInput(raw: string): void {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  maxDeclines.value = n
  saveAskDebounced({ maxDeclines: n })
}
function onDeferInput(raw: string): void {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  deferMinutes.value = n
  saveAskDebounced({ maxDeferMs: n * 60_000 })
}
function onFloorInput(raw: string): void {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  floorMb.value = n
  saveAskDebounced({ pressureFloorMb: n })
}

onMounted(async () => {
  try {
    const [policy, ask] = await Promise.all([
      window.api.monitorPolicyGet(),
      window.api.monitorNegotiationGet()
    ])
    applyPolicy(policy)
    applyAsk(ask)
  } finally {
    loading.value = false
  }
})

let saveTimer: ReturnType<typeof setTimeout> | null = null
function saveDebounced(patch: Partial<Policy>): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void window.api.monitorPolicySet(patch).then(applyPolicy)
  }, 300)
}

function onMaxLiveInput(raw: string): void {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  maxLive.value = n
  saveDebounced({ maxLive: n })
}
function onLruInput(raw: string): void {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  lruMinutes.value = n
  saveDebounced({ lruIdleMs: n * 60_000 })
}
function onHardInput(raw: string): void {
  const n = Number(raw)
  if (!Number.isFinite(n)) return
  hardMinutes.value = n
  saveDebounced({ hardIdleMs: n * 60_000 })
}
</script>

<template>
  <div v-if="!loading">
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
        {{ t('hibernationPolicy.eyebrow') }}
      </div>
      <p class="text-text-3" style="font-size: 11.5px; line-height: 1.5; margin-bottom: 14px">
        {{ t('hibernationPolicy.intro') }}
      </p>

      <div class="flex items-start justify-between" style="gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('hibernationPolicy.maxLive.label') }}
          </div>
          <SettingHint>{{ t('hibernationPolicy.maxLive.hint') }}</SettingHint>
        </div>
        <input
          type="number"
          min="1"
          max="50"
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
          :value="maxLive"
          :aria-label="t('hibernationPolicy.maxLive.label')"
          @input="onMaxLiveInput(($event.target as HTMLInputElement).value)"
        />
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('hibernationPolicy.lruIdleMs.label') }}
          </div>
          <SettingHint>{{ t('hibernationPolicy.lruIdleMs.hint') }}</SettingHint>
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
            :value="lruMinutes"
            :aria-label="t('hibernationPolicy.lruIdleMs.label')"
            @input="onLruInput(($event.target as HTMLInputElement).value)"
          />
          <span class="text-text-3" style="font-size: 11.5px">{{
            t('hibernationPolicy.minutesSuffix')
          }}</span>
        </div>
      </div>

      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('hibernationPolicy.hardIdleMs.label') }}
          </div>
          <SettingHint>{{ t('hibernationPolicy.hardIdleMs.hint') }}</SettingHint>
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
            :value="hardMinutes"
            :aria-label="t('hibernationPolicy.hardIdleMs.label')"
            @input="onHardInput(($event.target as HTMLInputElement).value)"
          />
          <span class="text-text-3" style="font-size: 11.5px">{{
            t('hibernationPolicy.minutesSuffix')
          }}</span>
        </div>
      </div>
    </section>

    <section style="margin-top: 24px">
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
        {{ t('hibernationPolicy.ask.eyebrow') }}
      </div>
      <p class="text-text-3" style="font-size: 11.5px; line-height: 1.5; margin-bottom: 14px">
        {{ t('hibernationPolicy.ask.intro') }}
      </p>

      <div class="flex items-start justify-between" style="gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('hibernationPolicy.ask.enabled.label') }}
          </div>
          <SettingHint>{{ t('hibernationPolicy.ask.enabled.hint') }}</SettingHint>
          <SettingHint v-if="parkMode === 'facts'">{{
            t('hibernationPolicy.ask.factsOnly')
          }}</SettingHint>
        </div>
        <ToggleSwitch
          :model-value="askEnabled"
          :aria-label="t('hibernationPolicy.ask.enabled.label')"
          @update:model-value="onAskToggle"
        />
      </div>

      <div
        class="flex items-start justify-between"
        :class="askEnabled ? '' : 'opacity-40'"
        style="gap: 12px; margin-top: 14px"
      >
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('hibernationPolicy.ask.maxDeclines.label') }}
          </div>
          <SettingHint>{{ t('hibernationPolicy.ask.maxDeclines.hint') }}</SettingHint>
        </div>
        <div class="flex items-center" style="gap: 6px">
          <input
            type="number"
            min="1"
            max="100"
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
            :value="maxDeclines"
            :disabled="!askEnabled"
            :aria-label="t('hibernationPolicy.ask.maxDeclines.label')"
            @input="onMaxDeclinesInput(($event.target as HTMLInputElement).value)"
          />
          <span class="text-text-3" style="font-size: 11.5px">{{
            t('hibernationPolicy.ask.timesSuffix')
          }}</span>
        </div>
      </div>

      <div
        class="flex items-start justify-between"
        :class="askEnabled ? '' : 'opacity-40'"
        style="gap: 12px; margin-top: 14px"
      >
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('hibernationPolicy.ask.maxDeferMs.label') }}
          </div>
          <SettingHint>{{ t('hibernationPolicy.ask.maxDeferMs.hint') }}</SettingHint>
        </div>
        <div class="flex items-center" style="gap: 6px">
          <input
            type="number"
            min="0"
            max="1440"
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
            :value="deferMinutes"
            :disabled="!askEnabled"
            :aria-label="t('hibernationPolicy.ask.maxDeferMs.label')"
            @input="onDeferInput(($event.target as HTMLInputElement).value)"
          />
          <span class="text-text-3" style="font-size: 11.5px">{{
            t('hibernationPolicy.minutesSuffix')
          }}</span>
        </div>
      </div>

      <div
        class="flex items-start justify-between"
        :class="askEnabled ? '' : 'opacity-40'"
        style="gap: 12px; margin-top: 14px"
      >
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ t('hibernationPolicy.ask.pressureFloorMb.label') }}
          </div>
          <SettingHint>{{ t('hibernationPolicy.ask.pressureFloorMb.hint') }}</SettingHint>
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
            :value="floorMb"
            :disabled="!askEnabled"
            :aria-label="t('hibernationPolicy.ask.pressureFloorMb.label')"
            @input="onFloorInput(($event.target as HTMLInputElement).value)"
          />
          <span class="text-text-3" style="font-size: 11.5px">{{
            t('hibernationPolicy.ask.mbSuffix')
          }}</span>
        </div>
      </div>
    </section>
  </div>
</template>
