import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from planner_api.main import app

MAPPING = {
    "category": "Columnas",
    "mode": "direct",
    "decimal": ",",
    "fields": {"level": "N", "volume": "V"},
    "units": {"volume": "m³"},
    "direct_basis": "row_total",
}


class Storage(unittest.TestCase):
    def setUp(self):
        self.tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(
            patch.dict(
                os.environ,
                CIVIL_BIM_DB=str(Path(self.tmp) / "synthetic.sqlite3"),
                CIVIL_BIM_ADMIN="administradora",
            )
        )
        self.client = self.enterContext(TestClient(app))
        self.register(self.client, "propietaria")
        self.pid = self.client.post("/api/projects", json={"name": "Espacio"}).json()["id"]
        self.base = f"/api/projects/{self.pid}"

    def register(self, client, username):
        response = client.post(
            "/api/auth/register",
            json={"username": username, "password": "frase de prueba sintética"},
        )
        self.assertEqual(response.status_code, 201, response.text)

    def headers(self, base=None):
        state = self.client.get(base or self.base).json()
        return {"If-Match": str(state["project"]["revision"])}

    def load(self, name, data):
        response = self.client.post(
            self.base + "/tables",
            headers=self.headers(),
            files={"file": (name, data)},
            data={"options": "{}"},
        )
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()["id"]

    def usage(self, client=None):
        response = (client or self.client).get("/api/usage")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_purge_trashed_table_frees_space(self):
        data = b"N;V\nPB;2\n" + b"P1;3\n" * 200
        sid = self.load("columnas.csv", data)
        self.assertGreaterEqual(self.usage()["total"], len(data))
        # Only tables in the trash can be deleted permanently.
        self.assertEqual(
            self.client.delete(
                self.base + f"/tables/{sid}/permanent", headers=self.headers()
            ).status_code,
            404,
        )
        self.client.delete(self.base + f"/tables/{sid}", headers=self.headers()).raise_for_status()
        self.assertGreaterEqual(self.usage()["trash"], len(data))
        self.client.delete(
            self.base + f"/tables/{sid}/permanent", headers=self.headers()
        ).raise_for_status()
        state = self.client.get(self.base).json()
        self.assertEqual(state["tables"], [])
        self.assertEqual(state["trashed_tables"], [])
        self.assertEqual(self.usage()["total"], 0)
        # The same file can be imported again afterwards.
        self.load("columnas.csv", data)

    def test_delete_report(self):
        sid = self.load("uno.csv", b"N;V\nPB;2")
        self.client.put(
            self.base + f"/tables/{sid}/mapping", json=MAPPING, headers=self.headers()
        ).raise_for_status()
        rid = self.client.post(self.base + "/reports", headers=self.headers()).json()["id"]
        self.assertGreater(self.usage()["reports"], 0)
        self.client.delete(
            self.base + f"/reports/{rid}", headers=self.headers()
        ).raise_for_status()
        self.assertEqual(self.client.get(self.base).json()["reports"], [])
        self.assertEqual(self.client.get(self.base + f"/reports/{rid}").status_code, 404)
        self.assertEqual(self.usage()["reports"], 0)
        self.assertEqual(
            self.client.delete(self.base + f"/reports/{rid}", headers=self.headers()).status_code,
            404,
        )

    def test_purge_project_only_from_trash_and_only_by_owner(self):
        sid = self.load("uno.csv", b"N;V\nPB;2")
        self.client.put(
            self.base + f"/tables/{sid}/mapping", json=MAPPING, headers=self.headers()
        ).raise_for_status()
        self.client.post(self.base + "/reports", headers=self.headers()).raise_for_status()
        self.assertEqual(
            self.client.delete(self.base + "/permanent", headers=self.headers()).status_code,
            404,
        )
        revision = self.headers()
        self.client.delete(self.base, headers=revision).raise_for_status()
        trashed = [
            p for p in self.client.get("/api/projects?include_deleted=true").json()
            if p["id"] == self.pid
        ][0]
        self.assertEqual(self.usage()["trash"], self.usage()["total"])
        with TestClient(app) as other:
            self.register(other, "intrusa")
            self.assertEqual(
                other.delete(
                    self.base + "/permanent",
                    headers={"If-Match": str(trashed["revision"])},
                ).status_code,
                404,
            )
        self.client.delete(
            self.base + "/permanent", headers={"If-Match": str(trashed["revision"])}
        ).raise_for_status()
        self.assertEqual(self.client.get("/api/projects?include_deleted=true").json(), [])
        self.assertEqual(self.usage(), {"total": 0, "trash": 0, "reports": 0, "projects": {}})

    def test_archived_issues_survive_a_category_correction(self):
        sid = self.load("CANT - COLUMNAS.csv", b"N;V\nPB;2\nP1;x")
        url = self.base + f"/tables/{sid}/mapping"
        self.client.put(
            url, json={**MAPPING, "category": "CANT - COLUMNAS.csv"}, headers=self.headers()
        ).raise_for_status()
        self.client.post(
            self.base + f"/tables/{sid}/issue-archive",
            json={"index": 0},
            headers=self.headers(),
        ).raise_for_status()
        review = self.client.get(self.base).json()["issue_review"][str(sid)]
        self.assertEqual((review["pending"], len(review["history"])), ([], 1))
        archived_at = review["history"][0]["archived_at"]
        self.client.put(
            url, json={**MAPPING, "category": "Columnas"}, headers=self.headers()
        ).raise_for_status()
        state = self.client.get(self.base).json()
        review = state["issue_review"][str(sid)]
        self.assertEqual(review["pending"], [])
        self.assertEqual(review["history"][0]["row"]["Categoría"], "Columnas")
        self.assertEqual(review["history"][0]["archived_at"], archived_at)
        self.assertTrue(review["history"][0]["current"])

    def test_old_archive_does_not_hide_a_new_rejection(self):
        sid = self.load("columnas.csv", b"N;V;W\nPB;2;2\nP1;x;3")
        url = self.base + f"/tables/{sid}/mapping"

        def save(category, volume):
            self.client.put(
                url,
                json={**MAPPING, "category": category, "fields": {"level": "N", "volume": volume}},
                headers=self.headers(),
            ).raise_for_status()

        save("A", "V")
        self.client.post(
            self.base + f"/tables/{sid}/issue-archive", json={"index": 0}, headers=self.headers()
        ).raise_for_status()
        save("A", "W")  # Row 3 becomes valid: the incidence disappears.
        save("B", "V")  # It comes back under another category.
        review = self.client.get(self.base).json()["issue_review"][str(sid)]
        self.assertEqual(review["pending"], [0])

    def test_tables_saved_before_the_check_are_reviewed(self):
        sid = self.load("CANT - COLUMNAS.csv", b"Nivel;Nivel base;V\nPB;PB;2\nP1;P1;3")
        m = {
            "category": "CANT - COLUMNAS.csv",
            "category_field": "Nivel base",
            "mode": "direct",
            "decimal": ",",
            "fields": {"level": "Nivel", "volume": "V"},
            "units": {"volume": "m³"},
            "direct_basis": "row_total",
        }
        self.client.put(self.base + f"/tables/{sid}/mapping", json=m, headers=self.headers()).raise_for_status()
        table = self.client.get(self.base).json()["tables"][0]
        self.assertTrue(table["levels_as_category"])
        # Simulate a result stored before the flag existed.
        import json
        import sqlite3

        db = sqlite3.connect(os.environ["CIVIL_BIM_DB"])
        result = json.loads(db.execute("SELECT result FROM source").fetchone()[0])
        del result["levels_as_category"]
        db.execute("UPDATE source SET result=?", (json.dumps(result),))
        db.commit()
        db.close()
        self.assertTrue(self.client.get(self.base).json()["tables"][0]["levels_as_category"])
        self.client.put(self.base + f"/tables/{sid}/mapping", json={**m, "category_confirmed": True}, headers=self.headers()).raise_for_status()
        self.assertFalse(self.client.get(self.base).json()["tables"][0]["levels_as_category"])

    def test_database_size_only_for_administrator(self):
        self.assertNotIn("database", self.usage())
        with TestClient(app) as admin:
            self.register(admin, "administradora")
            database = self.usage(admin)["database"]
            self.assertGreater(database["used"], 0)
            self.assertEqual(database["limit"], 512 * 1024 * 1024)


if __name__ == "__main__":
    unittest.main()
