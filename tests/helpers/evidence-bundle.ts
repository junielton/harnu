/**
 * Campaign ch.6 (T610, AC-6.4) — the verifier gate reads a step's evidence bundle, so a
 * fixture mission whose verifier-level steps are `verified` must leave one: a `worktree`
 * link to `.harnu/evidence/<missionId>/<stepId>` and the directory itself under the repo.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { evidenceBundleDir } from '../../src/main/mission-gates'
import type { MissionStep } from '../../src/main/mission-core'

export async function withEvidenceBundles(
  root: string,
  missionId: string,
  steps: MissionStep[]
): Promise<MissionStep[]> {
  return Promise.all(
    steps.map(async (s) => {
      if (s.proof !== 'verified' || s.verification !== 'verifier') return s
      const dir = evidenceBundleDir(missionId, s.id)
      await fs.mkdir(path.join(root, dir), { recursive: true })
      await fs.writeFile(path.join(root, dir, 'test-output.txt'), 'ok\n')
      return { ...s, links: [...s.links, { kind: 'worktree' as const, ref: dir }] }
    })
  )
}
