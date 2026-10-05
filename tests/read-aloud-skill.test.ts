/**
 * T236 AC-1 — the shipped `read-aloud` SKILL.md must actually parse.
 *
 * `parseSkillFrontmatter` is the only gate between a file in `resources/skills/`
 * and a skill the session can invoke: it is fail-soft PER ENTRY, so a malformed
 * frontmatter drops THAT skill silently and the catalog still stages. A typo in a
 * shipped skill would therefore ship as "the switch is there but the skill never
 * appears", with nothing red anywhere. This reads the real file off disk — not a
 * fixture — so that failure mode is caught here instead of by a user.
 *
 * The two structural guards below are cheap and cover the same class of silent
 * breakage: a personal absolute path baked into a file we ship to everyone, and a
 * catalog whose "Entries" table has drifted from what is on disk.
 *
 * T242 then migrated the skill onto the `speak` verb, and added the guards in the
 * second describe block. They are prose assertions on a model-facing file, which is
 * unusual for a test suite — but this file IS the artifact that ships, there is no
 * compiler between it and the session that reads it, and the three ways it can
 * regress are all invisible at runtime: losing the shell fallback (a silent
 * regression for anyone outside Harnu), reaching for `notify` (a permanent Activity
 * row for a sentence already heard), or falling back to the shell after `speak`
 * refused (routing around a mute the operator set on purpose).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILL_DIR = path.join(REPO_ROOT, 'resources', 'skills', 'skills', 'read-aloud')

function readSkill(): string {
  return readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')
}

describe('read-aloud — the shipped SKILL.md (T236 AC-1)', () => {
  it('parses into a BundledSkill whose name matches its directory', () => {
    const parsed = parseSkillFrontmatter(readSkill(), 'read-aloud')
    expect(parsed).not.toBeNull()
    expect(parsed!.name).toBe('read-aloud')
    expect(parsed!.description.length).toBeGreaterThan(0)
  })

  it('resolves its TTS command from the environment, not a personal path (AC-4)', () => {
    const raw = readSkill()
    // The positive half: the override and the fallback are both named, so the
    // skill can never quietly hardcode one engine.
    expect(raw).toContain('HARNU_TTS_COMMAND')
    expect(raw).toContain('CAPY_TTS_COMMAND')
    expect(raw).toContain("default_tts='spd-say -w'")
    expect(raw).toContain('Darwin) default_tts=say')
    // The negative half: no `/home/<someone>/` or `/Users/<someone>/` — this file
    // ships to every machine, and such a path would work on exactly one.
    expect(raw).not.toMatch(/\/(home|Users)\/[A-Za-z0-9._-]+\//)
  })

  it('is listed in the catalog the panel renders', () => {
    const catalog = readFileSync(path.join(REPO_ROOT, 'resources', 'skills', 'CATALOG.md'), 'utf8')
    expect(catalog).toMatch(/^\|\s*`read-aloud`\s*\|/m)
  })
})

describe('read-aloud — migrated onto the `speak` verb (T242)', () => {
  it('names `speak` as the door it takes inside Harnu (AC-1)', () => {
    const raw = readSkill()
    expect(raw).toContain('speak({')
    // The gate anchor and the deliberate omission are both load-bearing: without
    // `folder` the verb cannot resolve the operator's voice setting, and passing
    // `sessionId` would let the focus rule swallow the very utterance the operator
    // just asked for (they are looking at the session they typed the request into).
    expect(raw).toMatch(/folder:/)
    expect(raw).toMatch(/[Oo]mit `?sessionId/)
    // "Prefer speak" is an ORDER, not a mention: a step 4 that led with the shell
    // recipe and mentioned the verb afterwards would read as the shell being the
    // normal path, which is the pre-migration behaviour with extra words.
    const verbAt = raw.indexOf('speak({')
    const shellAt = raw.indexOf('HARNU_TTS_COMMAND:-${CAPY_TTS_COMMAND:-$default_tts}')
    expect(verbAt).toBeGreaterThan(-1)
    expect(shellAt).toBeGreaterThan(-1)
    expect(verbAt).toBeLessThan(shellAt)
  })

  it('keeps the shell command as the fallback for a session outside Harnu (AC-2)', () => {
    const raw = readSkill()
    // The RECIPE, not the words. Asserting on `HARNU_TTS_COMMAND` and the default
    // separately passes on a file that only MENTIONS them in prose while the shell
    // path itself has been gutted — verified by mutation, that exact false green
    // happened. This is the one expression the fallback cannot work without.
    expect(raw).toContain('${HARNU_TTS_COMMAND:-${CAPY_TTS_COMMAND:-$default_tts}}')
    // And it is still an executable recipe: the injection-safe heredoc and the
    // availability probe are what make the fallback usable rather than described.
    expect(raw).toContain("<<'SPEECH'")
    expect(raw).toContain('command -v "${tts%% *}"')
  })

  it('never lets a `speak` REFUSAL become a shell fallback (AC-2)', () => {
    const raw = readSkill()
    // The dangerous mis-reading of "keep the fallback": a refusal is the operator's
    // own switch answering, and shelling out afterwards would use the speakers they
    // just closed. The skill has to say so, not merely imply it.
    expect(raw).toMatch(/Never fall back to the shell after `speak` refused/i)
    expect(raw).toMatch(/does not exist\. Never for a verb that said no/i)
  })

  it('handles both refusal codes, and does not lobby against a deliberate mute', () => {
    const raw = readSkill()
    expect(raw).toContain('VOICE_DISABLED')
    expect(raw).toContain('VOICE_MUTED_FOR_FOLDER')
    expect(raw).toMatch(/do not tell them how to\s+undo it/i)
  })

  it('leaves NO Activity row — it never reaches for `notify` (AC-3)', () => {
    const raw = readSkill()
    // Every mention of `notify` in the shipped file must be a PROHIBITION. The
    // regression this pins is a skill that "helpfully" also files a notice, which
    // would fill the operator's Activity history with sentences they already heard
    // — the exact distinction `speak` was split out from `notify` to preserve.
    expect(raw).toMatch(/never reaches for the\s+`notify` verb/i)
    expect(raw).toMatch(/Never use `notify` to produce speech/i)
    // The verb side of the same guarantee is pinned in `mcp-speak-handler.test.ts`
    // (the bridge only ever sees `speech.say`); this is the skill side of it. The
    // call FORM is what is banned, anywhere in the file — the skill shows `speak({`
    // as a call, so a `notify(` next to it would be a working instruction, not prose.
    expect(raw).not.toMatch(/\bnotify\(/)
  })

  it('bumps the catalog marker and keeps the entry honest (AC-4)', () => {
    const catalog = readFileSync(path.join(REPO_ROOT, 'resources', 'skills', 'CATALOG.md'), 'utf8')
    const marker = /^<!-- harnu-skills v(\d+) /.exec(catalog)
    expect(marker).not.toBeNull()
    // v6 was the state this migration forked from; the marker is what tells a
    // staged copy it is stale, so a content change with no bump ships the OLD file.
    expect(Number(marker![1])).toBeGreaterThan(11)
    expect(catalog).toMatch(/^\|\s*`read-aloud`\s*\|.*`speak` verb/m)
  })
})
