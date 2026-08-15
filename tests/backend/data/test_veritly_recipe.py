import io
import json
import shutil
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from openpyxl import Workbook as ExcelWorkbook

from data_formulator.veritly_recipe import RecipeError, execute
from data_formulator.veritly_worker import app


def parquet(path: Path, rows: list[dict[str, object]]) -> Path:
    pq.write_table(pa.Table.from_pylist(rows), path, compression="zstd")
    return path


def source(cid: str, output: str, after: list[str] | None = None) -> dict[str, object]:
    return {"id": cid, "after": after or [], "kind": "source", "output": output}


def flow(cid: str, kind: str, source: str, output: str, after: list[str], **values) -> dict[str, object]:
    return {"id": cid, "after": after, "kind": kind, "input": source, "output": output, **values}


def output(cid: str, source: str, after: list[str], cls: str = "entity", owners=None, keys=None) -> dict[str, object]:
    return {
        "id": cid,
        "after": after,
        "kind": "output",
        "input": source,
        "schema": "sales_12345678",
        "table": "transactions",
        "class": cls,
        "keys": (["Customer ID"] if cls == "entity" else []) if keys is None else keys,
        "owners": owners or {},
    }


def rows(path: Path) -> list[dict[str, object]]:
    return pq.read_table(path).to_pylist()


def run(root: Path, inputs: dict[str, Path], commands: list[dict[str, object]], output: str, **opts):
    root.mkdir()
    staged = {}
    for offset, (name, path) in enumerate(inputs.items()):
        target = root / f"input-{offset}.parquet"
        shutil.copyfile(path, target)
        staged[name] = target
    return execute(root, staged, commands, output, **opts)


def test_cellwise_recipe_preserves_rows_ids_types_and_formula_lineage(tmp_path: Path):
    raw = parquet(tmp_path / "raw.parquet", [
        {"Customer ID": "C1", "Name": " alice ", "Amount": "1.234,50", "Day": "31/12/2025", "When": "2025-12-31 10:00", "Region": "EU", "Formula": "2"},
        {"Customer ID": "C2", "Name": "BOB", "Amount": "2.000,00", "Day": "01/01/2026", "When": "2026-01-01 11:00", "Region": None, "Formula": "4"},
        {"Customer ID": "C3", "Name": "carol", "Amount": "3,25", "Day": "02/01/2026", "When": "2026-01-02 12:00", "Region": "US", "Formula": "6"},
    ])
    commands = [
        source("source", "raw"),
        flow("key", "key", "raw", "keyed", ["source"], key={"strategy": "existing", "columns": ["Customer ID"]}),
        flow("trim", "trim", "keyed", "trimmed", ["key"], columns=["Name"]),
        flow("case", "case", "trimmed", "cased", ["trim"], columns=["Name"], mode="title"),
        flow("replace", "replace", "cased", "replaced", ["case"], column="Region", find="US", replacement="NA", exact=True),
        flow("null", "null", "replaced", "nulled", ["replace"], columns=["Region"], values=[None, ""]),
        flow("fill", "fill", "nulled", "filled", ["null"], columns=["Region"], mode="down"),
        flow("cast", "cast", "filled", "casted", ["fill"], columns=[
            {"column": "Amount", "type": "decimal", "locale": "de-DE", "invalid": "reject"},
            {"column": "Day", "type": "date", "locale": "en-GB", "invalid": "reject"},
            {"column": "When", "type": "timestamp", "timezone": "Atlantic/Reykjavik", "invalid": "reject"},
        ]),
        flow("rename", "rename", "casted", "renamed", ["cast"], columns={"Amount": "Revenue"}),
        flow("reorder", "reorder", "renamed", "ordered", ["rename"], columns=[
            "Customer ID", "Name", "Revenue", "Day", "When", "Region", "Formula",
        ]),
        output("final", "ordered", ["reorder"], owners={"Revenue": "shared"}),
    ]
    lineage = {"raw": {"Formula": {"owner": "formula", "formula": "=C2*2", "stale": True, "staleCount": 1}}}
    one = run(tmp_path / "one", {"raw": raw}, commands, "final", lineage=lineage, writeback=True)
    two = run(tmp_path / "two", {"raw": raw}, commands, "final", lineage=lineage, writeback=True)
    left = rows(one.path)
    right = rows(two.path)
    assert len(left) == 3
    assert [item["_veritly_id"] for item in left] == [item["_veritly_id"] for item in right]
    assert [item["Name"] for item in left] == ["Alice", "Bob", "Carol"]
    assert [item["Revenue"] for item in left] == [1234.5, 2000.0, 3.25]
    assert [item["Region"] for item in left] == ["EU", "EU", "NA"]
    assert one.manifest["rows"] == 3
    assert one.manifest["rowPolicy"] == "preserved"
    key = next(item for item in one.manifest["columns"] if item["name"] == "Customer ID")
    assert key["key"] is True
    formula = next(item for item in one.manifest["columns"] if item["name"] == "Formula")
    assert formula["owner"] == "formula"
    assert formula["formula"] == "=C2*2"
    assert formula["formulaStale"] is True
    assert one.manifest["diagnostics"] == [{
        "code": "formula_stale", "severity": "error", "column": "Formula",
        "count": 1, "command": "source",
    }]
    assert b"veritly.recipe" in pq.read_metadata(one.path).metadata


