/** Sidebar row geometry for the two density presets (design.md §4). */
export type SidebarDensity = 'comfortable' | 'compact'

export function isSidebarDensity(value: unknown): value is SidebarDensity {
  return value === 'comfortable' || value === 'compact'
}

interface SidebarMetrics {
  folderRowHeight: number
  checkoutRowHeight: number
  sessionRowHeight: number
  terminalRowHeight: number
  childRowHeight: number
  eyebrowHeight: number
  gap: number
  sessionIndent: number
  childIndent: number
}

export function densityMetrics(density: SidebarDensity): SidebarMetrics {
  const compact = density === 'compact'
  return {
    folderRowHeight: compact ? 26 : 30,
    checkoutRowHeight: compact ? 23 : 26,
    sessionRowHeight: compact ? 23 : 26,
    terminalRowHeight: compact ? 23 : 26,
    childRowHeight: compact ? 22 : 24,
    eyebrowHeight: compact ? 20 : 22,
    gap: 8,
    sessionIndent: 24,
    childIndent: compact ? 38 : 40
  }
}
