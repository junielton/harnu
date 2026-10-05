<script setup lang="ts">
/**
 * One parked agent-confirm row in the Approval Inbox "Needs you" tab (design §6
 * → "Variante agent-action" → parked row; T44 S4c, Decision 3). The async
 * sibling of `ApprovalRow`: a confirm from the MCP control server that arrived
 * while the window was unfocused, so instead of the focused-modal
 * `McpConfirmOverlay` it parks here to be answered whenever the operator returns.
 *
 * **Expand-to-review** (the T08 disclosure contract, never weakened): the row is
 * MUTED and compact by default — a warning dot, the confirm's `prompt` (the
 * technical op + folder summary built in main, never i18n), and a review hint.
 * Allow/Deny do NOT live in the collapsed row. Expanding reveals the FULL
 * disclosure — prompt (verbatim), the `sh -c` `commands` block (the RCE surface),
 * permission mode, non-default flags — and only THEN the Allow/Deny buttons. So
 * the operator ALWAYS sees the exact commands before approving; there is never a
 * one-click approve of hidden commands.
 *
 * Reuses `McpConfirmOverlay`'s disclosure markup + the inbox's green/red token
 * buttons. Tokens-only styling; all copy via `$t`.
 */
import { reactive, ref } from 'vue'
import { Check, ChevronDown, ChevronRight, X } from 'lucide-vue-next'
import { useSessionsStore } from '../stores/sessions'
import type { McpConfirmPending } from '../../../preload'

const props = defineProps<{ confirm: McpConfirmPending }>()

const sessions = useSessionsStore()
const expanded = ref(false)
// T93: "always allow this verb here" checkbox, defaulted from the wire (unchecked
// for the dangerous verbs). Only meaningful when the confirm offers it.
const alwaysAllow = ref(props.confirm.alwaysAllowDefault === true)

// T104: the manifest checklist — partial-go is native (§2.2): every card starts
// CHECKED, the operator unchecks the ones to leave out. Only meaningful when
// `confirm.manifestCards` is present (submit_manifest).
const manifestChecked = reactive<Record<string, boolean>>(
  Object.fromEntries((props.confirm.manifestCards ?? []).map((c) => [c.slug, true]))
)
function manifestMeta(card: NonNullable<McpConfirmPending['manifestCards']>[number]): string {
  return [card.kind, card.complexity, card.model].filter(Boolean).join(' · ')
}

// T102: per-card substrate override, prefilled from each row's resolved value
// (default `session`) — editable before Allow, written onto the card alongside
// the approval stamp.
const manifestSubstrate = reactive<Record<string, string>>(
  Object.fromEntries(
    (props.confirm.manifestCards ?? []).map((c) => [c.slug, c.substrate ?? 'session'])
  )
)
const SUBSTRATE_OPTIONS = ['session', 'worktree', 'teammate', 'internal'] as const

function respond(verdict: 'allow' | 'deny'): void {
  const data: {
    alwaysAllow?: boolean
    manifestSelectedSlugs?: string[]
    manifestSubstrateOverrides?: Record<string, string>
  } = {}
  if (props.confirm.alwaysAllowOffer) data.alwaysAllow = alwaysAllow.value
  if (props.confirm.manifestCards) {
    data.manifestSelectedSlugs = props.confirm.manifestCards
      .filter((c) => manifestChecked[c.slug])
      .map((c) => c.slug)
    data.manifestSubstrateOverrides = { ...manifestSubstrate }
  }
  void sessions.resolveParkedConfirm(
    props.confirm.id,
    verdict,
    Object.keys(data).length ? data : undefined
  )
}
</script>

