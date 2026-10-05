# BUG-64 — A Capy-cut worktree inherits its parent repo's trust, or Capy says nothing at all

**Date:** 2026-08-08 · **Status:** specified (not implemented) · **Card:** `.capy/memory/roadmap/BUG-64-fan-out-into-a-fresh-folder-worktree-hits-the-claude-trust.md`
**Verified against:** repo `main` @ `2706083`, Claude Code **2.1.226** (`~/.local/share/claude/versions/2.1.226`, the binary installed on this machine — the brief said 2.1.224; every CLI fact below was read from 2.1.226, so that is what this line records)
**Scope:** BUG-64 **part B only**. Part A (`prompt-inject-gate.ts`) and part C (stuck-session observability) already landed and are not reopened here — see §7.
**Related:** [T214](./T214-generic-boot-blocked-detector.md) (detection, §7) · [T209](./T209-claude-config-dir-resolver.md) (config-dir resolver — a hard dependency, §2.3 + O6) · [T210](./T210-worktree-steps-pipeline.md) (bring-up pipeline — deliberately not the host, D3) · BUG-41 (`projects.json` RMW race — the analogy the card invokes, D4)

## 1. What the card asks for, and what turns out to be true

The card's part B is: _"Capy establishes TRUST (not bypass) for folders IT created."_ Its own
2026-07-21 **CORRECTION** already walks that back — a worktree cut inside an
already-trusted repo did **not** hit the dialog — and demotes B without ever explaining
_why_ it was a no-op. This spec resolves that, because the mechanism decides the whole design.

**The CLI already inherits trust from ancestors.** Decompiled from 2.1.226, the workspace-trust
predicate is an ancestor walk from the session's cwd to `/`:

```js
function GES() {
  // "is this workspace trusted?"
  if (te.CLAUDE_CODE_SANDBOXED) return !0
  if (_Ue()) return !0 // accepted earlier in THIS session
  if (Fs()) return !0 // background mode (`--bg`)
  let e = Wt(),
    t = XAe()
  if (e.projects?.[t]?.hasTrustDialogAccepted) return !0
  let n = eze(Vt()) // normalized cwd
  while (!0) {
    // ── walk UP to the filesystem root
    if (e.projects?.[n]?.hasTrustDialogAccepted) return !0
    let i = eze(aS.resolve(n, '..'))
    if (i === n) break
    n = i
  }
  return !1
}
```

Capy's own validator guarantees every managed worktree is **inside** the repo:
`validateWorktreeRequest` rejects a target that escapes `<root>/.claude/worktrees`
(`src/main/worktree-core.ts:600-603`, via `isInside` at `:557-563`), and `worktreesRoot`
is `<repo>/.claude/worktrees` (`:47-49`). So for the default layout the repo root is an
ancestor of the worktree, and **a blanket "stamp every worktree" is a write that changes
nothing.** The card's correction was right; this is the missing mechanism behind it.

That does not make part B empty. Two real gaps survive the ancestor walk (§4), and both are
reachable from Capy's own code paths today.

## 2. Current behaviour, verified

### 2.1 Capy has no trust handling at all

```
grep -rn 'hasTrustDialogAccepted|trustDialog' src/   →  0 hits
```

The only mentions anywhere in the repo are prose in
`docs/reports/2026-07-20-orphan-spawn-postmortem.md:173,217,310`. Capy never reads the
CLI's trust state, never reports it, and never writes it.

The adjacent policy that _is_ implemented and **must stay untouched**: an MCP-spawned session is
`agentControlled`, which re-resolves the merged boot config, strips every permission-bypass flag
via `forceDowngradePermission`, and withholds Capy's `--mcp-config`
(`src/main/pty.ts:685-693`). Nothing in this card weakens that.

### 2.2 The create pipeline, and where a step could live

`createWorktree` (`src/main/worktree-ipc.ts:1185-1402`) is the whole flow:

| Step                                                                     | Site                                                                  |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| argv gate on `branch`/`baseRef`/`ref`                                    | `:1222-1223` → `validateWorktreeRequest` (`worktree-core.ts:574-606`) |
| plan: repo root, manifest, target, base                                  | `:1230-1235` → `resolveWorktreePlan` (`:746-799`)                     |
| POSIX-shell pre-flight                                                   | `:1241`                                                               |
| `git worktree add` (or delegated `create:`)                              | `:1260-1321`                                                          |
| `seed` + `setup` (login PATH, BUG-27)                                    | `:1327-1338`                                                          |
| **transactional rollback** on any seed/setup failure                     | `:1339-1351` → `rollbackWorktree` + `WorktreeProvisionError`          |
| `adoptFolder` — pins the folder, emits `folders:adopted`                 | `:1354-1385` → `:211-246`                                             |
| ACK fields (`path`/`base`/`branch`/`bornFrom`/`warnings`/`existingWork`) | `:1391-1400`, surfaced at `src/main/mcp/tool-handlers.ts:816-834`     |

The parent repo is **already in hand**: `resolveWorktreePlan` returns `repoRoot`, resolved from
`git rev-parse --git-common-dir` and de-`.git`'d (`worktree-ipc.ts:308-326`). No new resolution is
needed and none should be invented.

