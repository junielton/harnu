<script setup lang="ts">
import WalkCopy from './WalkCopy.vue'

/** An inline value with its copy: a command, an id, an expected text. The copy carries the full value. */
defineProps<{ text: string; what?: string; full?: string }>()
</script>

<template>
  <span class="val"
    ><code>{{ text }}</code
    ><WalkCopy :value="full ?? text" :what="what"
  /></span>
</template>