def test_explicit_row_changes_and_derived_columns_are_visible_and_not_writeback(tmp_path: Path):
    raw = parquet(tmp_path / "raw.parquet", [
        {"Name": "A-One", "Amount": 1},
        {"Name": "A-One", "Amount": 2},
        {"Name": "B-Two", "Amount": 3},
    ])
    commands = [
        source("source", "raw"),
        flow("key", "key", "raw", "keyed", ["source"], key={"strategy": "generated", "name": "Veritly ID"}),
        flow("split", "split", "keyed", "splitset", ["key"], column="Name", separator="-", columns=["Code", "Label"]),
        flow("merge", "merge", "splitset", "merged", ["split"], columns=["Code", "Label"], separator=":", column="Combined"),
        flow("derive", "derive", "merged", "derived", ["merge"], columns=[
            {"name": "Double", "type": "integer", "expression": '"Amount" * 2'},
        ]),
        flow("filter", "filter", "derived", "filtered", ["derive"], expression='"Amount" >= 2'),
        flow("dedupe", "dedupe", "filtered", "deduped", ["filter"], columns=["Name"], keep="first"),
        flow("validate", "validate", "deduped", "validated", ["dedupe"], rules=[
            {"kind": "required", "column": "Combined"},
            {"kind": "range", "column": "Double", "min": 5},
        ]),
        output(
            "final", "validated", ["validate"], owners={"Veritly ID": "workbook"}, keys=["Veritly ID"],
        ),
    ]
    result = run(tmp_path / "run", {"raw": raw}, commands, "final")
    data = rows(result.path)
    assert len(data) == 2
    assert all(uuid_like(item["Veritly ID"]) for item in data)
    assert all(item["Veritly ID"] == str(item["_veritly_id"]) for item in data)
    assert data[0]["Combined"] == "A:One"
    visible = next(item for item in result.manifest["columns"] if item["name"] == "Veritly ID")
    assert visible["system"] is True
    assert visible["key"] is True
    assert result.manifest["rowPolicy"] == "filtered"
    assert result.manifest["writeback"] is False
    assert result.manifest["diagnostics"] == [{
        "code": "validation", "severity": "error", "rule": 1,
        "kind": "range", "count": 1, "command": "validate",
    }]
    with pytest.raises(RecipeError, match="Write-back is not invertible") as error:
        run(tmp_path / "blocked", {"raw": raw}, commands, "final", writeback=True)
    assert error.value.code == "mapping_not_invertible"


