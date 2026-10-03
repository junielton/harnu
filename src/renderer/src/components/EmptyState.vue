<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionsStore } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import { useKeybindingsStore } from '../stores/keybindings'
import { Clock } from 'lucide-vue-next'
import { relativeTime } from '../composables/useRelativeTime'
import {
  DESCRIPTOR_BY_ID,
  renderKeysString,
  type ShortcutActionId
} from '../../../main/keybindings-core'
import { isMac } from '../lib/platform'

interface Shortcut {
  key: string
  keys: string[]
}

// The `<kbd>` hints derive from the one canonical chord table
// (`keybindings-core.ts`) and render for the current platform. They read the
// RESOLVED table from the keybindings store (T1 P3), so a `keybindings.json`
// edit updates them live; an unbound action renders no keys.
const SHORTCUT_ACTIONS: Array<{ key: string; id: ShortcutActionId }> = [
  { key: 'newSession', id: 'session.new' },
  { key: 'search', id: 'app.search' },
  { key: 'switchProject', id: 'project.switch' },
  { key: 'addFolder', id: 'folder.add' },
  { key: 'resumeLast', id: 'session.resumeLast' }
]

const keybindings = useKeybindingsStore()

const shortcuts = computed<Shortcut[]>(() =>
  SHORTCUT_ACTIONS.map((s) => {
    const rb = keybindings.resolved.byId[s.id]
    const chord = rb ? rb.keys : DESCRIPTOR_BY_ID[s.id].defaultKeys
    return { key: s.key, keys: renderKeysString(chord, { mac: isMac }) }
  })
)

const sessions = useSessionsStore()
const { t } = useI18n()

interface RecentRow {
  id: string
  name: string
  folder: string
  branch?: string
  lastActivity: string
}

const recents = computed<RecentRow[]>(() => {
  const out: RecentRow[] = []
  for (const folder of sessions.folders) {
    for (const s of folder.sessions) {
      if (sessions.isArchived(s.sessionId)) continue
      out.push({
        id: s.sessionId,
        name: sessionTitle(s, sessions.allSessions, t),
        folder: folder.alias,
        branch: folder.gitBranch || undefined,
        lastActivity: relativeTime(s.modified)
      })
    }
  }
  // Top 4, idle/archived only (active sessions are excluded — they're not
  // "recent", they're current). With no data this is empty and the section
  // is hidden by the `v-if="recents.length > 0"` template guard.
  return out.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1)).slice(0, 4)
})
</script>

<template>
  <div class="flex h-full w-full items-center justify-center">
    <div class="anim-fade-in flex flex-col" style="width: min(520px, 90%)">
      <h2 class="text-text" style="font-size: 15px; font-weight: 500; letter-spacing: -0.005em">
        {{ $t('empty.title') }}
      </h2>
      <p class="text-text-3" style="font-size: 13px; line-height: 1.55; margin-top: 6px">
        {{ $t('empty.subtitle') }}
      </p>

      <!-- Shortcuts -->
      <div
        class="text-text-3"
        style="
          margin-top: 24px;
          font-size: 10.5px;
          font-weight: 500;
          text-transform: uppercase;
          letter-spacing: 0.06em;
        "
      >
        {{ $t('empty.shortcutsLabel') }}
      </div>
      <div
        class="border border-border-2 bg-surface"
        style="margin-top: 8px; border-radius: 7px; padding: 4px"
      >
        <div
          v-for="(s, i) in shortcuts"
          :key="s.key"
          class="flex items-center justify-between"
          :class="i < shortcuts.length - 1 ? 'border-b border-border' : ''"
          style="padding: 8px 12px; font-size: 12.5px"
        >
          <span class="text-text-2">{{ $t(`empty.shortcuts.${s.key}`) }}</span>
          <span class="flex items-center gap-1">
            <!-- An unbound action keeps its row but has no chord to show — a
                 muted dash, so the row doesn't read as a rendering gap. -->
            <span v-if="s.keys.length === 0" class="text-text-4" style="font-size: 11px">—</span>
            <kbd
              v-for="k in s.keys"
              :key="k"
              class="inline-flex items-center justify-center border border-border bg-surface-2 font-mono text-text-3"
              style="
                min-width: 18px;
                height: 18px;
                padding: 0 5px;
                font-size: 10.5px;
                border-radius: 3px;
                line-height: 14px;
              "
              >{{ k }}</kbd
            >
          </span>
        </div>
      </div>

      <!-- Recents -->
      <template v-if="recents.length > 0">
        <div
          class="text-text-3"
          style="
            margin-top: 24px;
            font-size: 10.5px;
            font-weight: 500;
            text-transform: uppercase;
            letter-spacing: 0.06em;
          "
        >
          {{ $t('empty.recentsLabel') }}
        </div>
        <div style="margin-top: 6px">
          <button
            v-for="r in recents"
            :key="r.id"
            class="group flex w-full items-center gap-3 text-left transition hover:bg-surface"
            style="padding: 8px 8px; border-radius: 5px"
            @click="sessions.select(r.id)"
          >
            <Clock :size="12" :stroke-width="1.6" class="shrink-0 text-text-4" />
            <span class="flex-1 truncate text-text" style="font-size: 12.5px">{{ r.name }}</span>
            <span class="font-mono text-text-3" style="font-size: 11px">
              {{ r.folder
              }}<template v-if="r.branch">
                <span class="text-text-4">›</span> {{ r.branch }}</template
              >
            </span>
            <span
              class="tabular-nums text-text-4"
              style="font-size: 10.5px; min-width: 60px; text-align: right"
              >{{ r.lastActivity }}</span
            >
          </button>
        </div>
      </template>
    </div>
  </div>
</template>
