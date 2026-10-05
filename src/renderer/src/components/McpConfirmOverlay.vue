<script setup lang="ts">
/**
 * Agent-action confirm overlay (design §6 → "Variante agent-action"). The
 * fail-CLOSED sign-off surface for a mutation an external MCP agent requested
 * (create session / spawn terminal / create worktree). Mounted once at the App
 * level; it **auto-shows** from its own local queue whenever a `mode === 'modal'`
 * confirm arrives on `mcp:confirm:pending` (window focused → fast path), so it
 * surfaces regardless of the active view. `mode === 'parked'` confirms (window
 * unfocused) go to the Approval Inbox parked queue instead (T44 S4c) — never here.
 *
 * Two non-negotiable security properties (vs. the Approval Inbox row):
 *   1. **Fail-CLOSED.** Esc / backdrop do NOT close it. Verdict-producing exits
 *      are only Allow, Deny, or the deadline elapsing (the main-process gate
 *      auto-denies; we mirror that by pruning the row once its `deadline`
 *      passes). BUG-32 D3 adds one NON-verdict exit — **Dismiss** ("not now"):
 *      it defers the row back to the Approval Inbox without answering; the
 *      confirm stays `pending` and its TTL is untouched, so this is not a
 *      silent dismissal in the fail-closed sense above.
 *   2. **Mandatory disclosure.** Every row shows the effective prompt, the
 *      resolved permission mode, and the requested non-default flags — verbatim —
 *      before the Allow/Deny buttons.
 *
 * BUG-32 D1: a confirm that parked while the window was unfocused arrives here
 * too, once promoted — `confirm-core.ts` re-sends it with `mode: 'modal'` on
 * focus regain, and this component's own `onMcpConfirmPending` listener (below)
 * treats it exactly like a fresh arrival.
 *
 * Reuses the Approval Inbox's visual language (overlay anatomy, green/red token
 * buttons). Tokens-only styling, all copy via $t.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, Clock, ShieldAlert, X } from 'lucide-vue-next'
import { useFocusTrap } from '../composables/useFocusTrap'
import type { McpConfirmPending } from '../../../preload'

const pending = ref<McpConfirmPending[]>([])
const now = ref(Date.now())
const panelRef = ref<HTMLElement | null>(null)
// T61: per-confirm "inherit agent control" checkbox state, default checked (inherit).
// Keyed by confirm id; only meaningful for a confirm whose `worktreeInheritOffer` is true.
const inheritChoice = ref<Record<string, boolean>>({})
// T72: per-confirm inheritance-discovery scope, default 'once' (least privilege).
// Keyed by confirm id; only meaningful when `inheritDiscoveryOffer` is true.
const inheritScopeChoice = ref<Record<string, 'always' | 'once'>>({})
// T93: per-confirm "always allow this verb here" checkbox, defaulted from the wire
// (unchecked for the dangerous verbs). Keyed by id; only meaningful when
// `alwaysAllowOffer` is true. Independent of the T61/T72 offers (may co-occur).
const alwaysAllowChoice = ref<Record<string, boolean>>({})
// T104: per-confirm manifest checklist state (confirm id → slug → checked).
// Partial-go is native (§2.2): every card starts CHECKED, the operator unchecks
// the ones to leave out. Only meaningful when `manifestCards` is present.
const manifestChoice = ref<Record<string, Record<string, boolean>>>({})
function manifestMeta(card: NonNullable<McpConfirmPending['manifestCards']>[number]): string {
  return [card.kind, card.complexity, card.model].filter(Boolean).join(' · ')
}

// T102: per-confirm manifest substrate override (confirm id → slug → substrate).
// Prefilled from each row's resolved substrate (default `session`); the
// operator can flip it here before Allow — the pick rides back on
// `manifestSubstrateOverrides` and is written alongside the approval stamp.
const manifestSubstrate = ref<Record<string, Record<string, string>>>({})
const SUBSTRATE_OPTIONS = ['session', 'worktree', 'teammate', 'internal'] as const

let unsub: (() => void) | null = null
let ticker: ReturnType<typeof setInterval> | null = null

const isOpen = computed(() => pending.value.length > 0)
useFocusTrap({ active: isOpen, containerRef: panelRef })

/** Whole seconds until a confirm auto-denies (clamped at 0). */
function secondsLeft(p: McpConfirmPending): number {
  return Math.max(0, Math.ceil((p.deadline - now.value) / 1000))
}

