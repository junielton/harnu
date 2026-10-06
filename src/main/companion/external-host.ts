/**
 * "Harnu mod outside Harnu" as one unit (T389 P4W3): the switch, the install, the host side of an
 * outside session, and what the settings pane reads. Electron-free: `host.ts` injects the paths,
 * the clock, the prefs key and the CLI shell, so a test or a live-verify recipe points all of it
 * at a throwaway directory.
 *
 * Order of events when the switch turns ON: the companion must be on, the settings entry is
 * written (and refused or rolled back by the install shell), and only then does the `external`
 * key flip, so the host never accepts a claim the settings do not explain. Turning it OFF goes the
 * other way round: the key flips first (every live outside binding is revoked at once), then the
 * entry is removed.
 */

import type { ExternalBindingDeps, ExternalBinding } from './external-binding'
import { createExternalBinding } from './external-binding'
import type { ExternalInstall, ExternalInstallDeps } from './external-install'
import { createExternalInstall } from './external-install'
import type { InstallRefusal } from './external-install-core'

export interface ExternalPaneState {
  /** The `external` key. */
  on: boolean
  /** The file Harnu edits; the pane shows it as one line. */
  path: string
  /** What Harnu added to `CLAUDE_CODE_PLUGIN_DIRS`, for the manual-removal sentence. */
  entry: string | null
  /** The folder the next "on" would add: what the confirm dialog shows, exactly. */
  candidate: string | null
  /** Epoch ms of the last outside session Harnu corroborated, or null (never, this run). */
  lastSeenAt: number | null
  /** The Harnu mod itself is on (the kill switch): the switch cannot be turned on without it. */
  companionOn: boolean
  live: number
}

export type ExternalSetResult =
  { ok: true; on: boolean } | { ok: false; reason: InstallRefusal; manualPath?: string }

export interface ExternalHostDeps {
  install: ExternalInstallDeps
  binding: Omit<ExternalBindingDeps, 'isOn'>
  /** The `external` prefs key. */
  key: { get(): boolean; set(on: boolean): void }
  /** The kill switch and the CLI gate: the Harnu mod is on at all. */
  companionOn(): boolean
  /** Staging keeps what this names (the install record's entry). */
  pin?(fn: () => string[]): void
  sweepMs?: number
}

export interface ExternalHost {
  binding: ExternalBinding
  install: ExternalInstall
  get(): Promise<ExternalPaneState>
  set(on: boolean): Promise<ExternalSetResult>
  /** Boot: pins, re-points the entry, reconciles the key with the file, starts the sweep. */
  start(): Promise<void>
  stop(): void
}

export function createExternalHost(deps: ExternalHostDeps): ExternalHost {
  const install = createExternalInstall(deps.install)
  const binding = createExternalBinding({ ...deps.binding, isOn: () => deps.key.get() })
  let timer: ReturnType<typeof setInterval> | null = null

  async function get(): Promise<ExternalPaneState> {
    const st = await install.status()
    // The key follows the file: a user who removed the entry by hand reads off, and the host
    // stops accepting claims the settings no longer explain.
    if (!st.installed && deps.key.get()) {
      deps.key.set(false)
      binding.setSwitch(false)
    }
    const candidate = st.entry ?? (await deps.install.ensureStaged().catch(() => null))
    return {
      on: deps.key.get(),
      path: st.path,
      entry: st.entry,
      candidate,
      lastSeenAt: binding.lastSeenAt(),
      companionOn: deps.companionOn(),
      live: binding.counts().live
    }
  }

  async function set(on: boolean): Promise<ExternalSetResult> {
    if (on) {
      if (!deps.companionOn()) return { ok: false, reason: 'no-companion' }
      const r = await install.install()
      if (!r.ok) {
        return {
          ok: false,
          reason: r.reason,
          ...(r.manualPath !== undefined ? { manualPath: r.manualPath } : {})
        }
      }
      deps.key.set(true)
      return { ok: true, on: true }
    }
    // Off: no new claim is accepted and every live one is revoked before the entry goes.
    deps.key.set(false)
    binding.setSwitch(false)
    const r = await install.uninstall()
    if (!r.ok) {
      return {
        ok: false,
        reason: r.reason,
        ...(r.manualPath !== undefined ? { manualPath: r.manualPath } : {})
      }
    }
    return { ok: true, on: false }
  }

  async function start(): Promise<void> {
    deps.pin?.(() => install.pinned())
    try {
      await install.repoint()
    } catch {
      // a failed re-point leaves the old entry in place, which keeps working
    }
    await get().catch(() => undefined) // reconcile the key with the file
    timer = setInterval(() => void binding.sweep().catch(() => undefined), deps.sweepMs ?? 2_000)
    timer.unref?.()
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
    binding.dispose()
  }

  return { binding, install, get, set, start, stop }
}
