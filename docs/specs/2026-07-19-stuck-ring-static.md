# Decision spec: the stuck ring goes still (BUG-51)

**Card:** `BUG-51-stuck-ring-replace-marching-dash-animation-with-a-solid-static`
**Sequenced after:** `BUG-53` (liveness axis). Do not implement before BUG-53 lands —
~229 of the `stuck` rings on the operator's rail are phantoms today, so the restyle
cannot be judged against a real case until the flood is gone.

## Problem

Direct operator feedback while looking at a live card: _"That stuck animation didn't
turn out well, I'd rather have a solid red border line"_ (translated) — the marching-dash stuck
ring reads as messy rather than as "movement that goes nowhere". Drop the motion.

Current implementation (`src/renderer/src/styles/main.css:325-330`, keyframes at
`:348-352`):

```css
.ring-stuck .ring-path {
  stroke: var(--color-red);
  stroke-dasharray: 2.2 2.78;
  opacity: 0.6;
  animation: ring-travel-stuck 14s linear infinite;
}
```

~20 short dashes marching around the SVG perimeter on a 14s loop — a faithful T161
port of the old `conic-gradient` mechanism.

## The conflict this creates

`errored` is **already** a still, solid red ring (`main.css:333-336`, `.ring-errored::before`,
`--color-red` at `opacity: 0.55`), and `design.md` §7 states the intent explicitly:
_"`errored` and `done` are deliberately still: stillness is itself the signal, the
mirror of `working`'s motion."_ If `stuck` also becomes a plain solid red ring, the two
states collapse to the same signal — which breaks the contract the whole fleet-rail
reorg was built on (`docs/specs/2026-07-17-fleet-rail/`: _"No state labels… each card's
state is carried by its dot + border animation"_). The dot differs
(`FleetBoardCard.vue:172-184`: `errored` = filled red circle, `stuck` = red-outlined
circle) and line 3's meta text differs, but the ring itself must still carry state.

## Decision — option 3: a **static broken line** for `stuck`, continuous solid for `errored`

Of the card's three candidates (different opacity / different stroke width / a static
dash pattern), pick the **static dash pattern**: keep `stuck` on the SVG `.ring-path`
with its dashes, delete only the `animation`.

Justification, from the existing design rules rather than taste:

1. **It is the only option that carries meaning rather than just difference.** Opacity
   and stroke-width differences are arbitrary — nothing in the design system says
   "thinner = stuck". A broken line versus a continuous line says _interrupted_ versus
   _ended_, which is exactly the semantic gap between `stuck` (was running, went quiet)
   and `errored` (dead until you act). It preserves the original §7 intent
   ("movement that goes nowhere") minus the motion the operator rejected.
2. **T160 already ruled against weight/opacity as state carriers.** The comment at
   `main.css:353-358` records that a 0.3↔0.85 opacity swing "read as *some cards have a
   thicker border*rather than as a state signal". Reusing the axis T160 just narrowed
   for being illegible would re-introduce the same failure.
3. **It respects §7's core rule** — _"If the user notices the animation, it ran too
   long"_. Removing a 14s infinite loop is strictly in that direction, and stillness
   remains reserved for the terminal-ish states, with `working` / `needs-input` keeping
   the only motion in the rail.
4. **It costs nothing structurally.** `stuck` stays on the SVG path (which exists for
   dash control) and `errored` stays on the `::before` layer (a plain solid border) —
   the two states remain rendered by different mechanisms, so they cannot accidentally
   converge in a future refactor.

`prefers-reduced-motion` handling for `stuck` becomes moot once nothing animates.

## Spec — the change

```css
/* stuck — a STILL broken red line: it was moving and it stopped. The break in
   the line is the state; errored's unbroken line is the contrast. */
.ring-stuck .ring-path {
  stroke: var(--color-red);
  stroke-dasharray: 2.2 2.78;
  opacity: 0.6;
}
```

- Remove the `animation` declaration from `.ring-stuck .ring-path` (`main.css:329`).
- Remove the now-unused `@keyframes ring-travel-stuck` (`:348-352`).
- Keep `stroke-dasharray` and `opacity` exactly as they are — the dash density was
  tuned in T161 and is not being re-litigated.
- Do **not** touch `.ring-errored` (`:333-336`), `.ring-working` (`:307-315`),
  `.ring-needs-input` (`:317-320`), `.ring-done` (`:339-342`), or `@keyframes
ring-travel` (`:343-347`) — `ring-travel` is still used by `working`.

Contract updates required in the SAME PR (same discipline as T160/T161):

- `design.md` §7 — the Fleet card border-ring table row for `stuck` becomes
  _"A still, broken red line — **not animated**"_ / reads as _"Was running, stopped
  mid-flight"_, and the "deliberately still" sentence below the table is extended to
  cover `stuck`, distinguishing broken (`stuck`) from continuous (`errored`).
- `docs/specs/2026-07-17-fleet-rail/spec.html` — the stuck swatch/description must
  match the new static rendering.

## Scope boundary — files

| File                                         | Change                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/renderer/src/styles/main.css`           | remove the `animation` on `.ring-stuck .ring-path`; delete `@keyframes ring-travel-stuck` |
| `design.md` §7                               | ring table row + the stillness paragraph                                                  |
| `docs/specs/2026-07-17-fleet-rail/spec.html` | the stuck swatch/description                                                              |
| `CHANGELOG.md`                               | one bullet under `### Changed`                                                            |

Explicitly NOT touched: `FleetBoardCard.vue` (the dot already differentiates and stays
as-is), `InboxRail.vue` (owned by T159), any store or classifier file. No new token, no
new radius, no new easing — nothing here requires a `design.md` §9 addition.

## Acceptance criteria

- [ ] `.ring-stuck` no longer animates — the marching-dash motion is gone, and
      `@keyframes ring-travel-stuck` no longer exists in the stylesheet.
- [ ] `stuck` and `errored` remain distinguishable **from the ring alone** (not just
      dot/text): broken static line vs continuous static line. State the chosen
      differentiator explicitly in the PR body.
- [ ] `working`'s ring is unaffected (`@keyframes ring-travel` still present and used).
- [ ] `design.md` §7 and `docs/specs/2026-07-17-fleet-rail/spec.html` updated in the
      same PR.
- [ ] `CHANGELOG.md` entry present.
- [ ] Verified **live** against a running instance with a genuine stuck card — not read
      from the diff. This is why the card is sequenced after BUG-53.

## TDD plan

This is the weakest TDD fit in the cluster — vitest cannot assert what a border looks
like, and pretending otherwise would produce a test that passes while the ring is
wrong. Write the strongest honest guard FIRST, a stylesheet assertion in a new
`tests/fleet-ring-styles.test.ts` (vitest, reading `main.css` as text — the same
"assert the contract, not the pixels" shape used by `tests/fleet-board-card-width.test.ts`):

```ts
it('the stuck ring is static — no animation, no leftover keyframes', () => {
  const css = readFileSync('src/renderer/src/styles/main.css', 'utf8')
  const stuck = css.slice(css.indexOf('.ring-stuck .ring-path')).slice(0, 200)
  expect(stuck).not.toMatch(/animation:/)
  expect(css).not.toMatch(/@keyframes ring-travel-stuck/)
  expect(css).toMatch(/@keyframes ring-travel\b/) // working's motion must survive
})
```

It fails today (the `animation` line is present), which is the correct first red. The
remaining acceptance criteria are verified by eye against a running instance and by
reading the design-doc diff — state both explicitly in the PR body.
