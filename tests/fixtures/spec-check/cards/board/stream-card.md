---
id: T901
title: S-1 · Stream the export
status: backlog
spec: tests/fixtures/spec-check/cards/spec.md
---

spec-slice: S-1

## Acceptance criteria

<!-- spec:begin S-1 -->

- [ ] AC-1 #26ec — Exports stream rows as they are read. — proof: test:tests/export-stream.test.ts::streams
- [x] AC-2 #0000 — The stream keeps memory flat on a large export. — proof: test:tests/export-stream.test.ts::flat memory
- [ ] AC-9 #1234 — The export is resumable. — proof: test:tests/export-stream.test.ts::resumes
      scope: src/export/stream.ts, tests/export-stream.test.ts
      links: spec tests/fixtures/spec-check/cards/spec.md

<!-- spec:end S-1 -->

- [ ] AC-C — the PR's CHANGELOG obligations follow CLAUDE.md

An example the packet quotes, which is not an AC line of this card:

```
- [ ] AC-7 #ffff — quoted example — proof: test:x::y
```
