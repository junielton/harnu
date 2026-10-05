# ADR-0008 — The typed handoff is derived boot state, not a memory tier

**Status:** Proposed
**Date:** 2026-08-02
**Author:** Claude (drafting), from the T79 memory contract and the T55 boot-preamble design
**Deciders:** operator (this ADR is not accepted until read)
**Technical context:** `src/main/memory-digest.ts`, `src/main/capy-features.ts`, `src/main/claude-args.ts`, `.capy/memory/`

> Related: [`docs/specs/2026-08-02-t195-precompact-consolidation-handoff.md`](../specs/2026-08-02-t195-precompact-consolidation-handoff.md)
> · card `T195-consolidate-on-precompact-auto-inject-a-typed-handoff-at`

---

## 1. Context

T195 introduces a **typed handoff** — `next steps` / `open questions` / `failed
approaches` — written when a session consolidates and injected into the next
session's boot preamble. The idea is borrowed from
[ai-memory](https://github.com/akitaonrails/ai-memory), where a `SessionStart` hook
prepends a typed handoff before the first prompt.

Capy's memory already has four tiers with different contracts: `hot.md` (single
mutable snapshot, ≤500 words, auto-applied since digest v2), `decisions.md`
(append-only, curated, durable), `roadmap/` (one file per card, status-bearing,
board-owned), `sessions/` (episodic digests, evidence-gated), `archive/` (frozen).

Adding a fifth artifact forces a question the memory layer has answered consistently
so far and should not answer differently by accident: **is the handoff authored data
or derived data?**

The distinction is not academic. It decides:

- whether deleting it is data loss or a no-op;
- whether it is git-committed with the repo;
- whether a human is expected to maintain it;
- whether a wrong handoff must be corrected by hand or simply regenerated;
- whether it can accumulate per-session history, or must stay a single page.

## 2. Decision

**The handoff is derived state.** Concretely:

1. **Regenerable.** It is a projection of the digests + transcript truth + git
   evidence that produced it. Delete `handoff.md` and the next consolidation
   recreates it. No human ever has to write one.
2. **Single mutable page**, not a per-session series. History already lives in
   `sessions/` — the handoff is the _current_ frontier, and a series would duplicate
   the digest tier while inviting the same unbounded growth T193 exists to fix.
3. **Never curated.** No approval gate (consistent with digest v2), no expectation
   that the operator edits it. If it is wrong, the fix is a better consolidation or
   `memory_feedback` (T193), not hand-editing.
4. **Lower authority than `decisions.md`.** It is the most recent, most automated,
   least reviewed page in the memory. Under T194's tiering it ranks accordingly.
5. **Fenced and labeled as untrusted at the injection point.** It enters a system
   prompt while being model-authored text — the single highest-risk path in the
   memory design. The boot block states that it is CONTEXT, not instructions, in
   Capy's own voice, outside the quoted content.

### Rejected alternatives

**A — Handoff as a new curated tier (`handoff/` directory, one per session).**
Rejected: duplicates `sessions/`, grows without bound (the exact pathology T193 was
written to solve at 432 digests), and implies human maintenance nobody will do.

**B — No separate artifact; extend `hot.md` with typed sections.** Tempting, and
close to right. Rejected for v1 because `hot.md` has a live human contract — the
folder-hover preview (`extractHotPreview`) renders its first lines, and operators
read it as prose. Bolting machine-typed sections onto it changes a surface people
already use. **Revisit after T195 ships:** if the two pages prove hard to keep
consistent, the correct convergence is to derive `hot` _from_ `handoff`, not to
maintain two authors. This ADR should be superseded, not worked around, if that
happens.

**C — Inject `hot.md` itself at boot, no new artifact.** Rejected: `hot` is prose for
humans with no guaranteed structure; a boot payload needs fixed sections so it can be
bounded, and so the next session can tell "next steps" from "what happened".

## 3. Consequences

**Positive**

- `.capy/memory/handoff.md` can be gitignored or committed, and either choice is
  cheap — nothing depends on its history.
- A bad handoff is self-healing: the next consolidation overwrites it.
- No new maintenance burden on the operator, consistent with the zero-friction
  principle (human gates only at execute/accept doors).

**Negative / accepted costs**

- Losing per-session handoff history. Accepted: `sessions/` already holds it, and the
  handoff is explicitly the frontier, not the record.
- A single mutable page across concurrent worktrees means the last consolidation
  wins. This is the same shape as `hot.md` and is handled the same way (serialized
  writer, provenance stamped with branch + session). If it becomes a real problem,
  the fix is per-branch handoffs — which is a change to _keying_, not to this ADR's
  derived-state decision.
- Injecting model-authored text into a system prompt is a real injection surface. The
  fence + label mitigate; they do not eliminate. Anything that later lets a handoff
  carry directives (unfenced, unlabeled, or presented as Capy's voice) must be
  treated as a security regression.

## 4. Open

Whether `handoff.md` is committed or ignored by default in a repo's `.gitignore`.
Committing makes it visible in review and shareable across machines; ignoring keeps a
churning machine artifact out of diffs. Leaning ignore-by-default, but this is the
operator's call and does not block implementation.