> **Do not use `repoId` for this.** `AdoptedFolderPayload.repoId` is the **realpath'd**
> git common-dir (`src/main/git-probe.ts:15-16,48-55`) — i.e. `<repo>/.git` after symlink
> resolution. It is the wrong shape (a `.git` dir, not a repo root) and the wrong
> normalization (the CLI key is NOT realpath'd — §2.3, O5). `repoRoot` from the plan is the correct input.

### 2.3 The CLI's trust model, decompiled

| Fact                                                                                                                                          | Evidence (2.1.226)                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Trust key = `path.normalize(Cu(p) ?? path.resolve(p))`; `Cu` is the sandbox/runner `canonicalRepoPath` override, undefined on a local install | `nVt(e){return eze(Cu(e)??aS.resolve(e))}`, `wW(e){return nVt(e??$n())}`, exported as `getWorkspacePersistedTrustKey`                  |
| Trust is stored **only** in the CLI's private config at `projects[<key>].hasTrustDialogAccepted`                                              | `got={allowedTools:[],…,hasTrustDialogAccepted:!1,…}`; `Egf=["allowedTools","hasTrustDialogAccepted","hasCompletedProjectOnboarding"]` |
| Config path is resolved by `jv()` — see the code block below the table                                                                        | `jv`                                                                                                                                   |
| Trust is **ancestor-inherited** to the filesystem root                                                                                        | `GES()`, quoted in §1                                                                                                                  |
| A plain `claude` session shows the dialog when `!rp() \|\| Mvt()`                                                                             | `if(d=rp(),!d\|\|Mvt()){u=!0; let{TrustDialog:h}=await …}`                                                                             |
| The 2.1.225 addition applies to the **`claude agents`** entry point, gated on the same predicate                                              | `agentsTrustDecision(){ … return rp()&&!Mvt()?"trusted":"ask" }` / `ensureAgentsWorkspaceTrust`                                        |
| The CLI writes the config under a **cross-process `proper-lockfile`** at `<config>.lock`, re-reads under the lock, and merges `projects`      | `Q_(e,{lockfilePath:\`${e}.lock\`,onCompromised:…})`; `KES`/`kgf`; `JPn`                                                               |
| The CLI **watches** the config file and reloads on mtime change                                                                               | `JES(){ … nZr(e,{interval:XES,persistent:!1},(t)=>{ … PLa(t) }) }`                                                                     |

**The config path — three branches, all of which T209's resolver must model (O6):**

```js
jv = pn(() => {
  if (existsSync(join(Ln(), '.config.json'))) return join(Ln(), '.config.json')
  let e = `.claude${TYe()}.json` // TYe(): "" on prod, else -staging-oauth / -local-oauth / -custom-oauth
  return join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), e)
})
```

**`Mvt()` — the re-ask gate, and the reason an exact-key stamp is not equivalent to ancestor trust:**

```js
function Mvt() {
  if (te.CLAUDE_CODE_SANDBOXED) return !1
  if (_Ue()) return !1
  if (Fs()) return !1
  if (d4d.homedir() === $n()) return !1
  if (N2()) return !1 // ← the EXACT cwd key is trusted
  let { gateProject: e, gateLocal: t } = cbn()
  return (e && u4d('projectSettings')) || (t && u4d('localSettings'))
}
function u4d(e) {
  if (!fT().includes(e)) return !1
  return (
    n5t(e).some((t) => t.ruleBehavior === 'allow') ||
    (tn(e)?.permissions?.additionalDirectories?.length ?? 0) > 0
  )
}
```

So a directory that is trusted **only by ancestry** — `rp()` true, `N2()` false — still gets the
dialog when the workspace carries a `.claude/settings.json` or `.claude/settings.local.json` that
declares a `permissions.allow` rule or `permissions.additionalDirectories`. An **exact-key** entry
short-circuits it at `N2()`. That is the one thing the stamp buys that ancestry does not.

The companion warning proves the intent, and names the remedy verbatim:

> `Ignoring ${t} ${e} entries from ${o}: this workspace has not been trusted. Run Claude Code
interactively here once and accept the trust dialog, or set
projects[${De(n)}].hasTrustDialogAccepted: true in ${jv()}.`

### 2.4 Field census, this machine, 2026-08-08

`~/.claude.json`, 270 KB, mode `600`, 109 top-level keys, **84 project entries — 33 `true`, 51
`false`, 0 absent**. (The brief's "84 / 51 false / 33 true" reproduces exactly.) Beyond the counts:

- **`/` and `/home/u` are both `hasTrustDialogAccepted: true`.** By §1's ancestor walk,
  every path on this machine is already trusted. This is why the capy repo boots fine while its
  own key reads `false`, and why 10 dispatches into untrusted-keyed worktrees all worked
  (BUG-64's correction). **This machine cannot reproduce the bug and cannot validate the fix** —
  see §8's honest gap.
- **9 worktree entries under `.claude/worktrees/`, all `true`, all under parents that are also
  `true`** (`DemoApp`, `acme/www`). Their names (`funny-bohr-cfce08`,
  `gallant-satoshi-41c3c1`, …) are the CLI's own petname generator, not `slugifyBranch` — these
  are CLI-cut worktrees, and the CLI stamped each one at accept time.
- **3 worktree entries at `acme/worktrees/…` are `false`** — a **sibling** layout, outside
  the repo root at `acme/www`. This is §4.1's gap, observed in the wild.
- The file grew 269 823 → 269 893 → 270 189 bytes over ~15 minutes of writing this spec, with no
  Capy involvement. The race D4 addresses is not hypothetical.

### 2.5 What 2.1.225 does and does not change for Capy

The changelog line, verbatim from `~/.claude/cache/changelog.md:10`:

> Added a workspace trust prompt to `claude agents` for untrusted directories, matching the
> behavior of `claude`.

**Capy never spawns `claude agents`.** `PtyKind` is
`'shell' | 'claude-new' | 'claude-resume' | 'claude-fork' | 'teammate'` (`src/main/pty.ts:166`);
the claude kinds spawn bare `claude`, `claude --resume <uuid>`, or `claude --resume <uuid>
--fork-session` (`:615-645`), and no `agents` subcommand or `--bg` flag appears anywhere in
`src/main/`. So 2.1.225 is **not** a new regression on Capy's dispatch path — the plain-`claude`
path has always shown this dialog. It is a trend signal (the gate is spreading to entry points
that previously skipped it), which is T214's argument, not this card's.

Corollary worth recording: `Fs()` — background mode — returns trusted unconditionally in `GES()`.
If Capy ever adopts `--bg` dispatch (audit §4.1, T206), those sessions bypass the trust gate
entirely and this card becomes moot **for that substrate only**.

## 3. Is there a `settings.json`-level mechanism? — No. Investigated, and the answer is load-bearing

The card requires this be settled before defaulting to the file stamp. It is settled: **trust is
not expressible in any settings file.**

- Every read of trust in the binary goes through `Wt().projects?.[key]?.hasTrustDialogAccepted`
  (§2.3). There is no settings key. A full string sweep for `"*trust*"` identifiers in the binary
  returns exactly one Claude-Code-owned name — `"hasTrustDialogAccepted"` — plus unrelated
  vendored strings (`trustedDependencies` from bun, `TrustedHTML`, `trustedNetworkDirectories`,
  device-trust for auth).
- The three non-file escapes are all worse than the file: `CLAUDE_CODE_SANDBOXED=1` (asserting
  we are in a sandbox, which is false and changes far more than trust), `_Ue()`
  (in-session accept — the dialog we are trying to avoid), and `Fs()` (background mode).
- **Capy's existing per-session `--settings` blob is not a door here.** `hook-settings-blob.ts`
  can inject arbitrary settings at spawn (T207 D1), but there is no trust setting to inject.
- **The file stamp is the CLI's own documented remediation.** The error string in §2.3 tells the
  user to set `projects[<key>].hasTrustDialogAccepted: true` in the config file. Anthropic's own
  self-hosted runner does it programmatically, writing bare entries for the normalized, NFC,
  realpath and realpath-NFC spellings at mode `384` (0600):

  ```js
  for (let Fr of [dr, dr.normalize('NFC'), ...(Nt !== void 0 ? [Nt, Nt.normalize('NFC')] : [])])
    sr[Fr] = { hasTrustDialogAccepted: !0 }
  … await writeFile(mn, Ur, { mode: 384 })      // `.claude<suffix>.json`
  ```

**Finding: writing `projects[<key>].hasTrustDialogAccepted` is the only mechanism, and it is
sanctioned rather than reverse-engineered.** That does not make the file public API (D5 still assumes the schema can change without notice) — but
it removes "we are hand-editing a private file with no blessing" from the objection list.

## 4. The two gaps that survive the ancestor walk

### 4.1 A worktree outside the repo root (manifest `dir:`)

`resolveWorktreePlan` honours the manifest `dir` verbatim:

```ts
const target = manifest.dirExplicit
  ? resolveWorktreeDir(repoRoot, manifest.dir) // worktree-manifest.ts:499-503
  : deriveWorktreePath(repoRoot, branch) // worktree-core.ts:102-109
```

`resolveWorktreeDir`'s own doc comment endorses escape: _"A relative `dir` (e.g.
`../acme-worktrees/feat`) is resolved against the repo root — so the sibling layout the spec
favors lands beside the repo."_ The only guard is `isSafeWorktreeTarget`
(`worktree-manifest.ts:625-635`), which rejects the repo root, anything under `.git`, and
_ancestors_ of the repo root — **a sibling directory passes**. The containment check in
`validateWorktreeRequest` never sees the manifest path: it is called with
`explicitPath: undefined` (`worktree-ipc.ts:1222`), so it validates the _default_ location only.

Result: with `dir: ../worktrees/{slug}`, the worktree has **no trusted ancestor in common with the
repo**, and the trust dialog fires on first dispatch. §2.4's three `false` entries at
`acme/worktrees/…` are exactly this, on disk, today.

### 4.2 A worktree whose project settings gate the re-ask

Per §2.3's `Mvt()`: a worktree that carries `.claude/settings.json` or
`.claude/settings.local.json` with a `permissions.allow` rule gets the dialog **even inside a
trusted repo**, because its own key is untrusted. The committed `.claude/settings.json` of any
repo that ships permission rules lands in every fresh worktree by definition — it is tracked
content. A manifest `seed.copy: ['.claude/settings.local.json']` produces the same effect for the
untracked half.

This repo happens to dodge it: `.claude/settings.json` carries only `enabledPlugins`, and
`.claude/settings.local.json` (which does carry ~20 `permissions.allow` rules) is untracked and
not seeded by `WORKTREE.md`. That is luck, not design, and it is why the failure looked
unreproducible.

### 4.3 Where the rule declines

Fresh `/tmp` scratch repos — T174's original reproduction — have **no trusted ancestor and no
parent repo entry**. `create_worktree` is not what creates them either. The rule of this card
(D1) explicitly does nothing there. **T174's reported symptom is therefore _not_ fixed by this
card**; it is T214's to detect and the operator's to accept once. Saying so plainly is part of
the deliverable.

## 5. Decision

### D1 — The rule: inherit, never invent

At the end of a **successful** `create_worktree`, and only there:

```
if trustOf(repoRoot) === true  →  stamp trustOf(target) = true
otherwise                      →  do nothing, silently
```

Three properties, in the order they matter:

1. **Never creates trust.** A `false` or absent parent means Capy writes nothing. The human's
   decision — including a deliberate "no" — is never overridden, never widened, never repaired.
2. **Never widens scope.** Only the one directory Capy just created is stamped. No ancestor, no
   sibling, no repo root, no `/`.
3. **Only for directories Capy created.** `adopt_folder`, pinned folders, `add_folder`, and every
   path the human chose by hand are out of scope — the card's own 2026-07-21 operator scope
   decision, unchanged.

`hasTrustDialogAccepted` is the **only** key ever written. Never `allowedTools`, never
`hasCompletedProjectOnboarding`, never a `permissions` subtree. Note the CLI's own accept path
(`U0t`) spreads its full default template `got` when creating an entry; Capy must **not**
replicate that — write the bare `{ hasTrustDialogAccepted: true }` the runner seeder writes (§3).

### D2 — Modules: pure core + thin shell (ADR-0001)

- `src/main/claude-trust-core.ts` — **pure**. `trustKeyFor(path)` (the
  `path.normalize(path.resolve(p))` mirror of `wW`, §2.3); `readTrust(config, key)`;
  `decideTrustInheritance({ parentTrust, childTrust })` → `'stamp' | 'skip-parent-untrusted' |
'skip-already-trusted' | 'skip-unreadable'`; `applyTrustStamp(config, key)` returning a **new**
  object that differs from the input by exactly one boolean, or the input itself when nothing
  changes. Fully unit-testable, no fs.
- `src/main/claude-trust.ts` — **shell**. Path resolution (T209), the cross-process lock (D4),
  the read/parse/guard/write, and the structured result the caller logs.

Both are new top-level files under `src/main/`, which trips `scripts/ci/user-docs-gate.mjs`
(rule 2, `user-docs-gate-core.mjs:15-18`) — see §10.

### D3 — Where it runs: after adopt, inside the create, never as a bring-up step

Call site: `worktree-ipc.ts`, immediately **after** `adoptFolder` returns at `:1377-1384` and
before the return at `:1391`. Three reasons, all load-bearing:

- **After every rollback path.** `rollbackWorktree` fires from the seed/setup catch (`:1341`) and
  the adopt catch (`:1382`) and deletes the checkout _and_ the branch. Stamping earlier would
  leave a trust entry pointing at a directory that no longer exists — the very kind of orphan
  state this file must not accumulate.
- **Before any session can spawn.** `create_worktree` and `create_session` are separate verbs;
  the stamp lands long before a PTY exists. It is also picked up by an already-running CLI,
  which watches the config for mtime changes (`JES`, §2.3).
- **Not a T210 `steps:` entry.** T210 moves _runtime bring-up_ into a resumable pipeline and
  explicitly keeps creation transactional and all-or-nothing. A trust stamp is a create-time
  fact about the directory, not a bring-up command; it must not inherit `steps:`'s
  halt-and-resume semantics, and it must not become skippable.

Failure of the stamp **never fails the create**. `createWorktree` already returned a usable
worktree; the worst case is the pre-existing behaviour (the operator accepts a dialog once). Wrap
the call so no exception can escape, and record the outcome.

### D4 — The write: the CLI's own lock protocol, or nothing

The CLI serializes its config writes with `proper-lockfile` — `Q_(e, {lockfilePath:
`${e}.lock`, onCompromised})` — at library defaults (`stale: 10000`, `update: 5000`,
`retries: 0`, `realpath: true`). Capy must take **that same lock, with that same
`lockfilePath`**, or the write is a coin flip.

**Add `proper-lockfile` as a main-process dependency.** It is pure JS (no native build, so
`electron-builder install-app-deps` is unaffected) and it is the only way to be
protocol-compatible; a hand-rolled `mkdir`-and-mtime reimplementation of another process's lock
protocol is the wrong place to save a dependency.

```ts
const release = await lock(configPath, {
  lockfilePath: `${configPath}.lock`, // byte-identical to the CLI's
  realpath: true, // the CLI's default
  stale: 10_000, // the CLI's default — do not diverge
  update: 5_000,
  retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
  onCompromised: (e) => {
    /* log; abandon the write, never force */
  }
})
```

**The critical section is a hard constraint, not a guideline.** The CLI acquires with
`retries: 0`: if it finds our lock held it fails immediately and falls into its error path.
So Capy's hold must be a bounded read → parse → mutate → write, single-digit milliseconds, with
**no git subprocess, no network, no `await` on anything but fs inside it**. Resolve `repoRoot`,
read the parent's trust, and compute the decision **before** acquiring.

Two facts that materially lower the residual risk, both verified:

- The CLI **re-reads the file under its own lock** and merges: `KES` computes
  `{...a, projects: JPn(s.projects, a.projects)}` against the fresh on-disk read `s`, and
  `JPn(e,t)` copies every key present in `e` but absent from `t` into the result. A key that
  exists only on disk — exactly our freshly-stamped worktree — **survives** a concurrent CLI
  write to any other project.
- Failure to acquire is **not** an error condition for Capy. `ELOCKED` after retries → skip the
  stamp, log it, return `'skipped-locked'`. There is nothing to escalate: the fallback is the
  status quo.

### D5 — Fail safe: eight rules, and "write nothing" is always a valid outcome

`~/.claude.json` is the CLI's **private state file**. It is undocumented, versionless, holds
`oauthAccount` and ~109 unrelated top-level keys, and its shape can change in any patch release
without notice — 2.1.226 alone is 33 releases past the version Capy's teammate contract was
captured on (BUG-83 §2.1). Capy therefore treats every read as untrusted input and every
unexpected shape as a **reason to write nothing**, never as a reason to normalize, repair, or
reconstruct. Capy touches exactly one leaf and asserts nothing about the rest of the document.
Corrupting this file logs the user out and loses their per-project MCP config; the cost of a bad
write is far above the benefit of a successful one, and the rules below are priced accordingly.

| #   | Condition                                                                                  | Behaviour                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Config file missing (ENOENT)                                                               | **Do nothing.** No parent entry exists → the rule declines anyway. Never create the CLI's config file.                                                                                                                   |
| 2   | File exists, non-empty, does not parse as JSON                                             | **Abort, write nothing.** Mirrors `ClaudeSettingsCorruptError` (`claude-settings.ts:154-159`, thrown at `:189-199`) — the guard that exists because a naive overwrite once truncated `settings.json` from 9 KB to 162 B. |
| 3   | Parses, but not a plain object (array/scalar/null)                                         | **Abort.**                                                                                                                                                                                                               |
| 4   | No `projects` key, or `projects` is not a plain object                                     | **Abort.** Do not create the map: with no map there is no parent entry, so the rule already declines.                                                                                                                    |
| 5   | Parent entry absent, or `hasTrustDialogAccepted !== true` (strict `===`, never truthiness) | **Do nothing.** This is D1.                                                                                                                                                                                              |
| 6   | Child key already `true`                                                                   | **Do nothing.** No write at all — a no-op must not touch mtime, because the CLI watches it.                                                                                                                              |
| 7   | Child key exists with other fields                                                         | **Merge the one boolean.** Never replace the entry, never reorder keys, never inject `got`'s template fields.                                                                                                            |
| 8   | Any unexpected shape below `projects` (entry is not an object)                             | **Abort.**                                                                                                                                                                                                               |

Serialization must be byte-compatible with what the CLI writes, verified against the live file:
**2-space indent, no trailing newline, mode `0600`.**

> **Do not reuse `updateClaudeSettings` verbatim.** `claude-settings.ts`'s helper is the right
> _shape_ (lock → guarded read → backup → atomic rename) and its `path` parameter already makes it
> reusable, but two of its concretions are wrong for this file: `serialize()` appends `'\n'`
> (`:125-127`) and `atomicWrite` writes at the default umask mode (`:130-140`), i.e. `0644`.
> `~/.claude.json` is `0600` and holds `oauthAccount` — **widening it to 0644 would expose the
> user's OAuth material to every account on the machine.** Either parameterize
> `{ trailingNewline, mode }` on the existing helper, or write a sibling in `claude-trust.ts`.
> Whichever is chosen, the choice must be a test, not a comment.

Keep the `.backup` sidecar (`claude-settings.ts:202`) — same argument as the original: it costs
one write and is the only recovery path if a shape assumption turns out wrong in the field.
The backup inherits the same `0600` requirement.

### D6 — Observability: a `warnings[]` entry, and nothing new on the wire

`createWorktree`'s result already carries `warnings: string[]`, and the MCP ACK already forwards
it (`tool-handlers.ts:825-827`). When the parent is trusted and the child is **not** stamped for a
reason the operator can act on — the lock was held, the file was unparseable — push one warning.
When the parent is untrusted, push one **informational** warning naming the parent path, because
that is the case where the next `create_session` into this worktree may sit on a dialog and the
orchestrator should know.

No new ACK field, no `tool-catalog.ts` change, no new UI surface. The structured outcome
(`'stamped' | 'skipped-parent-untrusted' | 'skipped-already-trusted' | 'skipped-locked' |
'skipped-unreadable'`) goes to the main-process log for support.

### D7 — Explicitly out of scope

- Stamping on `adopt_folder` / pinned folders / `add_folder`.
- Stamping any ancestor, or repairing a `false` parent.
- Any change to `agentControlled` (`pty.ts:685-693`) or `forceDowngradePermission`.
- Any settings-file write, any `--dangerously-skip-permissions`, any `permissions.*` key.
- Removing the stamp when a worktree is reaped. (Deliberate: the CLI accumulates entries for dead
  paths already — 84 entries here, several pointing at directories that no longer exist — and a
  delete path is a second write, a second race, and a second way to corrupt the file for zero
  user-visible benefit. Revisit only if the file's growth becomes a real problem.)

### Alternatives rejected

| Option                                                     | Why not                                                                                                                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Do nothing — the ancestor walk covers it**               | Covers the default layout only. §4.1 (manifest `dir:` outside the repo) and §4.2 (settings-gated re-ask) are real, and §2.4 has three on-disk instances of the first. |
| **Stamp the repo root instead of the worktree**            | Inventing trust for a directory Capy did not create, on the human's behalf. Directly violates D1.                                                                     |
| **Set `CLAUDE_CODE_SANDBOXED=1` on the spawn**             | Asserts a sandbox that does not exist, and short-circuits far more than the trust check. A lie to the CLI about its own environment.                                  |
| **Inject trust through the per-session `--settings` blob** | There is no trust setting (§3).                                                                                                                                       |
| **Pre-answer the dialog by writing to the PTY**            | The exact failure BUG-64 part A exists to stop: blind-typing into an unidentified prompt.                                                                             |
| **Hand-rolled lock instead of `proper-lockfile`**          | We must be compatible with another process's protocol, not merely correct in isolation.                                                                               |
| **Fail the create when the stamp fails**                   | Turns a cosmetic degradation into a broken `create_worktree`. The fallback is the status quo.                                                                         |

## 6. Security: the honest argument, and what would make it wrong

**What the control is for.** The workspace-trust dialog exists so that opening a directory does not
silently execute what that directory contains: `.claude/settings.json` hooks and `permissions.allow`
rules, `CLAUDE.md`, skills, MCP server definitions. The threat model is a repository you did not
write — a cloned attack repo, a malicious PR branch, a zip from a stranger.

**Why inheriting is defensible here, stated as a conjunction — all four must hold:**

1. **The directory did not exist until Capy made it.** There is no pre-existing content in it that
   a third party planted; it is `git worktree add` output from a repo the operator already has
   checked out.
2. **Its content is a subset of the parent's, at a ref the parent's own manifest chose.** The base
   is `origin/<default>`, the manifest `from:`, or a caller-supplied ref that already passed
   `validateResolvedBase` (`worktree-core.ts:476`). Trusting the worktree grants nothing the
   parent's own trust did not already grant.
3. **The parent is already trusted — by an explicit human accept.** We copy that decision one hop;
   we never originate one.
4. **The CLI already treats trust as repository-scoped.** Its ancestor walk (§1) makes the
   worktree trusted by construction in the default layout, and its own dialog copy says so:
   _"Accepting trust grants that whole repository — every subdirectory and linked worktree of the
   root."_ The stamp makes an inference the CLI already draws **explicit at the exact key**, so it
   also survives `Mvt()`'s re-ask.

**Where the argument genuinely thins, and what would break it:**

- **A worktree is not always a subset.** A `create_worktree({ ref: … })` that checks out an
  **untrusted remote branch** — a contributor's PR head — puts third-party `.claude/settings.json`
  hooks into a directory we are about to mark trusted. This is the strongest objection to the
  card, and it is not hypothetical: `dispatch-pr-review`, the workflow that motivated BUG-64, cuts
  worktrees at PR head branches. **Mitigation to specify:** the stamp is skipped when
  `ref` is set and resolves to a ref outside the repo's own remote-tracking namespace (i.e. a
  fork/PR head). See **O2** — this is the one open question that should block implementation.
- **`repoRoot` is derived from `git rev-parse` on a caller-supplied `folder`.** A `folder` outside
  any repo degrades to `repoPath` itself (`worktree-ipc.ts:323-325`). An agent that could nominate
  an arbitrary trusted directory as `folder` could steer the parent lookup. Today `folder` is
  allowlist-gated on the MCP side, and this card must not be the thing that relaxes that.
- **"Inherit" is a monotone widening of an allow-set.** Every such rule accretes. If Capy later
  learns to create folders that are _not_ git worktrees of a trusted repo, clause 2 above stops
  holding and this rule must be re-derived, not extended by analogy.

**This would be wrong if:** the operator's mental model of accepting trust is "this directory",
not "this repository". The CLI's own dialog copy says repository (clause 4), and its ancestor walk
enforces repository, so the model is already repository-scoped — but that is Anthropic's UX
choice, not ours, and if they narrow it, this card must be reverted, not patched.

**It is not a bypass.** `--dangerously-skip-permissions` disables the permission prompt for every
tool call; trust decides whether a workspace's own config is honoured at all. Capy's
`agentControlled` policy (`pty.ts:685-693`) — which strips bypass flags and withholds
`--mcp-config` from every MCP-spawned session — is untouched by this card and must stay that way.

## 7. Relationship to T214, and to BUG-64's other parts

**Prevention and detection are different jobs, and this card is only prevention.**

|            | This card (B)                                                     | T214                                                  |
| ---------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| Question   | Can we avoid _causing_ a trust prompt for a directory we created? | Can we _notice_ a session sitting on any boot prompt? |
| Coverage   | Capy-created worktrees with a trusted parent                      | Every blocking prompt, known or not                   |
| Fails when | The parent is untrusted, or a `/tmp` scratch repo (§4.3)          | — (that is the point)                                 |

Landing this does not shrink T214's scope by one line. It removes one **known** cause of one
**known** prompt; T214 exists precisely because Anthropic ships new blocking prompts faster than
Capy ships detectors (2.1.225 is the second in two releases, §2.5). T214's gap analysis should
cite §2.3 of this spec — `src/main/detect/screen-detect.ts` is where the generic signal would
live, and the trust dialog is a concrete fixture for it.

**Part A** (`prompt-inject-gate.ts` requiring positive composer-ready proof) landed, regressed
delivery to 0/9, and was mitigated by deterministic-argv delivery (BUG-66) rather than fixed. Its
root cause — `fire()` tearing down the `onHook` listener on the first non-hook trigger — is
**still live for prompts over 8000 chars**. Untouched here.

**Part C** (stuck-session observability) landed and is confirmed valuable by BUG-66's live re-test.
Untouched here.

## 8. Acceptance

- A worktree created by `create_worktree` under a repo whose exact config key is
  `hasTrustDialogAccepted: true` comes out of the create with its **own** key set to `true`.
- A worktree created under a repo whose key is `false`, absent, or unreadable comes out with
  **no entry written at all**, and the ACK carries one informational warning naming the parent.
- No key other than `projects[<worktree>].hasTrustDialogAccepted` is ever added, changed or
  removed by Capy; every other byte of the config round-trips (`0600`, 2-space, no trailing
  newline).
- A config file that is unparseable, or whose `projects` is not an object, is **never written to**.
- Concurrent writes with a live `claude` are safe: Capy holds the CLI's own
  `<config>.lock`, and a held lock is a skip, not an error.
- A create that fails and rolls back leaves **no** trust entry behind.
- `agentControlled` (`pty.ts:685-693`) and `forceDowngradePermission` are byte-identical.
- No new MCP verb, no `tool-catalog.ts` change, no new ACK field.

**Honest gap.** This machine has `/` and `/home/u` marked trusted (§2.4), so the ancestor
walk makes every path trusted and **the bug cannot be reproduced here**. Validation requires a
throwaway `CLAUDE_CONFIG_DIR` with a hand-authored config containing exactly one trusted repo and
no trusted ancestors — see O1 and the DoD.

## 9. Test plan

| Test                                                                                                                                                                | File                                                                        | Asserts   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------- |
| `decideTrustInheritance`: parent `true` → `stamp`; parent `false`/absent/non-boolean → `skip-parent-untrusted`; child already `true` → `skip-already-trusted`       | **new** `tests/claude-trust-core.test.ts`                                   | D1        |
| `applyTrustStamp` returns the **same object reference** when nothing changes, and otherwise differs by exactly one leaf — key order and every sibling key preserved | **new** `tests/claude-trust-core.test.ts`                                   | D5 #6, #7 |
| `trustKeyFor` mirrors `wW`: `path.normalize(path.resolve(p))`, trailing separator stripped, no realpath                                                             | **new** `tests/claude-trust-core.test.ts`                                   | §2.3      |
| Unparseable / array / scalar config → **no write**, original bytes intact                                                                                           | **new** `tests/claude-trust-write.test.ts`                                  | D5 #2, #3 |
| Missing `projects`, or `projects` not an object → no write, no map created                                                                                          | **new** `tests/claude-trust-write.test.ts`                                  | D5 #4     |
| Round-trip byte-stability: 2-space, **no** trailing newline, mode `0600` on the file **and** the `.backup`                                                          | **new** `tests/claude-trust-write.test.ts`                                  | D5        |
| Held `<config>.lock` → `skipped-locked`, no write, no throw                                                                                                         | **new** `tests/claude-trust-write.test.ts`                                  | D4        |
| A concurrent unrelated mutation of another `projects` key does not lose the stamp (simulates `JPn`)                                                                 | **new** `tests/claude-trust-write.test.ts`                                  | D4        |
| Existing hardened-settings behaviour unchanged if `updateClaudeSettings` is parameterized rather than duplicated                                                    | `tests/claude-settings-write.test.ts` (existing)                            | D5 note   |
| `createWorktree` stamps after a successful adopt, and **not** when seed/setup or adopt rolled back                                                                  | `tests/worktree-adopt.test.ts` (existing)                                   | D3        |
| A stamp failure does not fail the create — `createWorktree` still resolves with the path                                                                            | `tests/worktree-adopt.test.ts` (existing)                                   | D3        |
| Parent-untrusted create emits exactly one warning naming the parent; already-trusted emits none                                                                     | `tests/worktree-provision-error-ack.test.ts` (existing)                     | D6        |
| `.claude/worktrees/<slug>` containment still enforced; a manifest `dir` outside the repo still resolves (the §4.1 case the stamp exists for)                        | `tests/worktree-path.test.ts`, `tests/worktree-manifest.test.ts` (existing) | §4.1      |

**Live validation (not a unit test — record the log in the PR).** With
`CLAUDE_CONFIG_DIR=/tmp/capy-trust-probe` and a config containing one repo at `true` and no
trusted ancestors: (a) default layout → confirm the worktree boots with no dialog **before** the
fix, proving the ancestor walk; (b) manifest `dir: ../probe-worktrees/{slug}` → confirm the dialog
**before** and its absence **after**; (c) a committed `.claude/settings.json` with a
`permissions.allow` rule in the default layout → confirm the §4.2 re-ask before and its absence
after. (c) is the case that proves the stamp is not a no-op.

## 10. Contracts touched

- **`CHANGELOG.md` — YES.** `### Fixed`: a worktree Capy creates inside a repo you already
  trusted no longer asks you to trust it again; Capy never marks anything trusted that you did
  not already trust.
- **`docs/capy-features.md` — NO, and no marker bump.** `tool-catalog.ts` is untouched, no ACK
  field is added (the warning rides existing `warnings[]`, `tool-handlers.ts:825-827`), no
  grant/confirm semantics change, and there is no affordance the agent should offer. By the
  CLAUDE.md litmus this is out. **If** implementation instead adds a `trust` field to the ACK,
  it becomes agent-facing and the doc + marker bump (`v34` → `v35`) are mandatory — decide once
  and record it in the PR.
- **`docs/user/` — YES, and the gate will fire.** Two new top-level `src/main/` files trip rule 2
  of `scripts/ci/user-docs-gate-core.mjs:15-18`. Update `docs/user/folders-and-worktrees.md`
  (what Capy does and pointedly does not do with Claude Code's trust state) and
  `docs/user/troubleshooting.md` ("Claude asks me to trust a worktree" — why, and that Capy
  declines to answer it for you when the parent is untrusted).
- **`design.md` — NO.** No new visual entity; the warning reuses the existing ACK/toast surfaces.
- **i18n — only if a renderer string is added.** The D6 warning is an ACK string, not a UI label.
  If the New-worktree dialog ever surfaces it, `en.json` **and** `pt-BR.json` in the same change.
- **`package.json` — YES.** `proper-lockfile` as a runtime dependency (D4), plus
  `@types/proper-lockfile` as a dev dependency. Pure JS — `electron-builder install-app-deps` is
  unaffected.
- **English-only — YES**, whole change.

## 11. Open questions

- **O1 (blocker — settle first).** Confirm on a machine where `/` and `$HOME` are **not**
  trusted that a default-layout worktree really is dialog-free by ancestry, and that the §4.2
  settings-gated re-ask really fires. Everything in §4 rests on decompiled control flow; a
  throwaway `CLAUDE_CONFIG_DIR` makes it observable. If §4.2 does not reproduce, this card
  narrows to §4.1 alone and is worth much less.
- **O2 (blocker — security).** Should the stamp be skipped for `create_worktree({ ref })` when
  `ref` is a fork/PR head (§6)? The honest default is **yes, skip** — but it directly weakens the
  `dispatch-pr-review` workflow that motivated BUG-64, so it is an operator decision, not an
  implementer's. Resolve before writing code.
- **O3.** `JPn`'s merge is key-level: a key present on disk but absent from the CLI's in-memory
  mutation survives. Confirm empirically that a CLI process which has **already seen** the
  worktree path in its in-memory `projects` does not overwrite our stamp on its next write.
- **O4.** The CLI's runner seeder writes NFC-normalized spellings alongside the plain ones (§3).
  Is that macOS-only defensiveness (APFS/HFS+ Unicode normalization), and should Capy stamp an
  NFC variant on darwin? Costs one extra key; prevents a silent miss on a path with combining
  characters.
- **O5.** The CLI keys off `$n()` (`originalCwd`), which is seeded from the process cwd. On POSIX
  `process.cwd()` is symlink-resolved, so a repo reached through a symlink yields a **realpath**
  key while `trustKeyFor` yields the un-resolved one. Confirm, and if it diverges, stamp both
  spellings (the runner seeder already does exactly this).
- **O6.** `jv()` prefers `<claude-dir>/.config.json` when it exists, and appends an OAuth-env
  suffix otherwise (§2.3). T209's resolver must model **both** or Capy will stamp a file the CLI
  does not read. Does T209's current spec cover the `.config.json` precedence? If not, it needs
  one line.
- **O7.** Should a Reaper sweep remove the stamp for a worktree it deletes? D7 says no; revisit
  only with evidence that the config's growth is a real problem.

## 12. Definition of done

- [ ] O1 answered with a live capture under a throwaway `CLAUDE_CONFIG_DIR`, logged in the PR
- [ ] O2 decided by the operator and the decision recorded in the spec before code is written
- [ ] T209 landed (or its resolver stubbed) so the config path honours `CLAUDE_CONFIG_DIR`, the
      OAuth-env suffix, and the `.config.json` precedence — O6
- [ ] `src/main/claude-trust-core.ts` (pure) + `src/main/claude-trust.ts` (shell), per D2
- [ ] `proper-lockfile` + `@types/proper-lockfile` added; the lock uses the CLI's exact
      `lockfilePath` and defaults, and the critical section contains no subprocess/network await
- [ ] All eight D5 fail-safe rules implemented, each with a test
- [ ] Write is `0600`, 2-space, **no** trailing newline; `.backup` sidecar also `0600`
- [ ] `updateClaudeSettings` either parameterized (`{ trailingNewline, mode }`) or deliberately
      not reused — with a test proving `~/.claude/settings.json`'s behaviour is unchanged
- [ ] Call site after `adoptFolder` (`worktree-ipc.ts:1377-1384`), non-fatal, never before a
      rollback path
- [ ] `warnings[]` entry per D6; **no** new ACK field, `tool-catalog.ts` untouched
- [ ] `pty.ts:685-693` and `forceDowngradePermission` verified byte-identical
- [ ] Tests in §9 green, including the two new files
- [ ] Live validation (a)/(b)/(c) from §9 recorded in the PR
- [ ] `CHANGELOG.md`, `docs/user/folders-and-worktrees.md`, `docs/user/troubleshooting.md`
- [ ] `npm run typecheck` and `npm run build` pass
