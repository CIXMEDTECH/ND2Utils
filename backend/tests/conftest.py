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

from nd2utils.main import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def sample_dir() -> Path:
    path = ROOT / "ND2demo"
    samples = sorted(path.glob("*.nd2")) if path.is_dir() else []
    if not samples:
        pytest.skip("ND2demo fixtures are local-only and not shipped in git")
    return path
