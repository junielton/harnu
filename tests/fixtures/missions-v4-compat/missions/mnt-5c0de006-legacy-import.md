---
id: mnt-5c0de006
slug: legacy-import
folder: /home/user/Workspace/org/www
owner:
  sessionId: 3f1c9a52-7d4e-4b8a-9c21-5e6a0b7d8f10
  folder: /home/user/Workspace/org/www
status: draft
declaredEnd:
  kind: code
  target: The importer reads every row of the sample export and reports the count
  evidence: The suite passes and the sample export imports 120 rows
steps:
  - id: stp-1
    ordinal: 1
    kind: fixed-start
    title: Scope confirmed
    verification: human
    proof: unproven
    links: []
    blockers: []
    addedAt: '2026-10-20T09:05:00.000Z'
  - id: stp-2
    ordinal: 2
    kind: custom
    title: parser
    verification: verifier
    proof: unproven
    links:
      - kind: session
        ref: 8a2d4c6e-1b3f-4a5c-9d7e-2f4a6c8e0b1d
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
openQuestions:
  - Which delimiter does the export use?
  - Is the header row optional?
createdAt: '2026-10-20T09:00:00.000Z'
updatedAt: '2026-10-21T10:00:00.000Z'
provenance:
  author: agent
  at: '2026-10-20T09:00:00.000Z'
  branch: card/T700-example
legacy:
  source: /home/user/Workspace/org/www/.harnu/goals/sample-goal.md
  sha256: sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
  needsReview:
    - declaredEnd
legacyRaw: |
  # Sample goal

  ## Objective

  Import the sample export.

  ## Units

  | Unit | Session |
  | ---- | ------- |
  | parser | 8a2d4c6e |
---
# Sample goal

## Log

Imported from a legacy goal file.
