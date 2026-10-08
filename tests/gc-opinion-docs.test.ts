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

describe('the user doc is accurate about where each fact comes from (delta 4)', () => {
  it('quotes the real refusal sentence, not a paraphrase', () => {
    const t = userDoc()
    expect(t).toContain('Changed since you confirmed — review it again.')
    expect(t).not.toContain('Changed since you opened it')
  })

  it('says the diff, the uncommitted files and the head are read from git when you ask', () => {
    const t = userDoc()
    expect(t).toMatch(
      /diff[^.]*uncommitted files[^.]*head[^.]*(read|taken) from git[^.]*(when|at the moment) you ask/i
    )
    expect(t).not.toMatch(
      /summary of the branch, the changes and the pull request is taken by Harnu from the last scan/
    )
  })

  it('says only the pull request state comes from the last scan', () => {
    expect(userDoc()).toMatch(/pull request state[^.]*(from|as of) the last scan/i)
  })

  it('does not claim the re-check reads the pull request state "as it is now"', () => {
    expect(userDoc()).not.toMatch(
      /as it is now \(its head, its uncommitted files, its pull request state\)/
    )
    expect(userDoc()).toMatch(/pull request state as of the last scan/i)
  })

  it('says nested-worktree and locked items are never counted or pre-selected', () => {
    const t = userDoc()
    expect(t).toMatch(/nested/i)
    expect(t).toMatch(/locked/i)
    expect(t).toMatch(/never (counted|pre-selected)|left out of (it|the count)|excluded/i)
  })
})

describe('every doc says exactly where the advisor can read', () => {
  const where = (t: string): void => {
    expect(t).toMatch(/inside the (repository|repo) folder|only inside the folder/i)
    expect(t).toMatch(/\.env|ignored files/i)
    expect(t).not.toMatch(/any file it opens in the worktree/i)
  }
  it('docs/user/cleanup.md', () => where(userDoc()))
  it('CHANGELOG.md', () => where(changelog()))
  it('design.md', () => where(designBlock()))

  it('the user doc says an outside file cannot be opened, and a worktree outside the folder is not readable', () => {
    const t = userDoc()
    expect(t).toMatch(/(cannot|can't) open (a |any )?file outside/i)
    expect(t).toMatch(/worktree[^.]*outside[^.]*(not readable|cannot read|works from the summary)/i)
  })
})

describe('the docs state exactly what confines the advisor (delta 5, item 2)', () => {
  const docs: [string, () => string][] = [
    ['docs/user/cleanup.md', userDoc],
    ['CHANGELOG.md', changelog],
    ['design.md', designBlock]
  ]

  describe.each(docs)('%s', (_name, get) => {
    it('does not claim the CLI refuses anything outside the folder', () => {
      const t = get()
      expect(t).not.toMatch(/refuses anything outside/i)
      expect(t).not.toMatch(/Claude CLI refuses a file outside/i)
    })

    it('says the repository folder only, with Claude’s own data folder explicitly blocked', () => {
      const t = get()
      expect(t).toMatch(/repository folder/i)
      expect(t).toMatch(/~\/\.claude|Claude['’]s own data folder|Claude data folder/i)
      expect(t).toMatch(
        /(explicitly|specifically) (blocked|denied)|blocked explicitly|denied by name/i
      )
    })

    it('says auto memory is off', () => {
      expect(get()).toMatch(/no auto memory|auto memory is (switched )?off|without auto memory/i)
    })
  })

  it('the user doc and design.md mention the hard link limitation, in a clause', () => {
    for (const t of [userDoc(), designBlock()]) {
      expect(t).toMatch(/hard link/i)
    }
  })

  it('the user doc says the advisor never runs in your home folder or the filesystem root', () => {
    expect(userDoc()).toMatch(/home folder or the filesystem root|never your home folder/i)
  })

  it('the user doc says an unknown pull request state is shown as unknown, not as none', () => {
    expect(userDoc()).toMatch(
      /pull request[^.]*unknown[^.]*not[^.]*none|unknown[^.]*never[^.]*none/i
    )
  })

  it('the user doc says the diff names the branch it was taken against and never the item’s own', () => {
    expect(userDoc()).toMatch(
      /names the (branch|ref)[^.]*(against|compared)|never (compared|compares)[^.]*own branch/i
    )
  })

  describe('the code comments make no claim the CLI does not keep', () => {
    const read2 = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
    it('opinion-core.ts', () => {
      const t = flat(read2('src/main/gc/opinion-core.ts'))
      expect(t).not.toMatch(
        /confines Read, Grep and Glob to the folder the process runs in, symlinks out of it included, and refuses the rest/
      )
      expect(t).toMatch(/explicitly denied|explicitly blocked/i)
      expect(t).toMatch(/auto memory/i)
      expect(t).toMatch(/hard link/i)
    })
    it('opinion-run.ts', () => {
      const t = flat(read2('src/main/gc/opinion-run.ts'))
      expect(t).not.toMatch(/the CLI confines its reads to it/)
      expect(t).toMatch(/hard link/i)
    })
  })
})
