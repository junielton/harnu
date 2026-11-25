refactor: bash completion script

<!--
  This template provides some ideas of things to include in your PR description.
  To start, try providing a short summary of your changes in the Title above.
  If a section of the PR template does not apply to this PR, then delete that section.
 -->

## What type of PR is this?

<!--
  Delete any of the following that do not apply:
 -->

- bug
- cleanup

## What this PR does / why we need it:

#2298 follow up for better readability and a bugfix for the missing `compgen` command for word completion

<!--
  What goal is this change working towards?
  Provide a bullet pointed summary of how each file was changed.
  Briefly explain any decisions you made with respect to the changes.
  Include anything here that you didn't include in *Release Notes*
  above, such as changes to CI or changes to internal methods.
-->

## Which issue(s) this PR fixes:

None

<!--
If this PR fixes one of more issues, list them here.
One line each, like so:

Fixes #123
Fixes #39
-->

## Special notes for your reviewer:

If bash3 support would dropped this can be much more cleaner using associative arrays and completion initialization without a wrapper

<!--
   Is there any particular feedback you would / wouldn't like?
   Which parts of the code should reviewers focus on?
-->

## Testing

Tested in VM with a snap contained application

<!--
  Describe how you tested this change.
-->

## Release Notes

<!--
  If this PR makes user facing changes, please describe them here. This
  description will be copied into the release notes/changelog, whenever the
  next version is released. Keep this section short, and focus on high level
  changes.

  Put your text between the block. To omit notes, use NONE within the block.
-->

```release-note
refactor: bash autocomplete script
```
