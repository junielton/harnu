/**
 * The bake-off's contestants and how each one's method reaches its `tool/` directory.
 *
 * All of them are read from files by the session (no `Skill` tool), so they load the same
 * way. A resolved tool is cached by contestant and sha, built aside and renamed in so a
 * concurrent unit never sees a partial one.
 */
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProblemCommand } from './checkout.mjs'

export const contestants = [
  {
    id: 'harnu-spec',
    source: {
      kind: 'repo',
      path: 'resources/skills/skills/spec',
      template: 'docs/specs/TEMPLATE.md'
    },
    entry: 'spec/SKILL.md',
    stopPoint: "the operator's yes to `Approve this spec?` and the header flip",
    tells: ['harnu:spec', 'harnu', 'Goldfish', 'Elephant'],
    specFile: '**/spec.md'
  },
  {
    id: 'superpowers',
    source: {
      kind: 'git',
      url: 'https://github.com/obra/superpowers',
      commit: 'bb92a77741419a4ab5f06e711a283343f1ada0c3',
      path: 'skills'
    },
    entry: 'brainstorming/SKILL.md, then writing-plans/SKILL.md',
    stopPoint: 'the plan is written; no execution',
    tells: ['superpowers', 'brainstorming', 'writing-plans'],
    specFile: 'docs/superpowers/plans/*.md'
  },
  {
    id: 'tlc-spec-driven',
    source: {
      kind: 'git',
      url: 'https://github.com/tech-leads-club/agent-skills',
      commit: '8658b6658c762b9e5efd3956ed35a51c41bdf6c3',
      skillName: 'tlc-spec-driven'
    },
    entry: 'SKILL.md',
    stopPoint: 'before its Execute phase',
    tells: ['tlc-spec-driven', 'tlc'],
    specFile: '**/spec.md'
  }
]

/**
 * @param {{ withTlc?: boolean }} options
 * @returns {typeof contestants} the round's contestants
 */
export function selectContestants({ withTlc = false } = {}) {
  return contestants.filter((c) => withTlc || c.id !== 'tlc-spec-driven')
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

/** `git` in `repoDir`, never prompting for credentials; throws on a failure. */
async function git(repoDir, ...args) {
  const cmd = ['git', '-C', repoDir, ...args].map(quote).join(' ')
  const r = await runProblemCommand(cmd, dirname(repoDir), {
    env: { GIT_TERMINAL_PROMPT: '0' }
  })
  if (r.exitCode !== 0) throw new Error(r.stderr || `git exited ${r.exitCode}`)
  return r.stdout
}

/** Unpack `treeish` (a commit or `commit:path`) from `repoDir` into `destDir`. */
async function extract(repoDir, treeish, destDir, scratch) {
  mkdirSync(destDir, { recursive: true })
  const tar = `${scratch}.tar`
  try {
    await git(repoDir, 'archive', '--format=tar', '-o', tar, treeish)
    const r = await runProblemCommand(`tar -xf ${quote(tar)} -C ${quote(destDir)}`, dirname(tar))
    if (r.exitCode !== 0) throw new Error(r.stderr)
  } finally {
    rmSync(tar, { force: true })
  }
}

function frontmatterName(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!block) return null
  return /^name:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m.exec(block[1])?.[1] ?? null
}

/** The one directory of `sha` whose `SKILL.md` frontmatter is named `name`, as a tree-ish. */
async function namedSkillTree(repoDir, sha, name) {
  const paths = (await git(repoDir, 'ls-tree', '-r', '-z', '--name-only', sha))
    .split('\0')
    .filter((p) => /(^|\/)SKILL\.md$/.test(p))
  const matches = []
  for (const path of paths) {
    if (frontmatterName(await git(repoDir, 'show', `${sha}:${path}`)) === name) matches.push(path)
  }
  if (matches.length !== 1) {
    throw new Error(`${matches.length} SKILL.md files are named ${name}; exactly one must be`)
  }
  const dir = dirname(matches[0])
  return dir === '.' ? `${sha}:` : `${sha}:${dir}`
}

async function fillFromRepo(source, repoDir, sha, aside) {
  await extract(repoDir, `${sha}:${source.path}`, join(aside, 'spec'), aside)
  const template = await git(repoDir, 'show', `${sha}:${source.template}`)
  writeFileSync(join(aside, 'spec', 'TEMPLATE.md'), template)
}

async function fillFromGit(source, url, sha, aside) {
  const scratch = `${aside}.git`
  try {
    mkdirSync(scratch, { recursive: true })
    await git(scratch, 'init', '-q', '--bare')
    await git(scratch, 'fetch', '-q', '--depth', '1', url, sha)
    const tree = source.skillName
      ? await namedSkillTree(scratch, sha, source.skillName)
      : `${sha}:${source.path}`
    await extract(scratch, tree, aside, aside)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Copy a contestant's method into `dest`, fetching it into the cache first when needed.
 *
 * @param {object} contestant one `contestants` entry
 * @param {{ skillRef: string, repo: string, cacheRoot: string, dest: string, sources?: Record<string, string> }} options
 *   `sources` maps a contestant id to a local repository that replaces its remote
 * @returns {Promise<{ sha: string } | { code: string, message: string }>}
 */
export async function resolveTool(contestant, { skillRef, repo, cacheRoot, dest, sources = {} }) {
  const { id, source } = contestant
  const local = sources[id]
  try {
    mkdirSync(cacheRoot, { recursive: true })
    let sha
    if (source.kind === 'repo') {
      sha = (await git(local ?? repo, 'rev-parse', '--verify', `${skillRef}^{commit}`)).trim()
    } else {
      sha = local ? (await git(local, 'rev-parse', 'HEAD')).trim() : source.commit
    }

    const cached = join(cacheRoot, 'tools', `${id}@${sha}`)
    if (!existsSync(cached)) {
      const aside = `${cached}.tmp-${randomUUID()}`
      mkdirSync(aside, { recursive: true })
      try {
        if (source.kind === 'repo') await fillFromRepo(source, local ?? repo, sha, aside)
        else await fillFromGit(source, local ?? source.url, sha, aside)
        if (!existsSync(cached)) renameSync(aside, cached)
      } finally {
        rmSync(aside, { recursive: true, force: true })
      }
    }
    cpSync(cached, dest, { recursive: true, verbatimSymlinks: true })
    return { sha }
  } catch (err) {
    return {
      code: 'TOOL_FETCH_FAILED',
      message: `The tool of ${id} could not be fetched: ${err.message}`
    }
  }
}
