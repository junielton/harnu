// Words for the Docker card's would-do rows (U3.7), shared with Settings → Cleanup's first-report list.
// The journal carries past-tense English sentences ("Removed empty network `x` — no containers"); a
// report-only item has not happened yet, so it is worded in the future, in the app's language.

import { ageParts } from './docker-card-format'
import { describeAction, reasonIsKnown, type ActionGroup } from './docker-card-view'
import type { DockerReportKind } from '../../../main/gc/gc-wire'

/** vue-i18n's `t(key, named, plural)`: the third argument picks the plural form. */
type Translate = (key: string, named?: Record<string, unknown>, plural?: number) => string

/**
 * "Would remove empty network x — no containers". A reason the card does not recognise is returned
 * as it is: showing the engine's own words beats inventing a sentence for it.
 */
export function wouldSentence(
  item: { kind?: DockerReportKind; target?: string; reason: string },
  t: Translate
): string {
  if (!reasonIsKnown(item.reason)) return item.reason
  const f = describeAction(item)
  const base = 'cleanup.gc.docker.actions.sentence'
  switch (f.kind) {
    case 'network':
      return t(`${base}.network`, { target: f.target })
    case 'orphan':
      return f.volumes.length > 0
        ? t(`${base}.orphan`, { target: f.target, volumes: f.volumes.join(', ') })
        : t(`${base}.orphanNone`, { target: f.target })
    case 'pause':
      return t(`${base}.pause`, { target: f.target, idle: f.idle ?? '' })
    default:
      return item.reason
  }
}

const GROUPS = 'cleanup.gc.docker.actions.groups'

/** "4 empty networks removed", "6 orphan stacks removed · 9 volumes kept", "Would pause 2 stacks". */
export function groupTitle(g: ActionGroup, t: Translate): string {
  if (g.kind === null) {
    const first = g.items[0]
    return first && first.kind === null ? first.raw : ''
  }
  const head = t(`${GROUPS}.${g.would ? 'would' : 'done'}.${g.kind}`, { n: g.count }, g.count)
  return g.kind === 'orphan' && g.volumes > 0
    ? `${head} · ${t(`${GROUPS}.volumesKept`, { v: g.volumes }, g.volumes)}`
    : head
}

/** Why the pass did it, in one line; null when there is nothing worth saying. */
export function groupDetail(g: ActionGroup, t: Translate): string | null {
  const base = 'cleanup.gc.docker.actions.detail'
  if (g.kind === 'network') return t(`${base}.network`)
  if (g.kind === 'orphan') return t(`${base}.orphanGroup`)
  if (g.kind === 'pause' && g.idleMinutes !== null) {
    const a = ageParts(g.idleMinutes * 60_000)
    const age = t(`cleanup.gc.docker.age.${a.unit}`, { n: a.n })
    return t(`${base}.${g.count === 1 ? 'pauseOne' : 'pauseMany'}`, { age })
  }
  return null
}
