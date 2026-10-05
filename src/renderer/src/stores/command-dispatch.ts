/**
 * Renderer command-dispatch shell for the Harnu MCP server (T25).
 *
 * This is the thin, env-bound half of the renderer control surface: it binds the
 * pure {@link makeCommandRouter} (T17) to the REAL Pinia store actions and to the
 * correlated CommandBridge IPC channel exposed by the preload (added by the
 * integrator — see `seamsForIntegrator`). A validated MCP op arrives over
 * `onRendererCommand` already past the main-process approval gate; we route it
 * through the router and echo the result back via `rendererCommandAck`, closing
 * the bridge's request/ack correlation (`src/main/command-bridge.ts`).
 *
 * ADR-0001 thin-shell: there is no logic here beyond wiring — validation,
 * mint/dedupe rules, and the headless-split contract all live in the pure
 * router/core. The shell only (1) injects the store actions, (2) marshals the
 * IPC message in/out, and (3) emits the renderer-ready handshake so main knows a
 * window is subscribed and safe to actuate against. Env-bound → e2e-only.
 *
 * Every method this file reaches for on `window.api` is part of the MCP renderer
 * surface the integrator adds to the preload (T27). Until then the methods are
 * absent at runtime; every call is feature-detected so a build WITHOUT the
 * preload additions (and the existing renderer unit tests, whose `window.api`
 * stubs omit these methods) stays green — the wiring simply no-ops.
 */

import type { GitMeta } from '../../../preload'
import { i18n } from '../i18n'
import { useSessionsStore } from './sessions'
import { useHelpersStore } from './helpers'
import { useNotificationsStore } from './notifications'
import { makeCommandRouter, type CommandRouterActions } from './command-router'
import { speech } from '../lib/speech'

/**
 * A correlated command pushed from main over `onRendererCommand`. Mirrors
 * `CommandMessage` in `src/main/command-bridge.ts`: the `requestId` is the token
 * the renderer MUST echo back on ack so the bridge can settle the right pending
 * dispatch.
 */
export interface RendererCommandMessage {
  requestId: string
  command: string
  payload: unknown
}

/**
 * Payload of the fire-and-forget `folders:adopted` push (T26): the worktree main
 * just created + adopted (`git worktree add` → `addUserProject`), plus the git
 * meta it probed. The renderer stashes the git fields so the new placeholder
 * folder groups under its repo from the first frame (see the sessions store's
 * `onFolderAdopted` handler).
 */
export type FolderAdoptedPayload = { path: string; select?: boolean } & GitMeta

/** Payload of the symmetric `folders:removed` push (T26): the worktree path dropped. */
export interface FolderRemovedPayload {
  path: string
}

/**
 * Payload of `session:ready` (T23): a freshly-spawned session's PTY has its
 * `claude` REPL up and is ready to accept input. `sessionKey` is the PTY session
 * key — the synthetic id at spawn time (the agent synthetic for an MCP-created
 * session). Gates the agent prompt injection in `TerminalPane`.
 */
export interface SessionReadyPayload {
  sessionKey: string
}

/**
 * The window.api surface the MCP renderer wiring depends on. Added to the
 * preload by the integrator (T27); typed here so this file (and its consumers)
 * compile against an explicit contract instead of a loose cast, and so the
 * integrator has the exact channel signatures in one place.
 */
export interface McpRendererApi {
  /** Subscribe to correlated commands pushed from the CommandBridge. Returns an unsubscribe fn. */
  onRendererCommand(cb: (msg: RendererCommandMessage) => void): () => void
  /** Echo a dispatch result back to main, settling the bridge request `requestId`. */
  rendererCommandAck(requestId: string, result: unknown): void
  /** One-shot handshake: tell main the renderer is subscribed and safe to actuate. */
  rendererReady(): void
  /** Subscribe to per-session "REPL ready" events. Returns an unsubscribe fn. */
  onSessionReady(cb: (payload: SessionReadyPayload) => void): () => void
  /** Subscribe to worktree-adopt pushes. Returns an unsubscribe fn. */
  onFolderAdopted(cb: (payload: FolderAdoptedPayload) => void): () => void
  /** Subscribe to worktree-removed pushes. Returns an unsubscribe fn. */
  onFolderRemoved(cb: (payload: FolderRemovedPayload) => void): () => void
  /** Resolve the live PTY id for a session key, or `null` if none is running. */
  ptyIdForSession(sessionKey: string): Promise<string | null>
}

