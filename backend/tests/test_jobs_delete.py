from __future__ import annotations

import threading
import time

from conftest import wait_job

from nd2utils import export_jobs, store
from nd2utils.config import settings


def _upload(client, path, folder=""):
    with path.open("rb") as fh:
        r = client.post("/api/files", params={"folder": folder}, files={"file": (path.name, fh)})
    assert r.status_code == 200, r.text
    return r.json()


def test_delete_finished_job_removes_record_and_download(client, sample_files):
    rec = _upload(client, sample_files[0])
    job_id = client.post("/api/export", json={"file_ids": [rec["id"]], "format": "png"}).json()["id"]
    job = wait_job(client, job_id)
    assert job["status"] == "done"
    zip_path = settings.exports_dir / job["download_name"]
    assert zip_path.exists()
    assert client.delete(f"/api/jobs/{job_id}").status_code == 200
    assert client.get(f"/api/jobs/{job_id}").status_code == 404
    assert not zip_path.exists()
    assert client.delete(f"/api/jobs/{job_id}").status_code == 404


def test_delete_running_job_cancels_it(client, sample_files, monkeypatch):
    rec = _upload(client, sample_files[0])
    started = threading.Event()
    release = threading.Event()
    real_open = export_jobs.open_nd2

    def slow_open(path):
        started.set()
        release.wait(10)
        return real_open(path)

    monkeypatch.setattr(export_jobs, "open_nd2", slow_open)
    job_id = client.post("/api/export", json={"file_ids": [rec["id"]], "format": "png"}).json()["id"]
    assert started.wait(10)
    assert client.delete(f"/api/jobs/{job_id}").status_code == 200
    release.set()
    # The export notices at its next progress write, stops without re-creating the record
    # and removes its working folder.
    deadline = time.time() + 10
    while time.time() < deadline and (settings.exports_dir / job_id).exists():
        time.sleep(0.05)
    assert not (settings.exports_dir / job_id).exists()
    assert client.get(f"/api/jobs/{job_id}").status_code == 404
    assert all(j["id"] != job_id for j in client.get("/api/jobs").json()["jobs"])
    assert store.job_cancelled(job_id)


def test_clear_finished_keeps_other_owners(client, admin, sample_files):
    mine = _upload(client, sample_files[0])
    theirs = _upload(admin, sample_files[1])
    a = client.post("/api/export", json={"file_ids": [mine["id"]], "format": "png"}).json()["id"]
    b = admin.post("/api/export", json={"file_ids": [theirs["id"]], "format": "png"}).json()["id"]
    wait_job(client, a)
    wait_job(admin, b)
    r = client.post("/api/jobs/clear", json={"scope": "finished"})
    assert r.status_code == 200 and a in r.json()["deleted"] and b not in r.json()["deleted"]
    assert admin.get(f"/api/jobs/{b}").status_code == 200
    # Someone else's job is invisible: 404, and it stays.
    assert client.delete(f"/api/jobs/{b}").status_code == 404
    assert admin.get(f"/api/jobs/{b}").status_code == 200
