# Missions v4 landing check: old records open in a build of main

`scripts/verify/missions-v4-landing.mjs` is the chapter 6 proof of the Missions v4 delivery
(spec `docs/specs/2026-11-14-missions-v4/spec.md`, slice S-42, AC-94 and AC-95). It answers one question:
**does a record written before v4 open in a build of main, with nothing rewritten?**

It works on copies in a throwaway repo, against a throwaway instance of the freshly built app, the way
[`live-verify-second-instance.md`](live-verify-second-instance.md) describes. It never touches your real `.harnu/`,
`~/.claude`, `~/.harnu` or `~/.config/harnu`, never links or copies a Claude credential, and never calls Claude.

## Run it

```bash
nice -n 19 node scripts/verify/missions-v4-landing.mjs --evidence <dir>
```

One build, one instance, serial. Needs `xvfb-run` on Linux (no window opens on your desktop), `gh` for the release
download, and `node_modules`. Options:

| Option                 | What it does                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `--no-build`           | Reuse the current `out/` build.                                                         |
| `--release <AppImage>` | Use this release AppImage (its sha256 is still checked) instead of downloading it.      |
| `--release-tag <tag>`  | Release to download. Default `v0.3.47`, the last published release when this was cut.   |
| `--skip-release`       | Skip the upgrade phase. The results then say so as a limit.                             |
| `--evidence <dir>`     | Where the screenshots and `landing-results.json` go. Default: inside the run directory. |
| `--plant-fault <name>` | Plant one fault to prove the matching assertion can fail. The run must then exit `1`.   |
| `--keep`               | Keep the run directory (`/tmp/harnu-verify-landing-*`) for a look.                      |

Exit `0`: every check passed. `1`: a check failed. `2`: the harness itself broke.

## What it opens

1. **Frozen v3 records.** Every mission in `tests/fixtures/missions-v4-compat/missions/` and the campaign with its
   two chapter missions (`campaigns/`). They were written by the v3 builders before any v4 change (S-1), copied
   byte for byte into the throwaway repo's `.harnu/missions/` and `.harnu/campaigns/`.
2. **Records written by the current version.** A v4 mission made through the build's own `mission_create`, plus an
   operator blocker through `mission_set_blocker`. The build has no campaign writer left (S-39 removed the
   verbs), so "a campaign written by the current version" is the v3 campaign converted by copy, by the build's own
   first v4 write (`mission_log` on the campaign id).
3. **An upgrade from the last published release.** The release AppImage is downloaded into the run directory, its
   sha256 is checked against the digest GitHub publishes, it is extracted and started under its own throwaway
   `HOME`. Its **own** v3 writers (`mission_create`, `mission_add_check`, `mission_set_blocker`, `mission_set_end`)
   write two missions through its real MCP transport, with no Claude call. Those files are copied into the repo the
   build of main opens.
   - Limit: `v0.3.47` has no campaign verbs (they landed after it), so no release-written campaign exists. The
     campaign upgrade rests on the frozen v3 campaign fixtures.

## What it asserts

| Group     | Check                                                                                                                                                                                                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open.*`  | Every v3 record answers `state: mission` on the view channel with the title its file gives. A chapter mission resolves to its campaign's one mission.                                                                                                                                         |
| `ng8.*`   | sha256 of every original and every copy is identical before and after the reads, the pane opens, each v4 write and the conversion. Reads create no `.harnu/missions-v4/`. The v3 directories hold only the files copied in. The v4 record written by the build is not changed by later reads. |
| `pane.*`  | Each open record opens in the Mission pane with its title, the Topbar pill's count equals the pane's count, and the same holds in pt-BR (the words change, the numbers do not).                                                                                                               |
| `owed.*`  | What the operator owed **before** is still owed **after**. Before is the release's own `youItems` (release records) or the v3 file's own facts (frozen records); after is the pane's waiting list. The v3 kinds map to v4 kinds (`OWED_MAP`); a kind that vanishes fails.                     |
| `doors.*` | Approve and Decline of a staged v3 re-scope work from the pane's buttons, clear the staging, add one Log entry and change no other v3 file.                                                                                                                                                   |
| campaign  | The campaign reads as one mission with its milestones in order and a next step box. The first v4 write converts it by copy into one new mission (`mnt-…`), writes a sidecar per old id, is idempotent on a second write, and leaves the campaign and chapter files byte-identical.            |
| guards    | The fixtures in the repo are byte-identical at the end; the operator's `~/.claude/settings.json` mtime and size are unchanged; the instance ran under a throwaway `HOME` and `--user-data-dir=/tmp/harnu-verify-landing-*`; only the PIDs the run started are stopped.                        |

## Planted faults

`--plant-fault <name>` makes a check fail on purpose. A proof that cannot fail proves nothing, so each fault must turn
the run red.

| Fault                | What is planted                                         | Check that must go red                                                   |
| -------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `rewrite-copy`       | One byte appended to a copied v3 file before the reads. | `ng8.reads-write-nothing`, `ng8.copies-equal-originals`                  |
| `rewrite-original`   | One byte appended to a v3 file after every write path.  | `ng8.final-v3-identical`                                                 |
| `drop-owed`          | One owed item hidden from the "after" list.             | `owed.*` for a record that owed something                                |
| `reorder-milestones` | The milestones the pane read, reversed.                 | `campaign.milestones-in-order`, `campaign.converted-milestones-in-order` |
| `pill-mismatch`      | A wrong pill count.                                     | `pane.pill-equals-count.cmp-ca0001aa`                                    |
| `stray-v4-dir`       | `.harnu/missions-v4/` created before the reads.         | `ng8.reads-write-nothing`                                                |

## What it does not do

- **It is not a real upgrade of an installed app.** It runs the release's own writers in a throwaway instance and
  opens the files they wrote in a build of main. That is the closest an unattended check gets; it does not replace
  installing the release over an existing profile.
- **The operator's sign-off on the screenshots is a check, not a result.** The screenshots in the evidence folder
  (`campaign-converted-en.png`, `campaign-converted-pt-BR.png`, the v3 and staged re-scope ones) are for a human and
  a verifier to look at. The script asserts the DOM (milestone order, a next step box), not the pixels.
- **A closed v4 record has no pane view** (known: BUG-279). The check records what the pane shows for a closed record
  as information and does not fail on it.

## Known finding: the re-scope door writes the v3 file

NG-8 says no v4 code writes a v3 file. One door does, by design: since S-40 (owner delta 1), **Approve** or
**Decline** of a re-scope staged before the upgrade rewrites the v3 file itself, in the v3 format
(`src/main/missions/v3-rescope-door.ts`), so the installed build keeps reading it, and makes no v4 copy. The check
asserts exactly that and nothing wider: one file changes, the staging is gone, one Log entry is added, every other
v3 file stays byte-identical. The spec text of NG-8, AC-22 and compatibility rule 4 has no amendment that says so.
