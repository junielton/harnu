/**
 * Campaign progress store (T596, campaign chapter 4b — design.md §6 "Campaign progress").
 *
 * Holds every open campaign of the repos the sidebar knows, as `campaign:list` projects it
 * (the campaign record plus the SERVER's chapter progress), and derives one
 * {@link CampaignModel} per bound mission so the Topbar pill and the Campaign popover read the
 * same answer. Read-only: there is no campaign door in main yet.
 *
 * Not polled on its own clock. A campaign's progress rolls up from its chapters' missions, so it
 * is re-read exactly when the mission store has just re-read them (`missions.refreshSeq`), and the
 * two always describe the same moment. A failed read keeps the last good list.
 */
import { defineStore } from 'pinia'
import { shallowRef, watch } from 'vue'
import type { CampaignView } from '../../../main/campaign-ipc'
import type { MissionView } from '../../../main/mission-ipc'
import { buildCampaignModel, campaignForMission, type CampaignModel } from '../lib/campaign-view'
import { useMissionsStore } from './missions'
import { useSessionsStore } from './sessions'

export const useCampaignsStore = defineStore('campaigns', () => {
  const missions = useMissionsStore()
  const sessions = useSessionsStore()
  const views = shallowRef<CampaignView[]>([])
  let inFlight: Promise<void> | null = null
  let started = false

  async function load(): Promise<void> {
    try {
      const res = await window.api.campaignList(sessions.folders.map((f) => f.path))
      views.value = res.views
    } catch {
      // A failed read keeps the last good list — the pill never flashes back to the mission look.
    }
  }

  /** Refresh now; concurrent callers share one round-trip. */
  function refresh(): Promise<void> {
    inFlight ??= load().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  /** Start following the mission store once; later calls are no-ops. */
  function ensureStarted(): void {
    if (started) return
    started = true
    void refresh()
    watch(
      () => missions.refreshSeq,
      () => void refresh()
    )
  }

  /** The campaign a mission is bound to, or `null` (today's pill). */
  function forMission(view: MissionView | null): CampaignView | null {
    return view ? campaignForMission(views.value, view) : null
  }

  /** The campaign model for the session's own mission, or `null` when it has no campaign. */
  function modelForMission(view: MissionView | null): CampaignModel | null {
    const cv = forMission(view)
    return cv && view
      ? buildCampaignModel(cv, missions.views, view.mission.id, missions.refreshedAt)
      : null
  }

  return { views, refresh, ensureStarted, forMission, modelForMission }
})
