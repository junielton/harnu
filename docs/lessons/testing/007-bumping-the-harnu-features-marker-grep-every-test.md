---
status: active
source: own
---

### Bumping the harnu-features marker: grep every test that pins the old version

**Category:** Testing
**Severity:** Medium

**Rule:** When you bump the `<!-- harnu-features vN -->` marker in `docs/harnu-features.md`, grep `tests/` and `src/` for both the prefixed form (`harnu-features vN`) and the bare version string (`'vN'`), update every hit, and run those tests before pushing.

**Bad:**

```sh
# T666: only the prefixed form was searched, so one pinned test was missed
grep -rl "harnu-features v128" tests   # 4 files; tests/harnu-features-prefs.test.ts is not among them
sed -i 's/harnu-features v128 /harnu-features v129 /' tests/*-docs.test.ts
```

**Good:**

```sh
grep -rnE "harnu-features v128|'v128'" tests src   # also finds HARNU_FEATURES_VERSION toBe('v128')
# update every hit, then run the pinned tests
npx vitest run tests/harnu-features-prefs.test.ts tests/park-docs.test.ts
```

**Why:** The marker is pinned in several tests, and one of them (`tests/harnu-features-prefs.test.ts`) asserts `HARNU_FEATURES_VERSION` against the bare string. A prefixed grep misses it and CI goes red on a docs-only change. It happened on PR #225 and again on PR #245.
