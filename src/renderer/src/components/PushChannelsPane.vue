<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Trash2, Send, Smartphone, Webhook } from 'lucide-vue-next'
import { usePushStore } from '../stores/push'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import type { PushChannel, PushChannelKind } from '../../../preload'

/**
 * Settings → Remote notifications tab (remote-push spec, design.md §6 →
 * Remote notifications). The registry editor for remote push channels — an ntfy
 * topic (phone) or a generic webhook. Mirrors EndpointsPane's anatomy (saved
 * cards + add form) and adds the master switch + pause row on top. Edits write
 * through the push store (IPC → `<userData>/push.json`); the SEND path re-reads
 * that file main-side, so changes apply to the very next notification.
 */

const push = usePushStore()
const { t } = useI18n()

onMounted(() => {
  if (!push.loaded) void push.load()
})

const config = computed(() => push.config)

// A 30s ticker so an active pause visibly expires without reopening the pane.
const now = ref(Date.now())
const ticker = setInterval(() => (now.value = Date.now()), 30_000)
onBeforeUnmount(() => clearInterval(ticker))

const paused = computed(
  () => config.value.pausedUntil !== null && now.value < config.value.pausedUntil
)
const pausedUntilLabel = computed(() => {
  const ts = config.value.pausedUntil
  if (ts === null) return ''
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
})

const masterEnabled = computed({
  get: () => config.value.enabled,
  set: (v: boolean) => void push.setEnabled(v)
})

const PAUSE_OPTIONS = [
  { ms: 30 * 60_000, labelKey: 'push.pause.m30' },
  { ms: 60 * 60_000, labelKey: 'push.pause.h1' },
  { ms: 8 * 60 * 60_000, labelKey: 'push.pause.h8' }
]

function pauseFor(ms: number): void {
  now.value = Date.now()
  void push.pauseFor(ms)
}

function resume(): void {
  void push.resume()
}

// --- Channel rows -----------------------------------------------------------

const KIND_ICON: Record<PushChannelKind, typeof Smartphone> = {
  ntfy: Smartphone,
  webhook: Webhook
}

// Inline edits debounce a write-through per channel id (cf. EndpointsPane).
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
function patch(ch: PushChannel, key: 'label' | 'url' | 'token', value: string): void {
  const next = { ...ch, [key]: value }
  const existing = saveTimers.get(ch.id)
  if (existing) clearTimeout(existing)
  saveTimers.set(
    ch.id,
    setTimeout(() => {
      saveTimers.delete(ch.id)
      void push.saveChannel(next)
    }, 250)
  )
}

/** Toggles write through immediately — a switch must never feel debounced. */
function setChannelEnabled(ch: PushChannel, enabled: boolean): void {
  void push.saveChannel({ ...ch, enabled })
}

function setChannelEvent(ch: PushChannel, key: keyof PushChannel['events'], v: boolean): void {
  void push.saveChannel({ ...ch, events: { ...ch.events, [key]: v } })
}

function remove(id: string): void {
  void push.deleteChannel(id)
}

// --- Send test ---------------------------------------------------------------

type TestState = 'sending' | 'ok' | 'fail'
const testState = ref<Record<string, TestState>>({})

async function sendTest(key: string, channel: Partial<PushChannel>): Promise<void> {
  testState.value = { ...testState.value, [key]: 'sending' }
  let ok = false
  try {
    const result = await push.test(channel, {
      title: t('push.testMessage.title'),
      body: t('push.testMessage.body')
    })
    ok = result.ok
  } catch {
    // A rejected invoke (IPC teardown, malformed payload) must land on "fail",
    // never leave the button stuck on "Sending…".
  }
  testState.value = { ...testState.value, [key]: ok ? 'ok' : 'fail' }
  setTimeout(() => {
    const { [key]: _drop, ...rest } = testState.value
    testState.value = rest
  }, 4000)
}

function testLabel(key: string): string {
  const s = testState.value[key]
  if (s === 'sending') return t('push.testing')
  if (s === 'ok') return t('push.testOk')
  if (s === 'fail') return t('push.testFail')
  return t('push.test')
}

// --- Add form ----------------------------------------------------------------

const draftKind = ref<PushChannelKind>('ntfy')
const draftLabel = ref('')
const draftUrl = ref('')
const draftToken = ref('')

