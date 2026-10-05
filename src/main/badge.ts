import { app, ipcMain, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { join } from 'node:path'

/**
 * OS dock/taskbar attention badge (attention-badge spec §4.4). The renderer sends
 * the needs-input count over `badge:set`; main picks the per-OS path. The decidable
 * parts (`badgeStrategy` / `normalizeBadgeCount` / `overlayAssetName`) are pure and
 * unit-tested (`tests/badge.test.ts`); the shell (`registerBadge`) is electron glue.
 * Best-effort: an unsupported environment no-ops gracefully (the window title is
 * the universal signal). Never throws.
 */

export type BadgeStrategy = 'count' | 'overlay' | 'none'

/** Pure: which badge path this OS uses. */
export function badgeStrategy(platform: NodeJS.Platform): BadgeStrategy {
  if (platform === 'darwin' || platform === 'linux') return 'count'
  if (platform === 'win32') return 'overlay'
  return 'none'
}

/** Pure: clamp any IPC payload into a count >= 0 (floor + guard). */
export function normalizeBadgeCount(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 0
  return n < 0 ? 0 : n
}

/**
 * Pure: map a count to the pre-rendered overlay PNG name. `1..9` → `badge-N.png`,
 * `>= 10` → `badge-9plus.png` (textual "9+" cap), `0` → `null` (caller clears).
 */
export function overlayAssetName(count: number): string | null {
  if (count <= 0) return null
  return count >= 10 ? 'badge-9plus.png' : `badge-${count}.png`
}

/**
 * Load the Windows taskbar overlay as a NativeImage from a pre-rendered PNG in
 * `resources/badges/` (raster, not an SVG data-URL — `createFromDataURL` doesn't
 * rasterize SVG in the main process). A missing asset yields an empty image, which
 * Electron renders as no overlay — graceful until the PNGs ship.
 */
export function loadOverlayIcon(count: number, resourcesDir: string): NativeImage | null {
  const asset = overlayAssetName(count)
  if (!asset) return null
  return nativeImage.createFromPath(join(resourcesDir, 'badges', asset))
}

export function registerBadge(getWindow: () => BrowserWindow | null): void {
  ipcMain.on('badge:set', (_e, raw: unknown) => {
    try {
      const count = normalizeBadgeCount(raw)
      const strat = badgeStrategy(process.platform)
      if (strat === 'count') {
        // setBadgeCount returns false where there's no dock/Unity launcher; that's
        // the support signal (app.isBadgeCountSupported doesn't exist this Electron).
        // Discard the boolean — the window title covers the universal case.
        app.setBadgeCount(count)
      } else if (strat === 'overlay') {
        const win = getWindow()
        if (!win || win.isDestroyed()) return
        win.setOverlayIcon(
          count > 0 ? loadOverlayIcon(count, process.resourcesPath) : null,
          count > 0 ? `${count} need input` : ''
        )
      }
      // strat === 'none' → graceful no-op
    } catch (err) {
      console.error('[badge] set failed', err)
    }
  })
}
