import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from planner_api.main import app
from planner_api.social import oauth


class SocialLogin(unittest.TestCase):
    def test_verified_subject_keeps_its_own_projects(self):
        folder = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.dict(os.environ, DATABASE_URL="", CIVIL_BIM_DB=str(Path(folder)/"test.db")))
        client = self.enterContext(TestClient(app))
        credentials = {"username": "persona@example.org", "password": "clave de prueba extensa"}
        self.assertEqual(client.post("/api/auth/register", json=credentials).status_code, 201)
        client.post("/api/projects", json={"name": "Proyecto personal"})
        client.post("/api/auth/logout")
        oidc = AsyncMock()
        oidc.authorize_access_token.return_value = {"userinfo": {
            "iss": "https://accounts.google.com", "sub": "synthetic-id", "email": credentials["username"]
        }}
        self.enterContext(patch.object(oauth, "create_client", return_value=oidc))
        url = "/api/auth/social/google/callback"
        self.assertEqual(client.get(url, follow_redirects=False).status_code, 303)
        self.assertEqual(client.get("/api/projects").json(), [])
        client.post("/api/projects", json={"name": "Proyecto social"})
        client.post("/api/auth/logout")
        client.get(url, follow_redirects=False)
        self.assertEqual([p["name"] for p in client.get("/api/projects").json()], ["Proyecto social"])
        client.post("/api/auth/logout")
        oidc.authorize_access_token.return_value = {}
        self.assertEqual(client.get(url, follow_redirects=False).headers["location"], "/?acceso=error")
        self.assertEqual(client.get("/api/projects").status_code, 401)
