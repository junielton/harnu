<script setup lang="ts">
import { computed } from 'vue'
import { useNow } from '@vueuse/core'
import { ArrowUpRight, Copy, Info, Pause } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'
import { useContainersCopy } from './containers-copy'
import { ICON_BTN_CLASS, btnClass, displayPath, formatStamp } from './containers-format'
import type { ContainersPausedStack } from '../../../preload'

/**
 * Detail pane of a Paused row (design.md "Paused detail", U3.4). A paused stack has no containers
 * and no verdict, so there are no tiers: the restore command IS the way back (spec C5), run by a
 * session or by the operator, and this pane only shows it and copies it.
 */
const props = defineProps<{ paused: ContainersPausedStack }>()

const sessions = useSessionsStore()
const { t, agoLong } = useContainersCopy()
const now = useNow({ interval: 30_000 })
const nowMs = computed(() => now.value.getTime())

const folderOpen = computed(() =>
  sessions.findFolderByPath(props.paused.workingDir)
    ? () => sessions.jumpToFolder(props.paused.workingDir)
    : null
)

async function copyCommand(): Promise<void> {
  await navigator.clipboard.writeText(props.paused.restoreCommand)
}
</script>

<template>
  <div
    data-dsqa="containers-detail--paused"
    class="flex min-h-0 min-w-0 flex-col gap-4 overflow-hidden px-[22px] py-[18px]"
  >
    <div class="scrollable @container flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      <div class="flex items-center gap-2.5">
        <Pause :size="15" :stroke-width="1.6" class="shrink-0 text-text-3" />
        <span class="truncate font-mono text-[13px] text-text" :title="paused.name">{{
          paused.name
        }}</span>
        <span
          class="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-surface-2 px-[9px] py-[3px] text-[10.5px] font-semibold text-text-3"
          >{{ t('containers.paused.chip') }}</span
        >
        <span v-if="folderOpen" class="ml-auto flex gap-1">
          <button type="button" :class="btnClass('ghost', 'sm')" @click="folderOpen()">
            <ArrowUpRight :size="11" :stroke-width="1.8" class="shrink-0" />{{
              t('containers.nav.openWorktree')
            }}
          </button>
        </span>
      </div>

      <div class="grid grid-cols-[150px_1fr] gap-x-3.5 gap-y-[7px] text-[11.5px]">
        <span class="text-text-4">{{ t('containers.paused.evidence.by') }}</span>
        <span class="text-text-2">{{ t(`containers.paused.actor.${paused.actor}`) }}</span>

        <span class="text-text-4">{{ t('containers.paused.evidence.when') }}</span>
        <span class="tabular-nums text-text-2"
          >{{ formatStamp(paused.pausedAt) }} · {{ agoLong(nowMs - paused.pausedAt) }}</span
        >

        <span class="text-text-4">{{ t('containers.paused.evidence.folder') }}</span>
        <span class="min-w-0 text-text-2"
          ><span class="block truncate font-mono text-[11px]" :title="paused.workingDir">{{
            displayPath(paused.workingDir)
          }}</span></span
        >

        <template v-if="paused.ports.length">
          <span class="text-text-4">{{ t('containers.paused.evidence.ports') }}</span>
          <span class="flex flex-wrap gap-1">
            <span
              v-for="port in paused.ports"
              :key="port"
              class="rounded-[3px] bg-surface-2 px-[5px] py-px font-mono text-[10.5px] tabular-nums text-text-3"
              >{{ port }}</span
            >
          </span>
        </template>

        <template v-if="paused.hasBuild">
          <span class="text-text-4">{{ t('containers.paused.evidence.build') }}</span>
          <span class="text-text-2">{{ t('containers.paused.evidence.buildYes') }}</span>
        </template>
      </div>

      <div
        class="flex items-start gap-2.5 rounded border border-border bg-surface px-3 py-2.5 text-[12px] leading-[18px] text-text-3"
      >
        <Info :size="14" :stroke-width="1.8" class="mt-0.5 shrink-0 text-text-4" />
        <span>{{ t('containers.paused.note') }}</span>
      </div>

      <div class="text-[10.5px] font-medium uppercase tracking-[0.07em] text-text-4">
        {{ t('containers.restore.toBringBack') }}
      </div>
      <div
        class="flex items-start gap-2.5 break-all rounded border border-border bg-surface py-[9px] pl-3 pr-2.5 font-mono text-[11.5px] leading-[18px] text-text-2"
      >
        {{ paused.restoreCommand }}
        <button
          type="button"
          data-testid="containers-paused-copy"
          class="ml-auto"
          :class="ICON_BTN_CLASS"
          :title="t('containers.restore.copy')"
          :aria-label="t('containers.restore.copy')"
          @click="copyCommand()"
        >
          <Copy :size="11" :stroke-width="1.7" />
        </button>
      </div>
    </div>
  </div>
</template>
