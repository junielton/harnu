<script setup lang="ts">
/**
 * Settings → MCP tab (design §6 → "Control server (MCP)"). The operator surface
 * for the loopback MCP control server: the kill switch, the live status (port +
 * agent-connection dot), a "Copy config" affordance for the loopback endpoint, the
 * "Ask before agent actions" friction toggle, the per-folder BLOCK list, and a
 * read-only audit log of every gated tool call.
 *
 * This pane is where the free-by-default posture is made visible and reversible:
 * agents act without confirms, so the operator's three opt-outs all live here (plus
 * the folder menu's copy of the block toggle) — kill the server, ask before every
 * action, or block one folder. The audit log below them is the accountability
 * surface for everything that ran unattended.
 *
 * Consumes ONLY the existing preload surface — `mcpStatus` / `mcpSetEnabled` /
 * `mcpAskGet` / `mcpAskSet` / `mcpGetAudit` for the server, and the sessions store
 * (`agentDeniedPaths` / `setFolderAgentDenied`, backed by
 * `userProjectsSetAgentDenied`) for the block list. The bearer token never crosses
 * into the renderer (it lives 0600 in `harnu.mcp.json` and is auto-injected into
 * Harnu-spawned sessions), so the pane surfaces the endpoint, not the secret.
 * Tokens-only styling, all copy via $t.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Copy } from 'lucide-vue-next'
import { useUiStore } from '../stores/ui'
import { useSessionsStore } from '../stores/sessions'
import { useMissionGrants } from '../composables/useMissionGrants'
import { clampPct } from './usage-format'
import ToggleSwitch from './ui/ToggleSwitch.vue'
import SettingHint from './ui/SettingHint.vue'
import type { McpServerStatus, McpAuditRecord, UserProject, McpGrantView } from '../../../preload'

const { t } = useI18n()
const ui = useUiStore()
const sessions = useSessionsStore()

// Active mission grants (T44 S5c) — the auto-approved scopes the operator can see
// + revoke. Read-mostly; the composable owns the fetch/subscribe/revoke + the TTL
// ticker and cleans both up when the pane unmounts.
const { orderedGrants, revoke, minutesLeft, isActive } = useMissionGrants()

/** Budget fill % for the grant meter (spent of budget), clamped to 0..100. */
function budgetPct(g: McpGrantView): number {
  return clampPct(g.budget > 0 ? (g.spent / g.budget) * 100 : 0)
}

const status = ref<McpServerStatus>({ enabled: false, port: 0, connected: false })
const audit = ref<McpAuditRecord[]>([])
/** Pinned projects (path + alias) — the only folders eligible for the allowlist. */
const projects = ref<UserProject[]>([])
const busy = ref(false)
// The friction opt-in: put a human confirm back in front of EVERY mutating agent
// action. Default OFF (agents act freely); main-side authoritative.
const ask = ref(false)
// T93: auto-register opt-out — inject Harnu's MCP server into spawned `claude`
// sessions. Default ON; main-side authoritative.
const autoRegister = ref(true)

let pollTimer: ReturnType<typeof setInterval> | null = null

/** The loopback endpoint a manual MCP client would point at. */
const endpoint = computed(() => `http://127.0.0.1:${status.value.port}/mcp`)

/** Audit log, newest first (the ring is appended oldest→newest). */
const auditRows = computed(() => audit.value.slice().reverse())

/** Basename of an absolute path (for the compact folder alias in audit rows). */
function basename(p: string): string {
  if (!p) return ''
  const trimmed = p.replace(/\/+$/, '')
  return trimmed.split('/').pop() || trimmed
}

/** Local time string for an audit timestamp. */
function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return ''
  }
}

/** verdict → token-backed text colour (allow green, deny red, else muted). */
function verdictClass(verdict: string): string {
  if (verdict === 'allow') return 'text-green'
  if (verdict === 'deny') return 'text-red'
  return 'text-text-3'
}

async function refreshStatus(): Promise<void> {
  try {
    status.value = await window.api.mcpStatus()
  } catch {
    /* leave last-known status */
  }
}

