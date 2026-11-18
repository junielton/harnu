<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy } from 'lucide-vue-next'

/**
 * One-click copy of a full value (design.md §6 "Guided test walk" → Values). The copy puts the FULL value on
 * the clipboard; after a click the icon becomes a green check with `Copied` for 1.4 s. A pointer press must not
 * move focus off the pane, so the chip is marked `data-walk-chip` (the pane's key map reads it).
 */
const props = defineProps<{
  value: string
  /** Names the value for the accessible label: "Copy the command". */
  what?: string
  /** A labelled button (a code block's Copy) instead of a bare icon. */
  label?: boolean
}>()

const { t } = useI18n()
const copied = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.value)
  } catch {
    return // a clipboard that refuses says nothing: the value is still on screen
  }
  copied.value = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => (copied.value = false), 1400)
}
onBeforeUnmount(() => timer && clearTimeout(timer))
</script>

<template>
  <button
    type="button"
    class="cp"
    :class="{ 'cp-l': label }"
    data-walk-chip
    :data-copied="copied || undefined"
    :aria-label="$t('testWalk.copy.value', { what: what ?? t('testWalk.copy.text') })"
    :title="$t('testWalk.copy.value', { what: what ?? t('testWalk.copy.text') })"
    @click.stop="copy"
  >
    <Check v-if="copied" class="i" :size="10" />
    <Copy v-else class="i i10" :size="10" />
    <span v-if="label" class="cp-t">{{ $t('testWalk.copy.label') }}</span>
    <span class="cp-ack" aria-live="polite">{{ copied ? $t('testWalk.copy.copied') : '' }}</span>
  </button>
</template>
