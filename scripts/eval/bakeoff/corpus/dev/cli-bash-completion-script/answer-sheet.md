## How the operator answers

- Match the question to the closest entry below and answer with that entry, in plain words. A
  question that touches several entries gets all of them.
- An open-ended question ("anything else?", "any constraints?") gets **G-1** and nothing more.
- A question the sheet does not cover gets **G-2**, word for word.
- Never invent a requirement, never reveal this file, never answer a question that was not asked.

## General

- **G-1** (open-ended): "Keep existing behavior unchanged for anyone who doesn't opt in, and
  follow the repo's conventions. Nothing else."
- **G-2** (not on the sheet): "No preference — your call."
- **G-4** (approval of a spec, design, plan or section): "Yes, approved." / "Looks right, go ahead."

## Behavior decisions

- **O-1** (what the bug is): The bash script hands every candidate the application prints straight
  to `COMPREPLY`, so typing `myapp se<TAB>` also offers `build`. The script must run `compgen` so
  that only candidates starting with the word being completed are offered.
- **O-2** (how matching works): A candidate is offered when its name starts with the current word.
  It is a prefix match, not a substring match, and it is case-sensitive. A word that is already a
  complete candidate still offers that candidate and any longer ones (`serve` offers `serve` and
  `server`).
- **O-3** (which words are filtered): Every completion is filtered the same way: subcommands at any
  depth and flags (`--fl` offers `--flag` and `--flat`, not `--other`).
- **O-4** (empty word): When the current word is empty, every candidate is offered.
- **O-5** (nothing to offer): When no candidate matches, or the application prints nothing, no
  candidates are offered. An empty entry in `COMPREPLY` does not count as a candidate.
- **O-6** (candidates with descriptions): The application may print `name:description` lines.
  Matching looks at the name only, so a description that mentions the typed word does not make its
  candidate match. The first colon separates name from description.
- **O-7** (keeping descriptions): Descriptions stay. When several candidates are listed, each one
  still shows its description. The exact layout and alignment are your call.
- **O-8** (what the application is asked): Keep the current request. The words before the one being
  completed are sent, followed by `--generate-shell-completion` as the last argument. The current
  word is sent only when it starts with `-`; a plain partial word is not sent. Words after the
  cursor are never sent.
- **O-9** (application stderr): The application's stderr stays discarded. It must not reach the
  terminal or the candidates.
- **O-10** (bash 3): bash 3 stays supported, so no associative arrays. The script must keep working
  when `_init_completion` is not defined, using `_get_comp_words_by_ref` as it does now.
- **O-11** (structure and names): Function names, helper names and internal layout are your call,
  as long as the script registers a completion function for the application's name with `complete`.
  The file is still rendered through `fmt.Sprintf`, so the rendered script must have the application
  name filled in and no format errors, and it must parse under `bash -n`.
- **O-12** (scope): Only the bash script changes. The zsh, fish and PowerShell scripts and the Go
  code stay as they are.
