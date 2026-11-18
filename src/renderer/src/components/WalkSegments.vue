<script setup lang="ts">
import type { Segment } from '../lib/walk-view'
import WalkValue from './WalkValue.vue'

/** A script's text: a backtick span is a copy chip, the rest is plain. Nothing in it is markup. */
defineProps<{ parts: Segment[] }>()
</script>

<template>
  <template v-for="(s, i) in parts" :key="i"
    ><WalkValue v-if="s.kind === 'chip'" :text="s.text" /><template v-else>{{
      s.text
    }}</template></template
  >
</template>
