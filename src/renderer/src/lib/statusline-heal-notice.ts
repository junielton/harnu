/**
 * Wording of the Activity notice posted when the self-heal re-installs a removed statusLine
 * (BUG-196 AC-4). Main decides WHEN (once per heal, `statusline-heal-core.ts`); this only words it.
 * Pure: `t` is injected, nothing is imported from `stores/`.
 */

/** One Activity entry for the notice: a later heal updates it in place instead of piling up. */
export const HEAL_NOTICE_GROUP = 'statusline-heal'

/** Session titles listed in the notice before the rest are counted. */
const NAMED_SESSIONS = 5

type Translate = (key: string, params?: Record<string, unknown>) => string

export function formatHealNotice(
  args: { time: string; titles: readonly string[] },
  t: Translate
): { title: string; description: string } {
  const title = t('statuslineHeal.title')
  if (args.titles.length === 0) return { title, description: t('statuslineHeal.descriptionNone') }
  const extra = args.titles.length - NAMED_SESSIONS
  const names =
    args.titles.slice(0, NAMED_SESSIONS).join(', ') +
    (extra > 0 ? ` ${t('statuslineHeal.more', { n: extra })}` : '')
  return {
    title,
    description: t('statuslineHeal.description', { time: args.time, sessions: names })
  }
}
