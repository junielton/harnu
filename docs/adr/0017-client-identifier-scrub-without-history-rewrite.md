# ADR-0017 — Client identifiers are scrubbed from `HEAD`; the history rewrite is deferred to the operator

> **Superseded (2026-10-05).** The deferred history rewrite was resolved the other way:
> the project moved to a fresh public repository with no prior history, so none of the
> commits this ADR describes were published. The confidentiality gate it introduced still
> runs, now with a local denylist layer for bare names. This record was renumbered from
> 0012, which another ADR also used.

**Status:** Proposed
**Date:** 2026-08-28
**Author:** agent (T253)
**Deciders:** operator (this ADR is not accepted until read — and D2 is not merely "accepted", it is a decision only the operator can take)
**Technical context:** `CLAUDE.md` § "Client confidentiality" / § "Language policy", `tests/no-client-identifiers.test.ts`, the whole tracked tree

---

## 1. Context

`CLAUDE.md` opens by declaring Capy open source, and the English-lingua-franca
section states the reason plainly: the codebase must be legible to an outside
contributor. Two contracts already follow from that (Changelog, user docs). A
third obligation was never written down and was therefore never met.

Capy's specs are written from **live evidence** — measured worktree counts, real
branch names, real PR numbers, real `gh` output pasted verbatim. That discipline
is the reason the specs are good, and it is also exactly how client data got in:
the machine those measurements were taken on is a work machine, and the corpus
being measured was a client repo.

Measured on `main` on 2026-08-28:

| Surface                                    | Count                      |
| ------------------------------------------ | -------------------------- |
| Tracked files carrying a client identifier | **28**                     |
| Commits introducing or touching one        | **40** (of 1163 on `main`) |
| Span of those commits                      | 2026-05-26 → 2026-08-23    |
| Repository visibility today                | **private**, 0 forks       |

The identifiers fall into four grades, weakest first:

1. **Tracker keys** — a client tracker prefix plus a number, usually carrying a
   branch slug (`XYZ-347-wave-2`). Two distinct clients' prefixes appeared. Weak
   alone, but they reached `src/renderer/src/lib/branch-slug.ts` (product source)
   and four shipped test files as fixture data, which is the sharpest form:
   identifiers a contributor would run in CI.
2. **Repo and org paths** (`~/Workspace/<employer>/<client>/www`, and its
   `-home-…-Workspace-…` slug form) — these disclose the employer, the client,
   and the on-disk layout of a private engagement in one string.
3. **The clients' own names** — one as a CamelCase repo-group label that also
   decoded its own tracker prefix retroactively, one in running prose across three
   specs ("the <client> manifest", "<client> has `bin/worktree/worktree.mjs`").
   This grade is the reason the guard test below is shape-based: a denylist would
   have had to write these names back into the tree to match them.
4. **Client stack detail** — a database name in a `migrate:fresh --seed` example,
   sibling repo names under a shared org directory.

No client hostnames, IPs, credentials, tracker workspace ids or customer data
were found; the leak is naming and layout, not secrets.

## 2. Decision

**D1 — Scrub the tracked tree, preserving the shape of every worked example.**
Replace each identifier with a stable neutral vocabulary (`PROJ-231`, `Acme`,
`ProjectAlpha`, `~/Workspace/org/…`), documented in `CLAUDE.md` so the next spec
reaches for it by default. Real commit SHAs, PR numbers and measured counts are
**kept**: once the branch names around them are neutral they identify nothing,
and dropping them would turn honest measurements into invented ones. Test
fixtures are renamed, never deleted or loosened — every assertion that used a
client identifier asserts the same behaviour under a neutral one.

**D2 — Do not rewrite history in this change. Record the recommendation and
leave the decision to the operator.**

The recommendation, stated plainly: **rewrite it, and do it before the repository
goes public.** A public repository with identifiers in its history is only
marginally better than one with them in `HEAD` — `git log -S`, the GitHub commit
API, and every mirror and fork resolve them in seconds, and unlike a working-tree
leak it cannot be fixed later. This ADR does not pretend D1 alone closes the
exposure.

What makes the recommendation actionable rather than theoretical is the timing:
**the repository is still private and has zero forks.** The usual objection to a
rewrite — coordinating with everyone holding a clone — costs approximately
nothing today and rises permanently the moment the repo is published. The cheap
window is open now and closes once.

## 3. Alternatives considered

**A. Rewrite history in this session.** Rejected on process, not on merit. A
rewrite of 40 commits across a 1163-commit history invalidates every outstanding
branch and PR — two sibling units were mid-flight in parallel worktrees while
this was written — and it is not an agent's call to make unilaterally. The
operator must choose the moment.

