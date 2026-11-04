# Decisions (append-only, newest at the bottom)

> Each entry: date · decision · why · provenance.

## 2026-09-20 — The demo server uses plain HTTP handlers, no framework

Why: the server has three routes and a framework would double the dependency tree.

> provenance: author=agent · at=2026-09-20 · branch=main

## 2026-10-01 — Health endpoint returns the build sha

Why: the deploy check compares the sha with the release tag.

> entry: e-0a1b2c3d · valid_from=2026-10-01 · watches=src/server.ts,health
> provenance: author=agent · at=2026-10-01 · branch=main · session=aaaa1111-0000-4000-8000-000000000001

## 2026-10-03 — The app header is sticky on every screen

Why: the operator wants the folder name visible while scrolling long lists.

> entry: e-4e5f6a7b · valid_from=2026-10-03 · watches=packages/app,header
> provenance: author=human · at=2026-10-03 · branch=main
