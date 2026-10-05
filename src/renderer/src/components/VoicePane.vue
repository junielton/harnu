<script setup lang="ts">
/**
 * Settings → Voice tab (design.md §6 → "Voice", T239). The interruptor for a
 * machine that was already fully built: the engine and its queue/mute (T237),
 * the runtime-downloaded Kokoro backend (T241) and the `speak` verb's gate
 * (T238). This pane designs none of that — it makes it reachable.
 *
 * Four product rules are enforced here rather than merely documented:
 *
 *  1. **Enabling voice never starts a download.** The master switch, the engine
 *     picker and this component's mount all leave the network alone; the ONLY
 *     call to `speechKokoroInstall` hangs off an explicit button.
 *  2. **What it says is the product.** The phrase template is a first-class
 *     field with a live preview, because "Done" spoken aloud is worth strictly
 *     less than the chime that already exists.
 *  3. **Fallback is silent but visible.** A failed utterance falls back to the
 *     packaged chime without complaining (the sessions store does that); the
 *     status line here is where the operator finds out WHY, so voice is never
 *     mute with no explanation.
 *  4. **Portuguese is disabled with a reason, never quietly broken.**
 *     `kokoro-js` hardcodes `en-us`/`en-gb`; downloading more does not unlock it.
 *  5. **Every button whose only output is audio narrates itself** (BUG-104).
 *     Audio is the one output an operator cannot see, so "nothing happened" has
 *     to be told apart from "muted", "loading the model" and "the backend
 *     failed". `speak()` already resolves with a `SpeakOutcome`; this pane
 *     renders it in words. See `lib/voice-probe.ts`.
 *
 * Reuses existing components only: `ToggleSwitch`, `SegmentedControl`,
 * `SettingHint`, the Inputs frame and the ghost/accent buttons. No new token.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Ban,
  Check,
  Download,
  Loader2,
  Play,
  TriangleAlert,
  Trash2,
  Volume2,
  VolumeX,
  X
} from 'lucide-vue-next'
import { useVoiceStore } from '../stores/voice'
import { useSessionsStore } from '../stores/sessions'
import { speech, speechErrorMessageKey } from '../lib/speech'
import {
  speechDropReason,
  speechProbeView,
  type SpeechDropReason,
  type SpeechProbePhase
} from '../lib/voice-probe'
import type { SpeechErrorCode } from '../lib/speech-backend'
import { KOKORO_ENGLISH_ONLY_KEY, kokoroLocaleSupport } from '../lib/speech-kokoro-voices'
import {
  renderVoicePhrase,
  normalizeFolderForSpeech,
  normalizeSessionForSpeech
} from '../lib/voice-phrase'
import { formatBytes } from './system-monitor-format'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import SettingHint from './ui/SettingHint.vue'
import type { SpeechBackendId } from '../lib/speech-backend'
// The per-voice size is main's number (one embedding file), not a figure typed
// into the UI — the pane must never quote a size the downloader disagrees with.
import { KOKORO_VOICE_BYTES } from '../../../main/speech-kokoro-plan'

const { t } = useI18n()
const voice = useVoiceStore()
const sessions = useSessionsStore()

onMounted(() => {
  // Reads status, the command and the gate. Deliberately NOT a download.
  void voice.load()
})
onBeforeUnmount(() => voice.dispose())

// ---- Engine ----------------------------------------------------------------

const engineOptions = computed(() => [
  { value: 'system-command' as SpeechBackendId, label: t('voice.engine.systemCommand') },
  { value: 'kokoro' as SpeechBackendId, label: t('voice.engine.kokoro') }
])

/**
 * `null` while the field is untouched, so the input follows the store; a string
 * once the operator types, so a debounced write-through cannot yank the caret.
 * Deliberately a ref rather than a "is a timer pending" flag — a plain `let`
 * would not be a reactive dependency, and the computed would silently stop
 * re-evaluating.
 */
const commandDraft = ref<string | null>(null)
let commandTimer: ReturnType<typeof setTimeout> | null = null

function onCommandInput(value: string): void {
  commandDraft.value = value
  if (commandTimer) clearTimeout(commandTimer)
  commandTimer = setTimeout(() => {
    commandTimer = null
    commandDraft.value = null
    void voice.setCommand(value.trim())
  }, 300)
}

onBeforeUnmount(() => {
  if (commandTimer) clearTimeout(commandTimer)
  if (phraseTimer) clearTimeout(phraseTimer)
})

const commandValue = computed(() => commandDraft.value ?? voice.command)

// ---- Download --------------------------------------------------------------

/** The consent figures, from main's own plan — never a number typed in the UI. */
const planBytes = ref<number | null>(null)

