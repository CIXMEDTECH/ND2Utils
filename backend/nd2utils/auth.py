"""Access codes and login sessions.

Every visitor must log in with an access code. Each code owns exactly one
workspace (its id is the owner id of files and jobs). The first start of a
deployment creates an admin code; the admin hands out further codes from the
settings page.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
import uuid
from threading import RLock
from typing import Any, Literal

from nd2utils.config import ensure_dirs, settings

Role = Literal["admin", "user"]
Kind = Literal["permanent", "temporary"]

SESSION_MAX_AGE = 30 * 24 * 60 * 60
_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_TOUCH_INTERVAL = 300
_LOGIN_WINDOW = 600
_LOGIN_MAX_FAILURES = 10

_LOCK = RLock()
_FAILURES: dict[str, list[float]] = {}


class AuthError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def normalize_code(raw: str) -> str:
    return "".join(ch for ch in str(raw).upper() if ch.isalnum())


def generate_code() -> str:
    raw = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(16))
    return "-".join(raw[i : i + 4] for i in range(0, 16, 4))


def _load() -> dict[str, Any]:
    ensure_dirs()
    path = settings.auth_path
    if not path.exists():
        return {"codes": {}, "sessions": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        # Never silently start over: that would drop every code and session.
        raise RuntimeError(f"{path} is unreadable; fix or remove it before starting ND2Utils.")
    if not isinstance(data, dict):
        data = {}
    data.setdefault("codes", {})
    data.setdefault("sessions", {})
    return data


def _save(data: dict[str, Any]) -> None:
    ensure_dirs()
    path = settings.auth_path
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def code_status(rec: dict[str, Any], now: float | None = None) -> str:
    now = now or time.time()
    if rec.get("disabled"):
        return "disabled"
    expires = rec.get("expires_at")
    if expires and now >= float(expires):
        return "expired"
    return "active"


def public_code(rec: dict[str, Any], *, reveal: bool = False) -> dict[str, Any]:
    out = {
        "id": rec["id"],
        "label": rec.get("label") or "",
        "role": rec.get("role", "user"),
        "kind": rec.get("kind", "temporary"),
        "expires_at": rec.get("expires_at"),
        "created_at": rec.get("created_at"),
        "last_login_at": rec.get("last_login_at"),
        "disabled": bool(rec.get("disabled")),
        "status": code_status(rec),
    }
    if reveal:
        out["code"] = rec.get("code")
    return out


def _new_record(code: str, *, label: str, role: Role, kind: Kind, expires_at: float | None) -> dict[str, Any]:
    return {
        "id": uuid.uuid4().hex,
        "code": code,
        "code_hash": _hash(normalize_code(code)),
        "label": label,
        "role": role,
        "kind": kind,
        "expires_at": expires_at,
        "created_at": time.time(),
        "last_login_at": None,
        "disabled": False,
    }


def ensure_admin() -> dict[str, Any]:
    """On the very first start, create the admin code and print it to the server log."""
    with _LOCK:
        data = _load()
        for rec in data["codes"].values():
            if rec.get("role") == "admin":
                return rec
        code = generate_code()
        rec = _new_record(code, label="Administrator", role="admin", kind="permanent", expires_at=None)
        data["codes"][rec["id"]] = rec
        _save(data)
    banner = "=" * 60
    print(f"\n{banner}\n ND2Utils admin access code / 管理员授权码:\n\n    {code}\n\n{banner}\n", flush=True)
    return rec


def _check_rate(client: str, now: float) -> None:
    recent = [t for t in _FAILURES.get(client, []) if now - t < _LOGIN_WINDOW]
    _FAILURES[client] = recent
    if len(recent) >= _LOGIN_MAX_FAILURES:
        raise AuthError("rate_limited", "Too many failed attempts. Try again later.")


def login(raw_code: str, client: str = "") -> tuple[str, dict[str, Any]]:
    now = time.time()
    with _LOCK:
        _check_rate(client, now)
        wanted = _hash(normalize_code(raw_code))
        data = _load()
        match = None
        for rec in data["codes"].values():
            if secrets.compare_digest(str(rec.get("code_hash", "")), wanted):
                match = rec
        if match is None:
            _FAILURES.setdefault(client, []).append(now)
            raise AuthError("invalid_code", "Invalid access code.")
        status = code_status(match, now)
        if status != "active":
            raise AuthError(f"code_{status}", f"This access code is {status}.")
        token = secrets.token_urlsafe(32)
        data["sessions"][_hash(token)] = {"code_id": match["id"], "created_at": now, "last_seen_at": now}
        match["last_login_at"] = now
        _prune_sessions(data, now)
        _save(data)
        _FAILURES.pop(client, None)
        return token, match


def _prune_sessions(data: dict[str, Any], now: float) -> None:
    codes = data["codes"]
    for key, sess in list(data["sessions"].items()):
        rec = codes.get(sess.get("code_id"))
        if (
            rec is None
            or code_status(rec, now) != "active"
            or now - float(sess.get("created_at") or 0) > SESSION_MAX_AGE
        ):
            data["sessions"].pop(key, None)


def resolve_session(token: str | None) -> dict[str, Any] | None:
    if not token or len(token) > 256:
        return None
    now = time.time()
    key = _hash(token)
    with _LOCK:
        data = _load()
        sess = data["sessions"].get(key)
        if not sess:
            return None
        rec = data["codes"].get(sess.get("code_id"))
        expired_session = now - float(sess.get("created_at") or 0) > SESSION_MAX_AGE
        if rec is None or expired_session or code_status(rec, now) != "active":
            data["sessions"].pop(key, None)
            _save(data)
            return None
        if now - float(sess.get("last_seen_at") or 0) > _TOUCH_INTERVAL:
            sess["last_seen_at"] = now
            _save(data)
        return dict(rec)


def logout(token: str | None) -> None:
    if not token:
        return
    with _LOCK:
        data = _load()
        if data["sessions"].pop(_hash(token), None) is not None:
            _save(data)


def list_codes() -> list[dict[str, Any]]:
    with _LOCK:
        items = list(_load()["codes"].values())
    items.sort(key=lambda r: (r.get("role") != "admin", -(r.get("created_at") or 0)))
    return items


def get_code(code_id: str) -> dict[str, Any] | None:
    with _LOCK:
        rec = _load()["codes"].get(code_id)
    return dict(rec) if rec else None


def known_owner_ids() -> dict[str, dict[str, Any]]:
    with _LOCK:
        return {k: dict(v) for k, v in _load()["codes"].items()}


def create_code(*, label: str, kind: Kind, expires_at: float | None) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        rec = _new_record(generate_code(), label=label.strip()[:80], role="user", kind=kind, expires_at=expires_at)
        data["codes"][rec["id"]] = rec
        _save(data)
        return rec


def update_code(code_id: str, changes: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        rec = data["codes"].get(code_id)
        if rec is None:
            raise AuthError("not_found", "Access code not found.")
        is_admin = rec.get("role") == "admin"
        if "label" in changes and changes["label"] is not None:
            rec["label"] = str(changes["label"]).strip()[:80]
        if not is_admin:
            # The admin code must stay usable, otherwise nobody can manage the deployment.
            if "kind" in changes and changes["kind"] in ("permanent", "temporary"):
                rec["kind"] = changes["kind"]
            if "expires_at" in changes:
                rec["expires_at"] = changes["expires_at"]
            if "disabled" in changes and changes["disabled"] is not None:
                rec["disabled"] = bool(changes["disabled"])
        _prune_sessions(data, time.time())
        _save(data)
        return rec


def regenerate_code(code_id: str) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        rec = data["codes"].get(code_id)
        if rec is None:
            raise AuthError("not_found", "Access code not found.")
        code = generate_code()
        rec["code"] = code
        rec["code_hash"] = _hash(normalize_code(code))
        for key, sess in list(data["sessions"].items()):
            if sess.get("code_id") == code_id:
                data["sessions"].pop(key, None)
        _save(data)
        return rec


def delete_code(code_id: str) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        rec = data["codes"].get(code_id)
        if rec is None:
            raise AuthError("not_found", "Access code not found.")
        if rec.get("role") == "admin":
            raise AuthError("forbidden", "The admin code cannot be deleted.")
        data["codes"].pop(code_id, None)
        _prune_sessions(data, time.time())
        _save(data)
        return rec

