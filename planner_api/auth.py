import hashlib
import hmac
import re
import secrets
import threading
import time
import unicodedata
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, SecretStr

from .db import INTEGRITY_ERRORS, connect

router = APIRouter(prefix="/api/auth")
COOKIE = "civil_session"
LIFETIME = 14 * 24 * 3600
# Each scrypt hash uses about 32 MiB. Bound concurrent hashes so a burst of
# sign-ins cannot exhaust a small instance (Render Free has 512 MB).
HASH_SLOTS = threading.BoundedSemaphore(2)
CLIENT_LIMIT = 60
ACCOUNT_LIMIT = 20


class Credentials(BaseModel):
    username: str
    password: SecretStr


def digest(token):
    return hashlib.sha256(token.encode()).digest()


def password_hash(password, salt):
    with HASH_SLOTS:
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


def limit_attempts(request, username=None):
    """Count attempts per client address and, for sign-in, per account name."""
    client = request.client.host if request.client else "unknown"
    keys = [(client, CLIENT_LIMIT)]
    if username:
        keys.append(("account:" + username[:254], ACCOUNT_LIMIT))
    now = int(time.time())
    exceeded = False
    with connect(True) as db:
        db.execute("DELETE FROM auth_attempt WHERE until<=?", (now,))
        for key, limit in keys:
            count = db.execute(
                "INSERT INTO auth_attempt VALUES(?,1,?) ON CONFLICT(client) DO UPDATE "
                "SET attempts=auth_attempt.attempts+1 RETURNING attempts",
                (key, now + 600),
            ).fetchone()["attempts"]
            exceeded = exceeded or count > limit
    if exceeded:
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
    limit_attempts(request, data.username.strip().lower())
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
        # A password change may have committed since it was checked.
        still = db.execute(
            "SELECT 1 FROM account WHERE id=? AND password_hash=?",
            (row["id"], row["password_hash"]),
        ).fetchone()
        if not still:
            raise HTTPException(401, "Usuario o contraseña incorrectos.")
        start_session(db, request, response, row["id"])
    return {"username": row["username"]}


@router.get("/me")
def me(user: Account):
    with connect() as db:
        row = db.execute(
            "SELECT password_hash FROM account WHERE id=?", (user["id"],)
        ).fetchone()
        issuers = [
            r["issuer"]
            for r in db.execute(
                "SELECT issuer FROM social_identity WHERE account_id=? ORDER BY issuer",
                (user["id"],),
            )
        ]
    providers = [
        name
        for name, host in (
            ("Google", "accounts.google.com"),
            ("Apple", "appleid.apple.com"),
            ("Microsoft", "login.microsoftonline.com"),
        )
        if any(host in i for i in issuers)
    ]
    return {
        "username": user["username"],
        "has_password": bool(row and bytes(row["password_hash"])),
        "providers": providers,
    }


def password_problems(password, username=""):
    """Rules for a new password, as shown next to the field."""
    problems = []
    if not 12 <= len(password) <= 256:
        problems.append("Usa entre 12 y 256 caracteres.")
    if not re.search(r"[A-ZÁÉÍÓÚÑÜ]", password):
        problems.append("Incluye al menos una letra mayúscula.")
    if not re.search(r"[a-záéíóúñü]", password):
        problems.append("Incluye al menos una letra minúscula.")
    if not re.search(r"\d", password):
        problems.append("Incluye al menos un número.")
    # Punctuation or symbols (Unicode P* and S*), as the form checks.
    if not any(unicodedata.category(c)[0] in "PS" for c in password):
        problems.append("Incluye al menos un símbolo, por ejemplo ! # $ % & *.")
    name = username.split("@")[0].lower()
    lowered = password.lower()
    if (len(name) >= 3 and name in lowered) or (
        username and username.lower() in lowered
    ):
        problems.append("No incluyas tu nombre de usuario.")
    return problems


class PasswordChange(BaseModel):
    current_password: SecretStr | None = None
    new_password: SecretStr


@router.post("/password")
def change_password(data: PasswordChange, request: Request, user: Account):
    limit_attempts(request, user["username"])
    new = data.new_password.get_secret_value()
    with connect() as db:
        row = db.execute(
            "SELECT salt, password_hash FROM account WHERE id=?", (user["id"],)
        ).fetchone()
    if not bytes(row["password_hash"]):
        raise HTTPException(
            409, "Esta cuenta entra con Google, Apple o Microsoft y no usa contraseña."
        )
    current = (
        data.current_password.get_secret_value() if data.current_password else ""
    )
    if len(current) > 256 or not hmac.compare_digest(
        password_hash(current, bytes(row["salt"])), bytes(row["password_hash"])
    ):
        raise HTTPException(403, "La contraseña actual no es correcta.")
    if hmac.compare_digest(current.encode(), new.encode()):
        raise HTTPException(
            422, "La nueva contraseña debe ser distinta de la actual."
        )
    problems = password_problems(new, user["username"])
    if problems:
        raise HTTPException(422, " ".join(problems))
    salt = secrets.token_bytes(16)
    hashed = password_hash(new, salt)
    with connect(True) as db:
        # Only over the password that was verified, and only from a session
        # that another change has not closed meanwhile.
        changed = db.execute(
            "UPDATE account SET salt=?, password_hash=? WHERE id=? AND password_hash=? "
            "AND EXISTS(SELECT 1 FROM session WHERE account_id=? AND digest=?) RETURNING id",
            (
                salt,
                hashed,
                user["id"],
                row["password_hash"],
                user["id"],
                digest(request.cookies.get(COOKIE, "")),
            ),
        ).fetchone()
        if not changed:
            raise HTTPException(
                409, "La contraseña cambió mientras tanto. Vuelve a intentarlo."
            )
        # Other devices must sign in again with the new password.
        db.execute(
            "DELETE FROM session WHERE account_id=? AND digest<>?",
            (user["id"], digest(request.cookies.get(COOKIE, ""))),
        )
    return {"ok": True}


@router.post("/logout")
def logout(request: Request, response: Response):
    with connect(True) as db:
        db.execute(
            "DELETE FROM session WHERE digest=?",
            (digest(request.cookies.get(COOKIE, "")),),
        )
    response.delete_cookie(COOKIE)
    return {"ok": True}