<template>
  <div class="flex flex-col border-b border-border">
    <!-- Collapsed header: muted by default; click to expand-to-review. -->
    <button
      type="button"
      class="flex items-start text-left transition hover:bg-surface-2"
      style="gap: 10px; padding: 10px 16px"
      :aria-expanded="expanded"
      :aria-label="expanded ? $t('agentConfirm.collapse') : $t('agentConfirm.expand')"
      @click="expanded = !expanded"
    >
      <span
        class="shrink-0 rounded-full bg-warning"
        style="width: 7px; height: 7px; margin-top: 4px"
      />
      <span class="flex min-w-0 flex-1 flex-col items-start" style="gap: 2px">
        <span
          class="max-w-full line-clamp-2 font-mono text-text-2"
          style="font-size: 12.5px; line-height: 1.4"
          >{{ confirm.prompt }}</span
        >
        <span class="max-w-full truncate text-text-4" style="font-size: 11px">{{
          $t('agentConfirm.parkedHint')
        }}</span>
      </span>
      <component
        :is="expanded ? ChevronDown : ChevronRight"
        :size="14"
        :stroke-width="1.7"
        class="shrink-0 text-text-3"
        style="margin-top: 2px"
      />
    </button>

    <!-- Expanded: full disclosure + Allow/Deny (the T08 command-disclosure contract). -->
    <div
      v-if="expanded"
      class="anim-fade-in flex flex-col border-t border-border"
      style="gap: 10px; padding: 14px 16px"
    >
      <!-- Prompt (verbatim, never truncated) -->
      <div class="flex flex-col" style="gap: 4px">
        <span
          class="text-text-3"
          style="
            font-size: 10.5px;
            font-weight: 500;
            letter-spacing: 0.06em;
            text-transform: uppercase;
          "
          >{{ $t('agentConfirm.promptLabel') }}</span
        >
        <div
          class="overflow-auto border border-border bg-bg font-mono text-text-2"
          style="
            padding: 8px 10px;
            border-radius: 5px;
            font-size: 11px;
            line-height: 1.5;
            max-height: 160px;
            white-space: pre-wrap;
            word-break: break-word;
          "
        >
          {{ confirm.prompt }}
        </div>
      </div>

      <!-- Shell commands (create_worktree RCE surface; hidden when none) -->
      <div v-if="confirm.commands.length" class="flex flex-col" style="gap: 4px">
        <span
          class="text-text-3"
          style="
            font-size: 10.5px;
            font-weight: 500;
            letter-spacing: 0.06em;
            text-transform: uppercase;
          "
          >{{ $t('agentConfirm.commandsLabel') }}</span
        >
        <span class="text-warning" style="font-size: 10.5px; line-height: 1.4">{{
          $t('agentConfirm.commandsWarning')
        }}</span>
        <div
          class="overflow-auto border border-border bg-bg font-mono text-text-2"
          style="
            padding: 8px 10px;
            border-radius: 5px;
            font-size: 11px;
            line-height: 1.5;
            max-height: 160px;
            white-space: pre-wrap;
            word-break: break-word;
          "
        >
          {{ confirm.commands.map((c) => `$ ${c}`).join('\n') }}
        </div>
      </div>

      <!-- Permission mode -->
      <div class="flex items-center" style="gap: 8px">
        <span
          class="shrink-0 text-text-3"
          style="
            font-size: 10.5px;
            font-weight: 500;
            letter-spacing: 0.06em;
            text-transform: uppercase;
          "
          >{{ $t('agentConfirm.permissionLabel') }}</span
        >
        <span class="truncate font-mono text-text-2" style="font-size: 11px">{{
          confirm.permissionMode
        }}</span>
      </div>

      <!-- Non-default flags (hidden when none) -->
      <div
        v-if="confirm.nonDefaultFlags.length"
        class="flex flex-wrap items-center"
        style="gap: 6px"
      >
        <span
          class="shrink-0 text-text-3"
          style="
            font-size: 10.5px;
            font-weight: 500;
            letter-spacing: 0.06em;
            text-transform: uppercase;
          "
          >{{ $t('agentConfirm.flagsLabel') }}</span
        >
        <span
          v-for="flag in confirm.nonDefaultFlags"
          :key="flag"
          class="border border-border bg-surface-2 font-mono text-text-3"
          style="padding: 1px 6px; border-radius: 4px; font-size: 10.5px"
          >{{ flag }}</span
        >
      </div>

      <!-- T104: the manifest checklist (only when offered) — partial-go: unchecked
           cards are left exactly as they are, never denied. -->
      <div v-if="confirm.manifestCards" class="flex flex-col" style="gap: 4px">
        <span
          class="text-text-3"
          style="
            font-size: 10.5px;
            font-weight: 500;
            letter-spacing: 0.06em;
            text-transform: uppercase;
          "
          >{{ $t('agentConfirm.manifest.cardsLabel') }}</span
        >
        <div class="flex flex-col border border-border" style="border-radius: 5px">
          <div
            v-for="card in confirm.manifestCards"
            :key="card.slug"
            class="flex flex-col border-b border-border last:border-b-0"
            style="padding: 8px 10px; gap: 4px"
          >
            <label class="flex cursor-pointer items-start" style="gap: 8px">
              <input
                type="checkbox"
                :checked="manifestChecked[card.slug]"
                style="margin-top: 2px"
                @change="manifestChecked[card.slug] = ($event.target as HTMLInputElement).checked"
              />
              <span class="flex min-w-0 flex-1 flex-col" style="gap: 2px">
                <span class="text-text-2" style="font-size: 12px">{{ card.title }}</span>
                <span class="font-mono text-text-4" style="font-size: 10.5px">{{ card.slug }}</span>
                <span v-if="manifestMeta(card)" class="text-text-4" style="font-size: 10.5px">{{
                  manifestMeta(card)
                }}</span>
                <span v-if="card.gaps.length" class="text-warning" style="font-size: 10.5px">{{
                  card.gaps.join('; ')
                }}</span>
              </span>
            </label>
            <!-- T102: per-card substrate override — defaults to the resolved value,
                 editable before Allow; the pick is written onto the card alongside
                 the approval stamp. -->
            <label class="flex items-center" style="gap: 6px; margin-left: 22px; font-size: 10.5px">
              <span class="text-text-4">{{ $t('agentConfirm.manifest.substrateLabel') }}</span>
              <select
                v-model="manifestSubstrate[card.slug]"
                class="border border-border bg-surface-2 text-text-2"
                style="padding: 1px 4px; border-radius: 4px; font-size: 10.5px"
              >
                <option v-for="s in SUBSTRATE_OPTIONS" :key="s" :value="s">
                  {{ $t(`roadmap.substrate.${s}`) }}
                </option>
              </select>
            </label>
            <details style="margin-left: 22px">
              <summary class="cursor-pointer text-text-4" style="font-size: 10.5px">
                {{ $t('agentConfirm.manifest.previewPrompt') }}
              </summary>
              <div
                class="overflow-auto border border-border bg-bg font-mono text-text-2"
                style="
                  margin-top: 4px;
                  padding: 6px 8px;
                  border-radius: 4px;
                  font-size: 10.5px;
                  line-height: 1.45;
                  max-height: 140px;
                  white-space: pre-wrap;
                  word-break: break-word;
                "
              >
                {{ card.prompt }}
              </div>
            </details>
          </div>
        </div>
        <span v-if="confirm.manifestCostNote" class="text-text-4" style="font-size: 10.5px">{{
          confirm.manifestCostNote
        }}</span>
      </div>

      <!-- T93: "always allow this verb here" (only when offered) -->
      <label
        v-if="confirm.alwaysAllowOffer"
        class="flex cursor-pointer items-start border border-border bg-surface-2"
        style="gap: 8px; padding: 8px 10px; border-radius: 5px"
      >
        <input
          type="checkbox"
          :checked="alwaysAllow"
          style="margin-top: 2px"
          @change="alwaysAllow = ($event.target as HTMLInputElement).checked"
        />
        <span class="text-text-2" style="font-size: 11.5px; line-height: 1.45">
          {{ $t('agentConfirm.alwaysAllow') }}
        </span>
      </label>

      <!-- Allow / Deny — only reachable after the disclosure above is on screen. -->
      <div class="flex justify-end" style="gap: 6px; margin-top: 2px">
        <button
          type="button"
          class="inline-flex items-center bg-green-soft text-green transition hover:opacity-80"
          style="gap: 5px; padding: 5px 10px; font-size: 12px; border-radius: 5px"
          :aria-label="$t('agentConfirm.allow')"
          @click="respond('allow')"
        >
          <Check :size="13" :stroke-width="2" />{{ $t('agentConfirm.allow') }}
        </button>
        <button
          type="button"
          class="inline-flex items-center bg-red-soft text-red transition hover:opacity-80"
          style="gap: 5px; padding: 5px 10px; font-size: 12px; border-radius: 5px"
          :aria-label="$t('agentConfirm.deny')"
          @click="respond('deny')"
        >
          <X :size="13" :stroke-width="2" />{{ $t('agentConfirm.deny') }}
        </button>
      </div>
    </div>
  </div>
</template>
