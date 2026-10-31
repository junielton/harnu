/**
 * Campaign IPC (T596, campaign chapter 4b) — the renderer's read of every open campaign over the
 * typed `campaign:list` channel. Mirrors `mission-ipc.ts` and is READ-ONLY on purpose: there is no
 * campaign operator door in main yet (the end door and the merge batch land with later chapters),
 * so the UI renders what the record says and offers nothing that would write it.
 *
 * Each {@link CampaignView} carries the campaign as stored plus the SERVER's chapter progress
 * ({@link computeCampaignProgress}, spec §3.1). A chapter's state rolls up from the mission bound
 * to it: an open mission contributes its freshly derived progress (the same views `mission:list`
 * returns), a mission that is no longer open (closed) contributes its status, and an unbound
 * chapter is `todo`. Nothing here is stored and the renderer never recounts it.
 */

import { readdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { ipcMain } from 'electron'
import { campaignsDir, parseCampaignFile, readCampaignLog, type Campaign } from './campaign-core'
import {
  computeCampaignProgress,
  type CampaignProgress,
  type ChapterFacts
} from './campaign-progress'
import { listMissionViews } from './mission-ipc'
import { loadMission, missionRoot } from './mcp/tool-handlers'

/** One open campaign as the renderer reads it (design.md §6 "Campaign progress"). */
export interface CampaignView {
  /** The repo root whose `.harnu/campaigns/` holds the file. */
  root: string
  campaign: Campaign
  title: string
  /** The server's chapter progress — the renderer prints it and never recounts. */
  progress: CampaignProgress
}

export interface CampaignListResult {
  views: CampaignView[]
  /** Campaign files that failed to parse — reported, never thrown. */
  unreadable: string[]
}

/** The first Markdown heading of the Log body names the campaign; otherwise its stored title. */
function campaignTitle(campaign: Campaign, log: string): string {
  const heading = /^#\s+(.+)$/m.exec(log)?.[1]?.trim()
  return heading || campaign.title
}

/** `.harnu/campaigns/<id>-<slug>.md` files of a root; `[]` when the directory does not exist. */
async function campaignFiles(root: string): Promise<string[]> {
  try {
    return (await readdir(campaignsDir(root)))
      .filter((n) => /^cmp-[0-9a-f]{8}-.+\.md$/.test(n))
      .sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * Every open (non-`closed`) campaign under the repos of `folders`, newest first. Chapter missions
 * are taken from one `listMissionViews` pass (so the numbers match `mission:list`), and a bound
 * mission that is not open is read from disk for its status.
 */
export async function listCampaignViews(
  folders: readonly string[],
  now = Date.now()
): Promise<CampaignListResult> {
  const roots = [...new Set(folders.filter((f) => typeof f === 'string').map(missionRoot))]
  if (roots.length === 0) return { views: [], unreadable: [] }

  const unreadable: string[] = []
  const found: Array<{ root: string; campaign: Campaign; log: string }> = []
  for (const root of roots) {
    for (const name of await campaignFiles(root)) {
      const raw = await readFile(path.join(campaignsDir(root), name), 'utf8')
      const parsed = parseCampaignFile(raw)
      if ('error' in parsed) {
        unreadable.push(name)
        continue
      }
      if (parsed.status === 'closed') continue
      found.push({ root, campaign: parsed, log: readCampaignLog(raw) })
    }
  }
  if (found.length === 0) return { views: [], unreadable }

  const open = new Map(
    (await listMissionViews(folders, now)).views.map((v) => [v.mission.id, v] as const)
  )

  const views = await Promise.all(
    found.map(async ({ root, campaign, log }): Promise<CampaignView> => {
      const facts = await Promise.all(
        campaign.chapters.map(async (c): Promise<ChapterFacts> => {
          if (!c.missionId) return { chapterId: c.id, mission: null }
          const live = open.get(c.missionId)
          if (live) {
            return {
              chapterId: c.id,
              mission: {
                status: live.mission.status,
                ...(live.mission.closedAs ? { closedAs: live.mission.closedAs } : {}),
                progress: live.progress
              }
            }
          }
          const loaded = await loadMission(root, c.missionId)
          if (!loaded.ok) return { chapterId: c.id, mission: null }
          const m = loaded.mission
          return {
            chapterId: c.id,
            mission: {
              status: m.status,
              ...(m.closedAs ? { closedAs: m.closedAs } : {}),
              progress: null
            }
          }
        })
      )
      return {
        root,
        campaign,
        title: campaignTitle(campaign, log),
        progress: computeCampaignProgress(campaign, facts, now)
      }
    })
  )
  views.sort((a, b) => b.campaign.updatedAt.localeCompare(a.campaign.updatedAt))
  return { views, unreadable }
}

/** Registers the renderer-facing channel. Called once from `src/main/index.ts`. */
export function registerCampaignIpc(): void {
  ipcMain.handle('campaign:list', async (_e, folders: unknown): Promise<CampaignListResult> =>
    listCampaignViews(Array.isArray(folders) ? (folders as string[]) : [])
  )
}
