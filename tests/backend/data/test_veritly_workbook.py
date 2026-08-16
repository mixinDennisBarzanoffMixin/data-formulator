import io
import re
import zipfile

from openpyxl import Workbook
from openpyxl.styles import PatternFill

from data_formulator.veritly_worker import app


def xlsx() -> bytes:
    book = Workbook()
    rows = book.active
    rows.title = "Transactions"
    for row in [
        ("Customer", "Amount", "Booked"),
        ("Ada", 42, "2026-01-01"),
        ("Lin", 18, "2026-01-02"),
        ("Sam", 27, "2026-01-03"),
        ("Mia", 33, "=C5+6"),
    ]:
        rows.append([None, *row])
    rows["H2"] = "Code"
    rows["I2"] = "Label"
    rows["H3"] = "A"
    rows["I3"] = "Side lookup"
    rows["F20"] = "Unrelated note"
    rows["K100"].fill = PatternFill(fill_type="solid", fgColor="FFFF00")
    hidden = book.create_sheet("Reference")
    hidden.sheet_state = "hidden"
    hidden["C4"] = "code"
    secret = book.create_sheet("Internal")
    secret.sheet_state = "veryHidden"
    secret["A3"] = "private"
    data = io.BytesIO()
    book.save(data)
    return data.getvalue()


def unsized() -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(xlsx())) as source, zipfile.ZipFile(output, "w") as target:
        for item in source.infolist():
            data = source.read(item)
            if item.filename == "xl/worksheets/sheet1.xml":
                data, count = re.subn(br"<dimension[^>]*/>", b"", data, count=1)
                assert count == 1
            target.writestr(item, data)
    return output.getvalue()


def test_workbook_catalog_returns_only_bounded_sheet_metadata(monkeypatch):
    monkeypatch.setenv("DATA_WORKER_TOKEN", "secret")
    response = app.test_client().post(
        "/workbook",
        data={"file": (io.BytesIO(xlsx()), "rows.xlsx")},
        headers={"x-veritly-service-token": "secret"},
        content_type="multipart/form-data",
    )
    assert response.status_code == 200
    assert response.get_json() == {
        "sheets": [
            {
                "name": "Transactions",
                "rows": {"start": 1, "end": 100},
                "columns": {"start": 1, "end": 11},
                "visibility": "visible",
                "regions": [
                    {"header": 1, "start": 2, "end": 5, "left": 2, "right": 4},
                    {"header": 2, "start": 3, "end": 3, "left": 8, "right": 9},
                ],
            },
            {
                "name": "Reference",
                "rows": {"start": 4, "end": 4},
                "columns": {"start": 3, "end": 3},
                "visibility": "hidden",
                "regions": [],
            },
            {
                "name": "Internal",
                "rows": {"start": 3, "end": 3},
                "columns": {"start": 1, "end": 1},
                "visibility": "veryHidden",
                "regions": [],
            },
        ]
    }


def test_workbook_catalog_streams_dimensions_when_the_xlsx_omits_them(monkeypatch):
    monkeypatch.setenv("DATA_WORKER_TOKEN", "secret")
    response = app.test_client().post(
        "/workbook",
        data={"file": (io.BytesIO(unsized()), "unsized.xlsx")},
        headers={"x-veritly-service-token": "secret"},
        content_type="multipart/form-data",
    )
    assert response.status_code == 200
    assert response.get_json()["sheets"][0] == {
        "name": "Transactions",
        "rows": {"start": 1, "end": 100},
        "columns": {"start": 1, "end": 11},
        "visibility": "visible",
        "regions": [
            {"header": 1, "start": 2, "end": 5, "left": 2, "right": 4},
            {"header": 2, "start": 3, "end": 3, "left": 8, "right": 9},
        ],
    }


def test_workbook_catalog_requires_service_authentication(monkeypatch):
    monkeypatch.setenv("DATA_WORKER_TOKEN", "secret")
    response = app.test_client().post(
        "/workbook",
        data={"file": (io.BytesIO(xlsx()), "rows.xlsx")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 401


def test_workbook_catalog_audits_archive_paths_before_opening(monkeypatch):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        archive.writestr("../outside.xml", "unsafe")
    monkeypatch.setenv("DATA_WORKER_TOKEN", "secret")
    response = app.test_client().post(
        "/workbook",
        data={"file": (io.BytesIO(data.getvalue()), "unsafe.xlsx")},
        headers={"x-veritly-service-token": "secret"},
        content_type="multipart/form-data",
    )
    assert response.status_code == 400
    assert response.get_json() == {"error": "XLSX archive contains an unsafe path"}
