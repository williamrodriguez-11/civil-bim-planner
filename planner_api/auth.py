import hashlib
import hmac
import re
import secrets
import time
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, SecretStr

from .db import INTEGRITY_ERRORS, connect

router = APIRouter(prefix="/api/auth")
COOKIE = "civil_session"
LIFETIME = 14 * 24 * 3600


class Credentials(BaseModel):
    username: str
    password: SecretStr


def digest(token):
    return hashlib.sha256(token.encode()).digest()


def password_hash(password, salt):
    return hashlib.scrypt(
        password.encode(), salt=salt, n=2**15, r=8, p=1, maxmem=64 << 20
    )


def account(request: Request):
    token = request.cookies.get(COOKIE)
    if token:
        with connect() as db:
            row = db.execute(
                "SELECT account.id, username FROM session JOIN account ON account.id=session.account_id "
                "WHERE digest=? AND expires>?",
                (digest(token), int(time.time())),
            ).fetchone()
            if row:
                return dict(row)
    raise HTTPException(401, "Inicia sesión para acceder a tus proyectos.")


Account = Annotated[dict, Depends(account)]


def require_project(pid: int, user: Account):
    with connect() as db:
        if not db.execute(
            "SELECT 1 FROM project WHERE id=? AND owner=?", (pid, user["id"])
        ).fetchone():
            raise HTTPException(404, "Proyecto inexistente.")


def limit_attempts(request):
    client = request.client.host if request.client else "unknown"
    now = int(time.time())
    with connect(True) as db:
        db.execute("DELETE FROM auth_attempt WHERE until<=?", (now,))
        count = db.execute(
            "INSERT INTO auth_attempt VALUES(?,1,?) ON CONFLICT(client) DO UPDATE "
            "SET attempts=auth_attempt.attempts+1 RETURNING attempts",
            (client, now + 600),
        ).fetchone()["attempts"]
    if count > 60:
        raise HTTPException(
            429, "Demasiados intentos. Vuelve a probar en diez minutos."
        )


def start_session(db, request, response, uid):
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    db.execute(
        "DELETE FROM session WHERE expires<=? OR digest=?",
        (now, digest(request.cookies.get(COOKIE, ""))),
    )
    db.execute(
        "INSERT INTO session VALUES(?,?,?)", (digest(token), uid, now + LIFETIME)
    )
    response.set_cookie(
        COOKIE,
        token,
        max_age=LIFETIME,
        httponly=True,
        samesite="lax",
        secure=request.url.hostname not in {"localhost", "127.0.0.1", "testserver"},
    )


@router.post("/register", status_code=201)
def register(data: Credentials, request: Request, response: Response):
    limit_attempts(request)
    username = data.username.strip().lower()
    password = data.password.get_secret_value()
    is_email = len(username) <= 254 and re.fullmatch(
        r"[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+", username
    )
    if not is_email and not re.fullmatch(r"[a-z0-9._-]{3,64}", username):
        raise HTTPException(
            422,
            "Ingresa un correo válido o un usuario de 3 a 64 letras, números, puntos o guiones.",
        )
    if not 12 <= len(password) <= 256:
        raise HTTPException(422, "Usa una contraseña de entre 12 y 256 caracteres.")
    salt = secrets.token_bytes(16)
    hashed = password_hash(password, salt)
    with connect(True) as db:
        try:
            uid = db.execute(
                "INSERT INTO account(username,salt,password_hash) VALUES(?,?,?) RETURNING id",
                (username, salt, hashed),
            ).fetchone()["id"]
        except INTEGRITY_ERRORS:
            raise HTTPException(409, "Ese nombre de usuario ya está en uso.") from None
        start_session(db, request, response, uid)
    return {"username": username}


@router.post("/login")
def login(data: Credentials, request: Request, response: Response):
    limit_attempts(request)
    with connect() as db:
        row = db.execute(
            "SELECT * FROM account WHERE username=?", (data.username.strip().lower(),)
        ).fetchone()
    password = data.password.get_secret_value()
    if len(password) > 256:
        raise HTTPException(401, "Usuario o contraseña incorrectos.")
    hashed = password_hash(password, row["salt"] if row else bytes(16))
    if not row or not hmac.compare_digest(hashed, row["password_hash"]):
        raise HTTPException(401, "Usuario o contraseña incorrectos.")
    with connect(True) as db:
        start_session(db, request, response, row["id"])
    return {"username": row["username"]}


@router.get("/me")
def me(user: Account):
    return {"username": user["username"]}


@router.post("/logout")
def logout(request: Request, response: Response):
    with connect(True) as db:
        db.execute(
            "DELETE FROM session WHERE digest=?",
            (digest(request.cookies.get(COOKIE, "")),),
        )
    response.delete_cookie(COOKIE)
    return {"ok": True}
