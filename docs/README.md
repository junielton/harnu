# Docs

| Path                                                       | What it is                                                                                   | Who it is for              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------- |
| [`user/`](user/)                                           | How to install and use Harnu, one page per feature                                           | People using the app       |
| [`adr/`](adr/)                                             | Architecture decision records: one decision, its context and its consequences                | Contributors               |
| [`lessons/`](lessons/)                                     | Bug classes this project hit, and how to spot them in a review                               | Contributors and reviewers |
| [`specs/`](specs/)                                         | Design and implementation specs, kept as engineering history                                 | Contributors               |
| [`prds/`](prds/)                                           | Product requirement documents for larger features                                            | Contributors               |
| [`dev/`](dev/)                                             | Development recipes, such as verifying a change in a second app instance                     | Contributors               |
| [`reports/`](reports/)                                     | Incident write-ups                                                                           | Contributors               |
| `harnu-*.md`                                               | Prompts Harnu injects into Claude Code sessions at runtime (features, orchestrator, teacher) | Shipped with the app       |
| [`hook-bridge-integration.md`](hook-bridge-integration.md) | How Harnu receives Claude Code hook events                                                   | Contributors               |

The visual system lives in [`../design.md`](../design.md), and the code layout in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md).

Ids such as `T212` or `BUG-64` refer to the maintainer's internal board; see
[`specs/README.md`](specs/README.md).