def test_join_union_pivot_and_unpivot_are_bounded_derived_outputs(tmp_path: Path):
    sales = parquet(tmp_path / "sales.parquet", [
        {"Customer ID": "C1", "Region": "EU", "Quarter": "Q1", "Amount": 10},
        {"Customer ID": "C2", "Region": "EU", "Quarter": "Q2", "Amount": 20},
    ])
    customers = parquet(tmp_path / "customers.parquet", [
        {"Customer ID": "C1", "Name": "Alice"},
        {"Customer ID": "C2", "Name": "Bob"},
    ])
    commands = [
        source("sales-source", "sales"),
        source("sales-source-2", "sales2"),
        source("customer-source", "customers"),
        {"id": "join", "after": ["sales-source", "customer-source"], "kind": "join", "left": "sales", "right": "customers", "output": "joined", "mode": "left", "on": [{"left": "Customer ID", "right": "Customer ID"}]},
        output("join-output", "joined", ["join"], "derived"),
        {"id": "union", "after": ["sales-source", "sales-source-2"], "kind": "union", "inputs": ["sales", "sales2"], "output": "unioned", "distinct": True},
        output("union-output", "unioned", ["union"], "derived"),
        flow("pivot", "pivot", "sales", "pivoted", ["sales-source"], rows=["Region"], columns=["Quarter"], values=[{"column": "Amount", "aggregate": "sum"}]),
        flow("unpivot", "unpivot", "pivoted", "long", ["pivot"], keys=["Region"], columns=["Q1", "Q2"], name="Quarter Name", value="Quarter Value"),
        output("pivot-output", "long", ["unpivot"], "derived"),
    ]
    inputs = {"sales": sales, "sales2": sales, "customers": customers}
    joined = run(tmp_path / "join", inputs, commands, "join-output")
    assert [item["Name"] for item in rows(joined.path)] == ["Alice", "Bob"]
    unioned = run(tmp_path / "union", inputs, commands, "union-output")
    assert len(rows(unioned.path)) == 2
    pivoted = run(tmp_path / "pivot", inputs, commands, "pivot-output")
    assert {(item["Quarter Name"], item["Quarter Value"]) for item in rows(pivoted.path)} == {("Q1", 10), ("Q2", 20)}
    assert pivoted.manifest["rowPolicy"] == "derived"


def test_rejects_external_sql_code_and_unbounded_outputs(tmp_path: Path):
    raw = parquet(tmp_path / "raw.parquet", [{"ID": "1"}, {"ID": "2"}])
    unsafe = [
        source("source", "raw"),
        flow("filter", "filter", "raw", "filtered", ["source"], expression="exists(select * from read_parquet('/etc/passwd'))"),
        output("final", "filtered", ["filter"], "derived"),
    ]
    with pytest.raises(RecipeError, match="unsupported SQL syntax"):
        run(tmp_path / "unsafe", {"raw": raw}, unsafe, "final")
    bounded = [source("source", "raw"), output("final", "raw", ["source"], "derived")]
    with pytest.raises(RecipeError, match="exceeds 1 rows"):
        run(tmp_path / "bounded", {"raw": raw}, bounded, "final", rows=1)
    code = [
        source("source", "raw"),
        {"id": "code", "after": ["source"], "kind": "code", "inputs": ["raw"], "output": "coded", "language": "python", "source": "pass", "signature": "sha256:" + "a" * 64, "columns": []},
        output("final", "coded", ["code"], "derived"),
    ]
    with pytest.raises(RecipeError, match="gVisor") as error:
        run(tmp_path / "code", {"raw": raw}, code, "final")
    assert error.value.code == "mapping_not_invertible"


