/**
 * The one operator door an older (v3) mission file keeps after the v3 verbs and doors are gone
 * (Missions v4 S-40, owner's delta 1): Approve or Decline of a re-scope its owner staged before the
 * upgrade.
 *
 * The pane shows the staged re-scope as the box a v4 record shows for a staged Done when, and the
 * operator answers it there. The answer is written on the v3 file itself (no v4 copy), exactly as the
 * old popover did: Approve makes the staged end the declared end, stamps the approval `via: operator`,
 * voids the fixed end's proof and leaves one Log line; Decline drops the staging and leaves one Log
 * line. Nothing else about the file changes.
 *
 * It imports only the frozen v3 reader, the one-mission-at-a-time lock and the atomic write, so the v3
 * core modules can be deleted (S-41) without touching it.
 */

import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { atomicWriteFile } from '../mcp/atomic-write'
import { serializeByKey } from '../roadmap-core'
import { loadMission } from './store'

export type V3RescopeDoor = 'approve' | 'decline'

export type V3RescopeResult = { ok: true } | { ok: false; error: string }

const locks = new Map<string, Promise<unknown>>()

/** `sha256:<hex>` of a declared end: the approval stamp's body hash, as v3 computed it. */
function endHash(end: { kind: string; target: string; evidence: string }): string {
  const canonical = JSON.stringify([end.kind, end.target, end.evidence])
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

/**
 * Apply the door to the v3 file of `missionId` under `root`. Never throws: a refusal (no such mission, a
 * closed one, nothing staged, an unreadable file) comes back as `{ ok: false, error }` with a code first.
 */
export function runV3RescopeDoor(
  root: string,
  missionId: string,
  door: V3RescopeDoor,
  at: string = new Date().toISOString()
): Promise<V3RescopeResult> {
  return serializeByKey(locks, missionId, async (): Promise<V3RescopeResult> => {
    try {
      const loaded = await loadMission(root, missionId)
      if (!loaded.ok) return { ok: false, error: loaded.error }
      const mission = structuredClone(loaded.mission)
      if (mission.status === 'closed') {
        return { ok: false, error: `MISSION_CLOSED: ${missionId} is closed.` }
      }
      const staged = mission.pendingRescope
      if (!staged) {
        return {
          ok: false,
          error: `NOTHING_STAGED: mission ${missionId} has no pending re-scope to ${door}.`
        }
      }
      delete mission.pendingRescope
      if (door === 'approve') {
        delete mission.pendingClose
        mission.declaredEnd = staged
        mission.declaredEndApproval = { at, bodyHash: endHash(staged), via: 'operator' }
        for (const step of mission.steps) {
          if (step.kind !== 'fixed-end') continue
          step.proof = 'unproven'
          delete step.verifiedBy
        }
        if (mission.status === 'delivered') mission.status = 'active'
        if (mission.legacy) {
          mission.legacy.needsReview = mission.legacy.needsReview.filter((f) => f !== 'declaredEnd')
        }
      }
      mission.updatedAt = at
      const frontmatter = yaml.dump(mission, { lineWidth: -1, noRefs: true, skipInvalid: true })
      const line = `\n### ${at} · operator ${door === 'approve' ? 'approved' : 'declined'} the re-scope\n`
      const log = loaded.log + (loaded.log.endsWith('\n') || loaded.log === '' ? '' : '\n') + line
      await atomicWriteFile(loaded.file, `---\n${frontmatter}---\n${log}`, 0o644)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }) as Promise<V3RescopeResult>
}
