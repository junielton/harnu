/**
 * T460 batch 0 — the deterministic on-disk world every dialog baseline and the
 * geometry spec launch the built app against (spec §6.3 step 3).
 *
 * `seedDialogWorld()` builds, under one tmp dir, everything a headless `ci`
 * launch can reach WITHOUT a Claude, a PR, Docker or an MCP caller:
 *
 *   - pinned folders (`<userData>/projects.json`): the `org/proj/www` git repo
 *     (main checkout) and one plain non-git folder;
 *   - the folder-menu dialogs: the repo has one LINKED worktree (RemoveWorktree
 *     needs it) — it is one of the long-list worktrees, `PROJ-231-wave-01`;
 *   - the long-list world (the BUG-184 shape): the same repo with
 *     `LONG_LIST_WORKTREES` linked worktrees on merged branches, a block of them
 *     in a state main refuses to clean (locked / detached HEAD / a worktree
 *     nested inside another);
 *   - a roadmap with 3 cards (backlog, ready, and one with a long body to edit);
 *   - 3 missions (an active one, a finished one with warnings, one with none).
 *
 * Determinism is the whole point — the `before` and `after` sides of a baseline
 * call this with the same arguments and must see the same world: fixed commit
 * dates, fixed names, no randomness, no clock reads. The only thing that varies
 * between two calls is the tmp directory prefix, which the seed returns so a
 * caller can normalize it out.
 *
 * Neutral vocabulary only (`org/proj/www`, `PROJ-231`) — see CLAUDE.md "Client
 * confidentiality". Never put a real client path or ticket key in here.
 *
 * NOT seedable here, by design (spec §6.3 step 3): Containers (needs Docker),
 * ReviewPane confirm (needs a PR), MCP gate (needs an MCP caller and "Ask before
 * agent actions"), ImageLightbox (needs a pasted image). A dirty card draft is UI
 * state, not disk state — the geometry spec types into the card to make one.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** How many linked worktrees the long-list repo carries (BUG-184: 33+ rows, 16+ refused). */
export const LONG_LIST_WORKTREES = 40

/** A commit date old enough that every worktree is far past any grace window, and fixed forever. */
/** Merged local branches with no worktree — they populate Cleanup's "Other leftovers" (Sweep). */
export const LEFTOVER_BRANCHES = 3

export const SEED_DATE = '2026-01-15T12:00:00+00:00'

/**
 * Which worktrees are in which "main would refuse this" state. Counts, not
 * names: the names are derived (`PROJ-231-wave-NN`). The three kinds are the
 * candidates spec §6.3 lists from `cleanup.gc.removal.reason`; `plain` is the
 * rest. A `Keep` mark is a per-user pref keyed by the item id and the branch
 * fate, so it is NOT written here — it is set through the UI when needed.
 */
export const REFUSAL_PLAN = {
  /** `git worktree lock` — refused as `locked`. */
  locked: 8,
  /** `git worktree add --detach` — a detached HEAD has no branch to judge, so the scan files it as In use. */
  detached: 4,
  /** Outer worktrees that have another worktree created INSIDE their folder — refused as `nested-worktree`. */
  nestedOuter: 8,
  /**
   * A tracked file modified after the merge: Needs review (`dirty`) but REMOVABLE once confirmed.
   * These are what make a Remove-selected confirm open at all with the refused ones ticked
   * alongside — the dialog only exists while at least one ticked row can be removed.
   */
  dirty: 6
} as const

export interface DialogSeed {
  /** The tmp root everything below lives under. */
  root: string
  /** Pass as `--user-data-dir` and as `HOME`. */
  userData: string
  /** The `org/proj/www` main checkout. */
  repo: string
  /** A pinned folder that is not a git repo. */
  plainFolder: string
  /** The one linked worktree RemoveWorktree is exercised on. */
  linkedWorktree: string
  /** Every linked worktree path, in creation order. */
  worktrees: string[]
  /** Worktree folder basenames grouped by the refusal state they were put in. */
  states: {
    plain: string[]
    locked: string[]
    detached: string[]
    dirty: string[]
    nestedOuter: string[]
    nestedInner: string[]
  }
  /** Merged local branches with no worktree. */
  leftoverBranches: string[]
  /** The seeded roadmap cards (file basenames, no extension). */
  cards: { backlog: string; ready: string; long: string }
  /** The seeded mission ids. */
  missions: { active: string; finishedWithWarnings: string; finishedClean: string }
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: cwd,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'Seed Author',
      GIT_AUTHOR_EMAIL: 'seed@example.invalid',
      GIT_COMMITTER_NAME: 'Seed Author',
      GIT_COMMITTER_EMAIL: 'seed@example.invalid',
      GIT_AUTHOR_DATE: SEED_DATE,
      GIT_COMMITTER_DATE: SEED_DATE,
      ...env
    }
  })
}