def test_execute_endpoint_streams_manifest_then_typed_ndjson(tmp_path: Path, monkeypatch):
    raw = parquet(tmp_path / "raw.parquet", [{"Customer ID": "C1", "Amount": "10"}])
    commands = [
        source("source", "raw"),
        flow("key", "key", "raw", "keyed", ["source"], key={"strategy": "existing", "columns": ["Customer ID"]}),
        flow("cast", "cast", "keyed", "casted", ["key"], columns=[{"column": "Amount", "type": "integer", "invalid": "reject"}]),
        output("final", "casted", ["cast"]),
    ]
    monkeypatch.setenv("DATA_WORKER_TOKEN", "secret")
    client = app.test_client()
    response = client.post(
        "/execute",
        data={
            "recipe": json.dumps({"inputs": ["raw"], "commands": commands, "output": "final"}),
            "file": (io.BytesIO(raw.read_bytes()), "raw.parquet"),
        },
        headers={"x-veritly-service-token": "secret", "accept": "application/x-ndjson"},
        content_type="multipart/form-data",
    )
    assert response.status_code == 200
    assert response.content_type.startswith("application/x-ndjson")
    lines = [json.loads(line) for line in response.get_data(as_text=True).splitlines()]
    assert lines[0]["$veritly"]["rows"] == 1
    assert lines[1]["Amount"] == 10
    assert uuid_like(lines[1]["_veritly_id"])
    assert len(response.headers["X-Veritly-Recipe-Sha256"]) == 64


def test_locate_endpoint_streams_physical_rows_and_skips_side_clutter(monkeypatch):
    book = ExcelWorkbook()
    sheet = book.active
    sheet.title = "Rows"
    sheet.append(["Customer", "Veritly ID", "Side"])
    sheet.append(["Ada", "20e7a402-6567-5d3e-949f-b5cfe6a46ab2", None])
    sheet.append([None, None, "unrelated"])
    sheet.append(["Grace", None, None])
    data = io.BytesIO()
    book.save(data)
    monkeypatch.setenv("DATA_WORKER_TOKEN", "secret")
    response = app.test_client().post(
        "/locate",
        data={
            "selection": json.dumps({"sheet": "Rows", "header": 1, "start": 2, "end": 4, "left": 1, "right": 2}),
            "identity": "Veritly ID",
            "file": (io.BytesIO(data.getvalue()), "rows.xlsx"),
        },
        headers={"x-veritly-service-token": "secret"},
        content_type="multipart/form-data",
    )
    assert response.status_code == 200
    lines = [json.loads(line) for line in response.get_data(as_text=True).splitlines()]
    assert lines == [
        {"$veritly": {"columns": ["Customer", "Veritly ID"]}},
        {"row": 1, "id": "20e7a402-6567-5d3e-949f-b5cfe6a46ab2"},
        {"row": 3, "id": None},
    ]


def test_metrics_endpoint_is_public_and_prometheus_compatible():
    response = app.test_client().get("/metrics")
    assert response.status_code == 200
    assert response.content_type.startswith("text/plain")
    assert "veritly_data_worker_up 1" in response.get_data(as_text=True)


@pytest.mark.parametrize("count", [100_000, 1_000_000])
def test_large_transaction_fixtures_preserve_every_physical_row(tmp_path: Path, count: int):
    raw = tmp_path / f"transactions-{count}.parquet"
    pq.write_table(
        pa.table({
            "Transaction ID": pa.array(range(count), type=pa.int64()),
            "Amount": pa.array(range(count), type=pa.int64()),
        }),
        raw,
        compression="zstd",
    )
    commands = [
        source("source", "raw"),
        flow("key", "key", "raw", "keyed", ["source"], key={"strategy": "existing", "columns": ["Transaction ID"]}),
        output("final", "keyed", ["key"], keys=["Transaction ID"]),
    ]
    result = run(tmp_path / f"scale-{count}", {"raw": raw}, commands, "final")
    assert result.manifest["rows"] == count
    assert result.manifest["rowPolicy"] == "preserved"
    assert pq.ParquetFile(result.path).metadata.num_rows == count


def uuid_like(value: object) -> bool:
    import re
    return isinstance(value, str) and bool(re.fullmatch(r"[0-9a-f-]{36}", value, re.I))
