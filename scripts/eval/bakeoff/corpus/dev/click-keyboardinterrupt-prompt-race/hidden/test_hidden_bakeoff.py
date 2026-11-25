"""A second interrupt while ``Command.main()`` reports an abort must not escape.

The race is reproduced deterministically: ``sys.stderr`` is replaced by a stream
that delivers a real SIGINT to this process from inside one chosen stream call.
A real signal, rather than a raised exception, leaves the implementation free to
close the race by catching the interrupt or by blocking the signal.
"""

import io
import signal
import sys

import pytest

import click
import click.termui

STREAM_CALLS = ("isatty", "write", "flush")


class InterruptingStderr(io.StringIO):
    """Delivers SIGINT once, from the first matching call after :meth:`arm`.

    ``writes_before`` is how many writes must finish first. It skips the blank
    line that ``main()`` prints before the abort message when the abort started
    as a ``KeyboardInterrupt`` or ``EOFError``, so that the interrupt lands in the
    abort message itself.
    """

    def __init__(self, call=None, writes_before=0):
        super().__init__()
        self.call = call
        self.writes_before = writes_before
        self.armed = False
        self.fired = False
        self.writes = 0

    def arm(self):
        self.armed = True

    def _deliver(self, call, writes_needed):
        if (
            self.armed
            and not self.fired
            and call == self.call
            and self.writes >= writes_needed
        ):
            self.fired = True
            signal.raise_signal(signal.SIGINT)

    def isatty(self):
        self._deliver("isatty", self.writes_before)
        return False

    def write(self, text):
        self._deliver("write", self.writes_before)
        written = super().write(text)
        self.writes += 1
        return written

    def flush(self):
        # The flush belonging to the abort message comes after its own write.
        self._deliver("flush", self.writes_before + 1)
        super().flush()


@pytest.fixture(autouse=True)
def default_sigint_handler():
    previous = signal.signal(signal.SIGINT, signal.default_int_handler)
    yield
    signal.signal(signal.SIGINT, previous)


def run_standalone(command, args=()):
    """Run ``command.main`` and return the exit code it ended with."""
    try:
        command.main(list(args), prog_name="prog", standalone_mode=True)
    except SystemExit as e:
        return e.code
    except KeyboardInterrupt:
        # Left alone, this would stop the whole pytest session.
        pytest.fail("KeyboardInterrupt escaped from Command.main()")

    pytest.fail("Command.main() returned instead of exiting")


def stub_input(monkeypatch, name, stream, exc):
    def fake_input(prompt=""):
        stream.arm()
        raise exc()

    monkeypatch.setattr(click.termui, name, fake_input)


def prompt_ctrl_c(monkeypatch, stream):
    stub_input(monkeypatch, "visible_prompt_func", stream, KeyboardInterrupt)

    @click.command()
    def cli():
        click.prompt("Name")

    return cli, []


def prompt_ctrl_d(monkeypatch, stream):
    stub_input(monkeypatch, "visible_prompt_func", stream, EOFError)

    @click.command()
    def cli():
        click.prompt("Name")

    return cli, []


def hidden_prompt_ctrl_c(monkeypatch, stream):
    stub_input(monkeypatch, "hidden_prompt_func", stream, KeyboardInterrupt)

    @click.command()
    def cli():
        click.prompt("Password", hide_input=True)

    return cli, []


def confirm_ctrl_c(monkeypatch, stream):
    stub_input(monkeypatch, "visible_prompt_func", stream, KeyboardInterrupt)

    @click.command()
    def cli():
        click.confirm("Continue?")

    return cli, []


def option_prompt_ctrl_c(monkeypatch, stream):
    stub_input(monkeypatch, "visible_prompt_func", stream, KeyboardInterrupt)

    @click.command()
    @click.option("--name", prompt=True)
    def cli(name):
        raise AssertionError("the command body must not run")

    return cli, []


def subcommand_prompt_ctrl_c(monkeypatch, stream):
    stub_input(monkeypatch, "visible_prompt_func", stream, KeyboardInterrupt)

    @click.group()
    def cli():
        pass

    @cli.command()
    def sub():
        click.prompt("Name")

    return cli, ["sub"]


def raised_abort(monkeypatch, stream):
    @click.command()
    def cli():
        stream.arm()
        raise click.Abort()

    return cli, []


