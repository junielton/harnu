/**
 * Session modes (T123): session boot presets.
 *
 * A **mode** is what makes a session start out knowing a role: a versioned contract
 * (`docs/harnu-<mode>.md`) injected into the `--append-system-prompt` preamble at spawn,
 * exactly as `HARNU_ORCHESTRATOR_DOC` already is (`pty.ts`).
 *
 * This is the registry: pure, no electron, no IPC. It resolves `id → contract` and
 * nothing else; `pty.ts` injects it and `FolderMenu` offers it in the UI.
 *
 * v1 ships ONE mode (`learning`). The Orchestrator keeps its own path (promoting an
 * EXISTING session, with its own guard and hook) and moves here in a separate card;
 * touching it now would double the risk without adding a capability.
 */

import { HARNU_TEACHER_DOC } from './harnu-teacher'

export type SessionModeId = 'learning'

export interface SessionMode {
  id: SessionModeId
  /** i18n key: main NEVER formats UI text; the renderer translates it. */
  labelKey: string
  /** Lucide glyph name; the renderer resolves the component. */
  icon: string
  /** The contract injected into the spawn preamble. */
  doc: string
}

export const SESSION_MODES: readonly SessionMode[] = [
  {
    id: 'learning',
    labelKey: 'folderMenu.modes.learning',
    icon: 'graduation-cap',
    doc: HARNU_TEACHER_DOC
  }
] as const

/** Type guard: `mode` arrives from the renderer over IPC, so it is UNTRUSTED. */
export function isSessionModeId(v: unknown): v is SessionModeId {
  return typeof v === 'string' && SESSION_MODES.some((m) => m.id === v)
}

/**
 * The contract for a mode, or `''` when there is no mode (a normal session) or the id
 * is unknown. Returning an empty string instead of throwing is deliberate: an invalid
 * id degrades to a normal session and never breaks the spawn.
 */
export function modeContract(id: string | undefined): string {
  if (!isSessionModeId(id)) return ''
  return SESSION_MODES.find((m) => m.id === id)?.doc ?? ''
}
