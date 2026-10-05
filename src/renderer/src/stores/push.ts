import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { PushChannel, PushConfig, PushTestResult } from '../../../preload'

/**
 * Remote push notifications store (remote-push spec). Thin write-through cache
 * over `<userData>/push.json` (main-side, `src/main/push.ts`): the pane edits
 * `config` through these actions, every mutation persists via IPC and re-adopts
 * the sanitized result main hands back — so the UI always shows what actually
 * hit disk (an invalid URL comes back dropped, not silently kept).
 *
 * The SEND path never touches this store: `maybeNotify` fires
 * `window.api.pushSend(...)` and main re-reads the file, so edits apply to the
 * very next notification without any cache-invalidation dance.
 */
export const usePushStore = defineStore('push', () => {
  const config = ref<PushConfig>({ enabled: false, pausedUntil: null, channels: [] })
  const loaded = ref(false)

  async function load(): Promise<void> {
    try {
      config.value = await window.api.pushConfigGet()
      loaded.value = true
    } catch {
      /* transient IPC failure — keep defaults; the pane stays editable */
    }
  }

  /**
   * IPC payloads must be structured-clone-safe: Vue's reactive proxies (this
   * store's `config`, the pane's v-for row objects) throw DataCloneError at the
   * contextBridge. The config is tiny, so a JSON round-trip is the simplest
   * deep-unwrap (`toRaw` only peels the outermost layer).
   */
  function toPlain<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T
  }

  /** Persist `next` and adopt the main-side sanitized result. */
  async function save(next: PushConfig): Promise<void> {
    config.value = await window.api.pushConfigSet(toPlain(next))
  }

  function setEnabled(enabled: boolean): Promise<void> {
    // Turning the master switch back on also clears a leftover pause — "ligar"
    // must mean notifications actually flow again.
    return save({
      ...config.value,
      enabled,
      pausedUntil: enabled ? null : config.value.pausedUntil
    })
  }

  /** Pause deliveries for `ms` from now (master switch stays on). */
  function pauseFor(ms: number): Promise<void> {
    return save({ ...config.value, pausedUntil: Date.now() + ms })
  }

  function resume(): Promise<void> {
    return save({ ...config.value, pausedUntil: null })
  }

  /** True while a pause is active (pure read on the cached config). */
  function isPaused(now: number = Date.now()): boolean {
    return config.value.pausedUntil !== null && now < config.value.pausedUntil
  }

  /** Upsert by id — the id is generated main-side for a new channel (absent id). */
  function saveChannel(channel: Partial<PushChannel> & { url: string }): Promise<void> {
    const channels = [...config.value.channels]
    const idx = channel.id ? channels.findIndex((c) => c.id === channel.id) : -1
    if (idx >= 0) channels[idx] = { ...channels[idx], ...channel }
    else channels.push(channel as PushChannel)
    return save({ ...config.value, channels })
  }

  function deleteChannel(id: string): Promise<void> {
    return save({
      ...config.value,
      channels: config.value.channels.filter((c) => c.id !== id)
    })
  }

  /** Fire a localized test message at one channel (drafts included). */
  function test(
    channel: Partial<PushChannel>,
    message: { title: string; body: string }
  ): Promise<PushTestResult> {
    return window.api.pushTest(toPlain(channel), message)
  }

  return {
    config,
    loaded,
    load,
    setEnabled,
    pauseFor,
    resume,
    isPaused,
    saveChannel,
    deleteChannel,
    test
  }
})
