<script setup lang="ts">
/**
 * Test harness that mirrors `HelperStack.vue`'s pane list VERBATIM (its
 * `<template v-for="(pane, idx) in panes" :key="pane.id">` block with the
 * conditional separator sibling — see HelperStack.vue lines 67-78). It renders
 * the REAL `HelperPane` so the test exercises the actual detach/reattach +
 * `liveHelpers` caching logic. Panes + worktreePath are driven as props so the
 * test can simulate a worktree switch without seeding the Pinia stores.
 */
import HelperPane from '@renderer/components/HelperPane.vue'
import type { AnyHelperPane } from '@renderer/stores/helpers'

defineProps<{ panes: AnyHelperPane[]; worktreePath: string }>()
</script>

<template>
  <div id="harness-host">
    <template v-for="(pane, idx) in panes" :key="pane.id">
      <div class="min-h-0 overflow-hidden">
        <HelperPane :pane="pane" :worktree-path="worktreePath" />
      </div>
      <div v-if="idx < panes.length - 1" class="sep" />
    </template>
  </div>
</template>