/**
 * Narrow `window.api` to the (integrator-provided) MCP surface, tolerating its
 * absence. Returns a `Partial` so every consumer feature-detects each method
 * (`typeof api.x === 'function'`) before calling — keeping builds/tests without
 * the preload additions green.
 */
export function getMcpApi(): Partial<McpRendererApi> {
  if (typeof window === 'undefined') return {}
  const api = (window as { api?: unknown }).api
  if (!api) return {}
  return api as Partial<McpRendererApi>
}

/**
 * Build the {@link CommandRouterActions} from the live Pinia stores. This is the
 * "REAL store actions injected" seam: `session.create` rides the sessions
 * store's non-deduped agent-create path; `pane.split` rides the helpers store's
 * headless append. Resolved lazily (inside the function) so the
 * stores' active pinia is the caller's.
 *
 * Exported (only) so the 2026-07-13 agent-pane-routing regression is directly
 * pinnable against real Pinia stores (`agent-pane-routing.test.ts`) — this
 * shell has no other exercised surface, since `wireCommandDispatch` is
 * env-bound (IPC) and coverage-excluded.
 */
export function buildDispatchActions(): CommandRouterActions {
  const sessions = useSessionsStore()
  const helpers = useHelpersStore()
  const notifications = useNotificationsStore()
  return {
    folderExists: (path) => sessions.folderExists(path),
    // BUG-18: forward ALL three args. The lambda previously dropped the 3rd
    // (`bootOverride`), so an agent's `{ model: 'haiku' }` never reached the
    // synthetic entry → the spawn used the operator's global model while the MCP
    // ACK still echoed the requested one. The router (command-router.ts) passes
    // bootOverride as the 3rd arg; this env-bound shell must relay it verbatim.
    insertAgentSession: (session, prePrompt, bootOverride) =>
      sessions.insertAgentSession(session, prePrompt, bootOverride),
    // Every action below is the AGENT path — the only way a pane reaches the
    // store without a human click (Topbar "Browse files", FolderMenu,
    // HelperStack drag-drop all call the store directly). `origin: 'agent'`
    // is free to stamp here (2026-07-13 agent-pane-routing design §Origin);
    // the store uses it to drive the unseen-panes badge + coalesced alert.
    addShellHelper: (worktreePath, cwd) =>
      helpers.addShellHelper(worktreePath, cwd, { origin: 'agent' }),
    addResumeHelper: (worktreePath, sessionId, cwd) =>
      helpers.addResumeHelper(worktreePath, sessionId, cwd, { origin: 'agent' }),
    // T74 `open_file`: headless, background markdown viewer append (dedup + cap in the store).
    // BUG-20/BUG-26 (2026-07-13 agent-pane-routing design): routing by the
    // CALLER's folder (`worktreePath`, as the router passed it) is correct —
    // the earlier hijack that re-read `sessions.selectedSession?.projectPath`
    // at dispatch time is what caused the misroute (a pane landing in
    // whichever folder the operator happened to be looking at, not the one
    // that asked for it). Invisibility is now solved upstream instead: main
    // canonicalizes the caller's folder against the known folders BEFORE it
    // ever becomes a routing key (`tool-handlers.ts`'s `resolvePaneFolder`),
    // so `worktreePath` here is always a real, rendered stack.
    addMarkdownHelper: (worktreePath, filePath, cwd) =>
      helpers.addMarkdownHelper(worktreePath, filePath, cwd, { origin: 'agent' }),
    // T218 U4: the `*.capycanvas.json` arm of the same `open_file` — the router
    // picks which of the two by suffix. Same `origin: 'agent'` stamp, so an
    // agent-opened board badges as unseen rather than stealing focus.
    addCanvasHelper: (worktreePath, filePath, cwd) =>
      helpers.addCanvasHelper(worktreePath, filePath, cwd, { origin: 'agent' }),
    closeHelperByPath: (worktreePath, path) => helpers.closeHelperByPath(worktreePath, path),
    closeHelperById: (worktreePath, paneId) => helpers.closeHelperById(worktreePath, paneId),
    // T113 (background drain): the board-dispatch spawn WITHOUT selection — the
    // synthetic boots via the BUG-23 background runner, so the drain never yanks
    // the operator's focus; the reaper still surfaces a boot that never PTYs.
    dispatchCardSession: (folderPath, prompt, bootOverride) => {
      // BUG-40 §3.2: dispatchCardSession now returns a discriminated result;
      // this bridge's own external contract (CommandRouterActions) stays
      // `string | null` — unwrap here rather than widen every consumer.
      const result = sessions.dispatchCardSession(folderPath, prompt, bootOverride, {
        select: false
      })
      if (!result.ok) return null
      sessions.enqueueAgentBoot(result.sessionId)
      sessions.armAgentBootDeadline(result.sessionId)
      return result.sessionId
    },
    // BUG-63: register a just-created worktree's folder into the live model
    // SYNCHRONOUSLY, before the router calls `dispatchCardSession` above —
    // mirrors `RoadmapBoard.vue`'s `spawnAndBind` (BUG-40) for the background
    // drain path, which has no direct Pinia access and can only reach the
    // renderer through this same correlated command.
    registerFolder: (payload) => {
      sessions.registerFolderImmediate(payload)
    },
    // T113: boot-prompt labels live in renderer i18n; main asks over the bridge.
    bootPromptLabels: () => ({
      heading: i18n.global.t('roadmap.boot.heading'),
      framing: i18n.global.t('roadmap.boot.framing'),
      specLabel: i18n.global.t('roadmap.boot.specLabel'),
      specFileHint: i18n.global.t('roadmap.boot.specFileHint'),
      closure: i18n.global.t('roadmap.boot.closure')
    }),
    // T116 `notify`: fold the agent's call into the same notification history
    // `pushToast` funnels every durable toast through (`stores/ui.ts`) — `ts` is
    // stamped here (the env-bound shell), not the pure router, matching how
    // `pushToast` stamps its own `Date.now()` at the call site.
    // T215 `session.wake`: queue the background resume of a parked session so a
    // brokered peer message has a live process to reach. Headless by
    // construction — the queue's runner in `TerminalPane` boots detached and
    // never touches `selectedId`.
    wakeSession: (sessionId) => sessions.enqueueSessionWake(sessionId),
    // T238 `speak`: the voice engine + where the operator's attention is. The
    // ROUTER decides (focus rule, mute, engine off) — this only reports state and
    // hands over an utterance that already passed. Deliberately nowhere near
    // `notifyAgent` below: speech leaves no row and raises no toast.
    speechContext: () => ({
      enabled: speech.state.enabled,
      muted: speech.state.muted,
      windowFocused: sessions.windowFocused,
      selectedId: sessions.selectedId
    }),
    speakUtterance: ({ text, sessionId, focus }) => {
      // Fire-and-forget: `speak` resolves when the AUDIO finishes, which can be
      // tens of seconds — far past the bridge deadline the ack has to beat. The
      // engine never rejects (T237), so there is no failure to swallow here.
      void speech.speak(text, { source: 'agent', ...(sessionId ? { sessionId } : {}), focus })
    },
    notifyAgent: ({ folderPath, title, description, kind, sessionId }) =>
      notifications.notify({
        ts: Date.now(),
        source: 'agent',
        kind,
        title,
        ...(description ? { description } : {}),
        ...(sessionId ? { sessionId } : {}),
        folderPath
      }).id
  }
}

