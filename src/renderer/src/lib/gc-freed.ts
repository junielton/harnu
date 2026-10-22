// The one wording for what a clean returned (design.md "The freed split"). A clean moves a
// checkout to the OS trash, so its bytes are not free yet: the hero chip, the toast and the
// last-cycle line all say "{freed} freed now · {trash} in the trash" through this function, so
// they cannot disagree. The words live in i18n (`cleanup.gc.freed.*`); nothing here is copy.

import { formatBytes } from '../components/system-monitor-format'

type Translate = (key: string, named: Record<string, unknown>) => string

/**
 * `freed` is what was really deleted, `trashed` what only moved to the trash. With nothing in the
 * trash only the first number is said, never a "0 B in the trash". A missing figure (a record
 * from before the split) counts as nothing.
 */
export function freedText(
  t: Translate,
  freedBytes: number | undefined,
  trashedBytes: number | undefined
): string {
  const freed = formatBytes(freedBytes ?? 0)
  const trashed = trashedBytes ?? 0
  return trashed > 0
    ? t('cleanup.gc.freed.split', { freed, trash: formatBytes(trashed) })
    : t('cleanup.gc.freed.now', { freed })
}
