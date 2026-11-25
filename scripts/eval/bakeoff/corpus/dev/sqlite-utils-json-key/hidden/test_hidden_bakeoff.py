"""Hidden acceptance tests for the bake-off (sqlite-utils issue #489 at 9c66baf).

Written before any contestant ran, from the pinned request and the answer sheet. Copied into
each build's `tests/` only after its executor finished. Each test names the atoms it grades
(`../hidden/atoms.md`).
"""

import io
import json
import pathlib

import pytest
from click.testing import CliRunner

from sqlite_utils import Database, cli
from sqlite_utils.utils import Format, RowsFromFileBadJSON, rows_from_file

EXAMPLE = {
    "Version": "5.5.52.6",
    "List": [
        {"Description": "Nonpartisan", "Id": 1, "ExternalId": ""},
        {"Description": "Undeclared", "Id": 2, "ExternalId": ""},
    ],
}


def _write(tmp_path, name, data):
    path = tmp_path / name
    path.write_text(json.dumps(data) if not isinstance(data, str) else data)
    return str(path)


def _invoke(args, input=None):
    return CliRunner().invoke(cli.cli, args, input=input, catch_exceptions=True)


def _clean_error(result):
    """O-14: a non-zero exit through click, never an uncaught exception."""
    assert result.exit_code != 0, result.output
    assert isinstance(result.exception, SystemExit), repr(result.exception)
    # An unknown option is also a clean click error: it must not count as the feature's error.
    assert "No such option" not in result.output, result.output


def _rows(db_path, table):
    db = Database(db_path)
    if not db[table].exists():
        return []
    return list(db[table].rows)


# --- R: the request itself ---------------------------------------------------------------


def test_insert_auto_key_imports_example(tmp_path):
    """R-1 R-2 R-3 R-4 R-7 O-2"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "example.json", EXAMPLE)
    result = _invoke(["insert", db, "t", src, "--auto-key"])
    assert result.exit_code == 0, result.output
    rows = _rows(db, "t")
    assert rows == EXAMPLE["List"]
    assert set(Database(db)["t"].columns_dict) == {"Description", "Id", "ExternalId"}


def test_insert_key_imports_example(tmp_path):
    """R-1 R-2 R-3 O-2"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "example.json", EXAMPLE)
    result = _invoke(["insert", db, "t", src, "--key", "List"])
    assert result.exit_code == 0, result.output
    assert _rows(db, "t") == EXAMPLE["List"]


def test_rows_from_file_auto_key():
    """R-4 O-2"""
    rows, fmt = rows_from_file(io.BytesIO(json.dumps(EXAMPLE).encode()), auto_key=True)
    assert list(rows) == EXAMPLE["List"]
    assert fmt == Format.JSON


def test_rows_from_file_key():
    """R-2 O-2"""
    rows, fmt = rows_from_file(io.BytesIO(json.dumps(EXAMPLE).encode()), key="List")
    assert list(rows) == EXAMPLE["List"]
    assert fmt == Format.JSON


def test_top_level_list_unchanged_with_auto_key(tmp_path):
    """R-8 O-7"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "list.json", EXAMPLE["List"])
    result = _invoke(["insert", db, "t", src, "--auto-key"])
    assert result.exit_code == 0, result.output
    assert _rows(db, "t") == EXAMPLE["List"]


def test_auto_key_skips_empty_and_scalar_lists(tmp_path):
    """R-6 O-6"""
    db = str(tmp_path / "data.db")
    data = {"empty": [], "tags": ["a", "b"], "mixed": [{"x": 1}, 2], "rows": [{"x": 1}]}
    src = _write(tmp_path, "d.json", data)
    result = _invoke(["insert", db, "t", src, "--auto-key"])
    assert result.exit_code == 0, result.output
    assert _rows(db, "t") == [{"x": 1}]


def test_auto_key_several_candidates_is_an_error_naming_them(tmp_path):
    """R-5 O-6 O-14"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "d.json", {"alpha": [{"x": 1}], "beta": [{"y": 2}]})
    result = _invoke(["insert", db, "t", src, "--auto-key"])
    _clean_error(result)
    assert "alpha" in result.output and "beta" in result.output
    assert _rows(db, "t") == []


