import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Every safety claim the docs make about "Ask for an opinion" has to be literally true (T444 delta 3).
// What is enforced: the session is started with `--tools Read,Grep,Glob` (no shell, no write, no web, no
// MCP) and what it reads goes to the model like any request; "Remove the N marked safe" re-asks Harnu's
// cache right before the dialog opens, and the dialog's confirm uses the facts captured when it opened.

const ROOT = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const flat = (s: string): string => s.replace(/\s+/g, ' ')

function section(text: string, from: RegExp, to: RegExp): string {
  const i = text.search(from)
  expect(i, `section ${from} not found`).toBeGreaterThan(-1)
  const rest = text.slice(i)
  const j = rest.slice(1).search(to)
  return flat(j === -1 ? rest : rest.slice(0, j + 1))
}

const userDoc = (): string =>
  section(read('docs/user/cleanup.md'), /^### Ask for an opinion/m, /^### /m)
const changelog = (): string => {
  const text = read('CHANGELOG.md')
  const i = text.indexOf('**Ask for an opinion on Needs review items.**')
  expect(i).toBeGreaterThan(-1)
  const j = text.indexOf('\n- **', i + 5)
  const k = text.indexOf('\n###', i)
  return flat(text.slice(i, Math.min(...[j, k].filter((n) => n > -1))))
}
const designBlock = (): string => section(read('design.md'), /^#### Opinion chip/m, /^#### /m)

describe.each([
  ['docs/user/cleanup.md', userDoc],
  ['CHANGELOG.md', changelog],
  ['design.md', designBlock]
])('%s — claims about the advisor are literally true', (_name, get) => {
  it('does not say nothing can leave the machine, or that there is no network at all', () => {
    const t = get()
    expect(t).not.toMatch(/nothing (from|in) your (repository|repo)[^.]* leave/i)
    expect(t).not.toMatch(/nothing leaves the machine/i)
    expect(t).not.toMatch(/has \*{0,2}no network access\*{0,2}[,.]/i)
  })

  it('says what it reads is sent to the model', () => {
    expect(get()).toMatch(/sent to the model|goes to the model|the model request/i)
  })

  it('says it reads files and runs nothing', () => {
    expect(get()).toMatch(/read(s)? files/i)
    expect(get()).toMatch(/(cannot|can't|no way to) run (any )?command|runs nothing|no shell/i)
  })
})

describe('the user doc describes the real protection of "Remove the N marked safe"', () => {
  it('no longer claims the opinion itself is re-checked at confirm time', () => {
    expect(userDoc()).not.toMatch(/one that changed since the opinion is skipped/i)
  })

  it('says Harnu re-checks the marked items right before the dialog and leaves out those it cannot confirm', () => {
    const t = userDoc()
    expect(t).toMatch(/right before (the|it opens the) (remove )?dialog/i)
    expect(t).toMatch(/left out|leaves? (them|it) out/i)
  })

  it('says the confirm uses what the dialog showed when it opened', () => {
    expect(userDoc()).toMatch(/when (it|the dialog) opened|you opened (it|the dialog)/i)
  })
})

describe('design.md names the real enforcement', () => {
  it('mentions the --tools roster restriction and the right-before-the-dialog re-check', () => {
    const t = designBlock()
    expect(t).toContain('--tools')
    expect(t).toMatch(/right before (the|it opens the) (remove )?dialog/i)
  })
})