const pad = (n: number): string => String(n).padStart(2, '0')
const WAVE = (n: number): string => `PROJ-231-wave-${pad(n)}`

function writeCard(
  repo: string,
  slug: string,
  fm: { id: string; title: string; status: 'backlog' | 'ready'; kind: string },
  body: string
): void {
  const dir = join(repo, '.harnu', 'memory', 'roadmap')
  mkdirSync(dir, { recursive: true })
  const front = [
    '---',
    `id: ${fm.id}`,
    `title: ${fm.title}`,
    `status: ${fm.status}`,
    `kind: ${fm.kind}`,
    'complexity: standard',
    'substrate: session',
    'provenance:',
    '  author: human',
    `  at: ${SEED_DATE}`,
    '  branch: main',
    '---',
    ''
  ].join('\n')
  writeFileSync(join(dir, `${slug}.md`), `${front}${body}\n`)
}

/**
 * The subset of `Mission` (src/main/mission-core.ts) the seed writes. It is NOT imported from
 * `src/`: this file must stay loadable by plain Node (type-stripping) so the baseline driver
 * (`scripts/dev/dialog-baseline.mjs`) and the Playwright specs share ONE seed. A mission file is
 * `---` + YAML frontmatter + `---` + the Log, and JSON is valid YAML, so the frontmatter is
 * written as a JSON document that `parseMissionFile` (js-yaml, CORE schema) reads back verbatim.
 */
interface Mission {
  id: string
  slug: string
  folder: string
  owner: { sessionId: string; folder: string }
  status: 'active' | 'delivered'
  declaredEnd: { kind: string; target: string; evidence: string }
  declaredEndApproval: { at: string; bodyHash: string; via: string }
  steps: Record<string, unknown>[]
  blockers: unknown[]
  openQuestions: string[]
  pendingClose?: { at: string; requestedBy: string }
  createdAt: string
  updatedAt: string
  provenance: { author: string; at: string; branch: string }
}

function buildMissionFileContent(m: Mission, log: string): string {
  return `---\n${JSON.stringify(m, null, 2)}\n---\n${log}`
}

function mission(
  repo: string,
  id: string,
  slug: string,
  over: Partial<Mission> & Pick<Mission, 'status'>,
  checks: number
): Mission {
  const at = SEED_DATE
  const m: Mission = {
    id,
    slug,
    folder: repo,
    owner: { sessionId: '00000000-0000-4000-8000-000000000001', folder: repo },
    declaredEnd: {
      kind: 'code',
      target: 'The Acme dashboard ships behind the new flag',
      evidence: 'PR merged and the flag documented'
    },
    declaredEndApproval: { at, bodyHash: 'sha256:00', via: 'chat' },
    steps: [
      {
        id: 'stp-1',
        ordinal: 1,
        kind: 'custom',
        title: 'PROJ-231 — dashboard widgets',
        verification: 'existence',
        proof: 'unproven',
        links: [],
        blockers: [],
        ...(checks > 0
          ? {
              checks: Array.from({ length: checks }, (_, i) => ({
                id: `chk-${i + 1}`,
                label: `Designer signed off on variant ${i + 1}`,
                source: 'agent' as const,
                createdAt: at
              }))
            }
          : {})
      },
      {
        id: 'stp-2',
        ordinal: 2,
        kind: 'fixed-end',
        title: 'Delivered and verified',
        verification: 'verifier',
        proof: 'unproven',
        links: [],
        blockers: []
      }
    ],
    blockers: [],
    openQuestions: [],
    createdAt: at,
    updatedAt: at,
    provenance: { author: 'agent', at, branch: 'main' },
    ...over
  }
  return m
}

/**
 * Build the world under `opts.root` (default: a fresh tmp dir, which must not exist yet or be
 * empty). `worktrees` defaults to {@link LONG_LIST_WORKTREES}; a smaller
 * number is for a fast smoke of the seed itself. Throws if `git` fails.
 */
