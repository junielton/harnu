import type { Severity } from '../../../preload'

/**
 * Pure presentational helpers for the Claude service-status widget (issue #17).
 * Framework-free so they're unit-testable in the `node` vitest env; the footer
 * dot + `ClaudeStatusPanel.vue` are thin templates over these.
 *
 * Severity → token map (design.md §2/§9 — no new tokens): operational→green,
 * degraded→warning, outage→red, maintenance→accent, unknown→text-3.
 */

/** Tailwind `bg-*` utility for the status dot fill. */
export function severityDotClass(severity: Severity): string {
  switch (severity) {
    case 'operational':
      return 'bg-green'
    case 'degraded':
      return 'bg-warning'
    case 'outage':
      return 'bg-red'
    case 'maintenance':
      return 'bg-accent'
    default:
      return 'bg-text-3'
  }
}

/** Tailwind `text-*` utility for severity-colored text (banner heading, badges). */
export function severityTextClass(severity: Severity): string {
  switch (severity) {
    case 'operational':
      return 'text-green'
    case 'degraded':
      return 'text-warning'
    case 'outage':
      return 'text-red'
    case 'maintenance':
      return 'text-accent'
    default:
      return 'text-text-3'
  }
}

/** i18n key for a severity's short label (`claudeStatus.severity.*`). */
export function severityLabelKey(severity: Severity): string {
  return `claudeStatus.severity.${severity}`
}
