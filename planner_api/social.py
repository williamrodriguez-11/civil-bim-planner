"""OpenID Connect sign-in using the app's existing account sessions."""

import os
import secrets
from uuid import UUID

import httpx
from authlib.integrations.base_client import OAuthError
from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, HTTPException, Request
from joserfc.errors import JoseError
from starlette.middleware.sessions import SessionMiddleware
from starlette.responses import RedirectResponse

from .auth import start_session
from .db import connect

router = APIRouter(prefix="/api/auth/social")
oauth = OAuth()


def configure(app):
    signing_key = os.getenv("OAUTH_SESSION_SECRET")
    if not signing_key:
        return
    app.add_middleware(
        SessionMiddleware,
        secret_key=signing_key,
        session_cookie="civil_oauth",
        max_age=600,
        https_only=True,
        same_site="none",
        path="/api/auth/social",
    )
    tenant = UUID(
        os.getenv("MICROSOFT_TENANT_ID", "9188040d-6c67-4c5b-b112-36a304b66dad")
    )
    issuers = {
        "google": "https://accounts.google.com",
        "apple": "https://appleid.apple.com",
        "microsoft": f"https://login.microsoftonline.com/{tenant}/v2.0",
    }
    for name, issuer in issuers.items():
        client_id = os.getenv(f"{name.upper()}_CLIENT_ID")
        secret = os.getenv(f"{name.upper()}_CLIENT_SECRET")
        if client_id and secret:
            options = {
                "scope": "openid email",
                "token_endpoint_auth_method": "client_secret_post",
            }
            if name != "apple":
                options["code_challenge_method"] = "S256"
            oauth.register(
                name,
                client_id=client_id,
                client_secret=secret,
                server_metadata_url=issuer + "/.well-known/openid-configuration",
                client_kwargs=options,
            )


@router.get("/providers")
def providers():
    return [p for p in ("google", "apple", "microsoft") if oauth.create_client(p)]


@router.get("/{provider}/start")
async def begin(provider: str, request: Request):
    client = oauth.create_client(provider)
    if not client:
        raise HTTPException(404, "Este proveedor aún no está configurado.")
    callback = request.url_for("social_callback", provider=provider).replace(
        scheme="https"
    )
    options = {"response_mode": "form_post"} if provider == "apple" else {}
    try:
        return await client.authorize_redirect(request, str(callback), **options)
    except (OAuthError, httpx.HTTPError):
        return RedirectResponse("/?acceso=error", status_code=303)


@router.api_route(
    "/{provider}/callback", methods=["GET", "POST"], name="social_callback"
)
async def callback(provider: str, request: Request):
    client = oauth.create_client(provider)
    if not client:
        raise HTTPException(404)
    try:
        token = await client.authorize_access_token(request)
        claims = token.get("userinfo") or {}
        if not claims.get("iss") or not claims.get("sub"):
            return RedirectResponse("/?acceso=error", status_code=303)
    except (OAuthError, httpx.HTTPError, JoseError, ValueError):
        return RedirectResponse("/?acceso=error", status_code=303)
    identity = (claims["iss"], claims["sub"])
    response = RedirectResponse("/?acceso=ok", status_code=303)
    with connect(True) as db:
        row = db.execute(
            "SELECT account_id FROM social_identity WHERE issuer=? AND subject=?",
            identity,
        ).fetchone()
        if row:
            uid = row["account_id"]
        else:
            username = f"{provider}:{secrets.token_hex(6)}"
            uid = db.execute(
                "INSERT INTO account(username,salt,password_hash) VALUES(?,?,?) RETURNING id",
                (username, secrets.token_bytes(16), b""),
            ).fetchone()["id"]
            db.execute(
                "INSERT INTO social_identity(issuer,subject,account_id) VALUES(?,?,?)",
                (*identity, uid),
            )
        start_session(db, request, response, uid)
    return response
