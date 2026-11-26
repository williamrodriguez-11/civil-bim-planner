import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import date
from hashlib import sha256
from pathlib import Path

import pandas as pd
from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from bim_planner.exporter import export_excel
from bim_planner.quantities import ISSUE_COLUMNS, QuantityConfig

from .auth import Account, require_project
from .auth import router as auth_router
from .db import INTEGRITY_ERRORS, close_pools, connect, database_url, initialize
from .models import ArchiveIssue, Mapping, Options, Plan, Project, ReportOptions
from .planning import schedule
from .project_xml import project_xml
from . import social
from .tables import (
    MAX_BYTES,
    calculate,
    identity,
    inspect_file,
    levels_as_category,
    profile,
    read,
    suggest_header,
)


@asynccontextmanager
async def lifespan(app):
    initialize()
    check_storage()
    yield
    close_pools()


app = FastAPI(title="Civil BIM Planner", lifespan=lifespan)
app.include_router(auth_router)
social.configure(app)
app.include_router(social.router)
project_routes = APIRouter(
    prefix="/api/projects/{pid}", dependencies=[Depends(require_project)]
)
hosts = ["localhost", "127.0.0.1", "testserver"]
public_host = os.environ.get("CIVIL_BIM_HOST") or os.environ.get(
    "RENDER_EXTERNAL_HOSTNAME"
)
if public_host:
    hosts.append(public_host)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts)


@app.middleware("http")
async def local_origin(request: Request, call_next):
    origin = request.headers.get("origin")
    if request.method not in {"GET", "HEAD", "OPTIONS"} and origin:
        from urllib.parse import urlsplit

        apple_callback = (
            request.url.path == "/api/auth/social/apple/callback"
            and origin == "https://appleid.apple.com"
        )
        if not apple_callback and urlsplit(origin).netloc != request.headers.get(
            "host"
        ):
            return JSONResponse({"detail": "Origen no permitido."}, status_code=403)
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "private, no-store"
    return response


@app.exception_handler(ValueError)
async def invalid(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=422)


