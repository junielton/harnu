<script setup lang="ts">
/**
 * The dock's Needs you section (design.md §6 "Bottom dock" and "Needs you rows"): the parked agent
 * confirms and the pending approvals. Not rendered while there are none.
 */
import { computed } from 'vue'
import { useSessionsStore } from '../stores/sessions'
import { useLayoutStore } from '../stores/layout'
import { PARK_TTL_MS } from '../../../main/mcp/confirm-core'
import SidebarDockSection from './SidebarDockSection.vue'
import McpConfirmRow from './McpConfirmRow.vue'
import ApprovalRow from './ApprovalRow.vue'

const sessions = useSessionsStore()
const layout = useLayoutStore()

// Parked confirms are fail-CLOSED, so they lead the queue.
const confirms = computed(() => sessions.parkedConfirmList)
const approvals = computed(() => sessions.pendingApprovalList)

/** When the oldest item arrived. A confirm carries only its deadline, `PARK_TTL_MS` later. */
const oldestAt = computed(() =>
  Math.min(
    ...confirms.value.map((c) => c.deadline - PARK_TTL_MS),
    ...approvals.value.map((a) => a.createdAtMs)
  )
)
</script>

<template>
  <SidebarDockSection
    dock="needs-you"
    island="sidebar-needs-you"
    :label="$t('approvalInbox.sections.needsYou')"
    :count="sessions.inboxCount"
    :oldest-at="oldestAt"
    :open="layout.needsYouOpen"
    @toggle="layout.needsYouOpen = !layout.needsYouOpen"
    @fold="layout.needsYouOpen = false"
  >
    <!-- The last row drops its rule: the next section draws its own top one. -->
    <div class="[&>*:last-child]:border-b-0">
      <McpConfirmRow v-for="c in confirms" :key="c.id" :confirm="c" />
      <ApprovalRow v-for="a in approvals" :key="a.requestId" :approval="a" />
    </div>
  </SidebarDockSection>
</template>
