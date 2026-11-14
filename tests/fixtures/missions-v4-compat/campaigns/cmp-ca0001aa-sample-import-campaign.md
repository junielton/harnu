---
id: cmp-ca0001aa
slug: sample-import-campaign
folder: /home/user/Workspace/org/www
owner:
  sessionId: 3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10
  folder: /home/user/Workspace/org/www
title: Deliver the sample import
declaredEnd:
  kind: code
  target: The sample import is delivered end to end
  evidence: The import runs on the sample export and the report matches
chapters:
  - id: chp-1
    ordinal: 1
    title: Import core
    missionId: mnt-ca000001
    required: true
    produces:
      - import-core
  - id: chp-2
    ordinal: 2
    title: Report
    missionId: mnt-ca000002
    required: true
    produces:
      - report
    consumes:
      - import-core
  - id: chp-3
    ordinal: 3
    title: Migrate the pages
    required: true
    unlocks:
      kind: chapter
      ref: chp-2
    consumes:
      - report
    radiant:
      template: migrate page {slug}
      total: 88
  - id: chp-4
    ordinal: 4
    title: Fix the parser edge cases
    required: false
    discoveredFrom:
      chapterId: chp-2
      stepId: stp-1
    unlocks:
      kind: chapter
      ref: chp-1
  - id: chp-5
    ordinal: 5
    title: Publish the notes
    required: true
    unlocks:
      kind: pr
      ref: '390'
status: active
scope:
  - kind: worktree
    ref: docs/specs/2026-10-20-sample-import/spec.md
createdAt: '2026-10-18T08:00:00.000Z'
updatedAt: '2026-10-21T10:00:00.000Z'
provenance:
  author: agent
  at: '2026-10-20T09:00:00.000Z'
  branch: card/T700-example
---
# Deliver the sample import

## Log

### 2026-10-18T08:05:00.000Z · surprise

Chapter 5 publishes before its prerequisite is produced.
