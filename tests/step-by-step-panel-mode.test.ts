/**
 * Guided walks · S-6 — the contract in both modes (AC-34, the conformance matrix's "agent side" rows).
 *
 * `step-by-step` has two transports for one contract: chat (the bundled `step-by-step` skill, and the operator's
 * personal copy, which this repository does not own) and the walk pane (the bundled `walk` skill, whose
 * `references/panel-contract.md` restates the whole contract once). The rules that only one copy has must still hold
 * in the panel whichever chat copy is in use, so the panel reference carries the UNION. This file pins:
 *
 *  - every rule of the spec's conformance matrix that binds the agent's conduct has its sentence in the panel
 *    reference (the matrix rows that name "the Panel mode" and cite this test);
 *  - every rule the BUNDLED chat copy carries is still there (the panel did not cost the chat copy a rule);
 *  - the red flags in the panel reference are the union of both copies' tables;
 *  - `step-by-step` gained its one pointer line and stayed within the length cap.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { parseSkillFrontmatter } from '../src/main/bundled-skills-core'

const REPO = path.resolve(import.meta.dirname, '..')
const SKILLS = path.join(REPO, 'resources', 'skills', 'skills')
const read = (...p: string[]): string => readFileSync(path.join(SKILLS, ...p), 'utf8')
/** Collapse Prettier's line wrapping and table padding so a sentence matches whatever its breaks. */
const flat = (s: string): string => s.replace(/\s+/g, ' ')

const PANEL = (): string => flat(read('walk', 'references', 'panel-contract.md'))
const WALK = (): string => flat(read('walk', 'SKILL.md'))
const CHAT = (): string => flat(read('step-by-step', 'SKILL.md'))

interface Rule {
  /** The conformance-matrix row(s) the rule serves. */
  rows: string
  what: string
  /** Every pattern must match the panel reference. */
  panel: RegExp[]
  /** Patterns the bundled chat copy must still match: only for a rule that copy carries. */
  chat?: RegExp[]
}

