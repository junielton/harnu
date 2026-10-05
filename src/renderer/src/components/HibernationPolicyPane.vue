<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SettingHint from './ui/SettingHint.vue'
import type { Policy } from '../../../preload'

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

onMounted(async () => {
  try {
    applyPolicy(await window.api.monitorPolicyGet())
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
  </div>
</template>