onMounted(async () => {
  try {
    planBytes.value = (await window.api.speechKokoroPlan()).totalBytes
  } catch {
    planBytes.value = null
  }
})

const downloadSize = computed(() => (planBytes.value === null ? '' : formatBytes(planBytes.value)))

/**
 * True when a download is running but no tick has landed yet — the moment after
 * the click, and the moment after coming back to a tab that was unmounted while
 * the download carried on (the status IPC reports `installing` but carries no
 * byte counts). Rendering "0 B / 119 MB · 0%" there would be a number the app
 * does not actually have, so the bar goes indeterminate and says "Starting"
 * instead until the next tick, 200 ms away.
 */
const progressUnknown = computed(() => voice.installing && voice.progress === null)

const progressPercent = computed(() => {
  const p = voice.progress
  if (!p || p.totalBytes <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((p.receivedBytes / p.totalBytes) * 100)))
})

const progressPhaseLabel = computed(() => {
  const phase = voice.progress?.phase
  if (!phase) return t('voice.download.starting')
  return t(`voice.download.phase.${phase}`)
})

// ---- Speaking out loud — the probe (product rule 5, BUG-104) ----------------

/**
 * Which control asked for the current utterance: `'phrase'` for the Test button
 * under WHAT IT SAYS, `voice:<id>` for a row in the VOICES list. One probe for
 * the whole pane, because there is one queue behind it — two controls reporting
 * "speaking" at once would be a lie about a machine that serialises.
 */
const probeTarget = ref<string | null>(null)
const probePhase = ref<SpeechProbePhase>('idle')
const probeDrop = ref<SpeechDropReason | null>(null)
const probeError = ref<SpeechErrorCode | null>(null)

const probe = computed(() =>
  speechProbeView(probePhase.value, { dropReason: probeDrop.value, errorCode: probeError.value })
)

/**
 * True from the click until the promise settles. Every speak control in the
 * pane is disabled while it holds — the answer to "what happens on a second
 * press" is **nothing**, deliberately: the engine QUEUES, so a second press
 * would buy a second utterance played after the first, which is the pile-up
 * this state exists to prevent (and, with a cold Kokoro, the press most likely
 * to happen — the model takes a beat and the button looks dead without this).
 */
const probeBusy = computed(() => probe.value.busy)

/** Is this control the one currently reporting? Keeps 27 other rows silent. */
function probeFor(target: string): boolean {
  return probeTarget.value === target
}

/**
 * `pending` → `speaking` on the engine's own signal, never on a timer. The
 * engine is a QUEUE, so "something is being spoken" is not the same as "mine
 * is": ours has started exactly when the engine is speaking and nothing is
 * waiting behind the current utterance. Pressing Test while an agent is
 * mid-sentence is the case this distinction is for — the click is acknowledged
 * immediately even though the audio is still a whole utterance away.
 */
watch(
  () => [voice.speaking, voice.queued] as const,
  ([speakingNow, queuedNow]) => {
    if (probePhase.value !== 'pending') return
    if (speakingNow && queuedNow === 0) probePhase.value = 'speaking'
  }
)

/**
 * Has Kokoro spoken at least once in this window? The backend caches the loaded
 * model on its own closure, so only the FIRST utterance pays the ~92 MB load —
 * and that first one is the one that looks broken. The pane cannot see inside
 * the backend (that would be an engine change), but it can remember whether it
 * has ever heard a `spoken` come back, which is the same question.
 */
const kokoroWarm = ref(false)

/** Shown under "Speaking…" only while the cold load is the honest explanation. */
const showColdModelHint = computed(
  () => probePhase.value === 'speaking' && voice.backend === 'kokoro' && !kokoroWarm.value
)

async function runSpeech(target: string, text: string): Promise<void> {
  if (probeBusy.value) return
  probeTarget.value = target
  probePhase.value = 'pending'
  probeDrop.value = null
  probeError.value = null

  // Read the reason BEFORE the call: `speak` collapses every refusal into
  // `'dropped'`, and by the time it answers the prefs may already have moved.
  const reason = speechDropReason({
    text,
    maxChars: voice.prefs.maxChars,
    enabled: voice.enabled,
    muted: voice.muted,
    source: 'human'
  })

  const outcome = await speech.speak(text, { source: 'human' })
  probePhase.value = outcome
  if (outcome === 'spoken' && voice.backend === 'kokoro') kokoroWarm.value = true
  if (outcome === 'dropped') probeDrop.value = reason
  if (outcome === 'failed') probeError.value = speech.state.lastError
}

// ---- Voices ----------------------------------------------------------------

/**
 * One row per VOICE, never per model: the 92 MB model is shared infrastructure
 * that downloads once, while each voice is a separate ~511 KB file.
 */
