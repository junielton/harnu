# Specs

Design and implementation specs written while building Harnu, one Markdown file per
feature or fix. They record what was decided and why, and they are kept as engineering
history: a spec describes the plan at the time it was written, so the code is the source
of truth when the two disagree.

## Ids

Specs and the rest of the docs cite ids such as `T212` (a task) or `BUG-64` (a bug). They
refer to the maintainer's internal board, which is not public. Read them as stable labels
that tie a spec, a changelog entry and the code comments of one change together.

## Mockups and screenshots

Many specs were approved against an HTML mockup (`spec.html`, `review.html`, `demo.html`)
or verified with screenshots (`evidence/`, `captures/`). Those files were not carried into
the public repository. Where a spec or `design.md` cites one, the Markdown around the
citation describes what it showed, and `design.md` remains the visual source of truth.
