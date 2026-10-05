/**
 * Resolve a toast/notification action label (BUG-49). Callers may pass either
 * a localization key under `toast.actions.*` (e.g. `'toast.actions.goToSession'`)
 * or an already-translated literal string — probe with `te()` ("translation
 * exists?") and fall back to the raw value when it isn't a known key. Shared
 * by `Toast.vue` and `ActivityBell.vue` so a third consumer can't drift by
 * reimplementing this and forgetting the `te()` probe.
 */
export function resolveActionLabel(
  t: (key: string) => string,
  te: (key: string) => boolean,
  raw: string | undefined
): string {
  if (!raw) return ''
  return te(raw) ? t(raw) : raw
}
