from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

TMP = Path(tempfile.mkdtemp(prefix="nd2utils-test-"))
os.environ["ND2UTILS_DATA_DIR"] = str(TMP)
os.environ["ND2UTILS_TTL_HOURS"] = "24"

import pytest
from fastapi.testclient import TestClient

from nd2utils import auth
from nd2utils.main import app


def admin_code() -> str:
    auth.ensure_admin()
    return next(rec["code"] for rec in auth.list_codes() if rec["role"] == "admin")


def login(client: TestClient, code: str) -> None:
    response = client.post("/api/auth/login", json={"code": code})
    assert response.status_code == 200, response.text


@pytest.fixture
def anon():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def client():
    """A client logged in with its own fresh temporary access code (= its own workspace)."""
    with TestClient(app) as c:
        rec = auth.create_code(label="test", kind="temporary", expires_at=None)
        login(c, rec["code"])
        c.code_id = rec["id"]
        yield c


@pytest.fixture
def admin():
    with TestClient(app) as c:
        login(c, admin_code())
        yield c


@pytest.fixture
def sample_files() -> list[Path]:
    """Up to three ND2 files from the first ND2demo folder that has some (local-only fixtures)."""
    root = ROOT / "ND2demo"
    samples = sorted(root.rglob("*.nd2")) if root.is_dir() else []
    if not samples:
        pytest.skip("ND2demo fixtures are local-only and not shipped in git")
    folder = samples[0].parent
    return [p for p in samples if p.parent == folder][:3]