def project(db, pid, revision=None, *, trashed=False):
    row = db.execute(
        "SELECT * FROM project_catalog WHERE id=? AND (deleted_at IS NOT NULL)=?",
        (pid, trashed),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Proyecto inexistente.")
    if revision is not None and revision != row["revision"]:
        raise HTTPException(
            409,
            "El proyecto cambió en otra ventana. Actualiza los datos y revisa la operación.",
        )
    return dict(row)


def source(db, pid, sid, *, trashed=False):
    row = db.execute(
        "SELECT * FROM source_catalog WHERE project=? AND id=? AND (deleted_at IS NOT NULL)=?",
        (pid, sid, trashed),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Tabla inexistente.")
    return row


def log(db, pid, message):
    db.execute("UPDATE project SET revision=revision+1 WHERE id=?", (pid,))
    db.execute("INSERT INTO event(project,message) VALUES(?,?)", (pid, message))


def results(db, pid):
    rows = db.execute(
        "SELECT id,result FROM source_catalog WHERE project=? AND deleted_at IS NULL AND result IS NOT NULL",
        (pid,),
    )
    return {r["id"]: json.loads(r["result"]) for r in rows}


def issue_snapshot(row):
    return json.dumps(row, sort_keys=True, ensure_ascii=False)


def issue_review(db, pid, data):
    review = {}
    archived = {}
    for record in db.execute(
        "SELECT a.* FROM issue_archive a JOIN source_catalog s ON s.id=a.source "
        "WHERE s.project=? AND s.deleted_at IS NULL ORDER BY a.archived_at DESC, a.digest",
        (pid,),
    ):
        archived.setdefault(record["source"], {})[record["issue"]] = record
    for sid in data.keys() | archived.keys():
        history = archived.get(sid, {})
        pending = []
        current = set()
        for index, row in enumerate(data.get(sid, {}).get("issues", [])):
            snapshot = issue_snapshot(row) if history else None
            if snapshot in history:
                current.add(snapshot)
            else:
                pending.append(index)
        review[sid] = {
            "pending": pending,
            "history": [
                {
                    "id": record["digest"],
                    "row": json.loads(snapshot),
                    "archived_at": record["archived_at"],
                    "current": snapshot in current,
                }
                for snapshot, record in history.items()
            ],
        }
    return review


def scheduled(plan, data):
    return schedule(plan, {i: v["detail"] for i, v in data.items()})


logger = logging.getLogger("civil_bim.storage")
STORAGE_WARNING = 0.7


def storage_limit():
    """Database plan limit in bytes (Neon Free: 0.5 GB)."""
    return int(float(os.environ.get("CIVIL_BIM_STORAGE_LIMIT_MB", "512")) * 1024 * 1024)


def database_size(db):
    if database_url():
        return db.execute(
            "SELECT pg_database_size(current_database()) AS size"
        ).fetchone()["size"]
    page = db.execute("PRAGMA page_size").fetchone()[0]
    return db.execute("PRAGMA page_count").fetchone()[0] * page


def check_storage():
    """Warn in the server log when the shared database nears its plan limit."""
    try:
        with connect() as db:
            used = database_size(db)
    except Exception:
        logger.exception("No se pudo medir el tamaño de la base de datos.")
        return None
    share = used / storage_limit()
    if share >= STORAGE_WARNING:
        logger.warning(
            "La base de datos usa %.0f MB, el %.0f %% del límite de %.0f MB. "
            "Vacía papeleras o amplía el plan antes de que se llene.",
            used / 2**20,
            share * 100,
            storage_limit() / 2**20,
        )
    return used


def is_admin(user):
    admin = os.environ.get("CIVIL_BIM_ADMIN", "").strip().lower()
    return bool(admin) and user["username"] == admin


@app.get("/api/usage")
def usage(user: Account):
    """Bytes stored by this account, so people know what to clean up."""
    with connect() as db:
        rows = db.execute(
            "SELECT p.id, p.deleted_at IS NOT NULL AS trashed, "
            "COALESCE((SELECT SUM(LENGTH(s.data) + COALESCE(LENGTH(s.result), 0)) "
            " FROM source s WHERE s.project = p.id AND NOT EXISTS "
            " (SELECT 1 FROM source_trash t WHERE t.source = s.id)), 0) AS tables, "
            "COALESCE((SELECT SUM(LENGTH(s.data) + COALESCE(LENGTH(s.result), 0)) "
            " FROM source s JOIN source_trash t ON t.source = s.id "
            " WHERE s.project = p.id), 0) AS trashed_tables, "
            "COALESCE((SELECT SUM(LENGTH(r.data)) FROM report r "
            " WHERE r.project = p.id), 0) AS reports "
            "FROM project_catalog p WHERE p.owner = ?",
            (user["id"],),
        ).fetchall()
        projects, total, trash, reports = {}, 0, 0, 0
        for r in rows:
            active, binned, archived = (
                int(r["tables"]), int(r["trashed_tables"]), int(r["reports"])
            )
            size = active + binned + archived
            projects[r["id"]] = size
            total += size
            if r["trashed"]:
                trash += size
            else:
                trash += binned
                reports += archived
        result = {
            "total": total,
            "trash": trash,
            "reports": reports,
            "projects": projects,
        }
        if is_admin(user):
            used = database_size(db)
            result["database"] = {"used": used, "limit": storage_limit()}
        return result


@app.get("/api/projects")
def list_projects(user: Account, include_deleted: bool = False):
    with connect() as db:
        return [
            dict(r)
            for r in db.execute(
                "SELECT id,name,description,kind,location,status,created,revision,deleted_at "
                "FROM project_catalog WHERE owner=? AND (deleted_at IS NULL OR ?) ORDER BY id DESC",
                (user["id"], include_deleted),
            )
        ]


@app.post("/api/projects", status_code=201)
def create(p: Project, user: Account):
    with connect(True) as db:
        pid = db.execute(
            "INSERT INTO project(name,description,kind,location,status,plan,owner) VALUES(?,?,?,?,?,?,?) RETURNING id",
            (
                p.name,
                p.description,
                p.kind,
                p.location,
                p.status,
                Plan().model_dump_json(),
                user["id"],
            ),
        ).fetchone()["id"]
        log(db, pid, "Proyecto creado")
        return {"id": pid}


@project_routes.put("")
def edit(pid: int, p: Project, revision: int = Header(alias="If-Match")):
    with connect(True, project=pid) as db:
        project(db, pid, revision)
        db.execute(
            "UPDATE project SET name=?,description=?,kind=?,location=?,status=? WHERE id=?",
            (p.name, p.description, p.kind, p.location, p.status, pid),
        )
        log(db, pid, "Ficha de proyecto actualizada")
    return {"id": pid}


@project_routes.delete("")
def trash_project(pid: int, revision: int = Header(alias="If-Match")):
    with connect(True, project=pid) as db:
        project(db, pid, revision)
        db.execute("INSERT INTO project_trash(project) VALUES(?)", (pid,))
        log(db, pid, "Proyecto enviado a la papelera")
    return {"id": pid}


@project_routes.post("/restore")
def restore_project(pid: int, revision: int = Header(alias="If-Match")):
    with connect(True, project=pid) as db:
        project(db, pid, revision, trashed=True)
        db.execute("DELETE FROM project_trash WHERE project=?", (pid,))
        log(db, pid, "Proyecto restaurado")
    return {"id": pid}


def purge_sources(db, ids):
    for sid in ids:
        db.execute("DELETE FROM issue_archive WHERE source=?", (sid,))
        db.execute("DELETE FROM source_trash WHERE source=?", (sid,))
        db.execute("DELETE FROM source WHERE id=?", (sid,))


@project_routes.delete("/permanent")
def purge_project(pid: int, revision: int = Header(alias="If-Match")):
    """Delete a project from the trash with all its files. Cannot be undone."""
    with connect(True, project=pid) as db:
        project(db, pid, revision, trashed=True)
        purge_sources(
            db,
            [r["id"] for r in db.execute("SELECT id FROM source WHERE project=?", (pid,))],
        )
        for table in ("report", "template", "event", "project_trash"):
            db.execute(f"DELETE FROM {table} WHERE project=?", (pid,))
        db.execute("DELETE FROM project WHERE id=?", (pid,))
    return {"id": pid}


# Tables saved before the category warning existed are checked once per
# process and per configuration, instead of on every page load.
_legacy_warnings = {}


def mapping_json(mapping: Mapping):
    """Stored mapping. The confirmation is only written when given, so that an
    older instance still running during a deploy can read the other tables."""
    exclude = None if mapping.category_confirmed else {"category_confirmed"}
    return mapping.model_dump_json(exclude=exclude)


def category_warning(db, row, result):
    """Whether this table's category column only repeats its levels."""
    if not row["mapping"]:
        return False
    if result is not None and "levels_as_category" in result:
        return result["levels_as_category"]
    mapping = Mapping.model_validate_json(row["mapping"])
    if not mapping.category_field:
        return False
    # Results saved before this check: read that one source once to decide.
    key = (row["id"], row["mapping"], row["options"])
    if key not in _legacy_warnings:
        found = db.execute("SELECT data FROM source WHERE id=?", (row["id"],)).fetchone()
        try:
            frame = read(found["data"], row["name"], Options.model_validate_json(row["options"]))
            _legacy_warnings[key] = levels_as_category(frame, mapping)
        except ValueError:
            _legacy_warnings[key] = False
    return _legacy_warnings[key]


@project_routes.get("")
def state(pid: int):
    with connect() as db:
        p = project(db, pid)
        plan = Plan.model_validate_json(p.pop("plan"))
        data = results(db, pid)
        summaries = []
        for row in db.execute(
            "SELECT id,name,options,sheet,created,mapping FROM source_catalog "
            "WHERE project=? AND deleted_at IS NULL ORDER BY id",
            (pid,),
        ):
            summary = dict(row)
            summary["mapping"] = json.loads(row["mapping"]) if row["mapping"] else None
            summary["options"] = json.loads(row["options"])
            summary["levels_as_category"] = category_warning(
                db, row, data.get(row["id"])
            )
            summaries.append(summary)
        return {
            "project": p,
            "tables": summaries,
            "trashed_tables": [
                dict(r)
                for r in db.execute(
                    "SELECT id,name,sheet FROM source_catalog WHERE project=? "
                    "AND deleted_at IS NOT NULL ORDER BY deleted_at DESC, id DESC",
                    (pid,),
                )
            ],
            "results": data,
            "issue_review": issue_review(db, pid, data),
            "plan": plan.model_dump(mode="json"),
            "schedule": scheduled(plan, data),
            "events": [
                dict(r)
                for r in db.execute(
                    "SELECT message,created FROM event WHERE project=? ORDER BY id DESC LIMIT 20",
                    (pid,),
                )
            ],
            "templates": {
                r["name"]: json.loads(r["mapping"])
                for r in db.execute(
                    "SELECT name,mapping FROM template WHERE project=?", (pid,)
                )
            },
            "reports": [
                dict(r)
                for r in db.execute(
                    "SELECT id,name,created FROM report WHERE project=? ORDER BY id DESC",
                    (pid,),
                )
            ],
        }


@project_routes.post("/tables/{sid}/issue-archive")
def archive_issue(
    pid: int, sid: int, entry: ArchiveIssue, revision: int = Header(alias="If-Match")
):
    with connect(True, project=pid) as db:
        project(db, pid, revision)
        table = source(db, pid, sid)
        rows = json.loads(table["result"])["issues"] if table["result"] else []
        if entry.index >= len(rows):
            raise HTTPException(404, "La incidencia ya no está en el cálculo.")
        snapshot = issue_snapshot(rows[entry.index])
        digest = sha256(snapshot.encode()).hexdigest()
        db.execute(
            "INSERT INTO issue_archive(source,digest,issue) VALUES(?,?,?) "
            "ON CONFLICT(source,digest) DO NOTHING",
            (sid, digest, snapshot),
        )
        log(db, pid, "Incidencia archivada")
        return {"id": sid}


@project_routes.post("/tables/{sid}/issue-archive/{digest}/restore")
def restore_issue(
    pid: int, sid: int, digest: str, revision: int = Header(alias="If-Match")
):
    with connect(True, project=pid) as db:
        project(db, pid, revision)
        table = source(db, pid, sid)
        record = db.execute(
            "SELECT issue FROM issue_archive WHERE source=? AND digest=?", (sid, digest)
        ).fetchone()
        rows = json.loads(table["result"])["issues"] if table["result"] else []
        if record is None or not any(issue_snapshot(row) == record["issue"] for row in rows):
            raise HTTPException(409, "La incidencia ya no está en el cálculo actual.")
        db.execute("DELETE FROM issue_archive WHERE source=? AND digest=?", (sid, digest))
        log(db, pid, "Incidencia devuelta a revisión")
        return {"id": sid}


def upload(file):
    name = Path((file.filename or "").replace("\\", "/")).name
    data = file.file.read(MAX_BYTES + 1)
    sheets = inspect_file(data, name)
    return name, data, sheets


@app.post("/api/preview")
def preview(
    user: Account,
    file: UploadFile = File(),
    options: str = Form("{}"),
    detect: bool = Form(False),
):
    name, data, sheets = upload(file)
    opts = Options.model_validate_json(options)
    try:
        if detect:
            opts = opts.model_copy(
                update={"header_row": suggest_header(data, name, opts)}
            )
        info = profile(read(data, name, opts))
    except ValueError as exc:
        return {"sheets": sheets, "options": opts, "error": str(exc), "table": None}
    return {"sheets": sheets, "options": opts, "error": None, "table": info}


@project_routes.post("/tables", status_code=201)
def save_table(
    pid: int,
    file: UploadFile = File(),
    options: str = Form(),
    revision: int = Header(alias="If-Match"),
):
    name, data, sheets = upload(file)
    opts = Options.model_validate_json(options)
    read(data, name, opts)
    digest, sheet = identity(data, opts, sheets)
    with connect(True, project=pid) as db:
        project(db, pid, revision)
        inserted = db.execute(
            "INSERT INTO source(project,name,digest,data,sheet,options) VALUES(?,?,?,?,?,?) ON CONFLICT(project,digest,sheet) DO NOTHING RETURNING id",
            (pid, name, digest, data, sheet, opts.model_dump_json()),
        ).fetchone()
        if inserted is None:
            if db.execute(
                "SELECT 1 FROM source_catalog WHERE project=? AND digest=? AND sheet=? AND deleted_at IS NOT NULL",
                (pid, digest, sheet),
            ).fetchone():
                raise HTTPException(
                    409,
                    "Esta tabla está en la papelera de tablas. Puedes restaurarla desde allí.",
                )
            raise HTTPException(
                409, "Esta hoja o archivo ya está importado en el proyecto."
            )
        sid = inserted["id"]
        log(db, pid, f"Tabla importada · {name}")
    check_storage()
    return {"id": sid}


@project_routes.delete("/tables/{sid}")
def trash_table(pid: int, sid: int, revision: int = Header(alias="If-Match")):
    with connect(True, project=pid) as db:
        p = project(db, pid, revision)
        row = source(db, pid, sid)
        linked = [
            f"{task.wbs} {task.name}"
            for task in Plan.model_validate_json(p["plan"]).tasks
            if task.quantity and task.quantity.table == sid
        ]
        if linked:
            raise HTTPException(
                409,
                "Antes de borrar esta tabla, cambia el origen de la duración "
                "en Programación para estas actividades: " + ", ".join(linked) + ".",
            )
        db.execute("INSERT INTO source_trash(source) VALUES(?)", (sid,))
        log(db, pid, f"Tabla enviada a la papelera · {row['name']}")
    return {"id": sid}


@project_routes.post("/tables/{sid}/restore")
def restore_table(pid: int, sid: int, revision: int = Header(alias="If-Match")):
    with connect(True, project=pid) as db:
        p = project(db, pid, revision)
        row = source(db, pid, sid, trashed=True)
        if row["result"]:
            validate_result(db, p, sid, json.loads(row["result"]))
        db.execute("DELETE FROM source_trash WHERE source=?", (sid,))
        log(db, pid, f"Tabla restaurada · {row['name']}")
    return {"id": sid}


@project_routes.delete("/tables/{sid}/permanent")
def purge_table(pid: int, sid: int, revision: int = Header(alias="If-Match")):
    """Delete a table from the trash with its original file. Cannot be undone."""
    with connect(True, project=pid) as db:
        project(db, pid, revision)
        row = source(db, pid, sid, trashed=True)
        purge_sources(db, [sid])
        log(db, pid, f"Tabla eliminada definitivamente · {row['name']}")
    return {"id": sid}


@project_routes.get("/tables/{sid}")
def table(pid: int, sid: int):
    with connect() as db:
        project(db, pid)
        row = source(db, pid, sid)
    return profile(
        read(row["data"], row["name"], Options.model_validate_json(row["options"]))
    )


@project_routes.get("/tables/{sid}/original")
def original(pid: int, sid: int):
    from urllib.parse import quote

    with connect() as db:
        project(db, pid)
        row = source(db, pid, sid)
        return Response(
            row["data"],
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": "attachment; filename*=UTF-8''"
                + quote(row["name"], safe="")
            },
        )


@project_routes.put("/tables/{sid}/options")
def revise_options(
    pid: int, sid: int, options: Options, revision: int = Header(alias="If-Match")
):
    with connect(True, project=pid) as db:
        p = project(db, pid, revision)
        row = source(db, pid, sid)
        sheets = inspect_file(row["data"], row["name"])
        frame = read(row["data"], row["name"], options)
        _, sheet = identity(row["data"], options, sheets)
        result = None
        mapping = None
        if row["mapping"]:
            mapping = Mapping.model_validate_json(row["mapping"])
            previous = Options.model_validate_json(row["options"])
            if options.header_row != previous.header_row or sheet != row["sheet"]:
                if mapping.excluded_rows:
                    raise ValueError(
                        "Retira las exclusiones manuales antes de cambiar la hoja o la fila de encabezados."
                    )
            if options != previous or sheet != row["sheet"]:
                # A confirmed category column was checked on other values.
                mapping = mapping.model_copy(update={"category_confirmed": False})
            result = calculate(frame, mapping, row["name"])
            validate_result(db, p, sid, result)
        try:
            db.execute(
                "UPDATE source SET options=?,sheet=?,mapping=?,result=? WHERE id=?",
                (
                    options.model_dump_json(),
                    sheet,
                    mapping_json(mapping) if mapping else None,
                    json.dumps(result) if result is not None else None,
                    sid,
                ),
            )
        except INTEGRITY_ERRORS as exc:
            raise HTTPException(
                409,
                "Esta hoja ya está registrada. Revisa la biblioteca y la papelera de tablas.",
            ) from exc
        log(db, pid, "Opciones de importación actualizadas · " + row["name"])
        return {"id": sid}


def carry_archived_issues(db, sid, previous, issues):
    """Keep archived issues archived when only their category label changed.

    Correcting a table's category (for example, levels used as categories)
    must not send the incidences the user already reviewed back to review.
    """
    def key(row):
        return issue_snapshot({k: v for k, v in row.items() if k != "Categoría"})

    current = {key(row): issue_snapshot(row) for row in issues}
    # Only incidences that were present just before this change keep their
    # archive; an older archive must not hide a new rejection.
    before = {issue_snapshot(row) for row in previous}
    for record in list(
        db.execute(
            "SELECT digest, issue, archived_at FROM issue_archive WHERE source=?",
            (sid,),
        )
    ):
        if record["issue"] not in before:
            continue
        snapshot = current.get(key(json.loads(record["issue"])))
        if snapshot is None or snapshot == record["issue"]:
            continue
        db.execute(
            "DELETE FROM issue_archive WHERE source=? AND digest=?",
            (sid, record["digest"]),
        )
        db.execute(
            "INSERT INTO issue_archive(source,digest,issue,archived_at) VALUES(?,?,?,?) "
            "ON CONFLICT(source,digest) DO NOTHING",
            (sid, sha256(snapshot.encode()).hexdigest(), snapshot, record["archived_at"]),
        )


def validate_result(db, p, sid, result):
    data = results(db, p["id"])
    other_ids = {
        (r["Categoría"], r["ID"])
        for table_id, saved in data.items()
        if table_id != sid
        for r in saved["detail"]
        if r["ID"]
    }
    overlap = sorted({(r["Categoría"], r["ID"]) for r in result["detail"]} & other_ids)
    if overlap:
        raise ValueError(
            "Hay elementos ya cuantificados en otra tabla de la categoría. "
            "Revisa y excluye los registros repetidos: "
            + ", ".join(f"{c} / {i}" for c, i in overlap[:8])
        )
    data[sid] = result
    scheduled(Plan.model_validate_json(p["plan"]), data)


@project_routes.put("/tables/{sid}/mapping")
def assign(
    pid: int,
    sid: int,
    m: Mapping,
    revision: int = Header(alias="If-Match"),
    template: str = "",
):
    with connect(True, project=pid) as db:
        p = project(db, pid, revision)
        row = source(db, pid, sid)
        if m.category_confirmed:
            # A confirmation covers only the category/level pair it was given for.
            stored = Mapping.model_validate_json(row["mapping"]) if row["mapping"] else None
            if stored is None or (stored.category_field, stored.fields.get("level")) != (
                m.category_field,
                m.fields.get("level"),
            ):
                m = m.model_copy(update={"category_confirmed": False})
        frame = read(
            row["data"], row["name"], Options.model_validate_json(row["options"])
        )
        result = calculate(frame, m, row["name"])
        validate_result(db, p, sid, result)
        db.execute(
            "UPDATE source SET mapping=?,result=? WHERE id=?",
            (mapping_json(m), json.dumps(result, allow_nan=False), sid),
        )
        previous = json.loads(row["result"])["issues"] if row["result"] else []
        carry_archived_issues(db, sid, previous, result["issues"])
        if template.strip():
            db.execute(
                "INSERT INTO template VALUES(?,?,?) ON CONFLICT(project,name) DO UPDATE SET mapping=excluded.mapping",
                (
                    pid,
                    template.strip(),
                    m.model_dump_json(
                        exclude={
                            "excluded_rows",
                            "filter_values",
                            "filter_column",
                            # Each table is checked on its own.
                            "category_confirmed",
                        }
                    ),
                ),
            )
        log(db, pid, f"Cuantificación guardada · {row['name']}")
    return {"id": sid}


@project_routes.put("/plan")
def update_plan(pid: int, plan: Plan, revision: int = Header(alias="If-Match")):
    with connect(True, project=pid) as db:
        project(db, pid, revision)
        scheduled(plan, results(db, pid))
        db.execute(
            "UPDATE project SET plan=? WHERE id=?", (plan.model_dump_json(), pid)
        )
        log(db, pid, "Cronograma actualizado")
    return {"id": pid}


@project_routes.get("/schedule.xml")
def export_plan(pid: int):
    with connect() as db:
        p = project(db, pid)
        plan = Plan.model_validate_json(p["plan"])
        rows = scheduled(plan, results(db, pid))
        if not rows:
            raise ValueError("Crea una actividad antes de exportar.")
    return Response(
        project_xml(p["name"], plan, rows),
        media_type="application/xml",
        headers={"Content-Disposition": 'attachment; filename="Cronograma.xml"'},
    )


@project_routes.post("/reports", status_code=201)
def report(
    pid: int,
    options: ReportOptions = ReportOptions(),
    revision: int = Header(alias="If-Match"),
):
    with connect(True, project=pid) as db:
        p = project(db, pid, revision)
        tables = list(
            db.execute(
                "SELECT * FROM source_catalog WHERE project=? AND deleted_at IS NULL ORDER BY id",
                (pid,),
            )
        )
        if options.tables is not None:
            selected = set(options.tables)
            if selected - {row["id"] for row in tables}:
                raise ValueError(
                    "Hay tablas seleccionadas que ya no están disponibles."
                )
            tables = [row for row in tables if row["id"] in selected]
        data = results(db, pid)
        if not tables or any(row["id"] not in data for row in tables):
            raise ValueError(
                "Calcula las tablas seleccionadas antes de generar el reporte."
            )
        detail, issues, sources, configs = [], [], {}, []
        for row in tables:
            m = Mapping.model_validate_json(row["mapping"])
            opt = Options.model_validate_json(row["options"])
            label = str(row["id"])
            sources[label] = read(row["data"], row["name"], opt)
            cfg = QuantityConfig(
                **m.model_dump(
                    exclude={
                        "material",
                        "strength",
                        "family",
                        "attributes",
                        "category_field",
                        "category_confirmed",
                    }
                )
            )
            configs.append(
                (
                    row["name"],
                    cfg,
                    {
                        **opt.model_dump(),
                        "hoja_fuente": label,
                        "familia": m.family,
                        "material": m.material,
                        "resistencia": m.strength,
                        "clasificacion": m.category_field,
                        "atributos": m.attributes,
                    },
                )
            )
            result = data[row["id"]]
            detail.extend({**r, "Fuente": label} for r in result["detail"])
            issues.extend({**r, "Fuente": label} for r in result["issues"])
        if not detail:
            raise ValueError("El reporte requiere al menos una fila válida.")
        content = export_excel(
            pd.DataFrame(detail),
            pd.DataFrame(issues, columns=[*ISSUE_COLUMNS, "Fuente"]),
            configs,
            sources,
            sections=options.sections,
            project_info={
                "Proyecto": p["name"],
                "Ubicación": p["location"],
                "Tipo": p["kind"],
                "Fecha": date.today().isoformat(),
                "Elementos": sum(r["Elementos"] for r in detail),
                **{
                    f"Medición registrada · {key}": sum(
                        r[key] for r in detail if r.get(key) is not None
                    )
                    for key in ["Volumen (m³)", "Longitud (m)", "Masa (kg)"]
                    if any(r.get(key) is not None for r in detail)
                },
                "Alcance": "Parcial"
                if any(r["Estado"] == "Rechazada" for r in issues)
                else "Filas válidas de la selección",
            },
        )
        rid = db.execute(
            "INSERT INTO report(project,name,data) VALUES(?,?,?) RETURNING id",
            (pid, "Cuantificación BIM.xlsx", content),
        ).fetchone()["id"]
        log(db, pid, "Reporte Excel generado")
    check_storage()
    return {"id": rid}


@project_routes.delete("/reports/{rid}")
def delete_report(pid: int, rid: int, revision: int = Header(alias="If-Match")):
    with connect(True, project=pid) as db:
        project(db, pid, revision)
        if not db.execute(
            "DELETE FROM report WHERE id=? AND project=? RETURNING id", (rid, pid)
        ).fetchone():
            raise HTTPException(404, "Reporte inexistente.")
        log(db, pid, f"Reporte #{rid} eliminado")
    return {"id": rid}


@project_routes.get("/reports/{rid}")
def download(pid: int, rid: int):
    with connect() as db:
        project(db, pid)
        row = db.execute(
            "SELECT data FROM report WHERE id=? AND project=?", (rid, pid)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Reporte inexistente.")
        return Response(
            row["data"],
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={
                "Content-Disposition": f'attachment; filename="Cuantificacion-{rid}.xlsx"'
            },
        )


app.include_router(project_routes)

dist = Path(__file__).resolve().parents[1] / "web" / "dist"
if dist.is_dir():
    app.mount("/", StaticFiles(directory=dist, html=True), name="web")
