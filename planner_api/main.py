import json
import os
from contextlib import asynccontextmanager
from datetime import date
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
from .db import INTEGRITY_ERRORS, connect, initialize
from .models import Mapping, Options, Plan, Project
from .planning import schedule
from .project_xml import project_xml
from . import social
from .tables import (
    MAX_BYTES,
    calculate,
    identity,
    inspect_file,
    profile,
    read,
    suggest_header,
)


@asynccontextmanager
async def lifespan(app):
    initialize()
    yield


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


def scheduled(plan, data):
    return schedule(plan, {i: v["detail"] for i, v in data.items()})


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
    with connect(True) as db:
        project(db, pid, revision)
        db.execute(
            "UPDATE project SET name=?,description=?,kind=?,location=?,status=? WHERE id=?",
            (p.name, p.description, p.kind, p.location, p.status, pid),
        )
        log(db, pid, "Ficha de proyecto actualizada")
    return {"id": pid}


@project_routes.delete("")
def trash_project(pid: int, revision: int = Header(alias="If-Match")):
    with connect(True) as db:
        project(db, pid, revision)
        db.execute("INSERT INTO project_trash(project) VALUES(?)", (pid,))
        log(db, pid, "Proyecto enviado a la papelera")
    return {"id": pid}


@project_routes.post("/restore")
def restore_project(pid: int, revision: int = Header(alias="If-Match")):
    with connect(True) as db:
        project(db, pid, revision, trashed=True)
        db.execute("DELETE FROM project_trash WHERE project=?", (pid,))
        log(db, pid, "Proyecto restaurado")
    return {"id": pid}


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
    with connect(True) as db:
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
        return {"id": sid}


@project_routes.delete("/tables/{sid}")
def trash_table(pid: int, sid: int, revision: int = Header(alias="If-Match")):
    with connect(True) as db:
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
    with connect(True) as db:
        p = project(db, pid, revision)
        row = source(db, pid, sid, trashed=True)
        if row["result"]:
            validate_result(db, p, sid, json.loads(row["result"]))
        db.execute("DELETE FROM source_trash WHERE source=?", (sid,))
        log(db, pid, f"Tabla restaurada · {row['name']}")
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
    with connect(True) as db:
        p = project(db, pid, revision)
        row = source(db, pid, sid)
        sheets = inspect_file(row["data"], row["name"])
        frame = read(row["data"], row["name"], options)
        _, sheet = identity(row["data"], options, sheets)
        result = None
        if row["mapping"]:
            mapping = Mapping.model_validate_json(row["mapping"])
            if (
                options.header_row
                != Options.model_validate_json(row["options"]).header_row
                or sheet != row["sheet"]
            ):
                if mapping.excluded_rows:
                    raise ValueError(
                        "Retira las exclusiones manuales antes de cambiar la hoja o la fila de encabezados."
                    )
            result = calculate(frame, mapping, row["name"])
            validate_result(db, p, sid, result)
        try:
            db.execute(
                "UPDATE source SET options=?,sheet=?,result=? WHERE id=?",
                (
                    options.model_dump_json(),
                    sheet,
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
    with connect(True) as db:
        p = project(db, pid, revision)
        row = source(db, pid, sid)
        frame = read(
            row["data"], row["name"], Options.model_validate_json(row["options"])
        )
        result = calculate(frame, m, row["name"])
        validate_result(db, p, sid, result)
        db.execute(
            "UPDATE source SET mapping=?,result=? WHERE id=?",
            (m.model_dump_json(), json.dumps(result, allow_nan=False), sid),
        )
        if template.strip():
            db.execute(
                "INSERT INTO template VALUES(?,?,?) ON CONFLICT(project,name) DO UPDATE SET mapping=excluded.mapping",
                (
                    pid,
                    template.strip(),
                    m.model_dump_json(
                        exclude={"excluded_rows", "filter_values", "filter_column"}
                    ),
                ),
            )
        log(db, pid, f"Cuantificación guardada · {row['name']}")
    return {"id": sid}


@project_routes.put("/plan")
def update_plan(pid: int, plan: Plan, revision: int = Header(alias="If-Match")):
    with connect(True) as db:
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
def report(pid: int, revision: int = Header(alias="If-Match")):
    with connect(True) as db:
        p = project(db, pid, revision)
        tables = list(
            db.execute(
                "SELECT * FROM source_catalog WHERE project=? AND deleted_at IS NULL ORDER BY id",
                (pid,),
            )
        )
        data = results(db, pid)
        if not data or len(data) != len(tables):
            raise ValueError("Configura todas las tablas antes de generar el reporte.")
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