/** One entry per rule of the contract, read from both copies. The panel text is the union; `chat` is the bundled copy. */
const RULES: Rule[] = [
  {
    rows: 'M-1, M-60',
    what: 'HARD-GATE: never perform a step; only read-only checks run',
    panel: [/Never perform a step yourself/, /only commands you run are read-only checks/],
    chat: [/Never perform a step yourself/, /only commands you run are read-only checks/]
  },
  {
    rows: 'M-2, M-66',
    what: 'HARD-GATE: never ask for a secret; confirm by a trace that is not secret',
    panel: [
      /Never ask the operator to paste a secret/,
      /confirmed by a trace that is not secret/,
      /last 4 characters/
    ]
  },
  {
    rows: 'M-3, M-69',
    what: 'HARD-GATE: never tick a criterion; the operator ticks it',
    // T787: the panel's agent never ticks or settles one itself; the app settles at the close (see walk-settle.test.ts)
    panel: [
      /Never tick or settle a criterion yourself/,
      /never call a criterion done because the operator said "done" in chat/
    ],
    chat: [/Never tick a criterion/]
  },
  {
    rows: 'M-4',
    what: 'the whole walk exists before check 1',
    panel: [/whole walk exists before check 1/, /refused whole/],
    chat: [/whole roadmap exists before the first step/]
  },
  {
    rows: 'M-5',
    what: 'a check found mid-walk is appended at the end and announced',
    panel: [/appended at the end with `walk_extend`/, /you say so in one line/],
    chat: [/appended and announced/]
  },
  {
    rows: 'M-6, M-7, M-55, M-56',
    what: 'one at a time, no preview, no bundling; an investigation is one thing per message',
    panel: [
      /One check at a time\. Exactly one/,
      /never preview the next one/,
      /bundle two "quick ones"/,
      /failure investigation is also one thing per message/
    ],
    chat: [/One step per message\. Exactly one/, /No preview, no bundling/]
  },
  {
    rows: 'M-8, M-59',
    what: 'a check is a complete how-to, never "open X, find Y, compare Z"',
    panel: [/complete how-to/, /zero context/, /Never "open X, find Y, compare Z"/]
  },
  {
    rows: 'M-9, M-64, M-75, M-47',
    what: 'the pane has the buttons; no dialog and no chat answer; a typed "done" moves nothing',
    panel: [
      /Never ask for an outcome through `AskUserQuestion` or in prose/,
      /a dialog hides the how-to/,
      /typed "done" in the chat is a follow-up, not a click, and moves nothing/
    ]
  },
  {
    rows: 'M-10, M-57',
    what: 'a check closes on the operator’s Done plus your check; silence never closes',
    panel: [
      /closes on the operator's Done plus your check/,
      /silence, "ok" or "it should have worked" never close one/,
      /never as verified by you/
    ],
    chat: [
      /closes on the operator's ✅ plus your read-only check/,
      /"it should have worked" never close a step/
    ]
  },
  {
    rows: 'M-11',
    what: 'a failed check after Done: show the evidence, the operator decides, follow anyway is unverified',
    panel: [/show the evidence and let the operator decide/, /follow anyway/, /unverified/],
    chat: [/show the evidence and let the operator decide/, /follow anyway/]
  },
  {
    rows: 'M-12, M-29, M-62, M-63',
    what: 'links: never hunt, never invent, a login is said, no link means a click path',
    panel: [
      /never hunts for a link/,
      /Never invent a URL/,
      /answers 200 on the right\s?page/,
      /id completed from memory is an invented URL/,
      /Behind a login you cannot prove the page/,
      /With no link, write the click path/
    ]
  },
  {
    rows: 'M-13',
    what: 'the operator’s language, fixed layout',
    panel: [/in the language they are speaking/]
  },
  {
    rows: 'M-14, M-15, M-67, M-74',
    what: 'six glyphs, no emoji',
    panel: [
      /Glyphs are `✓ ✗ ! - ⚑ \?` and nothing else/,
      /No emoji anywhere/,
      /A glyph marks an outcome/,
      /`✓` closed and verified, or confirmed by the operator where nothing can be checked from here/,
      /`✗` failed and still open/,
      /`!` closed with a caveat/,
      /`-` not reached yet, or skipped/,
      /`⚑` what the operator owes right now/,
      /`\?` an open question/,
      /Put exactly one space after a glyph/
    ]
  },
  {
    rows: 'M-16, M-53',
    what: 'phase 0: the five sources, and one question only when it cannot tell',
    panel: [
      /\(`feature`\)/,
      /\(`pr`\)/,
      /\(`branch`\)/,
      /\(`card`\)/,
      /\(`mission`, scope `step`, `milestone` or `mission`\)/,
      /Ask \*\*one\*\* question only when you cannot tell which source is meant/,
      /read it yourself/
    ]
  },
  {
    rows: 'M-17',
    what: 'acceptance criteria: one check per criterion in the ticket’s order, a hand-checked one is a verified row',
    panel: [
      /one check per criterion, in the ticket's order/,
      /already hand-checked goes in as a row already verified/,
      /when and by whom/
    ]
  },
  {
    rows: 'M-18, M-65',
    what: 'say where each is checked; a merged PR is not a deployed one: prove the deploy',
    panel: [
      /where each is checked/,
      /prove the deploy reached it/,
      /Merged is not deployed/,
      /preview or local app/
    ]
  },
  {
    rows: 'M-43',
    what: 'a check that changes something records how to undo it; Back leads with the undo',
    panel: [
      /records how to undo it in `undo`/,
      /Back reopens the previous check and leads with its undo/
    ],
    chat: [/how to undo it/, /lead with how to undo it/]
  },
  {
    rows: 'M-19',
    what: 'check before serving: the precheck states what is already proved',
    panel: [/Check before serving/, /`precheck`/, /A precheck that fails is a finding/]
  },
  {
    rows: 'M-20',
    what: 'the expected value per item: a table',
    panel: [/`table` of at most 12 rows/, /"Check the photos are right" is not a check/]
  },
  {
    rows: 'M-21',
    what: '`!` also means right in the open PR, not yet where it ships',
    panel: [/`openPr`/, /re-check N after the PR merges/]
  },
  {
    rows: 'M-22, M-58',
    what: 'atomic checks: at most 8 do items, bundles split, trivial ones are not folded',
    panel: [
      /One check is one action with one observable result/,
      /At most 8 `do` items/,
      /Trivial checks are where typos live/
    ],
    chat: [/atomic steps: one action, one observable result\. Split bundles/]
  },
  {
    rows: 'M-23, M-81',
    what: 'gate each candidate: done is a verified row; ours, optional or a decision is no check',
    panel: [
      /Gate each candidate/,
      /`leftOut` \(owner `ours`\)/,
      /A decision, not\s?an action: not a check either/,
      /`one-by-one`'s job/
    ]
  },
  {
    rows: 'M-24, M-44',
    what: 'order by dependency; a skipped one’s dependants wait',
    panel: [/Order by dependency/, /`blocks`/],
    chat: [/Order by dependency/]
  },
  {
    rows: 'M-26, M-54',
    what: 'the walk survives a compaction: walk_get is the read to make',
    panel: [/`walk_get` is the read to make/, /no memory of it/]
  },
  {
    rows: 'M-32',
    what: 'show, don’t characterize: passes and fails quote the literal',
    panel: [
      /Show, don't characterize/,
      /quote the literal value or symptom/,
      /never "resolves correctly"/
    ]
  },
  {
    rows: 'M-35, M-61',
    what: 'an unverifiable dashboard path is marked approximate; a dry-runnable command is dry-run',
    panel: [/`approximate`, never asserted as fact/, /a command you can dry-run/]
  },
  {
    rows: 'M-39, M-41, M-42, M-68',
    what: 'failure loop: one correction, a needed fact asked once, never advance, no list of causes, no attempt limit',
    panel: [
      /give \*\*one\*\* correction/,
      /ask for\s+one fact in chat and wait/,
      /Never advance, never fix the product yourself, never list every possible cause/,
      /no limit on attempts/
    ],
    chat: [/give \*\*one\*\* correction/, /No attempt limit, no list of possible causes/]
  },
  {
    rows: 'M-46',
    what: 'a check the operator did not understand was unclear, not the operator slow; never "as I said above"',
    panel: [/the check was unclear, not that they are slow/, /Never answer "as I said above"/]
  },
  {
    rows: 'M-48, M-49',
    what: 'the close-out: at most three lines, offers only (board cards)',
    panel: [/at most three lines/, /offering board cards for what\s+is still owed/, /only offer/],
    chat: [/Offer board cards for skipped and unverified items; only offer/]
  },
  {
    rows: 'M-50, M-53',
    what: 'persistence applies only to a mission source; with none, run the walk anyway and say so',
    panel: [
      /Every rule below applies \*\*only when the source is a mission\*\*/,
      /For any other source nothing is written to\s+any mission/,
      /run the walk anyway, write no criteria and say so/
    ],
    chat: [/run\s?the walk anyway, write no criteria and say so/]
  },
  {
    rows: 'M-51, M-70',
    what: 'criterion text is a fact of 3 words or more and at most 70 characters, stable, never reworded; a plan only grows',
    panel: [/three words or more, at most 70\s+characters/, /never reworded/, /a plan only grows/],
    chat: [/Keep it stable/, /a plan only grows/]
  },
  {
    rows: 'M-52, M-72',
    what: 'report a criterion open or settled from mission_get, never from the chat',
    panel: [
      /\*\*open\*\* or \*\*settled\*\* from `mission_get`, never from the chat/,
      /the criterion\s+stays open: say so once/
    ],
    chat: [/\*\*open\*\* or \*\*settled\*\*/, /say so once/]
  },
  {
    rows: 'M-71',
    what: 'the criteria are added before the walk opens, not as you go',
    panel: [/added before the walk opens/, /never as you go/],
    chat: [/added before the walk starts/]
  },
  {
    rows: 'M-73',
    what: 'add a criterion only if its wording is not already on the step; no edit, no remove; a done step gets none',
    panel: [
      /Add a criterion only when its wording is not already on the step/,
      /neither edit nor remove one/,
      /a step already done gets none/
    ],
    chat: [/neither edit nor remove a criterion/, /✔ with evidence and get \*\*no\*\* criterion/]
  },
  {
    rows: 'M-76',
    what: 'an action-brief handed back: the "needs you" block is the list, the "ours" block is not',
    panel: [/"needs you" block is the list; the "ours" block is not/]
  },
  {
    rows: 'M-78',
    what: 'read the skill’s LESSONS.md first; offer the mission skill only when the list should outlive the session',
    panel: [
      /`LESSONS\.md`/,
      /Offer the `mission`\s+skill only when the list should outlive the session/
    ],
    chat: [
      /`LESSONS\.md`/,
      /offer the `mission` skill\s?only when the operator wants the list to survive the session/
    ]
  },
  {
    rows: 'M-80',
    what: 'check up to four links yourself; with more, one link-finder agent',
    panel: [/Up to four, check them yourself/, /`dtk:link-finder`/]
  }
]

