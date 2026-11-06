<script setup lang="ts">
import { computed } from 'vue'
import { Code } from 'lucide-vue-next'
import { EDITOR_MARK_VIEWBOX, editorMarkPath } from '../lib/editor-marks'

/**
 * The mark of the configured editor (T581, design.md §5 "Editor marks"): a
 * monochrome Simple Icons glyph in `currentColor`, so it inherits the toolbar's
 * `--text-3` → `--text` pair like every Lucide icon next to it. A preset with no
 * mark, and a custom editor, render the generic Lucide `code` glyph instead.
 * Decorative: the button's `aria-label` carries the editor's name.
 */
const props = withDefaults(defineProps<{ editorId: string; size?: number }>(), { size: 14 })

const markPath = computed(() => editorMarkPath(props.editorId))
</script>

<template>
  <svg
    v-if="markPath"
    :width="size"
    :height="size"
    :viewBox="EDITOR_MARK_VIEWBOX"
    fill="currentColor"
    aria-hidden="true"
    data-test="editor-mark"
    :data-editor="editorId"
  >
    <path :d="markPath" />
  </svg>
  <Code
    v-else
    :size="size"
    :stroke-width="1.5"
    aria-hidden="true"
    data-test="editor-mark-generic"
  />
</template>
