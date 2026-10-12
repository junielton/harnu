<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { TriangleAlert } from 'lucide-vue-next'
import Button from './ui/Button.vue'
import type { GcRecoveryAction, GcRecoveryItem } from '../../../main/gc/gc-wire'

/**
 * What a clean that did not finish left behind (design.md "Workspace GC — unified Cleanup / Interrupted
 * cleans"). A guided action writes what it is about to change before changing it; if Harnu quit in the
 * middle, the next start turns the entry into a notice here. Containers are never started on Harnu's own
 * initiative, and a lock is put back on its own only on the very same worktree: everything else asks.
 * A notice stays until it is answered or dismissed, and is announced in Activity once.
 */
defineProps<{ items: GcRecoveryItem[] }>()
const emit = defineEmits<{ answer: [id: string, action: GcRecoveryAction] }>()
const { t } = useI18n()
</script>

<template>
  <section
    v-if="items.length > 0"
    class="flex flex-col gap-2"
    role="region"
    :aria-label="t('cleanup.gc.recovery.label')"
    data-testid="recovery-notices"
  >
    <div
      v-for="n in items"
      :key="n.id"
      class="flex flex-wrap items-center gap-2 rounded-sm border border-warning-line bg-warning-soft px-3 py-2"
      data-testid="recovery-notice"
    >
      <TriangleAlert
        :size="14"
        :stroke-width="1.6"
        class="shrink-0 text-warning"
        aria-hidden="true"
      />
      <p class="m-0 min-w-0 flex-1 text-ui text-text-2">
        <template v-if="n.notice === 'stack-stopped'">{{
          t('cleanup.gc.recovery.stackStopped', { names: n.detail })
        }}</template>
        <template v-else-if="n.notice === 'containers-gone'">{{
          t('cleanup.gc.recovery.containersGone', { names: n.detail })
        }}</template>
        <template v-else-if="n.mismatch">
          {{ t('cleanup.gc.recovery.lockMismatch', { path: n.path }) }}
          <span class="text-caption text-text-3">{{ n.mismatch }}</span>
        </template>
        <template v-else-if="n.notice === 'lock-failed'">
          {{ t('cleanup.gc.recovery.lockFailed', { path: n.path }) }}
          <span v-if="n.detail" class="font-mono text-caption text-text-3">{{ n.detail }}</span>
        </template>
        <template v-else>
          {{ t('cleanup.gc.recovery.lockSkipped', { path: n.path }) }}
          <span v-if="n.detail" class="font-mono text-caption text-text-3">{{ n.detail }}</span>
        </template>
      </p>
      <p
        v-if="n.notice === 'stack-stopped' && n.canStart === false"
        class="m-0 basis-full text-caption text-text-3"
        data-testid="recovery-cannot-start"
      >
        {{ n.cannotStart }}
      </p>
      <Button
        v-if="n.notice === 'stack-stopped' && n.canStart !== false"
        variant="soft"
        data-testid="recovery-start"
        @click="emit('answer', n.id, 'start')"
      >
        {{ t('cleanup.gc.recovery.start') }}
      </Button>
      <Button
        v-if="n.mismatch"
        variant="soft"
        data-testid="recovery-lock-anyway"
        @click="emit('answer', n.id, 'lock-anyway')"
      >
        {{ t('cleanup.gc.recovery.lockAnyway') }}
      </Button>
      <Button
        v-else-if="n.notice === 'lock-skipped' || n.notice === 'lock-failed'"
        variant="soft"
        data-testid="recovery-lock"
        @click="emit('answer', n.id, 'lock')"
      >
        {{ t('cleanup.gc.recovery.lock') }}
      </Button>
      <Button
        variant="ghost"
        data-testid="recovery-dismiss"
        @click="emit('answer', n.id, 'dismiss')"
      >
        {{
          n.notice === 'stack-stopped'
            ? t('cleanup.gc.recovery.leave')
            : t('cleanup.gc.recovery.dismiss')
        }}
      </Button>
    </div>
  </section>
</template>
