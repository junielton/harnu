<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Cloud } from 'lucide-vue-next'
import { useSessionsStore, type Session } from '../stores/sessions'
import { sessionTitle } from '../lib/session-label'
import Button from './ui/Button.vue'

/**
 * Shown in place of `TerminalPane` when the selected session is a cloud/bridge
 * stub with no local transcript to resume (`resumable === false`). Spawning
 * `claude --resume <id>` for these returns "No conversation found …" and ends
 * the PTY — so instead of a doomed terminal we render a calm status panel.
 * "Resume anyway" (BUG-198) is the way out when the classification is wrong: it
 * mounts the terminal regardless, so the CLI's own output is what the user sees.
 *
 * See `design.md` §6 → "Cloud session panel" and §6 Session status → cloud.
 */
const props = defineProps<{ session: Session }>()

const sessions = useSessionsStore()
const { t } = useI18n()

/** The shared session name (BUG-78) — same as the sidebar row's. */
const title = computed(() => sessionTitle(props.session, sessions.allSessions, t))

function resumeAnyway(): void {
  sessions.resumeAnyway(props.session.sessionId)
}
</script>

<template>
  <div class="flex h-full w-full items-center justify-center bg-bg">
    <div class="anim-fade-in flex flex-col items-center text-center" style="max-width: 420px">
      <Cloud :size="28" :stroke-width="1.6" class="text-text-4" />
      <h2
        v-if="title"
        class="text-text-2"
        style="font-size: 15px; font-weight: 500; margin-top: 14px; letter-spacing: -0.005em"
      >
        {{ title }}
      </h2>
      <h2
        v-else
        class="text-text-2"
        style="font-size: 15px; font-weight: 500; margin-top: 14px; letter-spacing: -0.005em"
      >
        {{ $t('cloudSession.title') }}
      </h2>
      <p class="text-text-3" style="font-size: 12.5px; line-height: 1.55; margin-top: 8px">
        {{ session.bridged ? $t('cloudSession.body') : $t('cloudSession.bodyNoBridge') }}
      </p>
      <Button
        variant="ghost"
        data-test="cloud-resume-anyway"
        style="margin-top: 16px"
        @click="resumeAnyway"
      >
        {{ $t('cloudSession.resumeAnyway') }}
      </Button>
    </div>
  </div>
</template>