const voiceRows = computed(() =>
  voice.catalog.map((v) => ({
    ...v,
    downloaded: voice.downloadedVoices.includes(v.id),
    selected: voice.voice === v.id
  }))
)

const downloadedCount = computed(() => voice.downloadedVoices.length)

/**
 * Rule 4. Every locale the app itself speaks, answered honestly — `pt-BR` comes
 * back `unavailable` with its reason, so the row renders disabled-with-a-cause
 * instead of offering a voice that would read Portuguese with English phonemes.
 */
const unavailableLocales = computed(() =>
  ['pt-BR']
    .map((locale) => kokoroLocaleSupport(locale))
    .filter((l) => l.status === 'unavailable')
    .map((l) => ({ locale: l.locale, reasonKey: l.reasonKey ?? KOKORO_ENGLISH_ONLY_KEY }))
)

const selectedVoiceName = computed(
  () => voice.catalog.find((v) => v.id === voice.voice)?.name ?? voice.voice
)

/**
 * The 28-row catalog lives in a bounded scroller (design.md §4 "Layout
 * dimensions" → settings-pane bounded list), so WHAT IT SAYS, SESSIONS and the
 * disk row stay reachable. Two things have to survive that bound: the operator
 * must still be able to find the voice in use (the summary line above, plus this
 * scroll-into-view), and keyboard focus must still work inside it (native
 * buttons in a `tabindex="0"` region — nothing here traps or steals focus).
 */
const voiceListRef = ref<HTMLElement | null>(null)

function revealSelectedVoice(): void {
  const list = voiceListRef.value
  if (!list) return
  const row = list.querySelector<HTMLElement>('[data-voice-selected="true"]')
  // `scrollIntoView` is not implemented in jsdom, and a missing scroll is never
  // worth an exception in a settings pane.
  row?.scrollIntoView?.({ block: 'nearest' })
}

watch(
  () => [voice.backend, voice.voice] as const,
  () => void nextTick(revealSelectedVoice),
  { immediate: true }
)

/**
 * Pressing a voice both SELECTS it and speaks it. The row's icon has always been
 * a `play`, and a play that plays nothing is the same silence this card is
 * about — previewing without selecting is not on offer, because the engine reads
 * the chosen voice from the prefs at utterance time and nothing below this pane
 * takes a per-utterance override.
 */
function selectVoice(id: string): void {
  if (probeBusy.value) return
  voice.setVoice(id)
  void runSpeech(`voice:${id}`, phrasePreview.value)
}

/** The voice already in use — hear it again without changing anything. */
function previewVoice(id: string): void {
  void runSpeech(`voice:${id}`, phrasePreview.value)
}

function getVoice(id: string): void {
  void voice.install([id])
}

// ---- What it says ----------------------------------------------------------

const EVENT_KEYS = ['needsInput', 'completed', 'failed'] as const

const phraseDraft = ref<string | null>(null)
let phraseTimer: ReturnType<typeof setTimeout> | null = null

const phraseValue = computed(() => phraseDraft.value ?? voice.phrase)

function onPhraseInput(value: string): void {
  phraseDraft.value = value
  if (phraseTimer) clearTimeout(phraseTimer)
  phraseTimer = setTimeout(() => {
    phraseTimer = null
    voice.setPhrase(value)
    phraseDraft.value = null
  }, 300)
}

/**
 * The live example, rendered from the same pure functions the real path uses
 * (BUG-129) — so the preview is exactly what a real notification would say,
 * slug/UUID normalization included.
 */
const phrasePreview = computed(() =>
  renderVoicePhrase(phraseValue.value, {
    folder: normalizeFolderForSpeech(t('voice.phrase.sampleFolder')),
    session: normalizeSessionForSpeech(t('voice.phrase.sampleSession')),
    event: t('voice.events.needsInput')
  })
)

/**
 * A `human`-sourced utterance, so it is never suppressed by the focus rule: the
 * operator pressed Test, they get to hear it wherever they are looking. The
 * outcome is rendered in words next to the button — see `runSpeech`.
 */
function testPhrase(): void {
  void runSpeech('phrase', phrasePreview.value)
}

// ---- Sessions (the `speak` gate) -------------------------------------------

const blockedPaths = computed(() => sessions.agentDeniedPaths)

/**
 * Folders the operator touched in THIS pane. A row returned to "Default" would
 * otherwise disappear the instant it stops being an exception — the control
 * vanishing under the cursor, with no chance to see the inherited state that was
 * just chosen. View state only: nothing about it is persisted.
 */
const touched = ref(new Set<string>())

const exceptionRows = computed(() =>
  voice.exceptionRows(
    sessions.folders.map((f) => ({ path: f.path, alias: f.alias })),
    blockedPaths.value,
    touched.value
  )
)