async function refreshAudit(): Promise<void> {
  try {
    audit.value = await window.api.mcpGetAudit()
  } catch {
    /* leave last-known audit */
  }
}

async function loadProjects(): Promise<void> {
  try {
    const r = await window.api.userProjectsList()
    projects.value = Array.isArray(r) ? r : r.projects
  } catch {
    projects.value = []
  }
}

async function toggleEnabled(next: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  status.value = { ...status.value, enabled: next } // optimistic
  try {
    status.value = await window.api.mcpSetEnabled(next)
  } catch {
    status.value = { ...status.value, enabled: !next } // revert
  } finally {
    busy.value = false
    void refreshAudit()
  }
}

/** The row toggle reads "agents allowed here", so ON = NOT blocked. */
async function toggleFolder(path: string, allowed: boolean): Promise<void> {
  try {
    await sessions.setFolderAgentDenied(path, !allowed)
  } catch {
    /* store mirror simply won't flip — no destructive state */
  }
}

async function loadAsk(): Promise<void> {
  try {
    ask.value = await window.api.mcpAskGet()
  } catch {
    ask.value = false // default: no confirms
  }
}

async function toggleAsk(next: boolean): Promise<void> {
  ask.value = next // optimistic
  try {
    ask.value = await window.api.mcpAskSet(next)
  } catch {
    ask.value = !next // revert
  }
}

async function loadAutoRegister(): Promise<void> {
  try {
    autoRegister.value = await window.api.mcpAutoRegisterGet()
  } catch {
    autoRegister.value = true // default ON
  }
}

async function toggleAutoRegister(next: boolean): Promise<void> {
  autoRegister.value = next // optimistic
  try {
    autoRegister.value = await window.api.mcpAutoRegisterSet(next)
  } catch {
    autoRegister.value = !next // revert
  }
}

async function copyConfig(): Promise<void> {
  const config = {
    mcpServers: {
      harnu: { type: 'http', url: endpoint.value }
    }
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(config, null, 2))
    ui.pushToast({ kind: 'success', title: t('mcpServer.configCopied'), persist: false })
  } catch {
    ui.pushToast({ kind: 'danger', title: t('sessionMenu.copyFailed') })
  }
}

onMounted(() => {
  void refreshStatus()
  void refreshAudit()
  void loadProjects()
  void loadAsk()
  void loadAutoRegister()
  // Light poll keeps the connection dot + audit log fresh while the pane is open.
  pollTimer = setInterval(() => {
    void refreshStatus()
    void refreshAudit()
  }, 3000)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})

const eyebrowStyle =
  'font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 8px'
</script>

