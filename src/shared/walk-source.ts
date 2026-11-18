/**
 * Guided walks: the five source kinds and their checks (spec S-1, AC-3).
 *
 * Pure and Electron-free: what Harnu can read (the board, the mission record) is injected as a
 * {@link SourceProbe}, so the same rules run in main, in the renderer and in tests.
 *
 * A source says what a walk is about. The validator checks what Harnu can verify (a `card` slug is
 * on the board, a `mission` source's ids are on the record, a branch is a name git accepts) and
 * takes the rest as the agent's declaration (a PR's title and author are shown as such).
 */

/** One rule broken by a script: where (a JSON path), which rule, and a human sentence. */
export interface Violation {
  path: string
  rule: string
  message: string
}

export type WalkSource =
  | { kind: 'feature'; text: string }
  | { kind: 'pr'; number: number; title: string; author: string; url?: string }
  | { kind: 'branch'; branch: string; base: string }
  | { kind: 'card'; slug: string }
  | {
      kind: 'mission'
      missionId: string
      scope: 'step' | 'milestone' | 'mission'
      id?: string
    }

/** What a walk may know of a mission record: its milestones, steps and criteria ids. */
export interface MissionFacts {
  milestones: string[]
  steps: { id: string; milestone: string | null; criteria: string[] }[]
}

/** The reads a source needs. Injected, so this module stays pure. */
export interface SourceProbe {
  /** Is `slug` a card on the folder's board? */
  cardSlugExists(slug: string): boolean
  /** The mission record `id` names, or `null` when there is none (unknown, removed, unreadable). */
  mission(id: string): MissionFacts | null
}

export const FEATURE_TEXT_MAX = 300
const TEXT_MAX = 160

const v = (path: string, rule: string, message: string): Violation => ({ path, rule, message })
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const nonEmpty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0

/** Is `s` an http or https address? */
export function isHttpUrl(s: unknown): boolean {
  if (typeof s !== 'string') return false
  try {
    const u = new URL(s)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0
  } catch {
    return false
  }
}

/**
 * Would `git check-ref-format --branch` accept `name`? The rules of git-check-ref-format(1): no
 * space, control character, `~ ^ : ? * [ \`, no `..`, `@{`, `//`, no leading `-` or `/`, no trailing
 * `/`, `.` or `.lock`, no component that starts with `.`, and not the single name `@`.
 */
export function isGitBranchName(name: unknown): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 250) return false
  if (name === '@' || name.startsWith('-') || name.startsWith('/') || name.endsWith('/'))
    return false
  if (name.endsWith('.') || name.endsWith('.lock')) return false
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f~^:?*[\\]/.test(name)) return false
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false
  return name
    .split('/')
    .every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}

/**
 * Validate a script's `source`. Returns every violation (one per rule, with its JSON path under
 * `path`, which defaults to `$.source`) and, when there is none, the typed source.
 */