def context_abort(monkeypatch, stream):
    @click.command()
    @click.pass_context
    def cli(ctx):
        stream.arm()
        ctx.abort()

    return cli, []


def body_keyboard_interrupt(monkeypatch, stream):
    @click.command()
    def cli():
        stream.arm()
        raise KeyboardInterrupt()

    return cli, []


def body_eof_error(monkeypatch, stream):
    @click.command()
    def cli():
        stream.arm()
        raise EOFError()

    return cli, []


ABORT_SOURCES = {
    "prompt_ctrl_c": (prompt_ctrl_c, 0),
    "prompt_ctrl_d": (prompt_ctrl_d, 0),
    "hidden_prompt_ctrl_c": (hidden_prompt_ctrl_c, 0),
    "confirm_ctrl_c": (confirm_ctrl_c, 0),
    "option_prompt_ctrl_c": (option_prompt_ctrl_c, 0),
    "subcommand_prompt_ctrl_c": (subcommand_prompt_ctrl_c, 0),
    "raised_abort": (raised_abort, 0),
    "context_abort": (context_abort, 0),
    "body_keyboard_interrupt": (body_keyboard_interrupt, 1),
    "body_eof_error": (body_eof_error, 1),
}


@pytest.mark.parametrize("call", STREAM_CALLS)
@pytest.mark.parametrize("source", ABORT_SOURCES)
def test_interrupt_while_reporting_abort_does_not_escape(monkeypatch, source, call):
    build, writes_before = ABORT_SOURCES[source]
    stream = InterruptingStderr(call, writes_before)
    monkeypatch.setattr(sys, "stderr", stream)
    command, args = build(monkeypatch, stream)

    code = run_standalone(command, args)

    assert code not in (0, None)


@pytest.mark.parametrize("source", ABORT_SOURCES)
def test_abort_without_second_interrupt_is_reported(monkeypatch, source):
    build, _ = ABORT_SOURCES[source]
    stream = InterruptingStderr()
    monkeypatch.setattr(sys, "stderr", stream)
    command, args = build(monkeypatch, stream)

    code = run_standalone(command, args)

    assert code == 1
    assert "Aborted!" in stream.getvalue()


def test_successful_command_is_unaffected(monkeypatch):
    stream = InterruptingStderr()
    monkeypatch.setattr(sys, "stderr", stream)

    @click.command()
    def cli():
        pass

    assert run_standalone(cli) == 0
    assert "Aborted!" not in stream.getvalue()


def test_click_exception_keeps_its_exit_code(monkeypatch):
    stream = InterruptingStderr()
    monkeypatch.setattr(sys, "stderr", stream)

    @click.command()
    def cli():
        raise click.UsageError("bad usage")

    assert run_standalone(cli) == 2
    assert "bad usage" in stream.getvalue()
    assert "Aborted!" not in stream.getvalue()


def test_not_standalone_abort_propagates_without_message(monkeypatch):
    stream = InterruptingStderr()
    monkeypatch.setattr(sys, "stderr", stream)

    @click.command()
    def cli():
        raise click.Abort()

    with pytest.raises(click.Abort):
        cli.main([], prog_name="prog", standalone_mode=False)

    assert "Aborted!" not in stream.getvalue()


@pytest.mark.parametrize("exc", (KeyboardInterrupt, EOFError))
def test_not_standalone_body_exception_becomes_abort(monkeypatch, exc):
    stream = InterruptingStderr()
    monkeypatch.setattr(sys, "stderr", stream)

    @click.command()
    def cli():
        raise exc()

    with pytest.raises(click.Abort) as info:
        cli.main([], prog_name="prog", standalone_mode=False)

    assert isinstance(info.value.__cause__, exc)
    assert "Aborted!" not in stream.getvalue()


def test_not_standalone_prompt_interrupt_raises_abort(monkeypatch):
    stream = InterruptingStderr()
    monkeypatch.setattr(sys, "stderr", stream)
    command, args = prompt_ctrl_c(monkeypatch, stream)

    with pytest.raises(click.Abort):
        command.main(args, prog_name="prog", standalone_mode=False)

    assert "Aborted!" not in stream.getvalue()


def test_cli_runner_reports_abort_at_empty_input():
    from click.testing import CliRunner

    @click.command()
    def cli():
        click.prompt("Name")

    result = CliRunner().invoke(cli, input="")

    assert result.exit_code == 1
    assert "Aborted!" in result.output
