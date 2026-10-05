# T218 — Canvas pane: the mockup stops being a picture

**Status:** PRD v1 (2026-08-23) · **Effort:** L · **Card:** `T218-canvas-pane-infinite-whiteboard-where-agent-deliverables-land` (feature, complex, substrate `worktree`)
**Spec:** [`docs/specs/2026-08-23-t218-canvas-pane.md`](../specs/2026-08-23-t218-canvas-pane.md) — the mechanics
**Delivery plan:** [`docs/plans/2026-08-23-t218-canvas-pane-delivery.md`](../plans/2026-08-23-t218-canvas-pane-delivery.md)
**Related:** T74 (Markdown pane — the read-only viewer this replaces for visual deliverables) · T198 (PR Stack Canvas)

> This PRD states **what problem this solves, for whom, what is out of scope, and how we
> will know it worked.** Every "how" question — file format, substrate, verb shape, Save
> semantics — is answered in the spec, and the spec is the document an implementer reads.

---

## 1. The problem

Capy already lets an agent hand a finished artifact to the operator: `open_file` opens it
in a viewer pane, in the background, without making them leave the app. For a report or a
drafted message that is exactly right — the operator reads it, copies it, moves on.

For a **visual**, it is a dead end. A mockup PNG, a rendered HTML page, an architecture
diagram lands in a read-only pane, and the operator can do precisely one thing with it:
look at it. The motivating screenshot on the card is a daily-budget mockup rendered to PNG
and opened in the viewer — dead pixels in a box.

The moment a mockup is on screen is exactly the moment the operator wants to **point at
it**: circle the wrong number, drag the card somewhere else, drop a note saying "this row
belongs below the hairline". Instead they have to translate a spatial correction into
prose, type it into the terminal, and hope the agent reconstructs what they meant. That
translation is where the review loop leaks — it is slow, it is lossy, and it is the step
that makes people stop asking for mockups at all.

### 1.1 The half of the problem that is easy to miss

Making the picture editable is the obvious half. It is also the half that produces a
**drawing toy**: a canvas the operator scribbles on alone, which the agent cannot see and
therefore cannot act on.

The live loop test recorded on the card proved this concretely. Before the test the
prototype held its state only in the page; the operator pasted an image into their own
browser and the agent — holding a separate page instance — was **not degraded, it was
blind**. A file in the middle was added, and the same agent could then describe the
operator's edits precisely: three nodes deleted, two boxes drawn by hand, an image pasted,
one node moved.

So the product is **the loop**, and the file is the product surface:

> agent draws → operator edits → operator saves → **agent reads the edits back**

Anything that delivers only the first two arrows is a feature Capy already has, with extra
steps.

---

## 2. Who it is for

**Primary: the operator running agents in Capy** — one person, at their desk, reviewing
what an agent produced and correcting it. Their working session is the terminal; the canvas
is a pane beside it, not a place they go to draw. They open it because an agent put
something there, and they leave it as soon as the correction is expressed.

Three concrete moments this is for:

1. **Mockup review.** The agent renders a UI mockup. The operator circles two things, drags
   a row, drops a note, saves. The agent reads the annotations and revises.
2. **Architecture agreement.** The operator asks the agent to draw how a subsystem fits
   together. It is wrong in one place. Rather than describing the correction, they move the
   box and draw the arrow that should have been there.
3. **Thinking out loud with a witness.** The operator sketches a rough shape and asks the
   agent what is missing. The agent can actually read the sketch.

**Not for:** a design team collaborating in real time, a diagram-authoring product, or
anyone who wants a Figma. Those are addressed in §4.

---

## 3. What v1 delivers

A **canvas pane** in Capy's helper stack — a pan/zoom surface backed by one plain JSON file
scoped to one worktree:

- **The agent draws** through an MCP verb, adding and updating nodes and edges
  incrementally. It never wholesale-replaces the document, so it can never erase the
  operator's work without naming it.
- **The operator edits** — drag to create a box, double-click to rename, drag a port to
  draw a bound arrow, select, resize, delete, undo, redo, paste an image.
- **An explicit Save** writes the file. That Save is the handoff: it is what the agent
  reads, and until it happens the operator's work is theirs alone.
- **Every element is stamped** with who created it (agent or operator), which is what turns
  an edit into feedback rather than noise.
- **Agent deliverables land on the canvas** — a generated image becomes an image node; a
  live HTML mockup renders as a registered component in the same document.

Scoped **per worktree**, in a gitignored scratch directory, for the same reason a terminal
is folder-scoped: each branch discusses its own mockup without polluting the others. A
canvas that is itself a deliverable can be explicitly promoted into the repo.

---

## 4. Explicitly out of scope for v1

Each of these was considered and declined, with the reason, so the exclusion is a decision
rather than an oversight.

