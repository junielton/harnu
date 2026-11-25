/**
 * Guided walks: the view-model of the Walks library (design.md §6 "Walks library", spec S-4, AC-20).
 *
 * Pure and DOM-free, like `walk-view.ts`: main lists the repo's walks (`walk:list`), this turns them into the rows
 * the pane draws and decides nothing. A list, not a dashboard: a source icon, the title, a meta line (the source,
 * the last run's date, the outcome) and two actions, Re-run and Open; Delete lives in the row's menu (D-18). No
 * search, no filter, no sort control (V-23): main already lists the newest run first.
 *
 * It imports only TYPES from `walk-view.ts` (which imports {@link shortDate} from here), so the two never cycle.
 * Words come from `walksLibrary.*` through the injected `t`.
 */
import type { LibraryEntry } from '../../../preload'
import type { T } from './walk-view'

/** `Nov 16`, or `Nov 16, 2026` when the date is not in the year of `now`. */
export function shortDate(ms: number, now: number, locale = 'en'): string {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  }).format(d)
}

export type LibraryIcon = 'target' | 'git-pull-request' | 'lightbulb' | 'git-branch' | 'bookmark'

export interface LibraryRowView {
  walkId: string
  icon: LibraryIcon
  title: string
  /** `Mission`, `PR #48 · alex`, `Feature`, `Branch card/dark-theme`, `Card · release-0-14`. */
  source: string
  /** When the walk last ran (or, for a live run, started); `null` for a walk never walked. */
  date: string | null
  outcome: {
    kind: 'walked' | 'in-progress' | 'not-walked'
    /** `4 of 6 passed`, `in progress, check 4 of 9` or `not walked yet`. */
    text: string
    /** Something did not pass: the row draws a `!` and the warning tone. */
    warn: boolean
  }
  /** What Open does: continue the live run, show the last run read-only, or start the first run. */
  openAs: 'continue' | 'past' | 'start'
  /** The run Open goes to (the live run, or the last run that ended); `null` when there is none to open yet. */
  openRunId: string | null
  live: boolean
  /** Runs that started; the delete confirmation names them. */
  runs: number
  actions: { rerun: true; open: true; menu: ['delete'] }
}

export interface LibraryView {
  mode: 'list' | 'empty'
  /** `Walks`; `null` in the empty state, which shows nothing else. */
  title: string | null
  sub: string | null
  rows: LibraryRowView[]
  empty: { title: string; body: string; command: string; hint: string } | null
}

const ICON_OF: Record<LibraryEntry['source']['kind'], LibraryIcon> = {
  mission: 'target',
  pr: 'git-pull-request',
  feature: 'lightbulb',
  branch: 'git-branch',
  card: 'bookmark'
}

function sourceText(e: LibraryEntry, t: T): string {
  const s = e.source
  switch (s.kind) {
    case 'pr':
      return s.author
        ? t('walksLibrary.source.pr', { number: s.number, author: s.author })
        : t('walksLibrary.source.prNoAuthor', { number: s.number })
    case 'branch':
      return t('walksLibrary.source.branch', { branch: s.branch })
    case 'card':
      return t('walksLibrary.source.card', { slug: s.slug })
    case 'mission':
      return t('walksLibrary.source.mission')
    default:
      return t('walksLibrary.source.feature')
  }
}

function rowOf(e: LibraryEntry, t: T, now: number, locale: string): LibraryRowView {
  const live = e.status === 'live' && e.live !== null
  let outcome: LibraryRowView['outcome']
  let date: string | null = null
  if (live && e.live) {
    outcome = {
      kind: 'in-progress',
      text: t('walksLibrary.outcome.inProgress', { check: e.live.check, total: e.live.total }),
      warn: false
    }
    if (e.live.startedAt !== null) date = shortDate(e.live.startedAt, now, locale)
  } else if (e.lastRun) {
    outcome = {
      kind: 'walked',
      text: t('walksLibrary.outcome.passed', {
        verified: e.lastRun.verified,
        total: e.lastRun.total
      }),
      warn: e.lastRun.verified < e.lastRun.total
    }
    date = shortDate(e.lastRun.at, now, locale)
  } else {
    outcome = { kind: 'not-walked', text: t('walksLibrary.outcome.notWalked'), warn: false }
  }
  return {
    walkId: e.walkId,
    icon: ICON_OF[e.source.kind],
    title: e.title,
    source: sourceText(e, t),
    date,
    outcome,
    openAs: live ? 'continue' : e.lastRun ? 'past' : 'start',
    openRunId: live ? (e.live?.runId ?? null) : (e.lastRun?.runId ?? null),
    live,
    runs: e.runs,
    actions: { rerun: true, open: true, menu: ['delete'] }
  }
}

/** The library as the pane draws it. `entries` come newest run first from main and keep their order. */
export function libraryView(
  entries: LibraryEntry[],
  t: T,
  opts: { now: number; locale?: string }
): LibraryView {
  if (entries.length === 0) {
    return {
      mode: 'empty',
      title: null,
      sub: null,
      rows: [],
      empty: {
        title: t('walksLibrary.empty.title'),
        body: t('walksLibrary.empty.body'),
        command: t('walksLibrary.empty.command'),
        hint: t('walksLibrary.empty.hint')
      }
    }
  }
  const locale = opts.locale ?? 'en'
  return {
    mode: 'list',
    title: t('walksLibrary.title'),
    sub:
      entries.length === 1
        ? t('walksLibrary.subOne')
        : t('walksLibrary.sub', { n: entries.length }),
    rows: entries.map((e) => rowOf(e, t, opts.now, locale)),
    empty: null
  }
}

/** The one question Delete asks (D-18): it names the runs, and says when one is in progress. */
export function deleteConfirm(row: LibraryRowView, t: T): string {
  if (row.runs === 0) return t('walksLibrary.delete.askNone', { title: row.title })
  const runs =
    row.runs === 1 ? t('walksLibrary.runs.one') : t('walksLibrary.runs.other', { n: row.runs })
  return t(row.live ? 'walksLibrary.delete.askLive' : 'walksLibrary.delete.ask', {
    title: row.title,
    runs
  })
}