<template>
  <div>
    <!-- Server: enable + status + endpoint -->
    <section style="margin-bottom: 18px">
      <div class="text-text-3" :style="eyebrowStyle">{{ $t('mcpServer.title') }}</div>

      <div class="flex items-start justify-between" style="gap: 12px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">{{ $t('mcpServer.enable') }}</div>
          <SettingHint>{{ $t('mcpServer.description') }}</SettingHint>
        </div>
        <ToggleSwitch
          :model-value="status.enabled"
          :disabled="busy"
          :aria-label="$t('mcpServer.enable')"
          @update:model-value="toggleEnabled($event)"
        />
      </div>

      <!-- Status + endpoint (only meaningful while the server is up) -->
      <div v-if="status.enabled" style="margin-top: 14px">
        <div class="flex items-center" style="gap: 8px">
          <span
            class="shrink-0 rounded-full"
            :class="status.connected ? 'bg-green' : 'bg-text-3'"
            style="width: 8px; height: 8px"
          />
          <span class="text-text-3" style="font-size: 11px">
            <template v-if="status.connected">{{ $t('mcpServer.agentConnected') }}</template>
            <template v-else>{{ $t('mcpServer.running', { port: status.port }) }}</template>
          </span>
        </div>

        <div class="flex items-center" style="gap: 10px; margin-top: 10px">
          <span
            class="min-w-0 flex-1 truncate font-mono tabular-nums text-text-4"
            style="font-size: 11px"
            :title="endpoint"
            >{{ endpoint }}</span
          >
          <button
            type="button"
            class="inline-flex shrink-0 items-center border border-border bg-surface text-text transition hover:bg-surface-2"
            style="gap: 6px; padding: 6px 12px; font-size: 12.5px; border-radius: 5px"
            @click="copyConfig()"
          >
            <Copy :size="13" :stroke-width="1.7" />{{ $t('mcpServer.copyConfig') }}
          </button>
        </div>

        <!-- T93: auto-register into spawned sessions (default ON; only meaningful while up) -->
        <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
          <div style="flex: 1; min-width: 0">
            <div class="text-text-2" style="font-size: 12px">
              {{ $t('mcpServer.autoRegister.label') }}
            </div>
            <SettingHint>{{ $t('mcpServer.autoRegister.description') }}</SettingHint>
          </div>
          <ToggleSwitch
            :model-value="autoRegister"
            :aria-label="$t('mcpServer.autoRegister.label')"
            @update:model-value="toggleAutoRegister($event)"
          />
        </div>
      </div>

      <!-- The friction opt-in: confirm EVERY mutating agent action. Default OFF. -->
      <div class="flex items-start justify-between" style="gap: 12px; margin-top: 14px">
        <div style="flex: 1; min-width: 0">
          <div class="text-text-2" style="font-size: 12px">
            {{ $t('mcpServer.ask.label') }}
          </div>
          <SettingHint>{{ $t('mcpServer.ask.description') }}</SettingHint>
        </div>
        <ToggleSwitch
          :model-value="ask"
          :aria-label="$t('mcpServer.ask.label')"
          @update:model-value="toggleAsk($event)"
        />
      </div>
    </section>

    <!-- Per-folder block list. ON = agents may act here (the default). -->
    <section style="margin-bottom: 18px">
      <div class="text-text-3" :style="eyebrowStyle">{{ $t('mcpServer.allowFolders.title') }}</div>
      <SettingHint style="margin-bottom: 8px">
        {{ $t('mcpServer.allowFolders.hint') }}
      </SettingHint>

      <div v-if="projects.length === 0" class="text-text-4" style="font-size: 12px; padding: 8px 0">
        {{ $t('mcpServer.allowFolders.empty') }}
      </div>
      <div v-else class="flex flex-col" style="gap: 4px">
        <div
          v-for="p in projects"
          :key="p.path"
          class="flex items-center justify-between border border-border bg-surface"
          style="gap: 12px; padding: 8px 10px; border-radius: 6px"
        >
          <div style="flex: 1; min-width: 0">
            <div class="truncate text-text-2" style="font-size: 12px">
              {{ p.alias || basename(p.path) }}
            </div>
            <div class="truncate font-mono text-text-4" style="font-size: 11px" :title="p.path">
              {{ p.path }}
            </div>
          </div>
          <ToggleSwitch
            :model-value="!sessions.agentDeniedPaths.has(p.path)"
            :aria-label="$t('mcpServer.allowFolders.title')"
            @update:model-value="toggleFolder(p.path, $event)"
          />
        </div>
      </div>
    </section>

    <!-- Active missions (the one path that auto-runs without a per-action confirm) -->
    <section v-if="status.enabled" style="margin-bottom: 18px">
      <div class="text-text-3" :style="eyebrowStyle">{{ $t('mcpServer.missions.title') }}</div>

      <div
        v-if="orderedGrants.length === 0"
        class="text-text-4"
        style="font-size: 12px; padding: 8px 0"
      >
        {{ $t('mcpServer.missions.empty') }}
      </div>
      <div v-else class="flex flex-col" style="gap: 6px">
        <div
          v-for="g in orderedGrants"
          :key="g.id"
          class="flex flex-col border border-border bg-surface"
          :class="{ 'opacity-60': !isActive(g) }"
          style="gap: 6px; padding: 8px 10px; border-radius: 6px"
        >
          <!-- Goal + Revoke / dimmed state -->
          <div class="flex items-center justify-between" style="gap: 10px">
            <span
              class="min-w-0 flex-1 truncate text-text-2"
              style="font-size: 12px"
              :title="g.goal"
            >
              {{ g.goal }}
            </span>
            <button
              v-if="isActive(g)"
              type="button"
              class="inline-flex shrink-0 items-center bg-red-soft text-red transition hover:opacity-80"
              style="padding: 4px 9px; font-size: 11.5px; border-radius: 5px"
              @click="revoke(g.id)"
            >
              {{ $t('mcpServer.missions.revoke') }}
            </button>
            <span v-else class="shrink-0 text-text-4" style="font-size: 11px">
              {{ g.revoked ? $t('mcpServer.missions.revoked') : $t('mcpServer.missions.expired') }}
            </span>
          </div>

          <!-- Folders · verbs (muted) -->
          <div
            v-if="g.folders.length || g.verbs.length"
            class="truncate text-text-4"
            style="font-size: 11px"
          >
            <template v-if="g.folders.length"
              >{{ $t('mcpServer.missions.folders') }}: {{ g.folders.join(', ') }}</template
            >
            <template v-if="g.folders.length && g.verbs.length"> · </template>
            <template v-if="g.verbs.length"
              >{{ $t('mcpServer.missions.verbs') }}: {{ g.verbs.join(', ') }}</template
            >
          </div>

          <!-- Budget meter + spent/budget + TTL -->
          <div class="flex items-center" style="gap: 10px">
            <div class="overflow-hidden rounded-full bg-surface-2" style="flex: 1; height: 3px">
              <div class="h-full rounded-full bg-accent" :style="{ width: budgetPct(g) + '%' }" />
            </div>
            <span class="shrink-0 tabular-nums text-text-3" style="font-size: 11px">{{
              $t('mcpServer.missions.budget', { spent: g.spent, budget: g.budget })
            }}</span>
            <span class="shrink-0 tabular-nums text-text-4" style="font-size: 11px">
              <template v-if="isActive(g)">{{
                $t('mcpServer.missions.expiresIn', { mins: minutesLeft(g) })
              }}</template>
              <template v-else>{{
                g.revoked ? $t('mcpServer.missions.revoked') : $t('mcpServer.missions.expired')
              }}</template>
            </span>
          </div>
        </div>
      </div>
    </section>

    <!-- Audit log (read-only) -->
    <section>
      <div class="text-text-3" :style="eyebrowStyle">{{ $t('mcpServer.auditTitle') }}</div>

      <div
        v-if="auditRows.length === 0"
        class="text-text-4"
        style="font-size: 12px; padding: 8px 0"
      >
        {{ $t('mcpServer.auditEmpty') }}
      </div>
      <div v-else class="flex flex-col">
        <div
          v-for="(row, idx) in auditRows"
          :key="idx"
          class="flex items-center border-b border-border"
          style="gap: 10px; padding: 7px 0"
        >
          <span class="shrink-0 font-mono text-text-2" style="font-size: 11px">{{ row.tool }}</span>
          <span
            v-if="row.folder"
            class="min-w-0 flex-1 truncate text-text-4"
            style="font-size: 11px"
            :title="row.folder"
            >{{ basename(row.folder) }}</span
          >
          <span v-else class="min-w-0 flex-1" />
          <span
            v-if="row.result"
            class="shrink-0 truncate font-mono text-text-4"
            style="font-size: 10.5px; max-width: 140px"
            :title="row.result"
            >{{ row.result }}</span
          >
          <span
            class="shrink-0 font-medium"
            :class="verdictClass(row.verdict)"
            style="font-size: 11px"
            >{{ row.verdict }}</span
          >
          <span class="shrink-0 tabular-nums text-text-4" style="font-size: 10.5px">{{
            formatTime(row.ts)
          }}</span>
        </div>
      </div>
    </section>
  </div>
</template>