/**
 * Subscribe the renderer to the CommandBridge, route each correlated command
 * through the pure router bound to the real store actions, ack the result, and
 * emit the renderer-ready handshake. Called once from the sessions store's
 * `init()`; the returned disposer (pushed onto the store's cleanup registry)
 * unsubscribes on HMR / unload.
 *
 * No-op (returns a noop disposer) when the MCP preload surface is absent — so a
 * build without the integrator's preload additions, and the existing renderer
 * unit tests, stay green.
 *
 * @returns an unsubscribe function for the `onRendererCommand` listener.
 */
export function wireCommandDispatch(): () => void {
  const api = getMcpApi()
  if (typeof api.onRendererCommand !== 'function') return () => {}

  const dispatch = makeCommandRouter(buildDispatchActions())

  const off = api.onRendererCommand((msg) => {
    if (!msg || typeof msg !== 'object') return
    const { requestId, command, payload } = msg as RendererCommandMessage
    let result: unknown
    try {
      result = dispatch(command, payload)
    } catch (err) {
      // The router already catches thrown actions; this guards the marshaling
      // itself so a malformed message never escapes the IPC callback.
      result = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    try {
      api.rendererCommandAck?.(requestId, result)
    } catch {
      // Bridge torn down mid-flight (window closing) — drop the ack; the
      // dispatch deadline on the main side evicts the request.
    }
  })

  // Handshake: the command channel is live, so main may actuate against us.
  try {
    api.rendererReady?.()
  } catch {
    /* ignore — main not listening yet */
  }

  return typeof off === 'function' ? off : () => {}
}