const folderOptions = computed(() => [
  { value: true, label: t('voice.sessions.on') },
  { value: false, label: t('voice.sessions.off') }
])

function setFolder(path: string, value: boolean | undefined): void {
  touched.value = new Set([...touched.value, path])
  void voice.setAgentFolder(path, value === undefined ? null : value)
}

// ---- Status ----------------------------------------------------------------

const errorMessage = computed(() => {
  const key = speechErrorMessageKey(voice.lastError)
  return key ? t(key) : null
})

const eyebrowStyle =
  'font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 8px'
const GHOST_BUTTON =
  'padding: 4px 10px; font-size: 11.5px; border-radius: 5px; background: none; gap: 5px'

/** Tone → token. Never a raw colour (CLAUDE.md → design contract). */
const PROBE_TONE_CLASS = {
  busy: 'text-text-3',
  ok: 'text-green',
  info: 'text-text-2',
  warn: 'text-warning'
} as const

const PROBE_TONE_ICON = {
  busy: Loader2,
  ok: Check,
  info: VolumeX,
  warn: TriangleAlert
} as const

/**
 * design.md §4 → "Layout dimensions" → **Settings pane — bounded list**. Roughly
 * five rows of this list, which is enough to read the catalog as a list and
 * short enough that WHAT IT SAYS is still on screen. Declared there first; this
 * is the reference, not an invented number.
 */
const LIST_MAX_HEIGHT = '280px'
</script>

