<script setup lang="ts">
/**
 * One Approval Inbox row (approval-inbox spec §4.6): an amber needs-input dot,
 * the tool-call summary (a technical string built in main — never i18n), the
 * owning folder · session summary, and Allow / Deny. Clicking the body opens
 * the session's tab (the inspection escape hatch). All copy via `$t`; colors are
 * tokens only (`bg-green-soft`/`text-green`, `bg-red-soft`/`text-red`).
 */
import { computed } from 'vue'
import { Check, X } from 'lucide-vue-next'
import { useCompanionStore } from '../stores/companion'
import { useSessionsStore } from '../stores/sessions'
import type { PendingApprovalWire } from '../../../preload'

type EnrichedApproval = PendingApprovalWire & { folderAlias: string; sessionSummary: string }

const props = defineProps<{ approval: EnrichedApproval }>()

const sessions = useSessionsStore()
const companion = useCompanionStore()

/** T389 P4W3: the session was not started by Harnu (a corroborated outside binding). */
const outside = computed(() => {
  const st = companion.stateFor(props.approval.sessionId)
  return st?.state === 'live' && st.outside === true
})

function allow(): void {
  void sessions.resolveApproval(props.approval.requestId, 'allow')
}
function deny(): void {
  void sessions.resolveApproval(props.approval.requestId, 'deny')
}
function openSession(): void {
  // T83 S0: nothing to close any more — the rail is a column, so jumping to the
  // session leaves the queue right where it was, still visible beside it.
  sessions.select(props.approval.sessionId)
}
</script>

<template>
  <div class="flex items-start border-b border-border" style="gap: 10px; padding: 10px 16px">
    <span
      class="shrink-0 rounded-full bg-warning"
      style="width: 7px; height: 7px; margin-top: 4px"
    />
    <button
      type="button"
      class="flex min-w-0 flex-1 flex-col items-start text-left"
      style="gap: 2px"
      :aria-label="$t('approvalInbox.openSessionAria', { tool: approval.summary })"
      @click="openSession"
    >
      <span
        class="max-w-full line-clamp-2 font-mono text-text"
        style="font-size: 12.5px; line-height: 1.4"
        >{{ approval.summary }}</span
      >
      <span
        v-if="approval.folderAlias || approval.sessionSummary || outside"
        class="max-w-full line-clamp-2 text-text-4"
        style="font-size: 11px; line-height: 1.4"
      >
        <template v-if="approval.folderAlias">{{ approval.folderAlias }}</template>
        <template v-if="approval.folderAlias && approval.sessionSummary"> · </template>
        <template v-if="approval.sessionSummary">{{ approval.sessionSummary }}</template>
        <template v-if="outside">
          <template v-if="approval.folderAlias || approval.sessionSummary"> · </template
          >{{ $t('approvalInbox.row.outside') }}
        </template>
      </span>
    </button>
    <div class="flex shrink-0" style="gap: 6px; margin-top: 2px">
      <button
        type="button"
        class="inline-flex items-center bg-green-soft text-green transition hover:opacity-80"
        style="gap: 5px; padding: 5px 10px; font-size: 12px; border-radius: 5px"
        :aria-label="
          $t('approvalInbox.allowAria', { tool: approval.summary, folder: approval.folderAlias })
        "
        @click="allow"
      >
        <Check :size="13" :stroke-width="2" />{{ $t('approvalInbox.allow') }}
      </button>
      <button
        type="button"
        class="inline-flex items-center bg-red-soft text-red transition hover:opacity-80"
        style="gap: 5px; padding: 5px 10px; font-size: 12px; border-radius: 5px"
        :aria-label="
          $t('approvalInbox.denyAria', { tool: approval.summary, folder: approval.folderAlias })
        "
        @click="deny"
      >
        <X :size="13" :stroke-width="2" />{{ $t('approvalInbox.deny') }}
      </button>
    </div>
  </div>
</template>