def test_rows_from_file_auto_key_several_candidates_raises():
    """R-5 O-6"""
    data = {"alpha": [{"x": 1}], "beta": [{"y": 2}]}
    with pytest.raises(RowsFromFileBadJSON):
        rows, _ = rows_from_file(io.BytesIO(json.dumps(data).encode()), auto_key=True)
        list(rows)


# --- O-1: opt-in, today's behavior is kept ------------------------------------------------


def test_object_without_option_is_still_one_row(tmp_path):
    """O-1"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "example.json", EXAMPLE)
    result = _invoke(["insert", db, "t", src])
    assert result.exit_code == 0, result.output
    rows = _rows(db, "t")
    assert len(rows) == 1
    assert rows[0]["Version"] == "5.5.52.6"
    assert json.loads(rows[0]["List"]) == EXAMPLE["List"]


def test_rows_from_file_object_without_option_is_still_one_row():
    """O-1"""
    rows, _ = rows_from_file(io.BytesIO(json.dumps(EXAMPLE).encode()))
    assert list(rows) == [EXAMPLE]


def test_memory_object_without_option_is_still_one_row(tmp_path):
    """O-1 O-3"""
    src = _write(tmp_path, "example.json", EXAMPLE)
    result = _invoke(["memory", src, "select count(*) as n from example"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == [{"n": 1}]


# --- O-3: every command that reads JSON ---------------------------------------------------


@pytest.mark.parametrize("option", (["--auto-key"], ["--key", "List"]))
def test_memory_options(tmp_path, option):
    """O-3 O-13"""
    src = _write(tmp_path, "example.json", EXAMPLE)
    result = _invoke(
        ["memory", src, "select Id, Description from example order by Id"] + option
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == [
        {"Id": 1, "Description": "Nonpartisan"},
        {"Id": 2, "Description": "Undeclared"},
    ]


def test_upsert_key(tmp_path):
    """O-3 O-11"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "example.json", EXAMPLE)
    assert _invoke(["upsert", db, "t", src, "--key", "List", "--pk", "Id"]).exit_code == 0
    changed = json.loads(json.dumps(EXAMPLE))
    changed["List"][0]["Description"] = "Changed"
    src2 = _write(tmp_path, "changed.json", changed)
    result = _invoke(["upsert", db, "t", src2, "--key", "List", "--pk", "Id"])
    assert result.exit_code == 0, result.output
    rows = sorted(_rows(db, "t"), key=lambda r: r["Id"])
    assert [r["Description"] for r in rows] == ["Changed", "Undeclared"]


def test_bulk_auto_key(tmp_path):
    """O-3"""
    db = str(tmp_path / "data.db")
    Database(db)["t"].create({"id": int, "name": str}, pk="id")
    src = _write(tmp_path, "example.json", EXAMPLE)
    result = _invoke(
        [
            "bulk",
            db,
            "insert into t (id, name) values (:Id, :Description)",
            src,
            "--auto-key",
        ]
    )
    assert result.exit_code == 0, result.output
    assert sorted(r["name"] for r in _rows(db, "t")) == ["Nonpartisan", "Undeclared"]


