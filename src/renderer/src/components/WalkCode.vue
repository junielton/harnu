<script setup lang="ts">
import WalkCopy from './WalkCopy.vue'

/** A paste-ready block: every command of a Do step, and the close-out's summary. */
defineProps<{ text: string; what?: string }>()
</script>

<template>
  <div class="code" data-dsqa-part="command">
    <pre>{{ text }}</pre>
    <WalkCopy :value="text" :what="what" label />
  </div>
</template>
