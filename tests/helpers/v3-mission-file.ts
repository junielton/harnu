/**
 * Test-only writer of a v3 mission FILE. The production builder went away with the v3 stack (S-40);
 * the only reader of such a file left is `src/main/missions/v3-read.ts`, and what it reads is plain
 * frontmatter YAML (the CORE schema, so every string comes back a string) followed by a free-text log.
 */
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

/** `<folder>/.harnu/missions` — where a repo keeps its mission files. */
export const v3MissionsDir = (folder: string): string => path.join(folder, '.harnu', 'missions')

/** `<folder>/.harnu/missions/<id>-<slug>.md`. */
export const v3MissionPath = (folder: string, id: string, slug: string): string =>
  path.join(v3MissionsDir(folder), `${id}-${slug}.md`)

/** The file text of a v3 mission: a frontmatter block, then the log body. */
export function buildV3MissionFile(mission: object, log = ''): string {
  const frontmatter = yaml.dump(mission, { lineWidth: -1, noRefs: true, skipInvalid: true })
  return `---\n${frontmatter}---\n${log}`
}

/** Write a v3 mission file under `folder` and return its path. */
export function writeV3Mission(
  folder: string,
  mission: { id: string; slug: string },
  log = ''
): string {
  const file = v3MissionPath(folder, mission.id, mission.slug)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buildV3MissionFile(mission, log))
  return file
}

/**
 * A small, complete v3 mission (one step, one declared end) for a repo `folder`. `over` patches the
 * top level; a closed mission needs its `closedAs`, which the caller gives.
 */
export function v3MissionObject(
  folder: string,
  over: Record<string, unknown> = {}
): { id: string; slug: string; [key: string]: unknown } {
  const at = '2026-11-01T09:00:00.000Z'
  return {
    id: 'mnt-0000000a',
    slug: 'ledger',
    folder,
    owner: { sessionId: '11111111-2222-4333-8444-555555555555', folder },
    status: 'active',
    declaredEnd: { kind: 'code', target: 'ship it', evidence: 'the PR merged' },
    steps: [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'custom',
        title: 'Step 1',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: []
      }
    ],
    blockers: [],
    openQuestions: [],
    createdAt: at,
    updatedAt: at,
    provenance: { author: 'agent', at },
    ...over
  }
}
