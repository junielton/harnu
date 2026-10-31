/**
 * Campaign progress view model (T596, campaign chapter 4b — design.md §6 "Campaign progress").
 * One pure derivation from a `campaign:list` view (plus the open missions the mission store
 * holds) to everything the pill and the Campaign popover render, so they can never disagree.
 *
 * It RENDERS the server's numbers and never recounts: the headline, every chapter's state, the
 * counts line and the radiant counter come from `view.progress` (`computeCampaignProgress`), and
 * each chapter's step headline from its mission's own `progress` (`progressHeadline`). What is
 * left here is presentation — which group a chapter sits in, the tone, the pill's words.
 */
import type { CampaignView } from '../../../main/campaign-ipc'
import type { Chapter } from '../../../main/campaign-core'
import { campaignHeadline, type ChapterState } from '../../../main/campaign-progress'
import type { MissionView } from '../../../main/mission-ipc'
import {
  buildMissionModel,
  type MissionHeadline,
  type MissionModel,
  type PillTone,
  type YouRow
} from './mission-view'

/** One chapter as the popover's left pane draws it. */
export interface CampaignChapterRow {
  chapter: Chapter
  /** The server's state for this chapter (`progress.states`). */
  state: ChapterState
  missionId: string | null
  /** The bound mission's view, when it is open; `null` for an unbound or closed mission. */
  mission: MissionModel | null
  missionView: MissionView | null
  /** The mission's own headline ("Step 2 of 4"); `null` without an open mission. */
  stepHeadline: MissionHeadline | null
  /** What this chapter's mission owes the operator. */
  youCount: number
  /** The chapter the server's current marker sits on. */
  current: boolean
}

/** One You-lane row of the campaign, tagged with the chapter that owes it. */
export interface CampaignYouRow {
  chapterId: string
  chapterOrdinal: number
  missionId: string
  row: YouRow
}

export interface CampaignModel {
  tone: PillTone
  /** The server headline: "Chapter N of M" / range / done / empty. */
  headline: ReturnType<typeof campaignHeadline>
  /** The own mission's headline (the pill's "Step a/b"); `null` when the session owns no chapter. */
  step: MissionHeadline | null
  /** `progress.allDone`. */
  done: boolean
  /** Everything owed across the campaign's open chapters (the pill's "n for you"). */
  youCount: number
  main: CampaignChapterRow[]
  side: CampaignChapterRow[]
  locked: CampaignChapterRow[]
  /** `progress` counts, verbatim. */
  counts: {
    done: number
    inReview: number
    running: number
    locked: number
    sideTotal: number
    sideDone: number
    sideOpen: number
  }
  radiant: { done: number; total: number } | null
  /** The chapter the open-chapter pane starts on: the server's current marker, else the first open. */
  currentId: string | null
  you: CampaignYouRow[]
}

/** The campaign a mission is bound to, if its view is loaded; otherwise `null` (today's pill). */
export function campaignForMission(
  views: readonly CampaignView[],
  mission: MissionView
): CampaignView | null {
  const id = mission.mission.campaignId
  if (!id) return null
  return views.find((v) => v.campaign.id === id) ?? null
}

/**
 * Build the campaign model. `missionViews` are the open missions the mission store holds;
 * `ownMissionId` is the mission the pill's session owns (its headline becomes the pill's step part).
 */
export function buildCampaignModel(
  cv: CampaignView,
  missionViews: readonly MissionView[],
  ownMissionId: string | null,
  now: number
): CampaignModel {
  const p = cv.progress
  const byMission = new Map(missionViews.map((v) => [v.mission.id, v] as const))
  const currentFrom = p.current?.from ?? null
  const requiredIds = cv.campaign.chapters.filter((c) => c.required).map((c) => c.id)
  const currentId = currentFrom !== null ? (requiredIds[currentFrom - 1] ?? null) : null

  const you: CampaignYouRow[] = []
  const rows = cv.campaign.chapters.map((chapter): CampaignChapterRow => {
    const missionView = chapter.missionId ? (byMission.get(chapter.missionId) ?? null) : null
    const mission = missionView ? buildMissionModel(missionView, now) : null
    if (mission && missionView) {
      for (const row of mission.youRows) {
        you.push({
          chapterId: chapter.id,
          chapterOrdinal: chapter.ordinal,
          missionId: missionView.mission.id,
          row
        })
      }
    }
    return {
      chapter,
      state: p.states[chapter.id] ?? 'todo',
      missionId: chapter.missionId ?? null,
      mission,
      missionView,
      stepHeadline: mission?.headline ?? null,
      youCount: mission?.youRows.length ?? 0,
      current: chapter.id === currentId
    }
  })

  const own = ownMissionId ? (rows.find((r) => r.missionId === ownMissionId) ?? null) : null
  const blocked = rows.some(
    (r) => r.mission && (r.mission.tone === 'warning' || r.mission.state === 'blocked')
  )
  const tone: PillTone = p.allDone ? 'success' : you.length > 0 || blocked ? 'warning' : 'accent'

  return {
    tone,
    headline: campaignHeadline(p),
    step: own?.stepHeadline ?? null,
    done: p.allDone,
    youCount: you.length,
    main: rows.filter((r) => r.chapter.required && r.state !== 'locked'),
    side: rows.filter((r) => !r.chapter.required),
    locked: rows.filter((r) => r.chapter.required && r.state === 'locked'),
    counts: {
      done: p.done,
      inReview: p.inReview,
      running: p.running,
      locked: p.locked,
      sideTotal: p.side.total,
      sideDone: p.side.done,
      sideOpen: p.side.open
    },
    radiant: p.radiant ? { done: p.radiant.done, total: p.radiant.total } : null,
    currentId,
    you
  }
}

type Translate = (key: string, values: Record<string, unknown>) => string

/** "Ch. 9/12" / "Ch. 9–10/12" / "Ch. 12/12 ✓" — the campaign part of the pill. */
export function chapterText(t: Translate, h: CampaignModel['headline']): string {
  if (h.kind === 'empty') return ''
  return t(`campaign.pill.${h.kind}`, { n: h.n, to: h.to, m: h.m })
}

/** The step part of the pill: "Step 2/4", "Steps 2–3/4", "Step 4/4 ✓"; `''` for an empty mission. */
export function stepText(t: Translate, h: MissionHeadline | null): string {
  if (!h || h.kind === 'empty') return ''
  return t(`campaign.pill.step.${h.kind}`, { n: h.n, to: h.to, m: h.m })
}

/**
 * The pill's whole label: "Ch. 9/12 · Step 2/4", with "· {n} for you" in the warning state, and
 * just "Ch. 12/12 ✓" once the campaign is delivered.
 */
export function campaignPillText(t: Translate, model: CampaignModel): string {
  const parts = [chapterText(t, model.headline)]
  if (!model.done) {
    const step = stepText(t, model.step)
    if (step) parts.push(step)
    if (model.youCount > 0) parts.push(t('campaign.pill.forYou', { n: model.youCount }))
  }
  return parts.filter(Boolean).join(' · ')
}