async function respond(p: McpConfirmPending, verdict: 'allow' | 'deny'): Promise<void> {
  // Optimistic remove — the gate settles server-side on the response.
  pending.value = pending.value.filter((x) => x.id !== p.id)
  // T61: on Allow, carry the inherit-checkbox choice back (default checked = inherit).
  // T72: for a discovery confirm, carry the chosen scope instead (default 'once').
  // The T61/T72 offers are mutually exclusive (create_worktree vs. act-in-worktree).
  // T93: the "always allow" choice is INDEPENDENT (can co-occur with the T61 offer on
  // a create_worktree), so it merges into the same data object additively.
  const data: {
    inheritWorktreeControl?: boolean
    inheritScope?: 'always' | 'once'
    alwaysAllow?: boolean
    manifestSelectedSlugs?: string[]
    manifestSubstrateOverrides?: Record<string, string>
  } = {}
  if (p.worktreeInheritOffer) data.inheritWorktreeControl = inheritChoice.value[p.id] !== false
  else if (p.inheritDiscoveryOffer) data.inheritScope = inheritScopeChoice.value[p.id] ?? 'once'
  if (p.alwaysAllowOffer) data.alwaysAllow = alwaysAllowChoice.value[p.id] === true
  if (p.manifestCards) {
    const checked = manifestChoice.value[p.id] ?? {}
    data.manifestSelectedSlugs = p.manifestCards.filter((c) => checked[c.slug]).map((c) => c.slug)
    data.manifestSubstrateOverrides = { ...(manifestSubstrate.value[p.id] ?? {}) }
  }
  const payload = Object.keys(data).length > 0 ? data : undefined
  delete inheritChoice.value[p.id]
  delete inheritScopeChoice.value[p.id]
  delete alwaysAllowChoice.value[p.id]
  delete manifestChoice.value[p.id]
  delete manifestSubstrate.value[p.id]
  try {
    await window.api.mcpConfirmRespond(p.id, verdict, payload)
  } catch {
    /* The main-process gate fails closed on its own deadline regardless. */
  }
}

/**
 * BUG-32 D3: "not now" — distinct from Deny. Removes the row from this
 * overlay's local queue (like `respond`) but produces NO verdict: the confirm
 * stays `pending`, its TTL keeps running, and it reappears in the Approval
 * Inbox "Needs you" tab (`session-mcp-confirms.ts` re-adds it on the
 * `mode: 'parked'` re-arrival this triggers, without replaying the chime).
 */
async function dismiss(p: McpConfirmPending): Promise<void> {
  pending.value = pending.value.filter((x) => x.id !== p.id)
  delete inheritChoice.value[p.id]
  delete inheritScopeChoice.value[p.id]
  delete alwaysAllowChoice.value[p.id]
  delete manifestChoice.value[p.id]
  delete manifestSubstrate.value[p.id]
  try {
    await window.api.mcpConfirmDismiss(p.id)
  } catch {
    /* the confirm stays live server-side regardless; a re-focus will re-offer it */
  }
}

onMounted(() => {
  unsub = window.api.onMcpConfirmPending((p) => {
    // Focused fast path only (T44 S4c): `mode === 'parked'` confirms (window was
    // unfocused) go to the Approval Inbox instead — the parked queue chimes,
    // raises OS attention, and renders an expand-to-review row there.
    if (p.mode !== 'modal') return
    if (!pending.value.some((x) => x.id === p.id)) {
      // T61: default the inherit checkbox to checked when the confirm offers it.
      if (p.worktreeInheritOffer) inheritChoice.value[p.id] = true
      // T72: default the discovery scope to 'once' (least privilege) when offered.
      if (p.inheritDiscoveryOffer) inheritScopeChoice.value[p.id] = 'once'
      // T93: default the "always allow" checkbox from the wire (unchecked for dangerous).
      if (p.alwaysAllowOffer) alwaysAllowChoice.value[p.id] = p.alwaysAllowDefault === true
      // T104: default every manifest card CHECKED (partial-go: uncheck to leave out).
      // T102: default the substrate picker to each row's resolved substrate.
      if (p.manifestCards) {
        manifestChoice.value[p.id] = Object.fromEntries(p.manifestCards.map((c) => [c.slug, true]))
        manifestSubstrate.value[p.id] = Object.fromEntries(
          p.manifestCards.map((c) => [c.slug, c.substrate ?? 'session'])
        )
      }
      pending.value = [...pending.value, p]
    }
  })
  // Drive the countdown + prune rows the main-process gate has already auto-denied.
  ticker = setInterval(() => {
    now.value = Date.now()
    pending.value = pending.value.filter((p) => p.deadline > now.value)
  }, 500)
})

