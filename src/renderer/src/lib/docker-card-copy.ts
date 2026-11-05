// Words for the Docker card's would-do rows (U3.7), shared with Settings → Cleanup's first-report list.
// The journal carries past-tense English sentences ("Removed empty network `x` — no containers"); a
// report-only item has not happened yet, so it is worded in the future, in the app's language.

import { describeAction, reasonIsKnown } from './docker-card-view'
import type { DockerReportKind } from '../../../main/gc/gc-wire'

type Translate = (key: string, named?: Record<string, unknown>) => string

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