/** The union of both copies' red-flag tables: the operator's 14 plus the bundled copy's three more. */
const RED_FLAGS: { rows: string; thought: string }[] = [
  { rows: 'M-55', thought: 'Then we go to check 2, which is on the VM' },
  { rows: 'M-56', thought: "I'll ask for these three things to diagnose it" },
  { rows: 'M-57', thought: "They said done, so it's done" },
  { rows: 'M-58', thought: "This check is trivial, I'll fold it into the next" },
  { rows: 'M-59', thought: 'Open X, find Y, compare Z is clear enough' },
  { rows: 'M-60', thought: "I'll just run this myself to speed it up" },
  { rows: 'M-61', thought: 'The dashboard menu is probably Access, Applications' },
  { rows: 'M-62', thought: 'The URL is surely /settings/secrets' },
  { rows: 'M-63', thought: "I remember most of that doc id, I'll complete it" },
  { rows: 'M-64', thought: "I'll put the options in a dialog, it's cleaner" },
  { rows: 'M-65', thought: 'The PR merged, so staging has it' },
  { rows: 'M-66', thought: 'Paste the token here so I can confirm it' },
  { rows: 'M-67', thought: 'A ✅ in the label reads friendlier' },
  { rows: 'M-68', thought: 'The user is stuck, let me list every possible cause' },
  { rows: 'M-69', thought: "They said done, I'll mark the criterion" },
  { rows: 'M-70', thought: "I'll reword the criterion so it's clearer" },
  { rows: 'M-71', thought: "I'll add the criteria as we go" }
]

