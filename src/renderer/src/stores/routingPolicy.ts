import { defineStore } from 'pinia'
import type { RoutingTable } from '../../../preload'

/**
 * Model routing policy store (T97) — the editing surface for a folder's
 * routing table (card kind → model+effort). Mirrors `stores/claudeBoot.ts`: the
 * values live in `<userData>/routing-policy.json` (read-modify-write via IPC,
 * `routing-policy.ts`); this store is a thin per-folder cache for the editor.
 *
 * Human-only by construction: nothing here is reachable from an MCP verb — the
 * only caller is the folder-settings routing editor (`ClaudeBootDialog.vue`).
 */

/** Plain, structured-clone-safe deep copy (a reactive Proxy can't cross IPC). */
function plain(table: RoutingTable): RoutingTable {
  return JSON.parse(JSON.stringify(table ?? {})) as RoutingTable
}

export const useRoutingPolicyStore = defineStore('routingPolicy', () => {
  /** Fetch a folder's routing table (the editor loads on open). */
  async function getFolder(folderPath: string): Promise<RoutingTable> {
    try {
      return await window.api.routingPolicyGetFolder(folderPath)
    } catch {
      return {}
    }
  }

  /** Persist a folder's routing table (whole-object write; empty prunes it). */
  async function saveFolder(folderPath: string, table: RoutingTable): Promise<void> {
    try {
      await window.api.routingPolicySetFolder(folderPath, plain(table))
    } catch (e) {
      console.warn('[routingPolicy] failed to save folder routing table:', e)
    }
  }

  return { getFolder, saveFolder }
})