def test_memory_csv_alongside_json_is_unaffected(tmp_path):
    """O-9 (memory skips CSV) O-13"""
    src = _write(tmp_path, "example.json", EXAMPLE)
    csv_path = _write(tmp_path, "people.csv", "id,name\n1,Cleo\n2,Bants\n")
    result = _invoke(
        [
            "memory",
            src,
            csv_path,
            "select (select count(*) from example) as e, (select count(*) from people) as p",
            "--auto-key",
        ]
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == [{"e": 2, "p": 2}]


# --- O-4 .. O-10: what the options read, and the errors -----------------------------------


def test_key_object_value_is_one_row(tmp_path):
    """O-4"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "d.json", {"record": {"id": 1, "name": "Cleo"}, "meta": 1})
    result = _invoke(["insert", db, "t", src, "--key", "record"])
    assert result.exit_code == 0, result.output
    assert _rows(db, "t") == [{"id": 1, "name": "Cleo"}]


@pytest.mark.parametrize("value", ("text", 3, None, True))
def test_key_scalar_value_is_an_error(tmp_path, value):
    """O-4 O-14"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "d.json", {"v": value})
    _clean_error(_invoke(["insert", db, "t", src, "--key", "v"]))


def test_key_is_literal_not_a_path(tmp_path):
    """O-4"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "d.json", {"a.b": [{"x": 1}]})
    result = _invoke(["insert", db, "t", src, "--key", "a.b"])
    assert result.exit_code == 0, result.output
    assert _rows(db, "t") == [{"x": 1}]
    nested = _write(tmp_path, "n.json", {"a": {"b": [{"x": 1}]}})
    _clean_error(_invoke(["insert", db, "t2", nested, "--key", "a.b"]))


def test_missing_key_is_an_error_naming_it(tmp_path):
    """O-5 O-14"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "example.json", EXAMPLE)
    result = _invoke(["insert", db, "t", src, "--key", "Records"])
    _clean_error(result)
    assert "Records" in result.output


def test_rows_from_file_missing_key_raises():
    """O-5"""
    with pytest.raises(RowsFromFileBadJSON) as excinfo:
        rows, _ = rows_from_file(
            io.BytesIO(json.dumps(EXAMPLE).encode()), key="Records"
        )
        list(rows)
    assert "Records" in str(excinfo.value)


def test_auto_key_no_candidate_is_an_error(tmp_path):
    """O-6 O-14"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "d.json", {"id": 1, "tags": ["a"]})
    _clean_error(_invoke(["insert", db, "t", src, "--auto-key"]))


def test_rows_from_file_auto_key_no_candidate_raises():
    """O-6"""
    with pytest.raises(RowsFromFileBadJSON):
        rows, _ = rows_from_file(io.BytesIO(b'{"id": 1}'), auto_key=True)
        list(rows)


def test_key_on_top_level_list_is_an_error(tmp_path):
    """O-7 O-14"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "list.json", EXAMPLE["List"])
    _clean_error(_invoke(["insert", db, "t", src, "--key", "List"]))


def test_rows_from_file_key_on_top_level_list_raises():
    """O-7"""
    with pytest.raises(RowsFromFileBadJSON):
        rows, _ = rows_from_file(
            io.BytesIO(json.dumps(EXAMPLE["List"]).encode()), key="List"
        )
        list(rows)


def test_rows_from_file_auto_key_on_top_level_list_is_a_no_op():
    """O-7 R-8"""
    rows, _ = rows_from_file(
        io.BytesIO(json.dumps(EXAMPLE["List"]).encode()), auto_key=True
    )
    assert list(rows) == EXAMPLE["List"]


def test_both_options_is_an_error(tmp_path):
    """O-8 O-14"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "example.json", EXAMPLE)
    _clean_error(_invoke(["insert", db, "t", src, "--key", "List", "--auto-key"]))


def test_rows_from_file_both_raises_value_error():
    """O-8"""
    with pytest.raises(ValueError):
        rows, _ = rows_from_file(
            io.BytesIO(json.dumps(EXAMPLE).encode()), key="List", auto_key=True
        )
        list(rows)


@pytest.mark.parametrize("flag", ("--csv", "--tsv", "--nl", "--lines", "--text"))
@pytest.mark.parametrize("option", (["--auto-key"], ["--key", "List"]))
def test_non_json_input_is_an_error(tmp_path, flag, option):
    """O-9 O-14"""
    db = str(tmp_path / "data.db")
    # Content that imports cleanly under `flag` alone, so ignoring the option fails the test.
    content = '{"id": 1}\n' if flag == "--nl" else "id,name\n1,Cleo\n"
    src = _write(tmp_path, "d.txt", content)
    assert _invoke(["insert", db, "plain", src, flag]).exit_code == 0
    _clean_error(_invoke(["insert", db, "t", src, flag] + option))


@pytest.mark.parametrize("fmt", (Format.CSV, Format.TSV, Format.NL))
def test_rows_from_file_explicit_non_json_format_raises(fmt):
    """O-9"""
    with pytest.raises(ValueError):
        rows, _ = rows_from_file(io.BytesIO(b"id,name\n1,Cleo\n"), format=fmt, key="x")
        list(rows)


def test_rows_from_file_detected_csv_is_unchanged():
    """O-9"""
    rows, fmt = rows_from_file(io.BytesIO(b"id,name\n1,Cleo\n"), auto_key=True)
    assert fmt == Format.CSV
    assert list(rows) == [{"id": "1", "name": "Cleo"}]


def test_empty_list_under_key_is_zero_rows(tmp_path):
    """O-10"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "d.json", {"List": [], "Version": "1"})
    result = _invoke(["insert", db, "t", src, "--key", "List"])
    assert result.exit_code == 0, result.output
    assert _rows(db, "t") == []


# --- O-11, O-12: composition and stdin ----------------------------------------------------


def test_flatten_applies_to_extracted_rows(tmp_path):
    """O-11"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "d.json", {"items": [{"id": 1, "a": {"b": 2}}]})
    result = _invoke(["insert", db, "t", src, "--key", "items", "--flatten"])
    assert result.exit_code == 0, result.output
    assert _rows(db, "t") == [{"id": 1, "a_b": 2}]


def test_pk_and_stop_after_apply_to_extracted_rows(tmp_path):
    """O-11"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "example.json", EXAMPLE)
    result = _invoke(
        ["insert", db, "t", src, "--auto-key", "--pk", "Id", "--stop-after", "1"]
    )
    assert result.exit_code == 0, result.output
    assert Database(db)["t"].pks == ["Id"]
    assert len(_rows(db, "t")) == 1


def test_convert_applies_to_extracted_rows(tmp_path):
    """O-11"""
    db = str(tmp_path / "data.db")
    src = _write(tmp_path, "example.json", EXAMPLE)
    result = _invoke(
        [
            "insert",
            db,
            "t",
            src,
            "--key",
            "List",
            "--convert",
            'row["Description"] = row["Description"].upper()',
        ]
    )
    assert result.exit_code == 0, result.output
    assert sorted(r["Description"] for r in _rows(db, "t")) == [
        "NONPARTISAN",
        "UNDECLARED",
    ]


def test_stdin_auto_key(tmp_path):
    """O-12"""
    db = str(tmp_path / "data.db")
    result = _invoke(["insert", db, "t", "-", "--auto-key"], input=json.dumps(EXAMPLE))
    assert result.exit_code == 0, result.output
    assert _rows(db, "t") == EXAMPLE["List"]


def test_memory_stdin_key():
    """O-12 O-13"""
    result = _invoke(
        ["memory", "-", "select count(*) as n from stdin", "--key", "List"],
        input=json.dumps(EXAMPLE),
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.output) == [{"n": 2}]


# --- O-15: docs --------------------------------------------------------------------------

DOCS = pathlib.Path(__file__).parent.parent / "docs"


def test_docs_cli_reference_regenerated():
    """O-15"""
    text = (DOCS / "cli-reference.rst").read_text()
    assert "--auto-key" in text and "--key" in text


def test_docs_cli_and_python_api_mention_options():
    """O-15"""
    assert "--auto-key" in (DOCS / "cli.rst").read_text()
    assert "auto_key" in (DOCS / "python-api.rst").read_text()
