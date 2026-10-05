# 006-electron-builder-skips-publish-when-release-type-mismatches: set `releaseType: release` when the tag's GitHub release is already published

**Category:** framework (electron-builder / CI release)
**Discovered in:** v0.3.3 and v0.3.5 releases shipping with zero assets (Jul 2026)
**Status:** active

## The bug

`release.yml` ran green on all three OS matrix legs (ubuntu/macos/windows),
`npx electron-builder --publish always` built every artifact successfully, but
the GitHub release for the tag ended up with **no assets** — just the
auto-generated "Source code (zip/tar.gz)" links GitHub adds to every tag. This
happened silently: no step failed, no red X anywhere in the Actions UI.

The publish step logs (visible only with `gh run view <id> --log`) showed the
real story:

```
• publishing      publisher=Github (owner: junielton, project: om2tab, version: 0.3.5)
• uploading       file=Capy-0.3.5.AppImage provider=github
• GitHub release not created  reason=existing type not compatible with publishing type
  tag=v0.3.5 version=0.3.5 existingType=release publishingType=draft
• skipped publishing  file=Capy-0.3.5.AppImage reason=existing type not compatible with publishing type ...
```

## Root cause

electron-builder's `publish.releaseType` defaults to `draft`. This repo's
release for the pushed tag was already **published** (non-draft) by the time
the CI job's build-and-publish step ran (a release created via the GitHub UI
right after the tag push, before the slower CI legs finished building).
electron-builder refuses to touch a release whose actual type doesn't match
the type it was configured to publish as — it treats "existing type ≠
configured type" as a signal to back off rather than risk mutating a release
state the operator didn't ask for, so it drops every asset upload with a
`skipped publishing` log line and exits 0.

Because nothing in `release.yml` re-uploads build outputs as GitHub Actions
artifacts (the workflow's only egress path is the direct `--publish` upload),
once the job finished the built `.AppImage`/`.deb`/`.dmg`/`.exe` files were
gone with the runner — there was no way to recover them after the fact; the
only fix was to rebuild.

## The fix (and why)

```yaml
# electron-builder.yml
publish:
  provider: github
  owner: junielton
  repo: om2tab
  releaseType: release
```

Setting `releaseType: release` tells electron-builder the target release is
expected to already be published, so it uploads assets to it directly instead
of comparing against the `draft` default and bailing.

## How to detect in reviews / going forward

1. A release-workflow run showing all-green jobs is **not** proof assets
   landed — check the actual release: `gh release view <tag> --json assets`.
   An empty `assets` array after a "successful" release run is the signature
   of this bug class.
2. `gh run view <run-id> --log | grep -i "skipped publishing\|not compatible"`
   surfaces the mismatch immediately; the top-level Actions UI never flags it
   because the step exits 0.
3. If the GitHub release for a tag gets published (manually or otherwise)
   before/while the CI build is still running, `releaseType` in
   `electron-builder.yml` must match that reality (`release`, not the
   `draft` default) or every subsequent run repeats the silent skip.

## Related

- `electron-builder.yml` (`publish` block)
- `.github/workflows/release.yml` (`Build and publish` step)
