import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ClaudeBootConfig, EndpointProfile } from '../../../preload'

/**
 * "Claude Boot" launch-options store. Backs the Settings → Startup tab (global
 * scope) and the per-folder dialog. The *values* live in
 * `<userData>/claude-boot.json` (read-modify-write via IPC, `claude-config.ts`);
 * this store is a thin reactive cache for the global config plus on-demand
 * helpers for per-folder configs.
 *
 * The spawn path reads the JSON directly in the main process, so this store is
 * purely the editing surface — nothing here is on the hot path of launching a
 * session.
 */

const SAVE_DEBOUNCE_MS = 200

/**
 * Plain, structured-clone-safe deep copy. The config is held in Pinia state, so
 * reading it back (`ref.value`, a store getter, or a component `ref().value`) is
 * a Vue reactive Proxy — and a Proxy thrown at Electron's IPC fails structured
 * clone ("An object could not be cloned"), so the `invoke` REJECTS and the save
 * silently no-ops, leaving `claude-boot.json` unwritten. A JSON round-trip
 * (`ClaudeBootConfig` is only strings/booleans/string[]) yields a plain object
 * the IPC can serialize. Keeps `{}` as `{}` (an empty config clears state).
 */
function plain(cfg: ClaudeBootConfig): ClaudeBootConfig {
  return JSON.parse(JSON.stringify(cfg ?? {})) as ClaudeBootConfig
}

export const useClaudeBootStore = defineStore('claudeBoot', () => {
  const global = ref<ClaudeBootConfig>({})
  /**
   * The global custom-endpoint registry (local-provider-endpoints spec). A
   * reactive cache for the provider picker + the Endpoints tab + the Topbar
   * provenance badge. The values live in `claude-boot.json#endpoints`; auth
   * tokens are carried so the editor can round-trip them, but they never reach
   * the spawn path through the renderer (main resolves provider → env).
   */
  const endpoints = ref<EndpointProfile[]>([])
  let started = false
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  /** Lazy-load the global config + endpoints (called when a dialog opens). */
  async function init(): Promise<void> {
    if (started) return
    started = true
    try {
      global.value = await window.api.claudeConfigGetGlobal()
    } catch {
      global.value = {}
    }
    await refreshEndpoints()
  }

  /** Re-read the endpoint registry from disk into the reactive cache. */
  async function refreshEndpoints(): Promise<void> {
    try {
      endpoints.value = await window.api.claudeConfigListEndpoints()
    } catch {
      endpoints.value = []
    }
  }

  /** Upsert an endpoint (by id when present) and refresh the cache. */
  async function saveEndpoint(draft: Partial<EndpointProfile>): Promise<void> {
    try {
      endpoints.value = await window.api.claudeConfigSaveEndpoint(draft)
    } catch {
      /* best effort — caller keeps its draft */
    }
  }

  /** Remove an endpoint by id and refresh the cache. */
  async function deleteEndpoint(id: string): Promise<void> {
    try {
      endpoints.value = await window.api.claudeConfigDeleteEndpoint(id)
    } catch {
      /* best effort */
    }
  }

  /** Look up an endpoint by id for the provenance badge / picker label. */
  function endpointById(id: string | undefined): EndpointProfile | undefined {
    if (!id) return undefined
    return endpoints.value.find((e) => e.id === id)
  }

  /** Replace the whole global config and debounced-persist it. */
  function setGlobal(cfg: ClaudeBootConfig): void {
    global.value = cfg
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      // `plain()` strips Vue reactivity — a raw reactive `global.value` makes the
      // IPC throw "could not be cloned" and the save would silently no-op.
      window.api.claudeConfigSetGlobal(plain(global.value)).catch((e) => {
        console.warn('[claudeBoot] failed to save global config:', e)
      })
    }, SAVE_DEBOUNCE_MS)
  }

  /** Fetch a folder's config (the per-folder dialog loads on open). */
  async function getFolder(folderPath: string): Promise<ClaudeBootConfig> {
    try {
      return await window.api.claudeConfigGetFolder(folderPath)
    } catch {
      return {}
    }
  }

  /**
   * Resolved config a new launch inherits, read main-side (single source of
   * truth for the "(inherited)" pre-fill — T57 #2). A folder path → global ⊕
   * folder (session dialog); `undefined` → just the global config (per-folder
   * dialog's inherit-from-above). Both dialogs now share this path.
   */
  async function getResolved(folderPath?: string): Promise<ClaudeBootConfig> {
    try {
      return await window.api.claudeConfigGetResolved(folderPath)
    } catch {
      return {}
    }
  }

  /** Persist a folder's config (whole-object write; empty prunes the entry). */
  async function saveFolder(folderPath: string, cfg: ClaudeBootConfig): Promise<void> {
    try {
      // `plain()` strips Vue reactivity so the IPC can structured-clone the payload.
      await window.api.claudeConfigSetFolder(folderPath, plain(cfg))
    } catch (e) {
      console.warn('[claudeBoot] failed to save folder config:', e)
    }
  }

  return {
    global,
    endpoints,
    init,
    setGlobal,
    getFolder,
    getResolved,
    saveFolder,
    refreshEndpoints,
    saveEndpoint,
    deleteEndpoint,
    endpointById
  }
})
