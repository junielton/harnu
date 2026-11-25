`KeyboardInterrupt` during `click.prompt()` can race

## Bug

When a user uses Ctrl-C during `click.prompt()`, this may cause an unhandled exception. Seen during CI on an Ubuntu 22.04 arm github runner. The same test on Ubuntu 22.04 x64, macOS arm, Windows x64/arm succeeded. This is likely to be a race that doesn't pop up every time

```
    | --- tty: Ctrl+C aborts at a prompt ---
    | spawn /home/runner/work/ethstaker-deposit-cli/ethstaker-deposit-cli/ethstaker_deposit-cli-c082a10-linux-arm64/deposit --language english --ignore_connectivity generate-mnemonic
    | Please choose the language of the mnemonic word list [1. 简体中文, 2. 繁體中文, 3. čeština, 4. English, 5. Français, 6. Italiano, 7. 日本語, 8. 한국어, 9. Português, 10. Español]:  [english]: ^CTraceback (most recent call last):
    |   File "click/core.py", line 1490, in main
    |   File "click/core.py", line 1968, in invoke
    |   File "click/core.py", line 1300, in make_context
    |   File "click/core.py", line 1311, in parse_args
    |   File "click/core.py", line 2686, in handle_parse_result
    |   File "click/core.py", line 3508, in consume_value
    |   File "ethstaker_deposit/utils/click.py", line 62, in prompt_for_value
    |   File "click/core.py", line 3372, in prompt_for_value
    |   File "click/termui.py", line 218, in prompt
    |   File "click/termui.py", line 201, in prompt_func
    | click.exceptions.Abort
    |
    | During handling of the above exception, another exception occurred:
    |
    | Traceback (most recent call last):
    |   File "deposit.py", line 128, in <module>
    |   File "deposit.py", line 121, in run
    |   File "click/core.py", line 1569, in __call__
    |   File "click/core.py", line 1532, in main
    |   File "click/utils.py", line 337, in echo
    |   File "click/_compat.py", line 509, in should_strip_ansi
    |   File "click/_compat.py", line 578, in isatty
    | KeyboardInterrupt
    | [PYI-3853:ERROR] Failed to execute script 'deposit' due to unhandled exception!
    |
    | [TEST FAIL] Unexpected EOF while waiting for: Aborted
```

## Replication

Probably a `click.prompt()` with Ctrl-C on a slower machine, run often enough to eventually trigger this race condition. In our case it was the free github `ubuntu-22.04-arm` runner.

## Expected

click handles the KeyboardInterrupt exception gracefully, regardless of timing or architecture.

Environment:

- Python version: 3.14
- Click version: 8.4.2