export function validateSource(
  input: unknown,
  probe: SourceProbe,
  path = '$.source'
): { violations: Violation[]; source: WalkSource | null } {
  if (input === undefined || input === null) {
    return { violations: [v(path, 'MISSING', 'A walk needs a source.')], source: null }
  }
  if (!isObj(input)) {
    return { violations: [v(path, 'NOT_AN_OBJECT', 'The source must be an object.')], source: null }
  }
  const out: Violation[] = []
  const at = (k: string): string => `${path}.${k}`
  switch (input.kind) {
    case 'feature': {
      if (!nonEmpty(input.text)) out.push(v(at('text'), 'MISSING', 'Say what was built.'))
      else if (input.text.length > FEATURE_TEXT_MAX)
        out.push(v(at('text'), 'TOO_LONG', `At most ${FEATURE_TEXT_MAX} characters.`))
      break
    }
    case 'pr': {
      const n = input.number
      if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0)
        out.push(
          v(at('number'), 'PR_NOT_A_NUMBER', 'A pull request number is a positive whole number.')
        )
      if (!nonEmpty(input.title)) out.push(v(at('title'), 'MISSING', 'Give the PR title.'))
      else if (input.title.length > TEXT_MAX)
        out.push(v(at('title'), 'TOO_LONG', `At most ${TEXT_MAX} characters.`))
      if (!nonEmpty(input.author)) out.push(v(at('author'), 'MISSING', 'Give the PR author.'))
      else if (input.author.length > 80)
        out.push(v(at('author'), 'TOO_LONG', 'At most 80 characters.'))
      if (input.url !== undefined && !isHttpUrl(input.url))
        out.push(v(at('url'), 'URL_NOT_HTTP', 'A PR address is an http or https URL.'))
      break
    }
    case 'branch': {
      if (!isGitBranchName(input.branch))
        out.push(v(at('branch'), 'BAD_BRANCH_NAME', 'That is not a branch name git accepts.'))
      if (!isGitBranchName(input.base))
        out.push(v(at('base'), 'BAD_BRANCH_NAME', 'That is not a branch name git accepts.'))
      break
    }
    case 'card': {
      if (!nonEmpty(input.slug)) out.push(v(at('slug'), 'MISSING', 'Name the card.'))
      else if (!probe.cardSlugExists(input.slug))
        out.push(v(at('slug'), 'CARD_NOT_FOUND', 'No card with that slug is on the board.'))
      break
    }
    case 'mission': {
      const scope = input.scope
      if (scope !== 'step' && scope !== 'milestone' && scope !== 'mission')
        out.push(v(at('scope'), 'BAD_VALUE', 'The scope is step, milestone or mission.'))
      if (!nonEmpty(input.missionId)) {
        out.push(v(at('missionId'), 'MISSING', 'Name the mission.'))
        break
      }
      const facts = probe.mission(input.missionId)
      if (!facts) {
        out.push(v(at('missionId'), 'MISSION_NOT_FOUND', 'No mission record has that id.'))
        break
      }
      if (scope === 'mission') {
        if (input.id !== undefined)
          out.push(v(at('id'), 'NOT_ALLOWED', 'A whole-mission source has no id.'))
      } else if (scope === 'step' || scope === 'milestone') {
        if (!nonEmpty(input.id)) out.push(v(at('id'), 'MISSING', `Name the ${scope}.`))
        else if (scope === 'step' && !facts.steps.some((s) => s.id === input.id))
          out.push(v(at('id'), 'STEP_NOT_FOUND', 'That step is not on the mission.'))
        else if (scope === 'milestone' && !facts.milestones.includes(input.id))
          out.push(v(at('id'), 'MILESTONE_NOT_FOUND', 'That milestone is not on the mission.'))
      }
      break
    }
    default:
      out.push(
        v(at('kind'), 'BAD_VALUE', 'The source kind is feature, pr, branch, card or mission.')
      )
  }
  return { violations: out, source: out.length === 0 ? (input as unknown as WalkSource) : null }
}

/**
 * A check's `criterion` (the id of a mission criterion it answers). Accepted only when the walk's
 * source is a mission and the id exists on that mission; any other source carries none.
 * `source` is `null` when the source itself was refused (the criterion then cannot be judged).
 */
export function validateCriterion(
  criterion: unknown,
  source: WalkSource | null,
  probe: SourceProbe,
  path: string
): Violation[] {
  if (criterion === undefined) return []
  if (typeof criterion !== 'string' || criterion.trim().length === 0)
    return [v(path, 'BAD_VALUE', 'A criterion is the id of a mission criterion.')]
  if (!source || source.kind !== 'mission')
    return [
      v(
        path,
        'CRITERION_NEEDS_MISSION_SOURCE',
        'Only a walk with a mission source carries criteria.'
      )
    ]
  const facts = probe.mission(source.missionId)
  if (!facts || !facts.steps.some((s) => s.criteria.includes(criterion)))
    return [v(path, 'CRITERION_NOT_FOUND', 'That criterion is not on the mission.')]
  return []
}

/**
 * The identity two walks share when they are about the same thing: `walk_open` refuses a second
 * walk whose identity matches one with a live run. A `feature` is compared after trimming.
 */
export function sourceIdentity(source: WalkSource): string {
  switch (source.kind) {
    case 'feature':
      return `feature:${source.text.trim()}`
    case 'pr':
      return `pr:${source.number}`
    case 'branch':
      return `branch:${source.branch}->${source.base}`
    case 'card':
      return `card:${source.slug}`
    case 'mission':
      return `mission:${source.missionId}:${source.scope}:${source.id ?? ''}`
  }
}
