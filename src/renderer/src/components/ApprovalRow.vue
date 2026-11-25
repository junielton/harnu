<script setup lang="ts">
/**
 * One Approval Inbox row (design.md §6 "Needs you rows"): an amber needs-input dot, the **whole**
 * tool call (a technical string — never i18n), the owning folder · session summary, and Allow / Deny
 * under them. Clicking the body opens the session's tab (the inspection escape hatch). All copy via
 * `$t`; colors are tokens only (`bg-green-soft`/`text-green`, `bg-red-soft`/`text-red`).
 */
import { computed } from 'vue'
import { Check, X } from 'lucide-vue-next'
import { useCompanionStore } from '../stores/companion'
import { useSessionsStore } from '../stores/sessions'
import { toolSummary } from '../../../main/approval-parse'
import type { PendingApprovalWire } from '../../../preload'

type EnrichedApproval = PendingApprovalWire & { folderAlias: string; sessionSummary: string }

const props = defineProps<{ approval: EnrichedApproval }>()

const sessions = useSessionsStore()
const companion = useCompanionStore()

/**
 * The call being approved, uncut. The wire's `summary` stops at 48 characters, so it is rebuilt from
 * the full tool input with the same pure function the main process uses, with no length limit.
 */
const command = computed(
  () =>
    toolSummary(
      props.approval.toolName,
      props.approval.toolInput ?? {},
      Number.POSITIVE_INFINITY
    ) || props.approval.summary
)

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
  <!-- The command takes its own line(s) and is never cut; Allow and Deny sit under it at every width,
       so no sidebar width can hide part of what a click approves. -->
  <div class="flex items-start border-b border-border" style="gap: 10px; padding: 10px 16px">
    <span
      class="shrink-0 rounded-full bg-warning"
      style="width: 7px; height: 7px; margin-top: 5px"
    />
    <div class="flex min-w-0 flex-1 flex-col" style="gap: 6px">
      <button
        type="button"
        class="flex w-full min-w-0 flex-col items-start text-left"
        style="gap: 2px"
        :aria-label="$t('approvalInbox.openSessionAria', { tool: command })"
        @click="openSession"
      >
        <span
          data-approval-command
          class="w-full whitespace-pre-wrap font-mono text-text [overflow-wrap:anywhere]"
          style="font-size: 12.5px; line-height: 1.4"
          >{{ command }}</span
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
      <div data-approval-actions class="flex flex-wrap" style="gap: 6px">
        <button
          type="button"
          class="inline-flex items-center bg-green-soft text-green transition hover:opacity-80"
          style="gap: 5px; padding: 5px 10px; font-size: 12px; border-radius: 5px"
          :aria-label="
            $t('approvalInbox.allowAria', { tool: command, folder: approval.folderAlias })
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
            $t('approvalInbox.denyAria', { tool: command, folder: approval.folderAlias })
          "
          @click="deny"
        >
          <X :size="13" :stroke-width="2" />{{ $t('approvalInbox.deny') }}
        </button>
      </div>
    </div>
  </div>
</template>