const canAdd = computed(() => {
  try {
    const u = new URL(draftUrl.value.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
})

const EVENT_KEYS = ['needsInput', 'completed', 'failed'] as const

async function add(): Promise<void> {
  if (!canAdd.value) return
  await push.saveChannel({
    kind: draftKind.value,
    label: draftLabel.value.trim(),
    url: draftUrl.value.trim(),
    ...(draftToken.value.trim() ? { token: draftToken.value.trim() } : {}),
    enabled: true,
    events: { needsInput: true, completed: true, failed: true }
  })
  draftLabel.value = ''
  draftUrl.value = ''
  draftToken.value = ''
}

function draftChannel(): Partial<PushChannel> {
  return {
    kind: draftKind.value,
    label: draftLabel.value.trim(),
    url: draftUrl.value.trim(),
    ...(draftToken.value.trim() ? { token: draftToken.value.trim() } : {})
  }
}
</script>

<template>
  <div>
    <p class="text-text-3" style="font-size: 11px; line-height: 1.5; margin-bottom: 14px">
      {{ t('push.intro') }}
    </p>

    <!-- Master switch + pause -->
    <section
      class="border border-border bg-bg"
      style="border-radius: 7px; padding: 12px; margin-bottom: 18px"
    >
      <div class="flex items-center justify-between" style="gap: 8px">
        <div class="min-w-0">
          <div class="text-text" style="font-size: 12.5px; font-weight: 500">
            {{ t('push.master.label') }}
          </div>
          <div class="text-text-3" style="font-size: 11px; line-height: 1.5; margin-top: 2px">
            {{ t('push.master.hint') }}
          </div>
        </div>
        <ToggleSwitch v-model="masterEnabled" :aria-label="t('push.master.label')" />
      </div>

      <div
        v-if="config.enabled"
        class="flex items-center justify-between border-t border-border"
        style="gap: 8px; margin-top: 12px; padding-top: 12px"
      >
        <template v-if="paused">
          <span class="text-warning" style="font-size: 11.5px">
            {{ t('push.paused', { time: pausedUntilLabel }) }}
          </span>
          <button
            type="button"
            class="border border-border text-text-2 transition hover:bg-surface-2"
            style="padding: 4px 10px; font-size: 11.5px; border-radius: 5px; background: none"
            @click="resume()"
          >
            {{ t('push.pause.resume') }}
          </button>
        </template>
        <template v-else>
          <span class="text-text-3" style="font-size: 11px">{{ t('push.pause.eyebrow') }}</span>
          <div class="flex" style="gap: 6px">
            <button
              v-for="opt in PAUSE_OPTIONS"
              :key="opt.ms"
              type="button"
              class="border border-border text-text-2 transition hover:bg-surface-2"
              style="padding: 4px 10px; font-size: 11.5px; border-radius: 5px; background: none"
              @click="pauseFor(opt.ms)"
            >
              {{ t(opt.labelKey) }}
            </button>
          </div>
        </template>
      </div>
    </section>

    <!-- Saved channels -->
    <section v-if="config.channels.length" style="margin-bottom: 18px">
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
        {{ t('push.savedEyebrow') }}
      </div>
      <div
        v-for="ch in config.channels"
        :key="ch.id"
        class="border border-border bg-bg"
        style="border-radius: 7px; padding: 12px; margin-bottom: 10px"
      >
        <div class="flex items-center justify-between" style="gap: 8px; margin-bottom: 10px">
          <div class="flex min-w-0 items-center text-text-2" style="gap: 6px; font-size: 12px">
            <component
              :is="KIND_ICON[ch.kind]"
              :size="13"
              :stroke-width="1.7"
              class="shrink-0 text-text-3"
            />
            <span class="truncate">{{ ch.label || ch.url }}</span>
          </div>
          <div class="flex shrink-0 items-center" style="gap: 8px">
            <button
              type="button"
              class="flex items-center border border-border text-text-2 transition hover:bg-surface-2 disabled:opacity-40"
              style="
                padding: 4px 10px;
                font-size: 11.5px;
                border-radius: 5px;
                gap: 5px;
                background: none;
              "
              :disabled="testState[ch.id] === 'sending'"
              @click="sendTest(ch.id, ch)"
            >
              <Send :size="11" :stroke-width="1.7" />
              {{ testLabel(ch.id) }}
            </button>
            <ToggleSwitch
              :model-value="ch.enabled"
              :aria-label="t('push.master.label')"
              @update:model-value="(v: boolean) => setChannelEnabled(ch, v)"
            />
            <button
              type="button"
              class="flex shrink-0 items-center justify-center rounded text-text-3 transition hover:bg-surface-2 hover:text-red"
              style="width: 24px; height: 24px"
              :aria-label="t('push.remove')"
              :title="t('push.remove')"
              @click="remove(ch.id)"
            >
              <Trash2 :size="13" :stroke-width="1.6" />
            </button>
          </div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
          <label class="text-text-3" style="font-size: 11px">
            {{ t('push.fields.label') }}
            <input
              :value="ch.label"
              type="text"
              spellcheck="false"
              class="mt-1 w-full border border-border bg-bg text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
              @input="patch(ch, 'label', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="text-text-3" style="font-size: 11px">
            {{ t('push.fields.token') }}
            <input
              :value="ch.token ?? ''"
              type="password"
              spellcheck="false"
              autocomplete="off"
              :placeholder="t('push.fields.tokenPlaceholder')"
              class="mt-1 w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
              @input="patch(ch, 'token', ($event.target as HTMLInputElement).value)"
            />
          </label>
          <label class="text-text-3" style="font-size: 11px; grid-column: 1 / -1">
            {{ t('push.fields.url') }}
            <input
              :value="ch.url"
              type="text"
              spellcheck="false"
              class="mt-1 w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
              @input="patch(ch, 'url', ($event.target as HTMLInputElement).value)"
            />
          </label>
        </div>
        <div class="flex items-center" style="gap: 14px; margin-top: 10px">
          <span class="text-text-3" style="font-size: 11px">{{ t('push.events.eyebrow') }}</span>
          <label
            v-for="key in EVENT_KEYS"
            :key="key"
            class="flex items-center text-text-2"
            style="gap: 5px; font-size: 11.5px; cursor: pointer"
          >
            <input
              type="checkbox"
              :checked="ch.events[key]"
              @change="setChannelEvent(ch, key, ($event.target as HTMLInputElement).checked)"
            />
            {{ t(`push.events.${key}`) }}
          </label>
        </div>
      </div>
    </section>

    <!-- Add a channel -->
    <section>
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
        {{ t('push.addEyebrow') }}
      </div>
      <div class="border border-border bg-bg" style="border-radius: 7px; padding: 12px">
        <div style="margin-bottom: 10px">
          <SegmentedControl
            v-model="draftKind"
            size="sm"
            :aria-label="t('push.fields.kind')"
            :options="[
              { value: 'ntfy', label: t('push.fields.kindNtfy'), mono: true },
              { value: 'webhook', label: t('push.fields.kindWebhook') }
            ]"
          />
        </div>
        <p
          v-if="draftKind === 'ntfy'"
          class="text-text-3"
          style="font-size: 11px; line-height: 1.5; margin-bottom: 10px"
        >
          {{ t('push.ntfyHint') }}
        </p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
          <label class="text-text-3" style="font-size: 11px">
            {{ t('push.fields.label') }}
            <input
              v-model.trim="draftLabel"
              type="text"
              spellcheck="false"
              :placeholder="t('push.fields.labelPlaceholder')"
              class="mt-1 w-full border border-border bg-bg text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
            />
          </label>
          <label class="text-text-3" style="font-size: 11px">
            {{ t('push.fields.token') }}
            <input
              v-model.trim="draftToken"
              type="password"
              spellcheck="false"
              autocomplete="off"
              :placeholder="t('push.fields.tokenPlaceholder')"
              class="mt-1 w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
            />
          </label>
          <label class="text-text-3" style="font-size: 11px; grid-column: 1 / -1">
            {{ t('push.fields.url') }}
            <input
              v-model.trim="draftUrl"
              type="text"
              spellcheck="false"
              :placeholder="
                draftKind === 'ntfy'
                  ? t('push.fields.urlPlaceholderNtfy')
                  : t('push.fields.urlPlaceholderWebhook')
              "
              class="mt-1 w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
              style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
            />
          </label>
        </div>
        <div class="flex items-center justify-between" style="margin-top: 12px">
          <button
            type="button"
            class="flex items-center border border-border text-text-2 transition hover:bg-surface-2 disabled:opacity-40"
            style="
              padding: 6px 12px;
              font-size: 12px;
              border-radius: 5px;
              gap: 6px;
              background: none;
            "
            :disabled="!canAdd || testState['draft'] === 'sending'"
            @click="sendTest('draft', draftChannel())"
          >
            <Send :size="12" :stroke-width="1.7" />
            {{ testLabel('draft') }}
          </button>
          <button
            type="button"
            class="flex items-center bg-accent text-accent-ink transition disabled:opacity-40"
            style="
              padding: 7px 14px;
              font-size: 12.5px;
              font-weight: 500;
              border-radius: 5px;
              height: 28px;
              border: none;
              gap: 6px;
            "
            :disabled="!canAdd"
            @click="add()"
          >
            <Plus :size="13" :stroke-width="2" />
            {{ t('push.add') }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>