| Not in v1                                       | Why                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Real-time collaborative editing**             | The two authors are one human and one agent at one desk. A discrete Save (the Claude Design precedent) buys the entire loop and costs one button; live sync buys nothing extra and costs a distributed-systems problem.                                                  |
| **A merge algorithm**                           | Follows from the above. If the operator saves over an agent write, the agent's write is lost — and the agent can trivially redo it, because it knows what it wrote. A structural merge of a two-author graph is a research project.                                      |
| **Freehand ink**                                | Three of the four motivating images are node-and-edge diagrams; the fourth is "put this mockup on the canvas". Freehand serves none of them. Addable later without changing the substrate.                                                                               |
| **Container / frame nodes**                     | Genuinely wanted, but the substrate spike did not exercise them, and containers imply drag-into, drag-out, resize-propagation and delete-cascade semantics. Shipping the least-verified surface inside the most-used unit is how a spike gets wasted. A clean follow-up. |
| **A project-wide shared board**                 | Nobody has asked for one. The per-worktree scratch board is the operator's actual case.                                                                                                                                                                                  |
| **Multi-page canvases**                         | One file, one surface. Pages are an organisational answer to a problem a scratch board does not have.                                                                                                                                                                    |
| **Arbitrary agent-authored HTML on the canvas** | The agent writes a **shape name** from a fixed catalog, never markup. This is a deliberate security posture, not a limitation to lift later — it retires the "arbitrary agent HTML rendering in the app" concern rather than mitigating it.                              |
| **Exporting to PNG/SVG/PDF**                    | The canvas is a working surface, not a publishing target. Nothing in the loop needs an export.                                                                                                                                                                           |
| **Garbage-collecting orphaned image assets**    | The files are small and live in a gitignored directory. A sweep that deletes something the operator can still undo their way back to is a worse bug than the one it fixes.                                                                                               |

---

## 5. How we will know it worked

### 5.1 The one that decides it

**The round trip works in both directions in one sitting.** An agent draws; the operator
edits and saves; the agent reads the result back and correctly describes what changed —
including which elements the human added versus the ones it drew itself.

This is spec AC **U5-7**, it requires a human in the real app, and it is the acceptance
test for the whole epic. If it does not pass, the feature has not shipped no matter how
green the unit tests are.

### 5.2 Supporting signals

| Signal                                          | What good looks like                                                                                                                                    | Where it is verified       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **A correction is faster to draw than to type** | The operator expresses a spatial correction by dragging rather than describing. Judged by use, not measured.                                            | manual, in practice        |
| **The agent's read-back is trustworthy**        | It never misreports what the operator named something. This is a real, observed failure — a stale label path — and it is why the reader must normalize. | U1-4 (test), U6-7 (manual) |
| **The file stays small**                        | Three pasted screenshots leave the canvas file well under its 2 MB cap, because image bytes live beside the file, not inside it.                        | U6-6 (test)                |
| **No edit is lost silently**                    | Saving over a changed file is possible, but only after the operator has been shown that the file moved. There is no path to a silent overwrite.         | U3-6, U3-7 (manual)        |
| **The pane costs nothing when unused**          | No PTY, no background work; it mounts and unmounts freely from its file path.                                                                           | review                     |
| **The substrate pin holds**                     | All four canvas plugins load with no console error — the guard against a dependency bump that silently removes selection, undo, resize and snaplines.   | U2-5 (test)                |

### 5.3 What would tell us we got it wrong

Stated up front so the failure is recognisable rather than rationalised:

- The operator opens a mockup in the canvas and still types the correction into the
  terminal. That means drawing it was not actually faster, and the pane is decoration.
- The agent's read-back is vague ("some nodes were changed") rather than specific. That
  means the origin stamps or the label normalization are not doing their job, and the
  feedback is noise.
- The operator stops saving. That means the Save button is friction in the wrong place and
  the handoff model needs rethinking — not that the canvas needs more features.

---

## 6. Cost and risk, stated plainly

- **A new dependency with a load-bearing version pin.** The chosen canvas engine's current
  major has no working plugins, and an unpinned install silently produces a broken pairing
  that looks like our bug. The pin carries an explanatory comment at the dependency site
  and a test that fails if the plugins stop loading. This is the single most likely way
  this feature quietly rots.
- **Most of it cannot be unit-tested.** Pointer gestures, hit-testing and routing geometry
  need a human in the real app. The spec names every such criterion explicitly (§10) so
  they are handed off rather than skipped.
- **The epic is droppable at the seams, and should be.** The loop (agent draws, operator
  edits, agent reads) is complete without container nodes, without promote-to-repo, and
  without live HTML mockups. Those are the payoff, and they are also the parts most likely
  to grow scope — each can land as a follow-up without making the rest useless.
