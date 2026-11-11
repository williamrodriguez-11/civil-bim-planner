import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

import psycopg
from dotenv import dotenv_values
from psycopg.rows import dict_row

DEFAULT_DB = Path(__file__).resolve().parents[1] / ".civil-bim" / "planner.sqlite3"
SCHEMA = """
CREATE TABLE IF NOT EXISTS account(
 id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt BLOB NOT NULL,
 password_hash BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS social_identity(
 issuer TEXT NOT NULL, subject TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES account(id),
 PRIMARY KEY(issuer, subject));
CREATE TABLE IF NOT EXISTS session(
 digest BLOB PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES account(id),
 expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS auth_attempt(
 client TEXT PRIMARY KEY, attempts INTEGER NOT NULL, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS project(
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
 kind TEXT NOT NULL, location TEXT NOT NULL, status TEXT NOT NULL,
 created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, revision INTEGER NOT NULL DEFAULT 0,
 plan TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS project_trash(
 project INTEGER PRIMARY KEY REFERENCES project(id),
 deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE VIEW IF NOT EXISTS project_catalog AS
 SELECT project.*, project_trash.deleted_at
 FROM project LEFT JOIN project_trash ON project_trash.project = project.id;
CREATE TABLE IF NOT EXISTS source(
 id INTEGER PRIMARY KEY, project INTEGER NOT NULL REFERENCES project(id),
 name TEXT NOT NULL, digest TEXT NOT NULL, data BLOB NOT NULL, sheet TEXT NOT NULL,
 options TEXT NOT NULL, mapping TEXT, result TEXT, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(project, digest, sheet));
CREATE TABLE IF NOT EXISTS source_trash(
 source INTEGER PRIMARY KEY REFERENCES source(id),
 deleted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE VIEW IF NOT EXISTS source_catalog AS
 SELECT source.*, source_trash.deleted_at
 FROM source LEFT JOIN source_trash ON source_trash.source = source.id;
CREATE TABLE IF NOT EXISTS report(
 id INTEGER PRIMARY KEY, project INTEGER NOT NULL REFERENCES project(id),
 name TEXT NOT NULL, data BLOB NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS template(
 project INTEGER NOT NULL REFERENCES project(id), name TEXT NOT NULL, mapping TEXT NOT NULL,
 PRIMARY KEY(project, name));
CREATE TABLE IF NOT EXISTS event(
 id INTEGER PRIMARY KEY, project INTEGER NOT NULL REFERENCES project(id),
 message TEXT NOT NULL, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
"""


LOCAL_ENV = DEFAULT_DB.parents[1] / ".env.local"
local_settings = dotenv_values(LOCAL_ENV, interpolate=False)
INTEGRITY_ERRORS = (sqlite3.IntegrityError, psycopg.IntegrityError)


def database_url():
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    if os.environ.get("CIVIL_BIM_DB"):
        return None
    return local_settings.get("DATABASE_URL")


class PostgresConnection:
    def __init__(self, connection):
        self.connection = connection

    def execute(self, sql, params=()):
        return self.connection.execute(sql.replace("?", "%s"), params)


@contextmanager
def connect(write=False):
    url = database_url()
    if url:
        with psycopg.connect(
            url, row_factory=dict_row, connect_timeout=15, prepare_threshold=None
        ) as pg:
            if write:
                # Serialize revision checks and updates, as SQLite BEGIN IMMEDIATE does.
                pg.execute("SELECT pg_advisory_xact_lock(6908765)")
            else:
                pg.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            yield PostgresConnection(pg)
        return
    path = Path(os.environ.get("CIVIL_BIM_DB", DEFAULT_DB))
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=15)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        yield db
        db.commit()
    finally:
        db.close()


def initialize():
    with connect(True) as db:
        if database_url():
            schema = (
                Path(__file__).with_name("postgres.sql").read_text(encoding="utf-8")
            )
            db.connection.execute(schema)
            return
        db.executescript(SCHEMA)
        db.execute("BEGIN IMMEDIATE")
        if "owner" not in {r["name"] for r in db.execute("PRAGMA table_info(project)")}:
            db.execute(
                "ALTER TABLE project ADD COLUMN owner INTEGER REFERENCES account(id)"
            )
        db.execute("CREATE INDEX IF NOT EXISTS project_owner ON project(owner)")