/** The five rows of the bundled copy's own table: the chat copy keeps them. */
const CHAT_FLAGS = [
  "They said done, I'll mark the criterion",
  "I'll reword the criterion so it's clearer",
  "I'll add the criteria as we go",
  "I'll just run this myself to speed it up",
  'Then step 2, which is on the VM'
]

describe('step-by-step: the contract in both modes', () => {
  it('keeps every contract rule in both modes', () => {
    const panel = PANEL()
    const chat = CHAT()
    const missing: string[] = []
    for (const r of RULES) {
      for (const re of r.panel)
        if (!re.test(panel)) missing.push(`panel [${r.rows}] ${r.what}: ${re}`)
      for (const re of r.chat ?? [])
        if (!re.test(chat)) missing.push(`chat [${r.rows}] ${r.what}: ${re}`)
    }
    expect(missing).toEqual([])

    // the two files that carry a rule are the ones the spec names: the skill points at its reference, the pointer
    // line sits in the chat copy, and the HARD-GATE is restated in the short skill too
    const walk = WALK()
    expect(walk).toContain('references/panel-contract.md')
    expect(walk).toMatch(/<HARD-GATE>/)
    expect(walk).toMatch(/Never ask for a secret\. Never tick or settle a criterion yourself/)
    expect(walk).toMatch(/Ask `walk_get\(\{ folder, source \}\)` before you write/)
    expect(walk).toMatch(/Only a \*\*mission\*\* source writes anything to a mission/)
  })

  it('carries the union of both red-flag tables, and the chat copy keeps its own', () => {
    const panel = PANEL()
    const table = /## Red flags[^|]*((?:\|[^|]*\|[^|]*\| ?)+)/.exec(panel)?.[1] ?? ''
    expect(table.length).toBeGreaterThan(500)
    const missing = RED_FLAGS.filter((f) => !table.includes(`"${f.thought}"`)).map(
      (f) => `[${f.rows}] ${f.thought}`
    )
    expect(missing).toEqual([])
    // one row per flag, not more: the union is the 17 thoughts, each once
    expect((table.match(/\| "/g) ?? []).length).toBe(RED_FLAGS.length)

    const chat = CHAT()
    expect(CHAT_FLAGS.filter((t) => !chat.includes(t))).toEqual([])
  })

  it('gives step-by-step one pointer line to the walk skill, inside the length cap', () => {
    const raw = read('step-by-step', 'SKILL.md')
    const pointer = raw.split('\n').filter((l) => /harnu:walk/.test(l))
    expect(pointer).toHaveLength(1)
    expect(pointer[0]).toMatch(/`walk_open`/)
    expect(pointer[0]).toMatch(/instead/)
    expect(parseSkillFrontmatter(raw, 'step-by-step')?.name).toBe('step-by-step')
    // the length test of skill-others-v4.test.ts ("a rewrite is never longer"): wc -l, at most 167
    expect(raw.split('\n').length - 1).toBeLessThanOrEqual(167)
  })
})
