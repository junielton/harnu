<!-- harnu-skills v12 (2026-10-03) -->

# Harnu bundled skills

The skills Harnu ships with the app. This directory is a valid Claude Code plugin
tree (`.claude-plugin/plugin.json` + `skills/<name>/SKILL.md`); Harnu stages the
**enabled** subset into its own userData directory and passes it to a spawned
session as `--plugin-dir`. A skill that is switched off is simply not staged, so
the session cannot see it even in principle.

Inside a session the skills arrive namespaced under the plugin name — a bundled
`mission` is invoked as `harnu:mission`. Personal skills of the same name are
never shadowed, renamed or removed; both are offered.

The marker comment on the first line is the **catalog version**. Bump it (`vN` →
`vN+1`) whenever the content of any shipped `SKILL.md` changes — `bundled-skills.ts`
parses it into `BUNDLED_SKILLS_VERSION` and compares it against the staged
`.stamp` to decide whether a folder's staged copy must be rewritten after an app
update. Individual skills are not independently versioned: the catalog moves with
the app release.

Everything under this directory is English-only (`CLAUDE.md` → Language policy)
and model-facing. In particular, each `SKILL.md`'s `description` is both the
CLI's trigger text **and** the one-line purpose the Settings → Skills panel
renders, so it is deliberately not translated.

## Entries

| Skill                  | What it does                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `orchestrate-delivery` | Decompose an objective into board cards, dispatch one session per unit, verify, hand back a report.                          |
| `delivery-verifier`    | Grade a finished unit's acceptance criteria from repo evidence, one at a time.                                               |
| `mission`              | Run one coordination tick over dispatched work and report a single line.                                                     |
| `delivery-watchdog`    | Read-only stall detector for dispatched deliveries; built to run as an `observe` Scheduler worker.                           |
| `conductor`            | Drive the Harnu fleet through the `harnu` MCP verbs.                                                                         |
| `status`               | Render a fixed six-line glance card of where every front stands, plus the links worth opening.                               |
| `read-aloud`           | Speak a short, ear-friendly summary of a result — the `speak` verb inside Harnu, a TTS command outside it.                   |
| `report-back`          | The shared final-report format for a multi-step run: a step rail, what the operator owes, the links, a 3-line summary.       |
| `draft-to-prompt`      | Turn a rough draft into a production prompt: pick the cheapest model that clears the bar, the harness, and the prompt shape. |
