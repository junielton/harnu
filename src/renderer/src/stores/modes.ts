import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { SessionModeWire } from '../../../preload'

/**
 * The merged builtin ∪ extension-contributed session modes (T138) — fetched
 * once from `modes:list`, refreshed on every `modes:changed` push (install/
 * edit/uninstall an extension, hot, no app restart). Replaces the compile-time
 * `import { SESSION_MODES } from '../../../main/session-modes'` `FolderMenu.vue`
 * used to do — the main process now owns the merge (see
 * `extensions-loader.ts#listSessionModes`), the renderer only renders it.
 */
export const useModesStore = defineStore('modes', () => {
  const modes = ref<SessionModeWire[]>([])

  async function refresh(): Promise<void> {
    try {
      const result = await window.api?.modesList?.()
      modes.value = Array.isArray(result) ? result : []
    } catch {
      modes.value = []
    }
  }

  function findMode(id: string | undefined): SessionModeWire | undefined {
    if (!id) return undefined
    return modes.value.find((m) => m.id === id)
  }

  void refresh()
  window.api?.onModesChanged?.(() => void refresh())

  return { modes, findMode }
})
