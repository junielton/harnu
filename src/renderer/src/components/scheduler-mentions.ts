/**
 * T305 — the Prompt field's `/skill` mentions, renderer side.
 *
 * `parseSkillMentions` and `SKILL_MENTION_RE` are a DELIBERATE mirror of
 * `parseSkillMentions` in `src/main/scheduler-core.ts` — duplicated because
 * that module is main-only per the process-boundary rule and the renderer never
 * imports across it, exactly like `READ_COMMAND_RULE` in
 * `SchedulerWorkerDetail.vue`. `tests/scheduler-mentions.test.ts` runs both
 * implementations over one shared corpus so the copy cannot drift.
 *
 * Everything here is a pure function of the prompt string. Nothing about a
 * mention is stored: the chips are a VIEW of the text, recomputed on every
 * render, and the tick recomputes the same set from the same string when it
 * fires.
 */
import type { AvailableSkill, SkillOrigin } from '../../../preload'

/** Mirrors `SKILL_MENTION_RE` (src/main/scheduler-core.ts). */
export const SKILL_MENTION_RE =
  /(?:^|\s)\/([A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?)/g

/** Characters that may follow the `/` of a mention while it is being typed. */
const MENTION_CHAR = /[A-Za-z0-9._:-]/

/** Mirrors `parseSkillMentions` (src/main/scheduler-core.ts). */
export function parseSkillMentions(prompt: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of prompt.matchAll(SKILL_MENTION_RE)) {
    const name = m[1].replace(/[.\-_]+$/, '')
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** The mention being typed at `caret`, when the popup should be open. */
export interface MentionTrigger {
  /** Index of the `/` itself. */
  start: number
  /** What has been typed after the `/`, up to the caret. */
  query: string
}

/**
 * The active `/` token at `caret`, or `null` when the popup must stay shut.
 *
 * The `/` opens the popup ONLY at a word boundary — start of the field or right
 * after whitespace. A prompt is full of paths (`src/main/`, `docs/user/`), and a
 * naive trigger would pop the menu open on every one of them and make the field
 * hostile to type in.
 *
 * A space closes it (whitespace can never be part of a skill id, so the scan
 * back simply fails), and so does any character a skill id cannot contain.
 */
export function mentionTrigger(text: string, caret: number): MentionTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === '/') {
      const before = i === 0 ? '' : text[i - 1]
      if (before !== '' && !/\s/.test(before)) return null
      return { start: i, query: text.slice(i + 1, caret) }
    }
    if (!MENTION_CHAR.test(ch)) return null
  }
  return null
}

/**
 * Replace the token at `trigger` with `/{name} `, returning the new text and
 * where the caret lands. The name goes into the prompt LITERALLY: the model
 * reads it the way it reads any other word, and Harnu parses the same text back
 * out to know what to stage.
 */
export function insertMention(
  text: string,
  trigger: MentionTrigger,
  caret: number,
  name: string
): { text: string; caret: number } {
  const head = `${text.slice(0, trigger.start)}/${name} `
  return { text: head + text.slice(caret), caret: head.length }
}

/**
 * One row per NAME, keeping the highest-precedence origin.
 *
 * `skillsAvailable` returns a name once per place it was found (project →
 * personal → bundled) so a `harnu:` mention can still resolve to a shadowed
 * bundled skill. The picker wants one row per name; `mentionChips` wants the
 * full list. Both read from the same array.
 */
export function pickerSkills(skills: readonly AvailableSkill[]): AvailableSkill[] {
  const seen = new Set<string>()
  const out: AvailableSkill[] = []
  for (const s of skills) {
    if (seen.has(s.name)) continue
    seen.add(s.name)
    out.push(s)
  }
  return out
}

/** Rows matching what has been typed so far: prefix hits first, then contains. */
export function filterSkills(skills: readonly AvailableSkill[], query: string): AvailableSkill[] {
  const q = query.toLowerCase()
  if (!q) return [...skills]
  const prefix: AvailableSkill[] = []
  const rest: AvailableSkill[] = []
  for (const s of skills) {
    const n = s.name.toLowerCase()
    if (n.startsWith(q)) prefix.push(s)
    else if (n.includes(q)) rest.push(s)
  }
  return [...prefix, ...rest]
}

/** One chip under the field: a mention and whether it actually resolves. */
/** Mirrors main's `PLUGIN_NAME` + legacy alias (src/main/bundled-skills.ts). */
// `capy` is the legacy alias of `harnu:` (persisted prompts keep their chip).
const BUNDLED_NAMESPACES: readonly string[] = ['harnu', 'capy']

export interface MentionChip {
  /** The mention exactly as written in the prompt, namespace included. */
  mention: string
  /** `undefined` when nothing on this machine answers to that name. */
  origin?: SkillOrigin
}

/**
 * The chip row for `prompt`, resolved against what this folder can stage.
 *
 * Mirrors main's `resolveMention`: a `harnu:` prefix (or its legacy alias
 * `harnu:`) pins the mention to the bundled catalog, any OTHER namespace names a plugin a tick can never load
 * (`--setting-sources ''`) and so resolves to nothing, and a bare name takes
 * whatever the folder's list already resolved it to.
 *
 * An unresolved mention is reported, never dropped — a skill name that looks
 * fine and silently resolves to nothing at 3am is the whole bug this row exists
 * to make visible.
 */
export function mentionChips(prompt: string, skills: readonly AvailableSkill[]): MentionChip[] {
  return parseSkillMentions(prompt).map((mention) => {
    const colon = mention.indexOf(':')
    if (colon !== -1) {
      const bare = mention.slice(colon + 1)
      const hit = BUNDLED_NAMESPACES.includes(mention.slice(0, colon))
        ? skills.find((s) => s.name === bare && s.origin === 'bundled')
        : undefined
      return hit ? { mention, origin: hit.origin } : { mention }
    }
    const hit = skills.find((s) => s.name === mention)
    return hit ? { mention, origin: hit.origin } : { mention }
  })
}
