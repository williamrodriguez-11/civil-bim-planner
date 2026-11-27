import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from planner_api.main import app

GOOD = "Nueva-Clave-2026"


class PasswordChange(unittest.TestCase):
    def setUp(self):
        self.tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(
            patch.dict(
                os.environ, CIVIL_BIM_DB=str(Path(self.tmp) / "synthetic.sqlite3")
            )
        )
        self.client = self.enterContext(TestClient(app))
        self.credentials = {"username": "residente", "password": "frase de prueba larga"}
        self.client.post("/api/auth/register", json=self.credentials)

    def change(self, current, new, client=None):
        return (client or self.client).post(
            "/api/auth/password",
            json={"current_password": current, "new_password": new},
        )

    def test_me_reports_password_sign_in(self):
        me = self.client.get("/api/auth/me").json()
        self.assertEqual(me["username"], "residente")
        self.assertTrue(me["has_password"])
        self.assertEqual(me["providers"], [])

    def test_wrong_current_password_is_rejected(self):
        response = self.change("otra cosa", GOOD)
        self.assertEqual(response.status_code, 403)
        self.assertIn("actual", response.json()["detail"])

    def test_rules_are_explained(self):
        for weak, words in (
            ("Corta-1", "12"),
            ("sin-mayusculas-12", "mayúscula"),
            ("SIN-MINUSCULAS-12", "minúscula"),
            ("Sin-Numeros-Aqui", "número"),
            ("SinSimbolos12345", "símbolo"),
            ("Residente-2026!", "usuario"),
        ):
            response = self.change(self.credentials["password"], weak)
            self.assertEqual(response.status_code, 422, weak)
            self.assertIn(words, response.json()["detail"], weak)
        response = self.change(
            self.credentials["password"], self.credentials["password"]
        )
        self.assertEqual(response.status_code, 422)

    def test_change_signs_out_other_devices_only(self):
        with TestClient(app) as other:
            other.post("/api/auth/login", json=self.credentials)
            self.assertEqual(other.get("/api/auth/me").status_code, 200)
            self.assertEqual(
                self.change(self.credentials["password"], GOOD).status_code, 200
            )
            self.assertEqual(other.get("/api/auth/me").status_code, 401)
        self.assertEqual(self.client.get("/api/auth/me").status_code, 200)
        with TestClient(app) as fresh:
            self.assertEqual(
                fresh.post("/api/auth/login", json=self.credentials).status_code, 401
            )
            self.assertEqual(
                fresh.post(
                    "/api/auth/login",
                    json={"username": "residente", "password": GOOD},
                ).status_code,
                200,
            )

    def test_requires_a_session(self):
        with TestClient(app) as anonymous:
            self.assertEqual(
                self.change("x", GOOD, anonymous).status_code, 401
            )


if __name__ == "__main__":
    unittest.main()
