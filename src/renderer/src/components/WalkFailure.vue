<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Image as ImageIcon, X } from 'lucide-vue-next'
import { canSendFailure } from '../lib/walk-view'
import { useWalkStore } from '../stores/walk'

/**
 * Failed (design.md §6 "Guided test walk" → States, `failed`): one line and a paste target, nothing else. Send
 * needs a line or an image. A pasted image is saved inside the run's folder by main; a line that looks like a
 * secret is flagged and held back, because it would be delivered to the session as the operator's own words.
 * The pane owns the buttons (Send, Back to the step); this owns the field and the paste.
 */
const props = defineProps<{ paneId: string; title: string }>()
const emit = defineEmits<{
  ready: [state: { canSend: boolean; line: string; shot: string | null }]
}>()

const { t } = useI18n()
const walk = useWalkStore()
const line = ref('')
const shot = ref<{ path: string; name: string; url: string } | null>(null)
const secret = ref(false)
const problem = ref<string | null>(null)
const input = ref<HTMLInputElement | null>(null)
let scanTimer: ReturnType<typeof setTimeout> | null = null
let blobs: string[] = []

function publish(): void {
  emit('ready', {
    canSend: canSendFailure(line.value, shot.value?.path ?? null) && !secret.value,
    line: line.value.trim(),
    shot: shot.value?.path ?? null
  })
}

watch(line, (v) => {
  if (scanTimer) clearTimeout(scanTimer)
  secret.value = false
  publish()
  if (!v.trim()) return
  scanTimer = setTimeout(async () => {
    secret.value = await window.api.walkScanLine(v)
    publish()
  }, 250)
})
watch(shot, publish)

async function onPaste(ev: ClipboardEvent): Promise<void> {
  const file = [...(ev.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
  if (!file) return // a text paste goes to the line
  ev.preventDefault()
  problem.value = null
  const bytes = new Uint8Array(await file.arrayBuffer())
  const res = await walk.saveShot(props.paneId, bytes)
  if (!res.ok) {
    problem.value = t('testWalk.form.saveFailed')
    return
  }
  const url = URL.createObjectURL(file)
  blobs.push(url)
  shot.value = { path: res.path, name: res.name, url }
}

onMounted(() => {
  publish()
  input.value?.focus()
})
onBeforeUnmount(() => {
  if (scanTimer) clearTimeout(scanTimer)
  blobs.forEach((u) => URL.revokeObjectURL(u))
  blobs = []
})
defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <h2 class="wk-title">{{ title }}</h2>
  <section
    class="sec"
    data-dsqa-part="failure-input"
    data-test="walk-failure-form"
    @paste="onPaste"
  >
    <label class="eyebrow" for="walk-failure-line">{{ $t('testWalk.form.title') }}</label>
    <input
      id="walk-failure-line"
      ref="input"
      v-model="line"
      class="line"
      type="text"
      autocomplete="off"
      :placeholder="$t('testWalk.form.placeholder')"
      :aria-invalid="secret || undefined"
      data-test="walk-failure-line"
    />
    <div v-if="secret" class="secret-flag" role="alert" data-test="walk-secret-flag">
      <span class="gl gl-warn" aria-hidden="true">!</span>{{ $t('testWalk.form.secret') }}
    </div>
    <div class="paste" data-dsqa-part="paste-area" tabindex="0">
      <span class="ph-i"><ImageIcon class="i" :size="14" /></span>
      <div class="pt">
        <b>{{ $t('testWalk.form.paste') }}</b>
        <span class="kbd2">{{ $t('testWalk.form.pasteKey') }}</span>
      </div>
      <div v-if="shot" class="att" data-dsqa-part="attachment" data-test="walk-shot">
        <img :src="shot.url" alt="" />
        <span class="trunc">{{ shot.name }}</span>
        <button
          type="button"
          class="ib"
          :aria-label="$t('testWalk.form.remove')"
          :title="$t('testWalk.form.remove')"
          @click="shot = null"
        >
          <X class="i i10" :size="10" />
        </button>
      </div>
      <div v-if="problem" class="secret-flag" role="alert">{{ problem }}</div>
    </div>
  </section>
</template>
