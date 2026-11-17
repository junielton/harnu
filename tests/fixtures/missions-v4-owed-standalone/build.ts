/**
 * Neutral standalone v3 missions (BUG-283), written as the v3 builders wrote them: plain `.md` files
 * with a YAML front matter under `<root>/.harnu/missions/`. Names, ids and sessions are made up.
 *
 * Each mission is a small "Acme" delivery with ONE shape the compat re-run found hidden:
 *
 *   owing-pr-unread     a step with a pull request link (its facts are unread offline) and an unticked check
 *   owing-no-links      a step with no pull request, card or start time and an unticked check
 *   owing-self-checked  a step whose verifier is also its builder (verdict needs-human) and an unticked check
 *   owing-human-pr      a human step on a step that also has a pull request link
 *   owing-human-plain   a human step with nothing linked
 *
 * `manyOpenMissions` writes N more open missions, none owing anything, for the "more than 20" case.
 */
import { mkdirSync } from 'node:fs'
import * as path from 'node:path'
import { writeV3Mission } from '../../helpers/v3-mission-file'

export const OWNER = '8f2c1e4a-1111-4222-8333-944455556666'
export const BUILDER = '2c9d0f1e-aaaa-4bbb-8ccc-ddddeeeeffff'
const AT = '2026-11-09T10:00:00.000Z'

export interface OwedShape {
  slug: string
  id: string
  /** The text the operator must see raised. */
  owed: string
}

const base = (folder: string, id: string, slug: string, steps: object[]): object => ({
  id,
  slug,
  folder,
  owner: { sessionId: OWNER, folder },
  status: 'active',
  declaredEnd: { kind: 'code', target: `Acme ${slug} is delivered`, evidence: 'The suite passes' },
  steps,
  blockers: [],
  openQuestions: [],
  createdAt: AT,
  updatedAt: AT,
  provenance: { author: 'agent', at: AT, branch: 'card/T900-example' }
})

const step = (ordinal: number, over: Record<string, unknown> = {}): object => ({
  id: `stp-${ordinal}`,
  ordinal,
  kind: 'custom',
  title: `Acme step ${ordinal}`,
  verification: 'verifier',
  proof: 'unproven',
  links: [],
  blockers: [],
  addedAt: AT,
  ...over
})

const end = (ordinal: number): object =>
  step(ordinal, { kind: 'fixed-end', title: 'Delivered and verified' })

const check = (label: string): object => ({
  id: 'chk-1',
  label,
  source: 'operator',
  createdAt: AT
})

/** The five shapes, as `{ file, owed }` rows. */
export function writeOwedStandalone(folder: string): OwedShape[] {
  const shapes: Array<{ slug: string; id: string; owed: string; steps: object[] }> = [
    {
      slug: 'owing-pr-unread',
      id: 'mnt-0b000001',
      owed: 'Redirects tested on staging',
      steps: [
        step(1, {
          links: [{ kind: 'pr', ref: '4101' }],
          checks: [check('Redirects tested on staging')]
        }),
        end(2)
      ]
    },
    {
      slug: 'owing-no-links',
      id: 'mnt-0b000002',
      owed: 'Layout reviewed by design',
      steps: [step(1, { checks: [check('Layout reviewed by design')] }), end(2)]
    },
    {
      slug: 'owing-self-checked',
      id: 'mnt-0b000003',
      owed: 'Sample files re-run by hand',
      steps: [
        step(1, {
          proof: 'verified',
          verifiedBy: { sessionId: BUILDER, at: AT, verdict: 'needs-human' },
          links: [{ kind: 'session', ref: BUILDER }],
          checks: [check('Sample files re-run by hand')]
        }),
        end(2)
      ]
    },
    {
      slug: 'owing-human-pr',
      id: 'mnt-0b000004',
      owed: 'Sign off the Acme copy',
      steps: [
        step(1, {
          title: 'Sign off the Acme copy',
          verification: 'human',
          links: [{ kind: 'pr', ref: '4102' }]
        }),
        end(2)
      ]
    },
    {
      slug: 'owing-human-plain',
      id: 'mnt-0b000005',
      owed: 'Approve the Acme layout',
      steps: [step(1, { title: 'Approve the Acme layout', verification: 'human' }), end(2)]
    }
  ]
  mkdirSync(path.join(folder, '.harnu', 'missions'), { recursive: true })
  for (const s of shapes) {
    writeV3Mission(folder, base(folder, s.id, s.slug, s.steps) as { id: string; slug: string })
  }
  return shapes.map(({ slug, id, owed }) => ({ slug, id, owed }))
}

/** `n` open standalone missions that owe nothing, `mnt-0c0000nn`, newest-written last. */
export function manyOpenMissions(folder: string, n: number): string[] {
  const ids: string[] = []
  for (let i = 1; i <= n; i++) {
    const id = `mnt-0c${String(i).padStart(6, '0')}`
    ids.push(id)
    writeV3Mission(
      folder,
      base(folder, id, `acme-open-${i}`, [step(1, { title: `Acme task ${i}` }), end(2)]) as {
        id: string
        slug: string
      }
    )
  }
  return ids
}

/**
 * BUG-284: a standalone mission whose ONLY owed item is a pull request to look over. One verifier step
 * ("Import core"), a `pr` link and nothing else: no check, no human step, no blocker. With its pull request
 * open (the facts say so) the step waits for review and the waiting list holds one `review` item.
 */
export const REVIEW_ONLY = { id: 'mnt-0d000001', slug: 'review-only', pr: '4103' }

export function writeReviewOnly(folder: string): typeof REVIEW_ONLY {
  mkdirSync(path.join(folder, '.harnu', 'missions'), { recursive: true })
  writeV3Mission(
    folder,
    base(folder, REVIEW_ONLY.id, REVIEW_ONLY.slug, [
      step(1, { title: 'Import core', links: [{ kind: 'pr', ref: REVIEW_ONLY.pr }] }),
      end(2)
    ]) as { id: string; slug: string }
  )
  return REVIEW_ONLY
}
