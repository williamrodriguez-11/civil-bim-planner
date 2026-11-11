import os
import tempfile
import unittest
from datetime import date
from io import BytesIO
from pathlib import Path
from unittest.mock import patch
from xml.etree import ElementTree as ET

import xlwt
from fastapi.testclient import TestClient
from openpyxl import Workbook, load_workbook

from planner_api.main import app
from planner_api.models import Plan
from planner_api.planning import schedule

ROOT = Path(__file__).resolve().parents[1]


class Workflow(unittest.TestCase):
    def setUp(self):
        self.tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(
            patch.dict(
                os.environ, CIVIL_BIM_DB=str(Path(self.tmp) / "synthetic.sqlite3")
            )
        )
        self.client = self.enterContext(TestClient(app))
        self.credentials = {
            "username": "propietaria",
            "password": "frase de prueba sintética",
        }
        self.assertEqual(
            self.client.post("/api/auth/register", json=self.credentials).status_code,
            201,
        )
        self.base = "/api/projects/" + str(
            self.client.post("/api/projects", json={"name": "Prueba sintética"}).json()[
                "id"
            ]
        )

    def headers(self):
        return {
            "If-Match": str(self.client.get(self.base).json()["project"]["revision"])
        }

    def test_two_accounts_files_trash_and_second_computer(self):
        sid = self.load("solo-mia.csv", b"Nivel;Volumen\nN1;2")
        file_url = self.base + f"/tables/{sid}/original"
        with TestClient(app) as other:
            self.assertEqual(other.get(file_url).status_code, 401)
            self.assertEqual(other.get("/api/projects").status_code, 401)
            self.assertEqual(
                other.post(
                    "/api/auth/register",
                    json={
                        "username": "segunda",
                        "password": "otra cuenta para la prueba",
                    },
                ).status_code,
                201,
            )
            self.assertEqual(other.get("/api/projects?include_deleted=true").json(), [])
            for path in (
                "",
                f"/tables/{sid}",
                f"/tables/{sid}/original",
                "/schedule.xml",
                "/reports/1",
            ):
                self.assertEqual(other.get(self.base + path).status_code, 404)
            self.assertEqual(
                other.delete(self.base, headers=self.headers()).status_code, 404
            )
            self.assertEqual(
                self.client.delete(self.base, headers=self.headers()).status_code, 200
            )
            self.assertEqual(other.get("/api/projects?include_deleted=true").json(), [])
            self.assertEqual(
                other.post(
                    self.base + "/restore", headers={"If-Match": "3"}
                ).status_code,
                404,
            )
            self.assertEqual(
                other.post("/api/auth/login", json=self.credentials).status_code, 200
            )
            self.assertEqual(
                len(other.get("/api/projects?include_deleted=true").json()), 1
            )
            token = other.cookies.get("civil_session")
            self.assertEqual(other.post("/api/auth/logout").status_code, 200)
            other.cookies.set("civil_session", token)
            self.assertEqual(other.get("/api/projects").status_code, 401)

    def load(self, name, data, options="{}"):
        response = self.client.post(
            self.base + "/tables",
            headers=self.headers(),
            files={"file": (name, data)},
            data={"options": options},
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()["id"]

    def mapping(self, sid, m):
        return self.client.put(
            self.base + f"/tables/{sid}/mapping?template=Prueba",
            json=m,
            headers=self.headers(),
        )

    def test_reference_project_and_archived_report(self):
        for category in ["Columnas", "Vigas", "Losas", "Muros"]:
            path = ROOT / "examples" / (category.lower() + ".csv")
            sid = self.load(path.name, path.read_bytes())
            m = {
                "category": category,
                "mode": "direct",
                "fields": {"level": "Nivel", "count": "Cantidad", "volume": "Volumen"},
                "units": {"volume": "m³"},
                "decimal": ",",
                "direct_basis": "row_total",
            }
            self.assertEqual(self.mapping(sid, m).status_code, 200)
        state = self.client.get(self.base).json()
        rows = [r for result in state["results"].values() for r in result["detail"]]
        self.assertEqual(sum(r["Elementos"] for r in rows), 10)
        self.assertAlmostEqual(sum(r["Volumen (m³)"] for r in rows), 36.4)
        report = self.client.post(self.base + "/reports", headers=self.headers())
        self.assertEqual(report.status_code, 201, report.text)
        url = self.base + "/reports/" + str(report.json()["id"])
        content = self.client.get(url).content
        reopened = load_workbook(BytesIO(content), data_only=True)
        self.assertEqual(reopened["Proyecto"]["B2"].value, "Prueba sintética")
        self.assertIn("Fuente 4", reopened.sheetnames)
        self.assertEqual(len(reopened["Detalle"]["A"]), len(rows) + 1)
        with TestClient(app) as restarted:
            self.assertEqual(
                restarted.post("/api/auth/login", json=self.credentials).status_code,
                200,
            )
            self.assertEqual(
                restarted.get(self.base).json()["results"], state["results"]
            )
            self.assertEqual(restarted.get(url).content, content)

    def test_trash_and_restore_preserve_project_contents_and_isolation(self):
        raw = b"Nivel;Volumen\nN1;2"
        sid = self.load("fuente.csv", raw)
        self.assertEqual(
            self.mapping(
                sid,
                {
                    "category": "Columnas",
                    "mode": "direct",
                    "decimal": ",",
                    "direct_basis": "row_total",
                    "fields": {"level": "Nivel", "volume": "Volumen"},
                    "units": {"volume": "m³"},
                },
            ).status_code,
            200,
        )
        plan = {
            "start": "2026-01-05",
            "tasks": [{"id": 1, "name": "Columnas", "wbs": "1", "duration": 2}],
        }
        self.assertEqual(
            self.client.put(
                self.base + "/plan", headers=self.headers(), json=plan
            ).status_code,
            200,
        )
        rid = self.client.post(self.base + "/reports", headers=self.headers()).json()[
            "id"
        ]
        report_url = self.base + f"/reports/{rid}"
        original_report = self.client.get(report_url).content
        other = self.client.post("/api/projects", json={"name": "Otra obra"}).json()[
            "id"
        ]
        before = self.client.get(self.base).json()
        revision = before["project"]["revision"]
        self.assertEqual(
            self.client.delete(
                self.base, headers={"If-Match": str(revision - 1)}
            ).status_code,
            409,
        )
        self.assertEqual(
            self.client.delete(self.base, headers=self.headers()).status_code, 200
        )
        self.assertEqual(
            [p["id"] for p in self.client.get("/api/projects").json()], [other]
        )
        for path in [
            "",
            f"/tables/{sid}",
            f"/tables/{sid}/original",
            "/schedule.xml",
            f"/reports/{rid}",
        ]:
            self.assertEqual(self.client.get(self.base + path).status_code, 404, path)
        self.assertEqual(
            self.client.put(
                self.base + "/plan", json=plan, headers={"If-Match": str(revision + 1)}
            ).status_code,
            404,
        )

        with TestClient(app) as restarted:
            self.assertEqual(
                restarted.post("/api/auth/login", json=self.credentials).status_code,
                200,
            )
            trash = [
                p
                for p in restarted.get("/api/projects?include_deleted=true").json()
                if p["deleted_at"]
            ]
            self.assertEqual([p["id"] for p in trash], [before["project"]["id"]])
            restore = self.base + "/restore"
            self.assertEqual(
                restarted.post(
                    restore, headers={"If-Match": str(revision)}
                ).status_code,
                409,
            )
            self.assertEqual(
                restarted.post(
                    restore, headers={"If-Match": str(trash[0]["revision"])}
                ).status_code,
                200,
            )
            after = restarted.get(self.base).json()
            self.assertIsNone(after["project"]["deleted_at"])
            self.assertEqual(after["project"]["revision"], revision + 2)
            for field in [
                "tables",
                "results",
                "plan",
                "schedule",
                "templates",
                "reports",
            ]:
                self.assertEqual(after[field], before[field], field)
            self.assertEqual(
                restarted.get(self.base + f"/tables/{sid}/original").content, raw
            )
            self.assertEqual(restarted.get(report_url).content, original_report)

    def test_xls_and_header_preview(self):
        book = xlwt.Workbook()
        book.add_sheet("Portada").write(0, 0, "Título")
        sheet = book.add_sheet("Partidas")
        for i, row in enumerate(
            [["Obra sintética"], ["Planta", "Medición"], ["Sótano", 2.25]]
        ):
            for j, v in enumerate(row):
                sheet.write(i, j, v)
        out = BytesIO()
        book.save(out)
        resp = self.client.post(
            "/api/preview",
            files={"file": ("Sintético.xls", out.getvalue())},
            data={"options": '{"sheet":"Partidas"}', "detect": "true"},
        ).json()
        self.assertEqual(resp["sheets"], ["Portada", "Partidas"])
        self.assertEqual(resp["options"]["header_row"], 2)
        self.assertEqual(
            resp["table"]["rows"], [{"Planta": "Sótano", "Medición": 2.25}]
        )

    def test_revit_schedule_preserves_source_rows_and_manual_headers(self):
        book = Workbook()
        schedule = book.active
        schedule.title = "Column Schedule"
        for row in [
            ["Column1", "Column2", "Column3"],
            [schedule.title],
            ["Base Level", "Top Level", "Volume"],
            [],
            ["Ground", "First", "0.34 m³"],
            ["Ground", "First", "0.34 m³"],
            ["Grand total: 2"],
        ]:
            schedule.append(row)
        ordinary = book.create_sheet("Inventario")
        ordinary.append(["Column1", "Column2"])
        ordinary.append(["Entrada parcial"])
        ordinary.append(["Acero", "Almacén"])
        out = BytesIO()
        book.save(out)
        files = {"file": ("prueba.xlsx", out.getvalue())}

        def preview(options, detect):
            return self.client.post(
                "/api/preview", files=files, data={"options": options, "detect": detect}
            ).json()

        detected = preview("{}", "true")
        self.assertEqual(detected["options"]["header_row"], 3)
        self.assertEqual(
            detected["table"]["columns"], ["Base Level", "Top Level", "Volume"]
        )
        self.assertEqual(detected["table"]["indexes"], [5, 6, 7])
        self.assertEqual(detected["table"]["duplicates"], 2)
        self.assertEqual(
            preview('{"header_row":1}', "false")["table"]["indexes"], [2, 3, 5, 6, 7]
        )
        generic = preview('{"sheet":"Inventario"}', "true")
        self.assertEqual(generic["options"]["header_row"], 1)
        self.assertEqual(generic["table"]["indexes"], [2, 3])

    def test_duplicates_revision_isolation_and_rejections(self):
        data = b"Planta;V\nP1;2\nP1;error"
        stale = self.headers()
        sid = self.load("source.csv", data)
        self.assertEqual(
            self.client.put(
                self.base, headers=stale, json={"name": "Antiguo"}
            ).status_code,
            409,
        )
        self.assertEqual(
            self.client.post(
                self.base + "/tables",
                headers=self.headers(),
                files={"file": ("otro.csv", data)},
                data={"options": "{}"},
            ).status_code,
            409,
        )
        m = {
            "category": "Zapatas",
            "mode": "direct",
            "fields": {"level": "Planta", "volume": "V"},
            "units": {},
            "decimal": ",",
            "direct_basis": "row_total",
        }
        self.assertEqual(self.mapping(sid, m).status_code, 422)
        m["units"] = {"volume": "m³"}
        self.assertEqual(self.mapping(sid, m).status_code, 200)
        state = self.client.get(self.base).json()
        self.assertEqual(len(state["results"][str(sid)]["issues"]), 1)
        other = self.client.post(
            "/api/projects", json={"name": "Otro sintético"}
        ).json()["id"]
        self.assertEqual(
            self.client.get(f"/api/projects/{other}/tables/{sid}").status_code, 404
        )
        self.assertEqual(
            self.client.post(
                "/api/projects",
                headers={"Origin": "https://externo.example"},
                json={"name": "x"},
            ).status_code,
            403,
        )

    def test_live_quantity_link_and_xml(self):
        sid = self.load("pile.csv", b"N;V\nPB;12")
        m = {
            "category": "Pilotes",
            "mode": "direct",
            "fields": {"level": "N", "volume": "V"},
            "units": {"volume": "m³"},
            "decimal": ",",
            "direct_basis": "row_total",
        }
        self.mapping(sid, m).raise_for_status()
        payload = {
            "start": "2026-11-06",
            "holidays": ["2026-11-09"],
            "tasks": [
                {
                    "id": 1,
                    "name": "Perforar",
                    "wbs": "1.1",
                    "quantity": {"table": sid, "rate": 5, "unit": "m³"},
                },
                {
                    "id": 2,
                    "name": "Verificar",
                    "wbs": "1.2",
                    "links": [{"predecessor": 1, "relation": "FS", "lag": 1}],
                },
            ],
        }
        self.client.put(
            self.base + "/plan", headers=self.headers(), json=payload
        ).raise_for_status()
        state = self.client.get(self.base).json()
        a, b = state["schedule"]
        blocked = self.client.delete(
            self.base + f"/tables/{sid}", headers=self.headers()
        )
        self.assertEqual(blocked.status_code, 409)
        self.assertIn("1.1 Perforar", blocked.json()["detail"])
        self.assertEqual(self.client.get(self.base).json(), state)
        self.assertEqual(
            (a["duration"], a["finish"], b["start"]), (3, "2026-11-11", "2026-11-13")
        )
        xml = ET.fromstring(self.client.get(self.base + "/schedule.xml").content)
        ns = {"p": "http://schemas.microsoft.com/project/2007"}
        self.assertEqual(xml.findtext(".//p:LinkLag", namespaces=ns), "4800")
        self.assertEqual(
            xml.findtext(".//p:FromDate", namespaces=ns), "2026-11-09T00:00:00"
        )
        m["units"] = {"volume": "ft³"}
        self.mapping(sid, m).raise_for_status()
        self.assertEqual(
            self.client.get(self.base).json()["schedule"][0]["duration"], 1
        )
        m["excluded_rows"] = [2]
        self.assertEqual(self.mapping(sid, m).status_code, 422)
        self.assertEqual(
            self.client.get(self.base).json()["schedule"][0]["duration"], 1
        )

    def test_table_trash_preserves_original_and_excludes_quantities_from_new_reports(
        self,
    ):
        raw = b"Nivel;Volumen;ID\nN1;5;A"
        sid = self.load("primera.csv", raw)
        other = self.load("segunda.csv", b"Nivel;Volumen;ID\nN1;1;B")
        dest = self.base + f"/tables/{sid}"
        mapping = {
            "category": "Columnas",
            "mode": "direct",
            "decimal": ",",
            "direct_basis": "row_total",
            "fields": {"level": "Nivel", "volume": "Volumen", "id": "ID"},
            "units": {"volume": "m³"},
        }
        for table in (sid, other):
            self.mapping(table, mapping).raise_for_status()

        def make_report():
            reports = self.base + "/reports"
            rid = self.client.post(reports, headers=self.headers()).json()["id"]
            return reports + "/" + str(rid)

        archived = make_report()
        archived_bytes = self.client.get(archived).content
        before = self.client.get(self.base).json()
        self.assertEqual(
            self.client.delete(dest, headers={"If-Match": "0"}).status_code, 409
        )
        self.client.delete(dest, headers=self.headers()).raise_for_status()
        current = self.client.get(self.base).json()
        self.assertEqual([s["id"] for s in current["tables"]], [other])
        self.assertEqual([s["id"] for s in current["trashed_tables"]], [sid])
        self.assertEqual(set(current["results"]), {str(other)})
        self.assertEqual(self.client.get(dest + "/original").status_code, 404)
        self.assertEqual(self.mapping(sid, mapping).status_code, 404)
        duplicate = self.client.post(
            self.base + "/tables",
            files={"file": ("copia.csv", raw)},
            headers=self.headers(),
            data={"options": "{}"},
        )
        self.assertEqual(duplicate.status_code, 409)
        self.assertIn("papelera", duplicate.json()["detail"])
        new_report = load_workbook(
            BytesIO(self.client.get(make_report()).content), data_only=True
        )
        self.assertNotIn(f"Fuente {sid}", new_report.sheetnames)
        self.assertIn(f"Fuente {other}", new_report.sheetnames)
        self.assertEqual(self.client.get(archived).content, archived_bytes)
        overlap = self.load("nueva.csv", b"Nivel;Volumen;ID\nN2;4;A")
        self.mapping(overlap, mapping).raise_for_status()
        self.assertEqual(
            self.client.post(dest + "/restore", headers=self.headers()).status_code, 422
        )
        self.client.delete(
            self.base + f"/tables/{overlap}", headers=self.headers()
        ).raise_for_status()
        self.client.post(dest + "/restore", headers=self.headers()).raise_for_status()
        after = self.client.get(self.base).json()
        self.assertEqual(after["tables"], before["tables"])
        self.assertEqual(after["results"], before["results"])
        self.assertEqual(self.client.get(dest + "/original").content, raw)

    def test_reparse_original_and_export_inventory(self):
        raw = b"N;ID;g\n PB ;X1;0.0000000000001"
        sid = self.load("perfil.csv", raw)
        dest = self.base + f"/tables/{sid}"
        self.assertEqual(self.client.get(dest + "/original").content, raw)
        self.client.put(
            dest + "/options", headers=self.headers(), json={"trim": True}
        ).raise_for_status()
        self.assertEqual(self.client.get(dest).json()["rows"][0]["N"], "PB")
        mapping = {
            "category": "Perfiles",
            "mode": "inventory",
            "fields": {"level": "N", "id": "ID", "mass": "g"},
            "units": {"mass": "g"},
            "attributes": ["ID"],
            "decimal": ".",
            "direct_basis": "row_total",
        }
        self.mapping(sid, mapping).raise_for_status()
        result = self.client.get(self.base).json()["results"][str(sid)]["detail"][0]
        self.assertAlmostEqual(result["Masa (kg)"] / 1e-16, 1)
        self.assertIsNone(result["Volumen (m³)"])
        report = self.client.post(self.base + "/reports", headers=self.headers())
        report.raise_for_status()
        workbook = load_workbook(
            BytesIO(
                self.client.get(
                    self.base + "/reports/" + str(report.json()["id"])
                ).content
            )
        )
        self.assertIsNone(workbook["Resumen por nivel"]["D2"].value)
        other = self.load("otro.csv", b"N;ID;g\nPB;X1;2")
        self.assertEqual(self.mapping(other, mapping).status_code, 422)


class ScheduleTests(unittest.TestCase):
    def test_fixed_finish_respects_calendar_and_dependencies(self):
        plan = Plan.model_validate(
            {
                "start": "2026-11-02",
                "tasks": [
                    {"id": 1, "name": "Armado", "wbs": "1", "duration": 2},
                    {
                        "id": 2,
                        "name": "Vaciado",
                        "wbs": "2",
                        "duration": 2,
                        "fixed_finish": "2026-11-06",
                        "links": [{"predecessor": 1}],
                    },
                ],
            }
        )
        a, b = schedule(plan, {})
        self.assertEqual(
            (a["slack"], b["start"], b["finish"]), (1, "2026-11-05", "2026-11-06")
        )
        plan.tasks[1].fixed_finish = date(2026, 11, 3)
        with self.assertRaisesRegex(ValueError, "impiden"):
            schedule(plan, {})

    def test_mixed_categories_keep_source_rows(self):
        from bim_planner.importer import read_table
        from planner_api.models import Mapping
        from planner_api.tables import calculate

        rows = read_table(
            b"Planta;Clase;V\nN1;Zapata;4\nN1;Pilote;2\nN1;;10", "mixta.csv"
        )
        mapping = Mapping(
            category="Inventario",
            category_field="Clase",
            mode="direct",
            fields={"level": "Planta", "volume": "V"},
            units={"volume": "m³"},
            direct_basis="row_total",
            decimal=",",
        )
        saved = calculate(rows, mapping, "mixta.csv")
        self.assertEqual(
            {r["Categoría"]: r["Volumen (m³)"] for r in saved["detail"]},
            {"Zapata": 4, "Pilote": 2},
        )
        self.assertEqual(saved["issues"][0]["Fila origen"], 4)

    def test_inventory_units_attributes_and_unmeasured_volume(self):
        from bim_planner.importer import read_table
        from planner_api.models import Mapping
        from planner_api.tables import calculate

        frame = read_table(
            "Piso;Marca;Peso;Largo;Piezas\nN1;A;500 g;300 cm;4".encode(),
            "sintetico.csv",
        )
        m = Mapping(
            category="Perfiles",
            fields={
                "level": "Piso",
                "mass": "Peso",
                "length": "Largo",
                "count": "Piezas",
            },
            units={"mass": "g", "length": "cm"},
            mode="inventory",
            decimal=",",
            direct_basis="per_element",
            attributes=["Marca"],
        )
        row = calculate(frame, m, "sintetico.csv")["detail"][0]
        self.assertEqual(
            (row["Masa (kg)"], row["Longitud (m)"], row["Campo · Marca"]), (2, 12, "A")
        )
        self.assertIsNone(row["Volumen (m³)"])
        plan = Plan.model_validate(
            {
                "tasks": [
                    {
                        "id": 1,
                        "name": "Montar",
                        "wbs": "1",
                        "quantity": {"table": 8, "unit": "kg", "rate": 0.75},
                    }
                ]
            }
        )
        self.assertEqual(schedule(plan, {8: [row]})[0]["duration"], 3)

    def test_relations_holidays_and_float(self):
        for kind, offset in [("FS", 5), ("SS", 1), ("FF", 3), ("SF", 0)]:
            plan = Plan.model_validate(
                {
                    "start": "2026-11-02",
                    "weekdays": list(range(7)),
                    "tasks": [
                        {"id": 1, "wbs": "1", "name": "A", "duration": 4},
                        {
                            "id": 2,
                            "wbs": "2",
                            "name": "B",
                            "duration": 2,
                            "links": [{"predecessor": 1, "relation": kind, "lag": 1}],
                        },
                        {"id": 3, "wbs": "3", "name": "C", "duration": 1},
                    ],
                }
            )
            a, b, c = schedule(plan, {}, today=date(2026, 11, 2))
            self.assertEqual(b["start"], f"2026-11-{2 + offset:02}")
            self.assertTrue(a["critical"])
            self.assertGreater(c["slack"], 0)
            self.assertEqual(a["planned"], 25)

    def test_cycles_and_missing_nodes(self):
        for predecessor in [1, 99]:
            plan = Plan.model_validate(
                {
                    "tasks": [
                        {
                            "id": 1,
                            "wbs": "1",
                            "name": "A",
                            "links": [{"predecessor": predecessor}],
                        }
                    ]
                }
            )
            with self.assertRaises(ValueError):
                schedule(plan, {})
