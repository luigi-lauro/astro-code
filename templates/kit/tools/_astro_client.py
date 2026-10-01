"""_astro_client.py — shared stdlib HTTP client for kit tools that talk to a
hosted Astro instance (publish, source authoring, `kit_test.py --live`, …).

Stdlib only (urllib + json + os + re) so it runs anywhere python3 exists, and
under `python3 -I -S` (isolated mode, no site-packages) — see C9. A tool that
imports this module as a sibling must insert its own directory into
`sys.path` first (`-I` drops the script's directory from `sys.path`):

    _THIS_DIR = Path(__file__).resolve().parent
    if str(_THIS_DIR) not in sys.path:
        sys.path.insert(0, str(_THIS_DIR))
    import _astro_client as astro

Credentials never travel on argv: callers read them from environment
variables only (`env_credentials()`, `one_off_from_env()`), and every message
this module prints is passed through `redact()` against every secret it has
seen, so a value echoed back by the server (e.g. in an error body) never
reaches stdout/stderr in the clear.

Exit codes (via `die`), consistent with publish_kit.py's scheme:
    2  usage / missing configuration
    3  authentication failed
    6  network / timeout / service unavailable
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import NoReturn

C_RED, C_GRN, C_CYN, C_NC = "\033[0;31m", "\033[0;32m", "\033[0;36m", "\033[0m"

# Every secret value this process has handled (admin/one-off passwords). Every
# log/ok/warn/die call redacts against this set so a value echoed back by the
# server never reaches stdout/stderr in the clear.
_SECRETS: set[str] = set()


def _track(secret: str | None) -> None:
    if secret:
        _SECRETS.add(str(secret))


def redact(text: str, secrets) -> str:
    """Replace every occurrence of each non-empty secret in `text` with '***'."""
    out = text
    for s in secrets:
        if s:
            out = out.replace(s, "***")
    return out


def log(msg: str) -> None:
    print(f"{C_CYN}[astro]{C_NC} {redact(msg, _SECRETS)}")


def ok(msg: str) -> None:
    print(f"{C_GRN}[astro]{C_NC} {redact(msg, _SECRETS)}")


def warn(msg: str) -> None:
    print(f"{C_RED}[astro]{C_NC} warning: {redact(msg, _SECRETS)}", file=sys.stderr)


def die(code: int, msg: str) -> NoReturn:
    print(f"{C_RED}[astro]{C_NC} {redact(msg, _SECRETS)}", file=sys.stderr)
    sys.exit(code)


def _normalize_base(base: str) -> str:
    base = base.rstrip("/")
    if not re.match(r"^https?://", base):
        base = "https://" + base
    return base


def env_credentials() -> tuple[str, str, str]:
    """Read ASTRO_BASE_URL / ASTRO_ADMIN_EMAIL / ASTRO_ADMIN_PASSWORD. Dies 2
    naming whichever are missing — never prints a value, including this
    function's own die message."""
    base = os.environ.get("ASTRO_BASE_URL")
    email = os.environ.get("ASTRO_ADMIN_EMAIL")
    password = os.environ.get("ASTRO_ADMIN_PASSWORD")
    missing = [
        name
        for name, val in (
            ("ASTRO_BASE_URL", base),
            ("ASTRO_ADMIN_EMAIL", email),
            ("ASTRO_ADMIN_PASSWORD", password),
        )
        if not val
    ]
    if missing:
        die(
            2,
            "missing required environment variable(s): "
            + ", ".join(missing)
            + " (credentials are read from the environment only, never from argv)",
        )
    _track(password)
    return _normalize_base(base), email, password


def one_off_from_env(source_id: str) -> dict | None:
    """Read a one-off connection for `source_id` from
    ASTRO_SOURCE_<ID>_{HOST,PORT,DATABASE,USERNAME,PASSWORD,TRUST_SERVER_CERTIFICATE}.
    `<ID>` is `source_id` upper-cased with every run of non-alphanumeric
    characters collapsed to one underscore (`erp-main` -> `ERP_MAIN`). Returns
    None when no HOST is set for this source (no one-off configured)."""
    key = re.sub(r"[^A-Za-z0-9]+", "_", source_id.strip()).strip("_").upper()
    prefix = f"ASTRO_SOURCE_{key}_"
    host = os.environ.get(prefix + "HOST")
    if not host:
        return None
    conn: dict = {"host": host}
    port = os.environ.get(prefix + "PORT")
    if port:
        try:
            conn["port"] = int(port)
        except ValueError:
            die(2, f"{prefix}PORT must be an integer, got {port!r}")
    database = os.environ.get(prefix + "DATABASE")
    if database:
        conn["database"] = database
    username = os.environ.get(prefix + "USERNAME")
    if username:
        conn["username"] = username
    password = os.environ.get(prefix + "PASSWORD")
    if password:
        _track(password)
        conn["password"] = password
    trust = os.environ.get(prefix + "TRUST_SERVER_CERTIFICATE")
    if trust is not None:
        conn["trustServerCertificate"] = trust.strip().lower() in ("1", "true", "yes", "on")
    return conn


def _json_body(body: bytes | None) -> dict:
    if not body:
        return {}
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {}


def request_json(method: str, url: str, token: str | None = None, body: dict | None = None) -> tuple[int, dict]:
    """Issue one JSON request. Returns (status, json_body) for any response
    the server sends, including 4xx/5xx — only a network failure or a timeout
    dies (6). `timeout=$ASTRO_HTTP_TIMEOUT` seconds (default 120), kept above
    the server's 60 s per-call query limit so a slow-but-alive call is never
    mistaken for a hang."""
    data = json.dumps(body).encode() if body is not None else None
    headers: dict = {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        timeout = float(os.environ.get("ASTRO_HTTP_TIMEOUT", "120"))
    except ValueError:
        timeout = 120.0
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, _json_body(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, _json_body(e.read())
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        die(6, f"cannot reach {url}: {e}")


def login(base: str, email: str, password: str) -> str:
    """POST /api/auth/login. Returns the access token on success. 401/403 die
    3; 503 (auth not configured) dies 6, same bucket as a network failure —
    the instance is not usable either way."""
    _track(password)
    log(f"Logging in as {email}…")
    status, j = request_json("POST", f"{base}/api/auth/login", body={"email": email, "password": password})
    if status == 200 and j.get("accessToken"):
        ok("Authenticated")
        return j["accessToken"]
    if status == 401:
        die(3, "invalid email or password")
    if status == 403:
        die(3, "this account is disabled")
    if status == 503:
        die(6, "auth is not configured on this Astro instance")
    die(3, f"login failed ({status}): {j.get('message') or json.dumps(j)[:300]}")


def resolve_kit_id(root: Path) -> str:
    """Return the kit id from `kit.json` at `root` (`name` IS the id, as in
    publish_kit.py). Dies 2 if the file is missing, unreadable, or has
    neither `id` nor `name`."""
    path = root / "kit.json"
    if not path.is_file():
        die(2, f"no kit.json found at {path}")
    try:
        m = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        die(2, f"{path} is not valid JSON: {e}")
    kit_id = m.get("id") or m.get("name")
    if not kit_id:
        die(2, f"{path} has neither 'id' nor 'name'")
    return str(kit_id)
