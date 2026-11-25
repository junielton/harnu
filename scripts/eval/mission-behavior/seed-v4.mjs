/**
 * Seeded v4 records for the mission behavior eval (Missions v4 S-33).
 *
 * A scenario that tests a state a verb call cannot reach cheaply (a mission already half done, with a
 * blocker, a decision in its Log and a step that waits for review; a step built by one session and a
 * second session about to settle it) writes the record straight to `.harnu/missions-v4/` through the
 * product's own writer (`buildMissionRecordContent` of `src/main/missions/model.ts`), so the file is
 * exactly what Harnu would have written and a malformed seed fails here instead of in a live run.
 *
 * This module only WRITES. The grader (`grade.mjs`) reads with its own parser, never through the
 * product's, so a drift in the product's reader cannot make the grader agree with it.
 *
 * Spec (everything but `slug`, `title` and `doneWhen` is optional):
 *
 *   { slug, title, doneWhen,
 *     milestones?: [{ title, optional?, waitsFor? }],               → mls-1, mls-2, …
 *     steps: [{ title, milestone?, startedAt? ("now" = when seeded), links?, blockers?,
 *               acs: [{ text, by? (default session), fact?, person?, settled?, selfCheck? }] }],  → stp-1, …; ac-1, …
 *     sessions?: [{ id, role, from?, to?, stoppedAt? }],
 *     links?, blockers?, attachRequests?,
 *     log?: [{ kind?, stepId?, note }],                              → `### <time> · <kind> · <step>`
 *     ageMinutes? }                                                  → how long ago the seed was made
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { buildMissionRecordContent } from '../../../src/main/missions/model.ts'

/** `<folder>/.harnu/missions-v4` (the same path `grade.mjs` reads). */
function recordsDir(folder) {
  return path.join(folder, '.harnu', 'missions-v4')
}

/** A fresh `mnt-<8 hex>` id that no file in `dir` already uses. */
function mintId(dir) {
  const taken = existsSync(dir) ? readdirSync(dir).map((n) => n.slice(0, 12)) : []
  for (;;) {
    const id = `mnt-${randomBytes(4).toString('hex')}`
    if (!taken.includes(id)) return id
  }
}

/**
 * Write one v4 record and return `{ id, slug, file, at }`.
 *
 * @param {string} folder the sandbox repo (its main checkout)
 * @param {Record<string, any>} spec see the module doc; `{{…}}` placeholders are already filled
 * @param {{ now?: Date }} [opts]
 */
export function seedV4Record(folder, spec, { now = new Date() } = {}) {
  const dir = recordsDir(folder)
  mkdirSync(dir, { recursive: true })
  const id = mintId(dir)
  const at = new Date(now.getTime() - (spec.ageMinutes ?? 0) * 60_000).toISOString()
  const record = {
    schemaVersion: 4,
    id,
    title: spec.title,
    doneWhen: spec.doneWhen,
    status: 'open',
    milestones: (spec.milestones ?? []).map((m, i) => ({
      id: `mls-${i + 1}`,
      title: m.title,
      optional: m.optional ?? false,
      waitsFor: m.waitsFor ?? null
    })),
    steps: (spec.steps ?? []).map((s, i) => ({
      id: `stp-${i + 1}`,
      ...(s.milestone ? { milestone: s.milestone } : {}),
      title: s.title,
      ...(s.startedAt ? { startedAt: s.startedAt === 'now' ? at : s.startedAt } : {}),
      acs: (s.acs ?? []).map((c, k) => ({
        id: `ac-${k + 1}`,
        text: c.text,
        by: c.by ?? 'session',
        ...(c.fact ? { fact: c.fact } : {}),
        ...(c.person ? { person: c.person } : {}),
        ...(c.settled ? { settled: { at, ...c.settled } } : {}),
        ...(c.selfCheck ? { selfCheck: { at, ...c.selfCheck } } : {})
      })),
      links: s.links ?? [],
      blockers: (s.blockers ?? []).map((b, k) => ({ id: `blk-${k + 1}`, raisedAt: at, ...b }))
    })),
    sessions: (spec.sessions ?? []).map((s) => ({
      id: s.id,
      role: s.role,
      from: s.from ?? at,
      to: s.to ?? null,
      ...(s.stoppedAt ? { stoppedAt: s.stoppedAt } : {})
    })),
    links: spec.links ?? [],
    blockers: (spec.blockers ?? []).map((b, k) => ({ id: `blk-${k + 1}`, raisedAt: at, ...b })),
    ...(spec.attachRequests ? { attachRequests: spec.attachRequests } : {})
  }
  const log =
    `# ${spec.title}\n\n## Log\n` +
    (spec.log ?? [])
      .map((e) => `### ${at} · ${e.kind ?? 'note'}${e.stepId ? ` · ${e.stepId}` : ''}\n${e.note}\n`)
      .join('\n')
  const file = path.join(dir, `${id}-${spec.slug}.md`)
  writeFileSync(file, buildMissionRecordContent(record, log), 'utf8')
  return { id, slug: spec.slug, file, at }
}
