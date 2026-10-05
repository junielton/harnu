import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue'
import type { McpGrantView } from '../../../preload'

/**
 * Mission-grants surface (T44 S5c) — the single source of truth for the active
 * mission grants shown in TWO places: the canonical Settings → Control server
 * "Active missions" section (`McpServerPane`) and the compact live-missions strip
 * at the top of the `InboxRail` (where a grant's escalations land).
 *
 * A mission grant is the ONE path where an agent's matching actions auto-run
 * without a per-action confirm, so the operator needs to SEE what's auto-allowed
 * (budget/time left) and REVOKE any with one click. This composable keeps the
 * fetch/subscribe/revoke logic DRY — both consumers call `useMissionGrants()`
 * and render the same reactive list.
 *
 * Mirrors the queue composables (`session-approvals.ts` / `session-mcp-confirms.ts`):
 * a reactive list reassigned on every change (`docs/lessons/reactivity/002`),
 * seeded once via `mcpGrantsList()` and kept live by `onMcpGrantsChanged`. Unlike
 * those (wired into the sessions store), grants are read-mostly and consumed by
 * only two overlays, so each component instantiates its own — the subscription +
 * the TTL `now` ticker are cleaned up via `onScopeDispose`.
 *
 * TTL is derived lazily off a shared `now` ref ticked every 30s (the main-process
 * registry ALSO emits `changed` when a grant's TTL fires, so the countdown stays
 * honest either way); "active" is recomputed client-side against `now` so a grant
 * dims the moment it expires, not only when the next server event lands.
 */

const TICK_MS = 30_000

export interface MissionGrantsSurface {
  /** Every grant the registry currently holds — includes dimmed revoked/expired ones. */
  grants: Ref<McpGrantView[]>
  /** Live grants only (not revoked/expired/exhausted), soonest-expiry first. */
  activeGrants: ComputedRef<McpGrantView[]>
  /** All grants ordered active-first, then dimmed — for the full Settings list. */
  orderedGrants: ComputedRef<McpGrantView[]>
  /** Re-pull the snapshot (called once on setup; harmless to call again). */
  refresh: () => Promise<void>
  /** Revoke a grant (optimistic dim; the `changed` broadcast reconciles). */
  revoke: (id: string) => Promise<void>
  /** Whole minutes left before this grant's TTL, floored at 0. */
  minutesLeft: (g: McpGrantView) => number
  /** Whether the grant can still auto-allow right now (recomputed against `now`). */
  isActive: (g: McpGrantView) => boolean
}

export function useMissionGrants(): MissionGrantsSurface {
  // The full grant list, reassigned wholesale on every change (list()/changed) so
  // the derived computeds pick it up. `now` drives the TTL countdown + liveness.
  const grants = ref<McpGrantView[]>([])
  const now = ref(Date.now())

  function isActive(g: McpGrantView): boolean {
    return !g.revoked && g.remaining > 0 && g.expiresAt > now.value
  }

  function minutesLeft(g: McpGrantView): number {
    return Math.max(0, Math.ceil((g.expiresAt - now.value) / 60000))
  }

  const activeGrants = computed(() =>
    grants.value.filter(isActive).sort((a, b) => a.expiresAt - b.expiresAt)
  )

  const orderedGrants = computed(() =>
    [...grants.value].sort(
      (a, b) => Number(isActive(b)) - Number(isActive(a)) || a.expiresAt - b.expiresAt
    )
  )

  async function refresh(): Promise<void> {
    try {
      grants.value = await window.api.mcpGrantsList()
    } catch {
      /* leave last-known snapshot */
    }
  }

  async function revoke(id: string): Promise<void> {
    // Optimistic: dim the row at once. A `mcp:grants:changed` broadcast will also
    // arrive and reconcile; a rejected revoke is swallowed (never-throw).
    grants.value = grants.value.map((g) => (g.id === id ? { ...g, revoked: true, live: false } : g))
    try {
      await window.api.mcpGrantsRevoke(id)
    } catch {
      /* never-throw — the registry stays authoritative and re-broadcasts */
    }
  }

  void refresh()

  // Feature-detected like the parked-confirm feed in `sessions.ts`: a stub/older
  // preload without the grants channel simply gets no live updates (still seeded
  // by the `refresh()` above), rather than throwing on setup.
  const off =
    typeof window.api.onMcpGrantsChanged === 'function'
      ? window.api.onMcpGrantsChanged((list) => {
          grants.value = list
        })
      : (): void => {}

  const timer = setInterval(() => {
    now.value = Date.now()
  }, TICK_MS)

  onScopeDispose(() => {
    off()
    clearInterval(timer)
  })

  return { grants, activeGrants, orderedGrants, refresh, revoke, minutesLeft, isActive }
}