**B. Scrub `HEAD` and consider the matter closed.** Rejected as dishonest. It
would leave `CLAUDE.md` asserting a confidentiality contract that the repository's
own history violates, with nothing recording that anyone noticed.

**C. Leave the identifiers and rely on the repo staying private.** Rejected: the
open-source declaration in `CLAUDE.md` is the stated direction, and the leak grows
with every spec written from live evidence until a convention exists to stop it.

**D. Flatten worked examples to `foo`/`bar`.** Rejected. The value of these specs
is the _shape_ of the example — a branch stacked on a branch, two branches sharing
one upstream, a 47-worktree corpus. Anonymising the shape away would satisfy a
grep and destroy the documents.

## 4. Consequences

**Good**

- The tracked tree is clean, and `tests/no-client-identifiers.test.ts` keeps it
  clean: it `git grep`s the tracked tree for the _shape_ of an identifier and fails
  CI on a new one, whether or not that client has ever been seen here.
  Its negative control was verified — reintroducing an identifier fails the suite.
  The sweep is binary-safe (`--text`, not `-I`): a stray NUL byte anywhere in a source
  file makes git classify the whole file as binary, and `-I` skips it wholesale. That
  is not theoretical — `tests/branch-slug.test.ts` carries a deliberate NUL slugify
  fixture, and it rode a client ticket key and its full title straight through the
  first pass of this scrub with every gate green. True binary assets are excluded by
  extension instead, so a text file git mislabels stays in scope.
- `CLAUDE.md` now carries the convention, so the next spec written from live
  evidence has a vocabulary to reach for instead of inventing one per document.
- The specs remain readable. Every worked example kept its structure.

**Bad / accepted**

- **The history is still exposed.** 40 commits, addressable by anyone with read
  access the day the repo is published. This ADR is the record that the risk was
  measured and consciously carried, not overlooked.
- The guard test matches _shapes_, not names, so it does catch an unseen client's
  first appearance — but a shape gate is only as good as its shapes. An identifier
  that looks like nothing it models (a bare client name in running prose, with no
  tracker key or `Workspace/` path around it) still passes. `CLAUDE.md`'s prohibition
  on client names is a convention, not an enforcement, and cannot become one without
  writing those names into the tree.
- **The residual class, stated explicitly: a bare tracker prefix carrying no digits.**
  Both key gates anchor on `-[0-9]{2,6}`, so `PROJ-231` is caught and a bare `PROJ`
  in prose — "§1 of the PROJ manifest" — is not. This was found for real: the T253
  scrub converted five of six occurrences in
  `docs/specs/T210-worktree-steps-pipeline.md` and the sixth, a digitless prefix,
  survived because nothing could see it.
  Dropping the digit anchor was considered and **rejected**. A two-to-six letter
  uppercase token with no digits matches ordinary prose and acronyms everywhere, and
  under the `--text` sweep it also matches byte noise inside binary assets — a probe
  for one such bare prefix returned hits in roughly twenty tracked PNG and font files.
  The narrow alternative — a word-boundary check against an explicit list of known
  client prefixes — is self-defeating for the same reason a name denylist is: it would
  have to spell those prefixes out in the tracked tree, which is the thing this whole
  change exists to prevent.
  So the digit anchor stays, and this class is carried by convention and review, not
  by CI. It is recorded here rather than left unstated so the next person to widen the
  gate knows the tradeoff was made deliberately.
- Neutral vocabulary drifts if future specs invent their own. The `CLAUDE.md`
  table is the mitigation.

## 5. If the operator accepts the rewrite

Not performed here; recorded so the cost is visible rather than estimated later.

1. Best tool is `git filter-repo --replace-text` with a rules file mapping each
   real identifier to its neutral form — the same map as `CLAUDE.md`'s table. It
   rewrites every blob, so the scrub is uniform across all 1163 commits rather
   than only the 40 that introduced the strings.
2. Every commit SHA from the first rewritten commit (2026-05-26) forward changes.
   Every open PR must be re-based or re-opened; every existing clone must
   re-clone, not pull.
3. Cross-references _inside_ the repo that cite a commit SHA break silently. A
   `git grep -E '\b[0-9a-f]{7,40}\b'` over `docs/**` before and after is the check.
4. Do it while the repo is private and unforked. Afterwards, a force-push to a
   public GitHub repo does not remove the old objects from GitHub's cache or from
   forks; that is the asymmetry this ADR is warning about.