<template>
  <div>
    <p class="text-text-3" style="font-size: 11px; line-height: 1.5; margin-bottom: 14px">
      {{ $t('voice.intro') }}
    </p>

    <!-- Master switch. Turning it on starts NOTHING (product rule 1). -->
    <section
      class="border border-border bg-bg"
      style="border-radius: 7px; padding: 12px; margin-bottom: 18px"
    >
      <div class="flex items-center justify-between" style="gap: 8px">
        <div class="min-w-0">
          <div class="text-text" style="font-size: 12.5px; font-weight: 500">
            {{ $t('voice.master.label') }}
          </div>
          <SettingHint>{{ $t('voice.master.hint') }}</SettingHint>
        </div>
        <ToggleSwitch
          :model-value="voice.enabled"
          :aria-label="$t('voice.master.label')"
          @update:model-value="voice.setEnabled($event)"
        />
      </div>

      <div
        v-if="voice.enabled"
        class="flex items-center justify-between border-t border-border"
        style="gap: 8px; margin-top: 12px; padding-top: 12px"
      >
        <span class="text-text-2" style="font-size: 12px">{{ $t('voice.mute.label') }}</span>
        <ToggleSwitch
          :model-value="voice.muted"
          :aria-label="$t('voice.mute.label')"
          @update:model-value="voice.setMuted($event)"
        />
      </div>

      <!-- Rule 3: the fallback is silent, the REASON is not. -->
      <div
        v-if="errorMessage"
        data-testid="voice-status"
        class="flex items-start bg-red-soft"
        style="gap: 6px; margin-top: 12px; padding: 8px 10px; border-radius: 6px"
      >
        <TriangleAlert
          :size="13"
          :stroke-width="1.8"
          class="text-warning"
          style="margin-top: 1px; flex: none"
        />
        <div class="text-text-2" style="font-size: 11.5px; line-height: 1.5">
          {{ errorMessage }}
          <div class="text-text-3">{{ $t('voice.status.fellBackToChime') }}</div>
        </div>
      </div>
    </section>

    <!-- ENGINE -->
    <section style="margin-bottom: 18px">
      <div class="text-text-3" :style="eyebrowStyle">{{ $t('voice.engine.eyebrow') }}</div>

      <SegmentedControl
        :model-value="voice.backend"
        :options="engineOptions"
        size="sm"
        :aria-label="$t('voice.engine.eyebrow')"
        style="margin-bottom: 10px"
        @update:model-value="voice.setBackend($event as SpeechBackendId)"
      />

      <!-- System command: the operator's own TTS. Nothing to download. -->
      <div
        v-if="voice.backend === 'system-command'"
        class="border border-border bg-bg"
        style="border-radius: 7px; padding: 12px"
      >
        <label class="text-text-3" style="font-size: 11px">
          {{ $t('voice.engine.commandLabel') }}
          <input
            :value="commandValue"
            type="text"
            spellcheck="false"
            data-testid="voice-command"
            class="mt-1 w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
            style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
            @input="onCommandInput(($event.target as HTMLInputElement).value)"
          />
        </label>
        <SettingHint style="margin-top: 6px">{{ $t('voice.engine.commandHint') }}</SettingHint>
      </div>

      <!-- Kokoro: selecting it downloads NOTHING (product rule 1). -->
      <div v-else class="border border-border bg-bg" style="border-radius: 7px; padding: 12px">
        <template v-if="voice.installing">
          <div
            class="flex items-center justify-between"
            style="gap: 10px; margin-bottom: 8px; font-size: 11.5px"
          >
            <span class="text-text-2">{{ progressPhaseLabel }}</span>
            <span v-if="!progressUnknown" class="tabular-nums text-text-3">
              {{ formatBytes(voice.progress?.receivedBytes ?? 0) }} /
              {{ formatBytes(voice.progress?.totalBytes ?? planBytes ?? 0) }}
            </span>
          </div>
          <div
            class="bg-surface-2"
            style="height: 4px; border-radius: 2px; overflow: hidden"
            role="progressbar"
            :aria-valuenow="progressUnknown ? undefined : progressPercent"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div
              class="bg-accent"
              data-testid="voice-progress-fill"
              :class="progressUnknown ? 'anim-shimmer-dot' : ''"
              style="height: 100%; transition: width var(--dur) var(--ease)"
              :style="{ width: progressUnknown ? '100%' : progressPercent + '%' }"
            />
          </div>
          <div class="flex justify-end" style="margin-top: 10px">
            <button
              type="button"
              data-testid="voice-cancel"
              class="flex items-center border border-border text-text-2 transition hover:bg-surface-2"
              :style="GHOST_BUTTON"
              @click="voice.cancelInstall()"
            >
              <X :size="11" :stroke-width="1.8" />
              {{ $t('voice.download.cancel') }}
            </button>
          </div>
        </template>

        <template v-else-if="!voice.installed">
          <div class="text-text-2" style="font-size: 12px">
            {{ $t('voice.download.size', { size: downloadSize }) }}
          </div>
          <SettingHint style="margin-top: 4px">{{ $t('voice.download.neverAuto') }}</SettingHint>
          <SettingHint style="margin-top: 4px">{{ $t('voice.download.licence') }}</SettingHint>
          <div
            v-if="voice.directory"
            class="truncate font-mono text-text-4"
            style="font-size: 11px; margin-top: 6px"
            :title="voice.directory"
          >
            {{ voice.directory }}
          </div>
          <div class="flex justify-end" style="margin-top: 12px">
            <button
              type="button"
              data-testid="voice-download"
              class="flex items-center bg-accent text-accent-ink transition"
              style="
                padding: 7px 14px;
                font-size: 12.5px;
                font-weight: 500;
                border-radius: 5px;
                height: 28px;
                border: none;
                gap: 6px;
              "
              @click="voice.install()"
            >
              <Download :size="13" :stroke-width="2" />
              {{ $t('voice.download.start') }}
            </button>
          </div>
        </template>

        <template v-else>
          <div class="text-text-2" style="font-size: 12px">{{ $t('voice.download.ready') }}</div>
          <SettingHint style="margin-top: 4px">{{ $t('voice.download.offlineHint') }}</SettingHint>
        </template>

        <div
          v-if="voice.installError"
          class="text-warning"
          style="font-size: 11.5px; line-height: 1.5; margin-top: 8px"
        >
          {{ $t('voice.download.failed') }}
        </div>
      </div>
    </section>

    <!-- VOICES — a list of voices, not of models. -->
    <section v-if="voice.backend === 'kokoro'" style="margin-bottom: 18px">
      <div class="text-text-3" :style="eyebrowStyle">{{ $t('voice.voices.eyebrow') }}</div>

      <!-- The voice in use, ALWAYS visible: 28 rows in a bounded scroller means
           the selected one is usually out of sight, and a setting you cannot
           read is not a setting. The list also scrolls to it on open. -->
      <div
        data-testid="voice-in-use"
        class="text-text-2"
        style="font-size: 11.5px; margin-bottom: 8px"
      >
        {{ $t('voice.voices.inUse', { name: selectedVoiceName }) }}
      </div>

      <div
        ref="voiceListRef"
        data-testid="voice-list"
        class="scrollable flex flex-col overflow-y-auto"
        style="gap: 4px"
        :style="{ maxHeight: LIST_MAX_HEIGHT }"
        tabindex="0"
        role="group"
        :aria-label="$t('voice.voices.listAria')"
      >
        <div
          v-for="row in voiceRows"
          :key="row.id"
          :data-voice-row="row.id"
          :data-voice-selected="row.selected ? 'true' : 'false'"
          class="flex shrink-0 items-center justify-between border border-border bg-surface"
          style="gap: 12px; padding: 8px 10px; border-radius: 6px"
        >
          <div style="flex: 1; min-width: 0">
            <div class="truncate text-text" style="font-size: 12.5px">{{ row.name }}</div>
            <div class="truncate font-mono text-text-4" style="font-size: 11px">{{ row.id }}</div>
          </div>
          <div class="flex shrink-0 items-center text-text-3" style="gap: 10px; font-size: 11px">
            <span class="font-mono">{{ row.locale }}</span>
            <span>{{ row.grade }}</span>
            <span class="tabular-nums">{{ formatBytes(KOKORO_VOICE_BYTES) }}</span>
          </div>
          <div class="flex shrink-0 items-center" style="gap: 6px">
            <span
              v-if="row.selected"
              class="border border-accent-line bg-accent-soft text-accent"
              style="padding: 2px 7px; font-size: 10.5px; border-radius: 4px"
            >
              {{ $t('voice.voices.default') }}
            </span>
            <!-- The voice already in use: hear it again, changing nothing. -->
            <button
              v-if="row.downloaded && row.selected"
              type="button"
              :data-testid="`voice-preview-${row.id}`"
              class="flex items-center border border-border text-text-2 transition hover:bg-surface-2 disabled:opacity-40"
              :style="GHOST_BUTTON"
              :disabled="probeBusy"
              :aria-label="$t('voice.voices.previewAria', { name: row.name })"
              @click="previewVoice(row.id)"
            >
              <Loader2
                v-if="probeBusy && probeFor(`voice:${row.id}`)"
                :size="11"
                :stroke-width="1.8"
                class="anim-spin"
              />
              <Volume2 v-else :size="11" :stroke-width="1.8" />
              {{ $t('voice.voices.preview') }}
            </button>
            <!-- Selecting a voice also speaks it: the icon has always been a
                 `play`, and a play that plays nothing is the silence BUG-104
                 is about. -->
            <button
              v-else-if="row.downloaded && !row.selected"
              type="button"
              :data-testid="`voice-use-${row.id}`"
              class="flex items-center border border-border text-text-2 transition hover:bg-surface-2 disabled:opacity-40"
              :style="GHOST_BUTTON"
              :disabled="probeBusy"
              @click="selectVoice(row.id)"
            >
              <Loader2
                v-if="probeBusy && probeFor(`voice:${row.id}`)"
                :size="11"
                :stroke-width="1.8"
                class="anim-spin"
              />
              <Play v-else :size="11" :stroke-width="1.8" />
              {{ $t('voice.voices.use') }}
            </button>
            <button
              v-else-if="!row.downloaded"
              type="button"
              class="flex items-center border border-border text-text-2 transition hover:bg-surface-2 disabled:opacity-40"
              :style="GHOST_BUTTON"
              :disabled="voice.installing"
              @click="getVoice(row.id)"
            >
              <Download :size="11" :stroke-width="1.8" />
              {{ $t('voice.voices.get') }}
            </button>
          </div>
        </div>
      </div>

      <!-- Rule 4: visibly disabled, WITH the reason. Never silently missing —
           and deliberately OUTSIDE the scroller, because a disclosure buried
           under 28 rows is a disclosure nobody reads. -->
      <div class="flex flex-col" style="gap: 4px; margin-top: 4px">
        <div
          v-for="locale in unavailableLocales"
          :key="locale.locale"
          data-testid="voice-locale-unavailable"
          class="flex items-start justify-between border border-border bg-surface"
          style="gap: 12px; padding: 8px 10px; border-radius: 6px; opacity: 0.45"
          aria-disabled="true"
        >
          <div style="flex: 1; min-width: 0">
            <div class="font-mono text-text-2" style="font-size: 12.5px">{{ locale.locale }}</div>
            <SettingHint>{{ $t(locale.reasonKey) }}</SettingHint>
          </div>
          <span class="shrink-0 text-text-4" style="font-size: 11px">
            {{ $t('voice.voices.unavailable') }}
          </span>
        </div>
      </div>

      <!-- The outcome of a per-voice press, in words. One line for the whole
           list: the engine has one queue, so only one row can be speaking. -->
      <div
        v-if="probeTarget?.startsWith('voice:') && probe.messageKey"
        data-testid="voice-preview-status"
        class="flex items-start"
        :class="PROBE_TONE_CLASS[probe.tone]"
        style="gap: 6px; margin-top: 8px; font-size: 11.5px; line-height: 1.5"
        role="status"
      >
        <component
          :is="PROBE_TONE_ICON[probe.tone]"
          :size="12"
          :stroke-width="1.8"
          :class="probe.tone === 'busy' ? 'anim-spin' : ''"
          style="margin-top: 2px; flex: none"
        />
        <span>
          {{ $t(probe.messageKey) }}
          <span v-if="showColdModelHint" class="text-text-4" style="display: block">
            {{ $t('voice.test.coldModel') }}
          </span>
        </span>
      </div>

      <SettingHint style="margin-top: 8px">
        {{
          $t('voice.voices.summary', {
            voices: voice.catalog.length,
            languages: voice.localeCount,
            downloaded: downloadedCount
          })
        }}
      </SettingHint>
    </section>

    <!-- WHAT IT SAYS — product rule 2. -->
    <section style="margin-bottom: 18px">
      <div class="text-text-3" :style="eyebrowStyle">{{ $t('voice.says.eyebrow') }}</div>
      <SettingHint style="margin-bottom: 10px">{{ $t('voice.says.hint') }}</SettingHint>

      <!-- Rule 3 again, at the other end: voice rides the notification decision, so
           with the master notifications switch off nothing is ever spoken. Saying
           so here is the difference between a setting that looks configured and
           an operator who can find out why the room is quiet. -->
      <div
        v-if="!sessions.notifyPrefs.enabled"
        data-testid="voice-notifications-off"
        class="flex items-start bg-red-soft"
        style="gap: 6px; margin-bottom: 12px; padding: 8px 10px; border-radius: 6px"
      >
        <TriangleAlert
          :size="13"
          :stroke-width="1.8"
          class="text-warning"
          style="margin-top: 1px; flex: none"
        />
        <div class="text-text-2" style="font-size: 11.5px; line-height: 1.5">
          {{ $t('voice.says.notificationsOff') }}
        </div>
      </div>

      <div
        class="flex items-center"
        style="gap: 16px; flex-wrap: wrap; margin-bottom: 12px"
        :style="{ opacity: sessions.notifyPrefs.enabled ? 1 : 0.45 }"
      >
        <label
          v-for="key in EVENT_KEYS"
          :key="key"
          class="flex items-center gap-2"
          :class="sessions.notifyPrefs.enabled ? 'cursor-pointer' : 'cursor-not-allowed'"
        >
          <ToggleSwitch
            :model-value="sessions.notifyPrefs[key]"
            :disabled="!sessions.notifyPrefs.enabled"
            :aria-label="$t(`voice.events.label.${key}`)"
            @update:model-value="sessions.setNotifyPref(key, $event)"
          />
          <span class="text-text-2" style="font-size: 12px">
            {{ $t(`voice.events.label.${key}`) }}
          </span>
        </label>
      </div>

      <div class="border border-border bg-bg" style="border-radius: 7px; padding: 12px">
        <label class="text-text-3" style="font-size: 11px">
          {{ $t('voice.phrase.label') }}
          <input
            :value="phraseValue"
            type="text"
            spellcheck="false"
            data-testid="voice-phrase"
            class="mt-1 w-full border border-border bg-bg font-mono text-text transition focus:border-accent-line focus:outline-none"
            style="padding: 6px 9px; font-size: 12px; border-radius: 5px"
            @input="onPhraseInput(($event.target as HTMLInputElement).value)"
          />
        </label>
        <SettingHint style="margin-top: 6px">{{ $t('voice.phrase.tokens') }}</SettingHint>
        <div class="flex items-center justify-between" style="gap: 10px; margin-top: 10px">
          <span
            class="truncate text-text-3"
            data-testid="voice-phrase-preview"
            style="font-size: 11px; line-height: 1.5"
          >
            → {{ phrasePreview }}
          </span>
          <button
            type="button"
            data-testid="voice-test"
            class="flex shrink-0 items-center border border-border text-text-2 transition hover:bg-surface-2 disabled:opacity-40"
            :style="GHOST_BUTTON"
            :disabled="probeBusy"
            @click="testPhrase()"
          >
            <Loader2
              v-if="probeBusy && probeFor('phrase')"
              :size="11"
              :stroke-width="1.8"
              class="anim-spin"
            />
            <Play v-else :size="11" :stroke-width="1.8" />
            {{ $t('voice.phrase.test') }}
          </button>
        </div>

        <!-- Product rule 5: the click, the wait and the outcome, in words. The
             button's only other output is audio, which the operator may well
             not be able to hear. -->
        <div
          v-if="probeFor('phrase') && probe.messageKey"
          data-testid="voice-test-status"
          class="flex items-start"
          :class="PROBE_TONE_CLASS[probe.tone]"
          style="gap: 6px; margin-top: 8px; font-size: 11.5px; line-height: 1.5"
          role="status"
        >
          <component
            :is="PROBE_TONE_ICON[probe.tone]"
            :size="12"
            :stroke-width="1.8"
            :class="probe.tone === 'busy' ? 'anim-spin' : ''"
            style="margin-top: 2px; flex: none"
          />
          <span>
            {{ $t(probe.messageKey) }}
            <span v-if="showColdModelHint" class="text-text-4" style="display: block">
              {{ $t('voice.test.coldModel') }}
            </span>
          </span>
        </div>
      </div>
    </section>

    <!-- SESSIONS — the `speak` gate, rendered as RESOLVED state. -->
    <section style="margin-bottom: 18px">
      <div class="text-text-3" :style="eyebrowStyle">{{ $t('voice.sessions.eyebrow') }}</div>

      <div class="border border-border bg-bg" style="border-radius: 7px; padding: 12px">
        <div class="flex items-center justify-between" style="gap: 8px">
          <div class="min-w-0">
            <div class="text-text" style="font-size: 12.5px; font-weight: 500">
              {{ $t('voice.sessions.label') }}
            </div>
            <SettingHint>
              {{
                voice.agentGlobal ? $t('voice.sessions.globalOn') : $t('voice.sessions.globalOff')
              }}
            </SettingHint>
          </div>
          <ToggleSwitch
            :model-value="voice.agentGlobal"
            data-testid="voice-agent-global"
            :aria-label="$t('voice.sessions.label')"
            @update:model-value="voice.setAgentGlobal($event)"
          />
        </div>

        <div
          v-if="exceptionRows.length"
          class="border-t border-border"
          style="margin-top: 12px; padding-top: 12px"
        >
          <div class="text-text-3" style="font-size: 11px; margin-bottom: 8px">
            {{ $t('voice.sessions.exceptionsEyebrow') }}
          </div>
          <div class="flex flex-col" style="gap: 4px">
            <div
              v-for="row in exceptionRows"
              :key="row.path"
              :data-testid="`voice-folder-${row.state}`"
              class="flex items-center justify-between border border-border bg-surface"
              style="gap: 12px; padding: 8px 10px; border-radius: 6px"
            >
              <div style="flex: 1; min-width: 0">
                <div class="flex items-center" style="gap: 6px">
                  <span class="truncate text-text-2" style="font-size: 12px">{{ row.alias }}</span>
                  <!-- The state IN WORDS, next to the control that shows it in
                       colour. An inherited "on" and an explicit "on" must not be
                       tellable apart only by a border. -->
                  <span
                    class="shrink-0 text-text-4"
                    :data-testid="`voice-folder-state-${row.state}`"
                    style="font-size: 10.5px"
                  >
                    {{ $t(`voice.sessions.state.${row.state}`) }}
                  </span>
                </div>
                <div
                  class="truncate font-mono text-text-4"
                  style="font-size: 11px"
                  :title="row.path"
                >
                  {{ row.path }}
                </div>
              </div>
              <!-- A blocked folder is silent-and-locked whatever the global says. -->
              <div
                v-if="row.state === 'blocked'"
                class="flex shrink-0 items-center text-text-4"
                style="gap: 5px; font-size: 11px"
              >
                <Ban :size="12" :stroke-width="1.8" />
                {{ $t('voice.sessions.blocked') }}
              </div>
              <!-- Inherited vs explicit are visually distinct: the neutral "Default"
                   pill is selected when unset, and `inheritedValue` gives the
                   inherited option the softer border-only treatment. -->
              <SegmentedControl
                v-else
                :model-value="row.value"
                :options="folderOptions"
                allow-default
                :default-label="$t('voice.sessions.inherit')"
                :inherited-value="voice.agentGlobal"
                size="sm"
                :aria-label="row.alias"
                @update:model-value="setFolder(row.path, $event as boolean | undefined)"
              />
            </div>
          </div>
          <div v-if="voice.hasExceptions" class="flex justify-end" style="margin-top: 10px">
            <button
              type="button"
              data-testid="voice-clear-exceptions"
              class="flex items-center border border-border text-text-2 transition hover:bg-surface-2"
              :style="GHOST_BUTTON"
              @click="voice.clearAgentExceptions()"
            >
              {{ $t('voice.sessions.clearExceptions') }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Disk — shown only once something is actually installed. -->
    <section v-if="voice.installed">
      <div
        class="flex items-center justify-between border border-border bg-bg"
        style="gap: 12px; border-radius: 7px; padding: 12px"
      >
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ $t('voice.disk.label') }}
            <span class="tabular-nums text-text">{{ formatBytes(voice.diskBytes) }}</span>
          </div>
          <div
            class="truncate font-mono text-text-4"
            style="font-size: 11px"
            :title="voice.directory"
          >
            {{ voice.directory }}
          </div>
        </div>
        <button
          type="button"
          data-testid="voice-remove"
          class="flex shrink-0 items-center border border-border text-text-2 transition hover:bg-surface-2 hover:text-red"
          :style="GHOST_BUTTON"
          @click="voice.remove()"
        >
          <Trash2 :size="12" :stroke-width="1.7" />
          {{ $t('voice.disk.remove') }}
        </button>
      </div>
    </section>
  </div>
</template>
