<script setup lang="ts">
import { Play, Plug, ListChecks } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import WalkValue from './WalkValue.vue'

/**
 * The two states with no check to show (design.md §6 "Guided test walk" → States). `empty`: a walk pane with no
 * walk (a restored pane whose walk was deleted), which says how a walk starts in source-neutral words. `error`:
 * a turn is due and no session can take it; the progress is saved, and Resume the session resumes the run's owner.
 */
defineProps<{
  kind: 'empty' | 'error'
  done?: number
  total?: number
  resuming?: boolean
  failed?: boolean
}>()
defineEmits<{ resume: [] }>()
const { t } = useI18n()
</script>

<template>
  <div v-if="kind === 'empty'" class="center" data-dsqa-part="empty" data-test="walk-empty">
    <ListChecks class="i i14" :size="14" />
    <b>{{ $t('testWalk.empty.title') }}</b>
    <p>{{ $t('testWalk.empty.body') }}</p>
  </div>
  <div v-else class="center err" data-dsqa-part="error" data-test="walk-error">
    <Plug class="i i14" :size="14" />
    <b>{{ $t('testWalk.error.title') }}</b>
    <p>{{ $t('testWalk.error.body', { done: done ?? 0, total: total ?? 0 }) }}</p>
    <div class="errv">
      <WalkValue :text="t('testWalk.error.errText')" :what="t('testWalk.copy.error')" />
    </div>
    <p v-if="failed" class="why">{{ $t('testWalk.error.resumeFailed') }}</p>
    <div class="acts2">
      <button
        type="button"
        class="btn md primary"
        :disabled="resuming"
        data-walk-primary
        data-test="walk-resume"
        @click="$emit('resume')"
      >
        <Play class="i i10" :size="10" />{{ $t('testWalk.error.resume') }}
      </button>
    </div>
  </div>
</template>
