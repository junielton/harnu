---
id: mnt-ca000002
slug: chapter-2-report
folder: /home/user/Workspace/org/www
owner:
  sessionId: 3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10
  folder: /home/user/Workspace/org/www
status: active
declaredEnd:
  kind: code
  target: The importer reads every row of the sample export and reports the count
  evidence: The suite passes and the sample export imports 120 rows
steps:
  - id: stp-1
    ordinal: 1
    kind: custom
    title: Render the report
    verification: existence
    proof: unproven
    links:
      - kind: session
        ref: 8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d
      - kind: worktree
        ref: /home/user/Workspace/org/www/.claude/worktrees/card-T702-render-report
    blockers: []
    addedAt: '2026-10-20T09:05:00.000Z'
  - id: stp-2
    ordinal: 2
    kind: custom
    title: Verify the report
    verification: verifier
    proof: unproven
    links:
      - kind: session
        ref: 6b8d0f2a-3c5e-4e7a-8b9c-1d3f5a7c9e2b
    blockers: []
    addedAt: '2026-10-20T09:05:00.000Z'
  - id: stp-3
    ordinal: 3
    kind: fixed-end
    title: Delivered and verified
    verification: verifier
    proof: unproven
    links: []
    blockers: []
    addedAt: '2026-10-20T09:05:00.000Z'
blockers: []
openQuestions: []
createdAt: '2026-10-20T09:00:00.000Z'
updatedAt: '2026-10-21T10:00:00.000Z'
provenance:
  author: agent
  at: '2026-10-20T09:00:00.000Z'
  branch: card/T700-example
ledger:
  - at: '2026-10-21T10:00:00.000Z'
    kind: dispatched
    stepId: stp-1
    ref: 8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d
    sessionId: 8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d
    detail: /home/user/Workspace/org/www
campaignId: cmp-ca0001aa
chapterId: chp-2
---
# Chapter 2 · Report

## Log
