---
name: local-ci
description: Use before pushing a branch or opening/updating a PR in this repo, when you need to know whether GitHub Actions will go green — it runs the same gates as the CI `verify` job locally (format:check, i18n parity, the CHANGELOG/self-awareness/user-docs contract gates, typecheck, lint, test:coverage). Also use when CI is unavailable (billing block, offline, rate limits) and a merge decision still has to be made, or when you want to fix every gate failure in one pass instead of one push per red check. Do NOT use as a substitute for the real CI on a PR that CAN run CI — it does not run the production build or the e2e job unless you pass --with-e2e.
---

# Local CI

`scripts/ci/local-pipeline.sh` mirrors the `verify` job in
`.github/workflows/ci.yml` — same steps, same commands, same order. A green run
means the same thing a green `verify` means, with the exceptions listed under
**Fidelity gaps** below. Read those before you tell anyone a branch is safe.

## Run it

```bash
scripts/ci/local-pipeline.sh                      # full verify parity
scripts/ci/local-pipeline.sh --fast               # skips coverage thresholds
scripts/ci/local-pipeline.sh --with-e2e           # + build + headless e2e job
scripts/ci/local-pipeline.sh --with-cli           # + real-`claude` suites (tests/cli), needs `claude`
scripts/ci/local-pipeline.sh --base origin/main --labels no-user-docs
scripts/ci/local-pipeline.sh --json /tmp/ci.json  # machine-readable summary
```

It prints one ✅/❌/⏭️ line per gate with a duration and a log path, and exits
non-zero if anything failed. It does **not** stop at the first failure — that is
deliberate: the whole point of running locally is to collect every problem in
one pass instead of burning a push-and-wait cycle per gate.

Requires `origin/main` to exist locally — the three contract gates diff against
it. Run `git fetch origin main` first if the ref is stale, or the gates will
judge your diff against an old base and give you a wrong answer.

## What it actually checks

| Step        | Command                              | What red means                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`    | `npm run format:check`               | Prettier drift. Fix with `npm run format`.                                                                                                                                                                                                                                         |
| `i18n`      | `node scripts/ci/i18n-parity.mjs`    | A key exists in `en.json` but not `pt-BR.json` (or vice versa). The script names the missing keys per file.                                                                                                                                                                        |
| `changelog` | `node scripts/ci/changelog-gate.mjs` | Behavior changed without a `CHANGELOG.md` entry.                                                                                                                                                                                                                                   |
| `awareness` | `node scripts/ci/awareness-gate.mjs` | Agent-facing surface changed without updating `docs/harnu-features.md` + its version marker.                                                                                                                                                                                       |
| `user-docs` | `node scripts/ci/user-docs-gate.mjs` | New component / main-process file / MCP verb without a `docs/user/` update.                                                                                                                                                                                                        |
| `typecheck` | `npm run typecheck`                  | `tsc` (node) or `vue-tsc` (web).                                                                                                                                                                                                                                                   |
| `lint`      | `npm run lint`                       | ESLint.                                                                                                                                                                                                                                                                            |
| `mod`       | `node scripts/ci/mod-step.mjs`       | The companion mod (T389): `claude plugin validate --strict` + `claude plugin test` in a temp copy. Needs `claude` >= 2.1.287; a missing or old CLI is a **failure**, `--skip mod` records `skipped`, and `blocked-by-policy` (managed settings turned hook modules off) fails too. |
| `test`      | `npm run test:coverage`              | Vitest, **with coverage thresholds enforced** per `vitest.config.mts`.                                                                                                                                                                                                             |

`--with-cli` adds a `cli` step (`tests/cli`: the real `claude` against the companion skeleton in a
hermetic temp HOME, zero model calls); its log starts with `claude --version`.

The three contract gates run _before_ the slow steps on purpose — a missing
CHANGELOG entry should cost 2 seconds, not 4 minutes.

Gate escape labels (`no-awareness`, `no-user-docs`, …) only apply if you pass
them: `--labels no-user-docs`. Pass the labels the PR actually carries, or a
gate that GitHub will skip fails here and you'll "fix" something that was never
broken.

## Fidelity gaps — say these out loud, don't imply parity you don't have

1. **No production build.** CI's `verify` ends with `npm run build`. This script
   stops at tests. `npm run build` = `typecheck` + `electron-vite build`, so the
   typecheck half _is_ covered; a bundler-only failure is not.
2. **No e2e unless asked.** The `e2e` job builds and runs headless Electron under
   xvfb. `--with-e2e` does both (it must build first — e2e loads `out/`), and it
   is slow. Without the flag, e2e is completely unverified.
3. **Dirty `node_modules`.** CI does a clean `npm ci` on a fresh checkout. This
   reuses whatever is installed. A missing/stale dependency or a lockfile out of
   sync with `package.json` will pass here and fail there. If a green local run
   is followed by a red CI install step, this is the first thing to check.
4. **Ubuntu-only runner.** CI is `ubuntu-latest`. Anything platform-sensitive
   behaves as your machine behaves.

## Using it inside a ship / merge loop

Run it after every rebase and after every fix, before pushing. Treat a red step
as blocking and fix it locally — pushing to discover the same failure wastes a
full CI cycle and, when the runner is unavailable, tells you nothing at all.

When the real CI **can** run, it is still the authority: get this green first,
push, then wait for `gh pr checks` before merging. When the real CI **cannot**
run (billing block, outage), this script plus `--with-e2e` is the strongest
signal available — report it as exactly that, naming the gaps above, never as
"CI passed".