onBeforeUnmount(() => {
  unsub?.()
  if (ticker) clearInterval(ticker)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      class="anim-overlay-fade fixed inset-0 flex justify-center"
      style="background: rgba(0, 0, 0, 0.55); z-index: 65"
      role="presentation"
    >
      <div
        ref="panelRef"
        class="anim-fade-in-scale flex flex-col overflow-hidden border border-border-2 bg-surface text-text"
        style="
          width: min(540px, 92vw);
          max-height: 80vh;
          margin-top: 10vh;
          height: max-content;
          border-radius: 7px;
          box-shadow: var(--shadow-pop);
        "
        role="dialog"
        aria-modal="true"
        :aria-label="$t('agentConfirm.title')"
      >
        <!-- Header -->
        <div
          class="flex shrink-0 items-center border-b border-border"
          style="padding: 12px 16px; gap: 10px"
        >
          <ShieldAlert :size="15" :stroke-width="1.7" class="shrink-0 text-warning" />
          <span class="min-w-0 flex-1 text-text" style="font-size: 13px; font-weight: 500">{{
            $t('agentConfirm.title')
          }}</span>
          <span
            v-if="pending.length > 1"
            class="shrink-0 border border-accent-line bg-accent-soft text-accent tabular-nums"
            style="padding: 1px 7px; border-radius: 999px; font-size: 11px"
            >{{ pending.length }}</span
          >
        </div>

        <!-- Body — one disclosure block per parked confirm -->
        <div class="scrollable flex-1 overflow-y-auto">
          <div
            v-for="p in pending"
            :key="p.id"
            class="flex flex-col border-b border-border"
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
                {{ p.prompt }}
              </div>
            </div>

            <!-- Shell commands (create_worktree RCE surface; hidden when none) -->
            <div v-if="p.commands.length" class="flex flex-col" style="gap: 4px">
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
                {{ p.commands.map((c) => `$ ${c}`).join('\n') }}
              </div>
            </div>

            <!-- T61: agent-control inheritance opt-out (only when offered) -->
            <label
              v-if="p.worktreeInheritOffer"
              class="flex cursor-pointer items-start border border-border bg-surface-2"
              style="gap: 8px; padding: 8px 10px; border-radius: 5px"
            >
              <input
                type="checkbox"
                :checked="inheritChoice[p.id] !== false"
                style="margin-top: 2px"
                @change="inheritChoice[p.id] = ($event.target as HTMLInputElement).checked"
              />
              <span class="text-text-2" style="font-size: 11.5px; line-height: 1.45">
                {{ $t('agentConfirm.inheritControl') }}
              </span>
            </label>

            <!-- T72: inheritance-discovery scope selector (only when offered). Three
                 visual choices, two verdicts: the segmented picks the scope that rides
                 on the green Allow; the red Deny is "Deny". Default = "Only this". -->
            <div v-if="p.inheritDiscoveryOffer" class="flex flex-col" style="gap: 5px">
              <span
                class="text-text-3"
                style="
                  font-size: 10.5px;
                  font-weight: 500;
                  letter-spacing: 0.06em;
                  text-transform: uppercase;
                "
                >{{ $t('agentConfirm.inheritDiscovery.scopeLabel') }}</span
              >
              <div
                class="inline-flex border border-border bg-surface-2"
                style="border-radius: 5px; padding: 2px; gap: 2px; width: max-content"
                role="radiogroup"
              >
                <button
                  type="button"
                  role="radio"
                  :aria-checked="(inheritScopeChoice[p.id] ?? 'once') === 'once'"
                  class="transition"
                  :class="
                    (inheritScopeChoice[p.id] ?? 'once') === 'once'
                      ? 'border border-accent-line bg-accent-soft text-accent'
                      : 'border border-transparent text-text-3 hover:text-text-2'
                  "
                  style="padding: 3px 12px; font-size: 11.5px; border-radius: 4px"
                  @click="inheritScopeChoice[p.id] = 'once'"
                >
                  {{ $t('agentConfirm.inheritDiscovery.scopeOnce') }}
                </button>
                <button
                  type="button"
                  role="radio"
                  :aria-checked="(inheritScopeChoice[p.id] ?? 'once') === 'always'"
                  class="transition"
                  :class="
                    (inheritScopeChoice[p.id] ?? 'once') === 'always'
                      ? 'border border-accent-line bg-accent-soft text-accent'
                      : 'border border-transparent text-text-3 hover:text-text-2'
                  "
                  style="padding: 3px 12px; font-size: 11.5px; border-radius: 4px"
                  @click="inheritScopeChoice[p.id] = 'always'"
                >
                  {{ $t('agentConfirm.inheritDiscovery.scopeAlways') }}
                </button>
              </div>
            </div>

            <!-- T93: "always allow this verb here" (only when offered) -->
            <label
              v-if="p.alwaysAllowOffer"
              class="flex cursor-pointer items-start border border-border bg-surface-2"
              style="gap: 8px; padding: 8px 10px; border-radius: 5px"
            >
              <input
                type="checkbox"
                :checked="alwaysAllowChoice[p.id] === true"
                style="margin-top: 2px"
                @change="alwaysAllowChoice[p.id] = ($event.target as HTMLInputElement).checked"
              />
              <span class="text-text-2" style="font-size: 11.5px; line-height: 1.45">
                {{ $t('agentConfirm.alwaysAllow') }}
              </span>
            </label>

            <!-- T104: the manifest checklist (only when offered) — partial-go: unchecked
                 cards are left exactly as they are, never denied. -->
            <div v-if="p.manifestCards" class="flex flex-col" style="gap: 4px">
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
                  v-for="card in p.manifestCards"
                  :key="card.slug"
                  class="flex flex-col border-b border-border last:border-b-0"
                  style="padding: 8px 10px; gap: 4px"
                >
                  <label class="flex cursor-pointer items-start" style="gap: 8px">
                    <input
                      type="checkbox"
                      :checked="manifestChoice[p.id]?.[card.slug] ?? true"
                      style="margin-top: 2px"
                      @change="
                        manifestChoice[p.id] = {
                          ...manifestChoice[p.id],
                          [card.slug]: ($event.target as HTMLInputElement).checked
                        }
                      "
                    />
                    <span class="flex min-w-0 flex-1 flex-col" style="gap: 2px">
                      <span class="text-text-2" style="font-size: 12px">{{ card.title }}</span>
                      <span class="font-mono text-text-4" style="font-size: 10.5px">{{
                        card.slug
                      }}</span>
                      <span
                        v-if="manifestMeta(card)"
                        class="text-text-4"
                        style="font-size: 10.5px"
                        >{{ manifestMeta(card) }}</span
                      >
                      <span
                        v-if="card.gaps.length"
                        class="text-warning"
                        style="font-size: 10.5px"
                        >{{ card.gaps.join('; ') }}</span
                      >
                    </span>
                  </label>
                  <!-- T102: per-card substrate override — defaults to the resolved
                       value, editable before Allow; the pick is written onto the
                       card alongside the approval stamp. -->
                  <label
                    class="flex items-center"
                    style="gap: 6px; margin-left: 22px; font-size: 10.5px"
                  >
                    <span class="text-text-4">{{
                      $t('agentConfirm.manifest.substrateLabel')
                    }}</span>
                    <select
                      :value="manifestSubstrate[p.id]?.[card.slug] ?? 'session'"
                      class="border border-border bg-surface-2 text-text-2"
                      style="padding: 1px 4px; border-radius: 4px; font-size: 10.5px"
                      @change="
                        manifestSubstrate[p.id] = {
                          ...manifestSubstrate[p.id],
                          [card.slug]: ($event.target as HTMLSelectElement).value
                        }
                      "
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
              <span v-if="p.manifestCostNote" class="text-text-4" style="font-size: 10.5px">{{
                p.manifestCostNote
              }}</span>
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
                p.permissionMode
              }}</span>
            </div>

            <!-- Non-default flags (hidden when none) -->
            <div
              v-if="p.nonDefaultFlags.length"
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
                v-for="flag in p.nonDefaultFlags"
                :key="flag"
                class="border border-border bg-surface-2 font-mono text-text-3"
                style="padding: 1px 6px; border-radius: 4px; font-size: 10.5px"
                >{{ flag }}</span
              >
            </div>

            <!-- Auto-deny countdown + Allow/Deny -->
            <div class="flex items-center justify-between" style="gap: 10px; margin-top: 2px">
              <span class="min-w-0 flex-1 truncate text-text-4" style="font-size: 10.5px">
                {{ $t('agentConfirm.autoDeny', { seconds: secondsLeft(p) }) }}
              </span>
              <div class="flex shrink-0" style="gap: 6px">
                <button
                  type="button"
                  class="inline-flex items-center border border-border bg-transparent text-text-2 transition hover:bg-surface-2"
                  style="gap: 5px; padding: 5px 10px; font-size: 12px; border-radius: 5px"
                  :title="$t('agentConfirm.dismissHint')"
                  @click="dismiss(p)"
                >
                  <Clock :size="13" :stroke-width="2" />{{ $t('agentConfirm.dismiss') }}
                </button>
                <button
                  type="button"
                  class="inline-flex items-center bg-green-soft text-green transition hover:opacity-80"
                  style="gap: 5px; padding: 5px 10px; font-size: 12px; border-radius: 5px"
                  @click="respond(p, 'allow')"
                >
                  <Check :size="13" :stroke-width="2" />{{ $t('agentConfirm.allow') }}
                </button>
                <button
                  type="button"
                  class="inline-flex items-center bg-red-soft text-red transition hover:opacity-80"
                  style="gap: 5px; padding: 5px 10px; font-size: 12px; border-radius: 5px"
                  @click="respond(p, 'deny')"
                >
                  <X :size="13" :stroke-width="2" />{{ $t('agentConfirm.deny') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
