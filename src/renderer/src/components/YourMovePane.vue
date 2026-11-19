<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from './ui/Button.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import SettingHint from './ui/SettingHint.vue'
import { useSessionsStore } from '../stores/sessions'
import type { CardView } from '../../../main/your-move/core'
import type { InspectNowResult, YourMovePrefsView } from '../../../main/your-move/ipc'

/**
 * Settings → Your move (design.md §6 → "Your move pane"). The one mode setting
 * (Off / Observe / Live) and, below it, a debug list of the cards the judge stored.
 *
 * Every string the judge wrote (`ask`) is shown with text interpolation only: it is model
 * output, never markup. No control here acts on a card; nothing answers one in U1.
 */

const { t, locale } = useI18n()
const sessions = useSessionsStore()

type Mode = YourMovePrefsView['mode']

const mode = ref<Mode>('off')
const loaded = ref(false)
const cards = ref<CardView[]>([])
const running = ref(false)
const result = ref<InspectNowResult | null>(null)

const modeOptions = computed(() => [
  { value: 'off', label: t('yourMove.mode.off') },
  { value: 'observe', label: t('yourMove.mode.observe') },
  { value: 'live', label: t('yourMove.mode.live') }
])

const selected = computed(() => sessions.selectedSession)

async function refreshCards(): Promise<void> {
  cards.value = await window.api.yourMoveList()
}

async function onMode(next: unknown): Promise<void> {
  if (next !== 'off' && next !== 'observe' && next !== 'live') return
  mode.value = next
  // Re-sync from what main persisted, never from the optimistic value.
  mode.value = (await window.api.yourMoveSetPrefs({ mode: next })).mode
}

async function inspectNow(): Promise<void> {
  const s = selected.value
  if (!s || running.value) return
  running.value = true
  result.value = null
  try {
    result.value = await window.api.yourMoveInspectNow({
      sessionId: s.sessionId,
      folder: s.projectPath
    })
  } finally {
    running.value = false
  }
  await refreshCards()
}

const outcomeText = computed(() => {
  const r = result.value
  if (!r) return ''
  return t(`yourMove.inspect.outcome.${r.outcome}`, { reason: r.reason ?? '' })
})

const ordered = computed(() => {
  const open = cards.value.filter((c) => c.closedAt === undefined)
  const closed = cards.value.filter((c) => c.closedAt !== undefined)
  return [
    ...open.sort((a, b) => b.openedAt - a.openedAt),
    ...closed.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))
  ]
})

const folderAlias = (folder: string): string => folder.split('/').filter(Boolean).pop() ?? folder
const when = (ms: number): string => new Date(ms).toLocaleString(locale.value)

let off: (() => void) | null = null
onMounted(async () => {
  try {
    mode.value = (await window.api.yourMovePrefsGet()).mode
    await refreshCards()
  } finally {
    loaded.value = true
  }
  off = window.api.onYourMoveChanged(() => void refreshCards())
})
onBeforeUnmount(() => off?.())
</script>

<template>
  <div v-if="loaded">
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
        {{ t('yourMove.eyebrow') }}
      </div>
      <p class="text-text-3" style="font-size: 11.5px; line-height: 1.5; margin-bottom: 14px">
        {{ t('yourMove.intro') }}
      </p>

      <div class="text-text-2" style="font-size: 12px; margin-bottom: 6px">
        {{ t('yourMove.mode.label') }}
      </div>
      <SegmentedControl
        :model-value="mode"
        :options="modeOptions"
        :aria-label="t('yourMove.mode.label')"
        @update:model-value="onMode"
      />
      <SettingHint style="margin-top: 6px">{{ t(`yourMove.mode.hint.${mode}`) }}</SettingHint>
      <SettingHint>{{ t('yourMove.mode.cost') }}</SettingHint>
    </section>

    <section style="margin-bottom: 16px">
      <div class="flex items-center" style="gap: 10px">
        <Button
          variant="ghost"
          data-testid="your-move-inspect"
          :disabled="!selected || running"
          @click="inspectNow"
        >
          {{ running ? t('yourMove.inspect.running') : t('yourMove.inspect.button') }}
        </Button>
        <span
          v-if="outcomeText"
          class="text-text-3"
          style="font-size: 11.5px"
          data-testid="your-move-result"
        >
          {{ outcomeText }}
        </span>
      </div>
      <SettingHint style="margin-top: 6px">
        {{ selected ? t('yourMove.inspect.hint') : t('yourMove.inspect.hintNone') }}
      </SettingHint>
    </section>

    <section>
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
        {{ t('yourMove.list.eyebrow', { count: ordered.length }) }}
      </div>
      <p
        v-if="ordered.length === 0"
        class="text-text-4"
        style="font-size: 11.5px"
        data-testid="your-move-empty"
      >
        {{ t('yourMove.list.empty') }}
      </p>
      <div v-else class="flex flex-col" style="gap: 6px">
        <div
          v-for="c in ordered"
          :key="c.id"
          class="bg-surface border border-border"
          :class="c.closedAt !== undefined ? 'text-text-4' : 'text-text-2'"
          style="border-radius: var(--radius); padding: 8px 10px"
          data-testid="your-move-card"
        >
          <div class="flex items-center" style="gap: 8px">
            <span
              class="bg-accent-soft text-accent font-mono"
              style="font-size: 10.5px; border-radius: var(--radius-sm); padding: 1px 6px"
            >
              {{ t(`yourMove.kind.${c.kind}`) }}
            </span>
            <span class="text-text-3" style="font-size: 11.5px; min-width: 0">
              {{ folderAlias(c.folder) }} ·
              {{ t('yourMove.list.session', { id: c.sessionId.slice(0, 8) }) }}
            </span>
            <span class="text-text-4" style="font-size: 11px; margin-left: auto">
              {{ t(`yourMove.lane.${c.lane}`) }} · {{ when(c.openedAt) }}
              <template v-if="c.closedBy">
                ·
                {{ t('yourMove.list.closed', { reason: t(`yourMove.closedBy.${c.closedBy}`) }) }}
              </template>
            </span>
          </div>
          <div style="font-size: 12px; margin-top: 4px; white-space: pre-wrap">{{ c.ask }}</div>
        </div>
      </div>
    </section>
  </div>
</template>
