<script setup lang="ts">
/**
 * The start page of a browser tab with no address (browser-tabs spec S-5, design.md §6 "Browser pane" → "Start
 * page"): "Running in this folder" (the folder's Docker and terminal servers) and "Recent" (its last sites), each left
 * out when empty. It owns no decisions: main builds both lists, this draws them, refreshes them when it shows and at
 * most every {@link START_REFRESH_MS} while it stays shown, and relays a pick to the pane, which opens it in the same
 * tab through the address bar's navigation call.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Clock, Server } from 'lucide-vue-next'
import { START_REFRESH_MS, useBrowserStore } from '../stores/browser'
import { tabFaviconView } from '../lib/browser-tabs-view'

const props = defineProps<{ folder: string }>()
const emit = defineEmits<{ open: [url: string] }>()

/** Most tiles Recent draws (main already cuts to this; the page keeps the promise on its own). */
const MAX_TILES = 8

const browser = useBrowserStore()
const servers = ref<Array<{ name: string; url: string; source: string }>>([])
const recent = ref<Array<{ title: string; url: string; host: string }>>([])
let timer: ReturnType<typeof setInterval> | null = null
let reading = false

async function refresh(): Promise<void> {
  // One read at a time: a slow `lsof` must not stack reads up behind the timer.
  if (reading) return
  reading = true
  try {
    const [s, r] = await Promise.all([
      browser.startServers(props.folder).catch(() => []),
      browser.startRecent(props.folder).catch(() => [])
    ])
    // An IPC answer is untrusted shape: anything but a list is an empty section.
    servers.value = Array.isArray(s) ? s : []
    recent.value = Array.isArray(r) ? r : []
  } finally {
    reading = false
  }
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), START_REFRESH_MS)
})
onBeforeUnmount(() => {
  if (timer !== null) clearInterval(timer)
  timer = null
})

const tiles = computed(() => recent.value.slice(0, MAX_TILES))

/** `localhost:5173`: a server's address without its scheme. */
function addressOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** A site's fallback icon: its first letter in the origin badge's colours (same rule as the tab strip). */
function favicon(url: string, label: string): { letter: string; cls: string } {
  const view = tabFaviconView({ url })
  return {
    letter: (label.charAt(0) || view.host.charAt(0)).toString(),
    cls: view.origin === 'local' ? 'bg-green-soft text-green' : 'bg-surface-2 text-text-2'
  }
}

const rowBase =
  'border border-border text-[12px] bg-surface rounded transition-colors hover:border-border-2 hover:bg-surface-2 focus-visible:border-accent-line focus-visible:outline-none cursor-pointer text-left'
const favBase =
  'grid size-3 shrink-0 place-items-center rounded-xs text-[8px] leading-none font-semibold'
</script>

<template>
  <div
    class="flex max-w-140 flex-col gap-1.5 px-5 py-4.5"
    data-testid="browser-start-page"
    data-dsqa-part="start-page"
  >
    <template v-if="servers.length > 0">
      <div
        class="flex items-center gap-1.5 text-[10.5px] tracking-[0.04em] text-text-3 uppercase"
        data-testid="browser-start-running"
      >
        <Server :size="12" :stroke-width="1.6" aria-hidden="true" />{{
          $t('browserPane.start.running')
        }}
      </div>
      <button
        v-for="s in servers"
        :key="s.url"
        type="button"
        :class="[rowBase, 'flex h-7.5 items-center gap-2 px-2.5']"
        data-testid="browser-start-server"
        @click="emit('open', s.url)"
      >
        <span :class="[favBase, favicon(s.url, s.name).cls]" aria-hidden="true">{{
          favicon(s.url, s.name).letter
        }}</span>
        <span
          class="min-w-0 truncate text-[12px] text-text"
          data-testid="browser-start-server-name"
          >{{ s.name }}</span
        >
        <span
          class="ml-auto min-w-0 truncate font-mono text-[10.5px] text-text-3"
          data-testid="browser-start-server-address"
          >{{ addressOf(s.url) }}</span
        >
        <span class="shrink-0 text-[10px] text-text-4" data-testid="browser-start-server-source">{{
          s.source
        }}</span>
      </button>
    </template>

    <template v-if="tiles.length > 0">
      <div
        class="mt-2 flex items-center gap-1.5 text-[10.5px] tracking-[0.04em] text-text-3 uppercase first:mt-0"
        data-testid="browser-start-recent"
      >
        <Clock :size="12" :stroke-width="1.6" aria-hidden="true" />{{
          $t('browserPane.start.recent')
        }}
      </div>
      <div class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5">
        <button
          v-for="r in tiles"
          :key="r.url"
          type="button"
          :class="[
            rowBase,
            'grid grid-cols-[12px_1fr] items-center gap-x-[7px] gap-y-0.5 px-2.5 py-2'
          ]"
          :title="r.url"
          data-testid="browser-start-tile"
          @click="emit('open', r.url)"
        >
          <span :class="[favBase, favicon(r.url, r.title).cls]" aria-hidden="true">{{
            favicon(r.url, r.title).letter
          }}</span>
          <span
            class="min-w-0 truncate text-[12px] text-text"
            data-testid="browser-start-tile-title"
            >{{ r.title }}</span
          >
          <span
            class="col-start-2 min-w-0 truncate font-mono text-[10.5px] text-text-3"
            data-testid="browser-start-tile-host"
            >{{ r.host }}</span
          >
        </button>
      </div>
    </template>
  </div>
</template>
