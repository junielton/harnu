/**
 * Missions v4 · S-1 · AC-1 — the frozen v3 compatibility fixtures.
 *
 * `tests/fixtures/missions-v4-compat/` holds mission and campaign files exactly as the v3
 * builders (`buildMissionFileContent`, `buildCampaignFileContent`) write them, in the layout
 * of a repo that used v3 (`missions/` and `campaigns/`; the `.harnu/` prefix is left off
 * because `.harnu/` is gitignored, and a later test copies them under it). Later slices run
 * their compatibility proofs (reads change no byte, v4 writes never touch a v3 file, the
 * mapping table, a campaign reading as one mission) against what is frozen here, so a
 * fixture must never change: its sha256 is pinned below, and a change shows as a failure.
 *
 * Do not regenerate or edit a fixture to make a later test pass. Add a new one beside it,
 * with its own pin.
 *
 * Every shape of the spec's table "How v3 concepts map to v4" is carried by at least one
 * fixture; the coverage test at the end names them.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import {
  buildMissionFileContent,
  parseMissionFile,
  readMissionLog,
  type Mission
} from '../src/main/mission-core'
import {
  buildCampaignFileContent,
  parseCampaignFile,
  readCampaignLog,
  type Campaign
} from '../src/main/campaign-core'

const DIR = path.join(__dirname, 'fixtures', 'missions-v4-compat')

/** The frozen files and the sha256 of each one's bytes. */
const PINS: Record<string, string> = {
  'campaigns/cmp-ca0001aa-sample-import-campaign.md':
    '8a49ecc45109e7ea4e566ae971200ed89b2e0cda7e355977674fb94079591543',
  'campaigns/cmp-ca0002bb-finished-campaign.md':
    '68995fd1fdc86dd0a1fdaa3363d8473069eaaaaec4f0cd725fb27534c2d1b7c0',
  'campaigns/cmp-ca0003cc-dropped-campaign.md':
    '5d81ea0cb72a3f4245679e930d288dd0b04333d4135785b18ee472c36940e027',
  'missions/mnt-5c0de001-modern-active.md':
    'd34d82b816315e06c9e90b4c9d5a1dee9fb38a8793dd206b992ca8ce6f5eecad',
  'missions/mnt-5c0de002-legacy-fixed-start.md':
    'f4869a76417e03176d696dc724801ccf0fde7f58247289856aacc04367aa0826',
  'missions/mnt-5c0de003-delivered-pending-close.md':
    '6383217f2ce171b592ff07f65da470d57fdd466d310f0832cb7095c0f9794f08',
  'missions/mnt-5c0de004-closed-delivered.md':
    'adeb4be350338a1b3bbb90404894035b55c4b139e0920bb603dbad72b87dab2a',
  'missions/mnt-5c0de005-closed-discarded.md':
    'f66e870f2b51220eaf0ab35561328386d25a31bd1596f7a56e0d9a032de60610',
  'missions/mnt-5c0de006-legacy-import.md':
    '2240dd9d7a8c2d67232a67ca54d7c8375d6a66861b10a2a76af165461c1e96c4',
  'missions/mnt-5c0de007-stored-stale.md':
    '5fce965580cc2891e29b4c14543d6a0b095fecef89d04cdfacc821eda2c9156a',
  'missions/mnt-ca000001-chapter-1-import-core.md':
    'daee9f3da911e65517619e92cf00b68d9b278164c876714b3f66073dac044e85',
  'missions/mnt-ca000002-chapter-2-report.md':
    '11977cc6d4d4ead59342fcdd0e5b1bf3b539687ec6ca22a2ea961dfec2e6704f'
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const list = (sub: string): string[] => readdirSync(path.join(DIR, sub)).sort()
/**
 * The `status` the file stores. The v3 parser reads a legacy `draft` as `active`, so a
 * round trip must put the stored value back before it rebuilds the file.
 */
const storedStatus = (raw: string): Mission['status'] =>
  /^status: (\w+)$/m.exec(raw)?.[1] as Mission['status']
const read = (rel: string): string => readFileSync(path.join(DIR, rel), 'utf8')

function missions(): { file: string; mission: Mission; raw: string }[] {
  return list('missions').map((n) => {
    const raw = read(`missions/${n}`)
    const parsed = parseMissionFile(raw)
    if ('error' in parsed) throw new Error(`${n}: ${parsed.error}`)
    return { file: n, mission: parsed, raw }
  })
}
function campaigns(): { file: string; campaign: Campaign; raw: string }[] {
  return list('campaigns').map((n) => {
    const raw = read(`campaigns/${n}`)
    const parsed = parseCampaignFile(raw)
    if ('error' in parsed) throw new Error(`${n}: ${parsed.error}`)
    return { file: n, campaign: parsed, raw }
  })
}

describe('fixtures are frozen v3', () => {
  it('hold exactly the pinned files, no more and no fewer', () => {
    const found = [
      ...list('missions').map((n) => `missions/${n}`),
      ...list('campaigns').map((n) => `campaigns/${n}`)
    ]
    expect(found.sort()).toEqual(Object.keys(PINS).sort())
  })

  it('keep the bytes they were frozen with (sha256 pinned)', () => {
    const actual = Object.fromEntries(
      Object.keys(PINS).map((rel) => [rel, sha256(readFileSync(path.join(DIR, rel)))])
    )
    expect(actual).toEqual(PINS)
  })

  it('parse with the v3 parser, under the id and slug their file name carries', () => {
    for (const { file, mission } of missions()) {
      expect(file).toBe(`${mission.id}-${mission.slug}.md`)
    }
    for (const { file, campaign } of campaigns()) {
      expect(file).toBe(`${campaign.id}-${campaign.slug}.md`)
    }
  })

  it('are what the v3 builders write: parse then build gives the same bytes back', () => {
    for (const { file, mission, raw } of missions()) {
      expect(
        buildMissionFileContent({ ...mission, status: storedStatus(raw) }, readMissionLog(raw)),
        file
      ).toBe(raw)
    }
    for (const { file, campaign, raw } of campaigns()) {
      expect(buildCampaignFileContent(campaign, readCampaignLog(raw)), file).toBe(raw)
    }
  })

  it('tie every chapter mission to its campaign both ways', () => {
    const byId = new Map(missions().map((m) => [m.mission.id, m.mission]))
    const bound = campaigns().flatMap(({ campaign }) =>
      campaign.chapters.flatMap((ch) => (ch.missionId ? [{ campaign, ch }] : []))
    )
    expect(bound.length).toBeGreaterThan(0)
    for (const { campaign, ch } of bound) {
      const m = byId.get(ch.missionId as string)
      expect(m, `${campaign.id}/${ch.id} -> ${ch.missionId}`).toBeDefined()
      expect(m?.campaignId).toBe(campaign.id)
      expect(m?.chapterId).toBe(ch.id)
    }
  })

  it('carry every v3 shape of the spec table "How v3 concepts map to v4"', () => {
    const mr = missions()
    const ms = mr.map((m) => m.mission)
    const steps = ms.flatMap((m) => m.steps.map((s) => ({ m, s })))
    const has = (name: string, ok: boolean): void => expect(ok, name).toBe(true)

    for (const status of ['draft', 'active', 'stale', 'delivered', 'closed'] as const) {
      has(
        `status ${status}`,
        mr.some(({ raw }) => storedStatus(raw) === status)
      )
    }
    has(
      'delivered with pendingClose',
      ms.some((m) => m.status === 'delivered' && !!m.pendingClose)
    )
    has(
      'closed as delivered with a reason',
      ms.some((m) => m.closedAs === 'delivered' && !!m.closeReason)
    )
    has(
      'closed as discarded with a reason',
      ms.some((m) => m.closedAs === 'discarded' && !!m.closeReason)
    )
    has(
      'fixed end, verified',
      steps.some(({ s }) => s.kind === 'fixed-end' && s.proof === 'verified')
    )
    has(
      'fixed end, unproven',
      steps.some(({ s }) => s.kind === 'fixed-end' && s.proof === 'unproven')
    )
    has(
      'fixed start with links',
      steps.some(({ s }) => s.kind === 'fixed-start' && s.links.length > 0)
    )
    has(
      'scope attachment',
      ms.some((m) => (m.scope?.length ?? 0) > 0)
    )
    has(
      'a custom step with an existing card link',
      steps.some(({ s }) => s.kind === 'custom' && s.links.some((l) => l.kind === 'card'))
    )
    has(
      'side step (required: false)',
      steps.some(({ s }) => s.required === false && !!s.discoveredFrom)
    )
    has(
      'existence step',
      steps.some(({ s }) => s.kind === 'custom' && s.verification === 'existence')
    )
    has(
      'a pr link',
      steps.some(({ s }) => s.links.some((l) => l.kind === 'pr'))
    )
    has(
      'a worktree link',
      steps.some(({ s }) => s.links.some((l) => l.kind === 'worktree'))
    )
    has(
      'a session link',
      steps.some(({ s }) => s.links.some((l) => l.kind === 'session'))
    )
    for (const proof of ['verified', 'self-verified', 'claimed', 'unproven'] as const) {
      has(
        `verifier step, proof ${proof}`,
        steps.some(
          ({ s }) => s.verification === 'verifier' && s.kind === 'custom' && s.proof === proof
        )
      )
    }
    has(
      'human step, verified',
      steps.some(({ s }) => s.verification === 'human' && s.proof === 'verified')
    )
    has(
      'human step, unproven',
      steps.some(({ s }) => s.verification === 'human' && s.proof === 'unproven' && !s.decision)
    )
    has(
      'a ticked check',
      steps.some(({ s }) => s.checks?.some((c) => c.ticked))
    )
    has(
      'an unticked check',
      steps.some(({ s }) => s.checks?.some((c) => !c.ticked))
    )
    has(
      'decision node, undecided',
      steps.some(({ s }) => s.decision && s.decision.chosen === undefined)
    )
    has(
      'decision node, decided',
      steps.some(({ s }) => s.decision && s.decision.chosen !== undefined)
    )
    for (const kind of ['blocks', 'validates', 'related'] as const) {
      has(
        `edge ${kind}`,
        steps.some(({ s }) => s.edges?.some((e) => e.kind === kind))
      )
    }
    has(
      'mission blocker',
      ms.some((m) => m.blockers.length > 0)
    )
    has(
      'step blocker',
      steps.some(({ s }) => s.blockers.length > 0)
    )
    has(
      'step session link (worked)',
      steps.some(({ s }) => s.links.some((l) => l.kind === 'session'))
    )
    has(
      'ledger',
      ms.some((m) => (m.ledger?.length ?? 0) > 0)
    )
    has(
      'outcome',
      ms.some((m) => !!m.outcome)
    )
    has(
      'memoryDrafts',
      ms.some((m) => (m.memoryDrafts?.length ?? 0) > 0)
    )
    has(
      'stewardPause',
      ms.some((m) => !!m.stewardPause)
    )
    has(
      'legacy and legacyRaw',
      ms.some((m) => !!m.legacy && !!m.legacyRaw)
    )
    has(
      'openQuestions',
      ms.some((m) => m.openQuestions.length > 0)
    )
    has(
      'pendingRescope',
      ms.some((m) => !!m.pendingRescope)
    )
    has(
      'linkedCard',
      ms.some((m) => !!m.linkedCard)
    )
    has(
      'declaredEndApproval via chat',
      ms.some((m) => m.declaredEndApproval?.via === 'chat')
    )
    has(
      'a Log with a title heading',
      missions().every((m) => /^# .+/.test(readMissionLog(m.raw)))
    )
    has(
      'a Log with a steward entry',
      missions().some((m) => /· steward/.test(readMissionLog(m.raw)))
    )

    const cs = campaigns().map((c) => c.campaign)
    const chapters = cs.flatMap((c) => c.chapters)
    has(
      'campaign, active',
      cs.some((c) => c.status === 'active')
    )
    has(
      'campaign, delivered with pendingClose',
      cs.some((c) => c.status === 'delivered' && !!c.pendingClose)
    )
    has(
      'campaign, closed as discarded',
      cs.some((c) => c.status === 'closed' && c.closedAs === 'discarded')
    )
    has(
      'chapter with a mission',
      chapters.some((c) => !!c.missionId)
    )
    has(
      'chapter with no mission yet',
      chapters.some((c) => !c.missionId)
    )
    has(
      'chapter required: false',
      chapters.some((c) => !c.required)
    )
    has(
      'chapter unlocks a chapter',
      chapters.some((c) => c.unlocks?.kind === 'chapter')
    )
    has(
      'chapter consumes',
      chapters.some((c) => (c.consumes?.length ?? 0) > 0)
    )
    has(
      'chapter produces',
      chapters.some((c) => (c.produces?.length ?? 0) > 0)
    )
    has(
      'chapter radiant',
      chapters.some((c) => !!c.radiant)
    )
    has(
      'chapter discoveredFrom',
      chapters.some((c) => !!c.discoveredFrom)
    )
    has(
      'a chapter mission closed as delivered',
      ms.some((m) => !!m.campaignId && m.closedAs === 'delivered')
    )
    has(
      'a chapter mission still running',
      ms.some((m) => !!m.campaignId && m.status === 'active')
    )
  })
})