export function seedDialogWorld(opts: { worktrees?: number; root?: string } = {}): DialogSeed {
  const total = opts.worktrees ?? LONG_LIST_WORKTREES
  // `root` makes the world's absolute paths identical across two builds (the baseline driver
  // passes the same relative layout under a per-side dir); without it the dir is a fresh mkdtemp.
  const root = opts.root ?? mkdtempSync(join(tmpdir(), 'harnu-dialogs-'))
  mkdirSync(root, { recursive: true })
  const userData = join(root, 'home')
  mkdirSync(userData, { recursive: true })

  // ---- the repo: org/proj/www, with a bare "origin" so origin/main exists ----
  const www = join(root, 'Workspace', 'org', 'proj', 'www')
  const origin = join(root, 'Workspace', 'org', 'proj', 'www-origin.git')
  const wtRoot = join(root, 'Workspace', 'org', 'proj', 'www-worktrees')
  mkdirSync(www, { recursive: true })
  mkdirSync(wtRoot, { recursive: true })
  git(root, ['init', '--bare', '--initial-branch=main', origin])
  git(www, ['init', '--initial-branch=main'])
  writeFileSync(join(www, 'README.md'), '# www\n')
  writeFileSync(join(www, '.gitignore'), '.harnu/\nnode_modules/\n')
  git(www, ['add', '.'])
  git(www, ['commit', '-m', 'chore: initial commit'])
  git(www, ['remote', 'add', 'origin', origin])
  git(www, ['push', '-u', 'origin', 'main'])

  // ---- worktrees on branches that are merged into main ----
  const worktrees: string[] = []
  /** Branch worktrees an agent has "released" (see the gc-prefs write below): item id → {path, tip}. */
  const released: { id: string; path: string; tip: string }[] = []
  const states: DialogSeed['states'] = {
    plain: [],
    locked: [],
    detached: [],
    dirty: [],
    nestedOuter: [],
    nestedInner: []
  }
  type Kind = 'locked' | 'detached' | 'nestedOuter' | 'dirty' | 'plain'
  const kinds: Kind[] = []
  for (let i = 0; i < REFUSAL_PLAN.locked; i++) kinds.push('locked')
  for (let i = 0; i < REFUSAL_PLAN.detached; i++) kinds.push('detached')
  for (let i = 0; i < REFUSAL_PLAN.nestedOuter; i++) kinds.push('nestedOuter')
  // Interleave the refusal states through the list so the refused rows are not one contiguous block.
  for (let i = 0; i < REFUSAL_PLAN.dirty; i++) kinds.push('dirty')
  const plan: Kind[] = []
  let k = 0
  for (let i = 0; i < total; i++) {
    plan.push(i % 3 === 1 && k < kinds.length ? kinds[k++] : 'plain')
  }
  while (k < kinds.length) {
    const slot = plan.findIndex((p) => p === 'plain')
    if (slot === -1) break
    plan[slot] = kinds[k++]
  }

  for (let i = 1; i <= total; i++) {
    const name = WAVE(i)
    const branch = `feat/${name.toLowerCase()}`
    const dir = join(wtRoot, name)
    const kind = plan[i - 1]
    if (kind === 'detached') {
      git(www, ['worktree', 'add', '--detach', dir, 'main'])
      states.detached.push(name)
    } else {
      // A merged branch: one commit, fast-forward merged into main, so the fate is "merged".
      git(www, ['worktree', 'add', '-b', branch, dir, 'main'])
      writeFileSync(join(dir, `${name}.txt`), `${name}\n`)
      git(dir, ['add', '.'])
      git(dir, ['commit', '-m', `feat: ${name}`])
      git(www, ['merge', '--ff-only', branch])
      released.push({
        id: `${www}::worktree::${branch}`,
        path: dir,
        tip: git(www, ['rev-parse', branch]).trim()
      })
      if (kind === 'locked') {
        git(www, ['worktree', 'lock', '--reason', 'seeded lock', dir])
        states.locked.push(name)
      } else if (kind === 'dirty') {
        writeFileSync(join(dir, `${name}.txt`), `${name}\nuncommitted edit\n`)
        // An ignored, untracked dependency folder: it is what the Dehydrate dialog offers to remove.
        mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
        writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}\n')
        states.dirty.push(name)
      } else if (kind === 'nestedOuter') {
        // A worktree created INSIDE this one's folder: the outer cannot be removed while it holds another checkout.
        const inner = join(dir, 'inner-checkout')
        git(www, ['worktree', 'add', '-b', `${branch}-inner`, inner, 'main'])
        released.push({
          id: `${www}::worktree::${branch}-inner`,
          path: inner,
          tip: git(www, ['rev-parse', `${branch}-inner`]).trim()
        })
        states.nestedOuter.push(name)
        states.nestedInner.push(`${name}/inner-checkout`)
      } else {
        states.plain.push(name)
      }
    }
    worktrees.push(dir)
  }
  // ---- "Other leftovers": merged local branches that no worktree uses (the Sweep dialog) ----
  const leftoverBranches: string[] = []
  for (let i = 1; i <= LEFTOVER_BRANCHES; i++) {
    const branch = `feat/proj-231-leftover-${pad(i)}`
    git(www, ['branch', branch, 'main'])
    leftoverBranches.push(branch)
  }
  git(www, ['push', 'origin', 'main'])
  const linkedWorktree = worktrees[0]

  // ---- <userData>/gc-prefs.json: the "released" marks that make worktrees READY ----
  // A worktree is only "Ready to clean" with a sign of life older than the grace window, and the
  // signs are a merged PR's date (needs `gh`), a session, or a container event — none of which a
  // headless seed has. The one sign a disk can carry is an agent's release mark (the
  // `release_worktree` verb): it skips the grace for a STRONGLY merged branch and nothing else.
  // So every branch worktree is released here; main still refuses locked / nested / detached ones.
  writeFileSync(
    join(userData, 'gc-prefs.json'),
    JSON.stringify(
      {
        version: 1,
        released: Object.fromEntries(released.map((r) => [r.id, Date.parse(SEED_DATE)])),
        releasedFrom: Object.fromEntries(
          released.map((r) => [r.id, { repoPath: www, path: r.path, localTip: r.tip }])
        )
      },
      null,
      2
    )
  )

  // ---- the plain (non-git) folder ----
  const plainFolder = join(root, 'Workspace', 'org', 'notes')
  mkdirSync(plainFolder, { recursive: true })
  writeFileSync(join(plainFolder, 'todo.txt'), 'nothing\n')

  // ---- <userData>/projects.json (the shape user-projects.ts reads) ----
  writeFileSync(
    join(userData, 'projects.json'),
    JSON.stringify(
      {
        version: 1,
        projects: [
          { path: www, alias: 'www', addedAt: SEED_DATE, worktrees: [] },
          { path: plainFolder, alias: 'notes', addedAt: SEED_DATE, worktrees: [] }
        ],
        hiddenPaths: []
      },
      null,
      2
    )
  )

  // ---- roadmap: 3 cards ----
  const longBody = Array.from(
    { length: 40 },
    (_, i) => `Line ${i + 1}: a paragraph long enough to make the dossier body scroll.`
  ).join('\n\n')
  writeCard(
    www,
    'T9001-seed-backlog-card',
    { id: 'T9001', title: 'Seed backlog card', status: 'backlog', kind: 'chore' },
    '## Objective\nA card that sits in the backlog.'
  )
  writeCard(
    www,
    'T9002-seed-ready-card',
    { id: 'T9002', title: 'Seed ready card', status: 'ready', kind: 'feature' },
    '## Objective\nA card that is ready to dispatch.'
  )
  writeCard(
    www,
    'T9003-seed-long-card',
    { id: 'T9003', title: 'Seed long card', status: 'backlog', kind: 'bug' },
    `## Objective\n${longBody}`
  )

  // ---- missions: active, finished with warnings, finished clean ----
  const missionsDir = join(www, '.harnu', 'missions')
  mkdirSync(missionsDir, { recursive: true })
  const ids = {
    active: 'mnt-00000001',
    finishedWithWarnings: 'mnt-00000002',
    finishedClean: 'mnt-00000003'
  }
  const defs: [string, string, Mission][] = [
    [
      ids.active,
      'seed-active-mission',
      mission(www, ids.active, 'seed-active-mission', { status: 'active' }, 1)
    ],
    [
      ids.finishedWithWarnings,
      'seed-finished-with-warnings',
      mission(
        www,
        ids.finishedWithWarnings,
        'seed-finished-with-warnings',
        { status: 'delivered', pendingClose: { at: SEED_DATE, requestedBy: 'seed' } },
        2
      )
    ],
    [
      ids.finishedClean,
      'seed-finished-clean',
      mission(
        www,
        ids.finishedClean,
        'seed-finished-clean',
        { status: 'delivered', pendingClose: { at: SEED_DATE, requestedBy: 'seed' } },
        0
      )
    ]
  ]
  for (const [id, slug, m] of defs) {
    writeFileSync(join(missionsDir, `${id}-${slug}.md`), buildMissionFileContent(m, `# ${slug}\n`))
  }

  return {
    root,
    userData,
    repo: www,
    plainFolder,
    linkedWorktree,
    worktrees,
    states,
    leftoverBranches,
    cards: {
      backlog: 'T9001-seed-backlog-card',
      ready: 'T9002-seed-ready-card',
      long: 'T9003-seed-long-card'
    },
    missions: ids
  }
}
