# Judge score sheet — fixed before any run

You are judging one spec at a time. You do not know which tool wrote it, and it does not matter.
Score it against the hidden atoms you were given (`atoms.md`), reading the spec bundle and
nothing else: not the target repository, not the web.

The bundle may be one file or several (a design, a plan, a task list). Read all of it; judge it as
the thing a builder would receive.

## Measures

1. **Atoms covered.** For every id in `atoms.md`, say `covered`
   (the spec states it so a builder would build it), `partial` (mentioned, but a builder could
   still get it wrong), `contradicted` (the spec says something else) or `missing`.
2. **Decisions left to the implementer.** List every choice a builder must make that changes
   observable behavior (an option name, an error case, a scope boundary) and the spec does not
   settle. Wording, internal structure and test names do not count. The count is the
   zero-decision measure: lower is better.
3. **Contradictions.** List every pair of statements inside the bundle that cannot both hold.
4. **Acceptance criteria with an executable proof.** Count the acceptance criteria (or
   requirements, or checks — whatever the bundle uses as its pass/fail list). Count how many name
   a proof a machine can run (a named test, a command, an assertion on output), as opposed to a
   prose check.
5. **Guesses a builder would need.** List the questions a builder would have to guess an answer
   to before writing code. Overlap with measure 2 is expected; this one is from the builder's
   seat.

## Output

Answer with exactly one fenced `json` block and nothing after it:

```json
{
  "spec": "<the label you were given>",
  "atoms": { "R-1": "covered", "R-2": "partial", "...": "..." },
  "decisions_left": ["<decision>", "..."],
  "contradictions": ["<statement A> vs <statement B>", "..."],
  "acceptance_criteria": { "total": 0, "executable": 0 },
  "builder_guesses": ["<question>", "..."],
  "notes": "<at most three sentences>"
}
```
