from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

import pytest
from helpers import fast, needs_torch

from synapse_studio.core import datasets, export, predict, training
from synapse_studio.core import project as projects
from synapse_studio.core.training import Job


def _run(args: list[str], cwd: Path) -> str:
    finished = subprocess.run([sys.executable, *args], cwd=cwd, capture_output=True, text=True, timeout=300,
                              env={"PATH": "/usr/bin:/bin", "HOME": str(cwd)})  # fmt: skip
    assert finished.returncode == 0, finished.stderr[-3000:]
    return finished.stdout


@pytest.mark.parametrize("algo", ["random_forest", "neural_network"])
def test_tabular_export_runs_without_synapse(ws, churn, algo, tmp_path):
    project = fast(projects.new_project(ws, churn["id"]), algo)
    project["transform"].append(projects._step("transform", "encode", {"method": "onehot"}))
    project["rows"].append(projects._step("rows", "balance_classes", {"method": "oversample"}))
    if algo == "neural_network":
        project["models"][0]["params"].update(epochs=5)
    else:
        project["models"][0]["params"].update(n_estimators=30)
    result = training.run(ws, project, Job("job"))
    record = result["models"][0]
    built = export.build(ws, project["id"], result["id"], record["id"], include_data=True)
    names = {f["name"] for f in built["files"]}
    assert {"model.joblib", "synapse_runtime.py", "predict.py", "serve.py", "train.py", "schema.json", "example.csv",
            "requirements.txt", "MODEL_CARD.md", "data.csv"} <= names  # fmt: skip
    target = tmp_path / "unzipped"
    with zipfile.ZipFile(ws.inside(built["zip"]["path"])) as bundle:
        bundle.extractall(target)
    folder = next(target.iterdir())
    out = _run(["predict.py", "example.csv", "-o", "scored.csv"], folder)
    assert "wrote 5 predictions" in out
    header = (folder / "scored.csv").read_text().splitlines()[0]
    assert "predicted_churned" in header and "probability_True" in header
    trained = _run(["train.py", "data.csv"], folder)
    assert "accuracy" in trained and "saved model.joblib" in trained
    requirements = (folder / "requirements.txt").read_text()
    assert "scikit-learn==" in requirements
    assert "Customer churn" in built["model_card"]


def test_serve_script(ws, churn, tmp_path):
    project = fast(projects.new_project(ws, churn["id"]), "logistic_regression")
    result = training.run(ws, project, Job("job"))
    built = export.build(ws, project["id"], result["id"], result["models"][0]["id"])
    folder = ws.inside(built["folder"])
    import socket

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = subprocess.Popen([sys.executable, "serve.py", "--port", str(port)], cwd=folder,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)  # fmt: skip
    try:
        body = json.dumps({"rows": [{"tenure_months": 3, "contract": "month_to_month"}]}).encode()
        for _ in range(100):
            try:
                request = urllib.request.Request(f"http://127.0.0.1:{port}/predict", data=body, method="POST")
                with urllib.request.urlopen(request, timeout=5) as reply:
                    answer = json.loads(reply.read())
                break
            except OSError:
                time.sleep(0.2)
        assert answer["predictions"][0] in (True, False) and set(answer["probabilities"][0]) == {"False", "True"}
    finally:
        server.terminate()


def test_predict_rows_and_file(ws, churn):
    project = fast(projects.new_project(ws, churn["id"]), "hist_gradient_boosting")
    result = training.run(ws, project, Job("job"))
    model_id = result["models"][0]["id"]
    answer = predict.predict_rows(ws, project["id"], result["id"], model_id,
                                  [{"tenure_months": "4", "monthly_charges": "", "contract": "month_to_month"}])  # fmt: skip
    assert answer["classes"] == ["False", "True"] and abs(sum(answer["probabilities"][0]) - 1) < 1e-6
    scored = predict.predict_dataset(ws, project["id"], result["id"], model_id, churn["id"])
    assert scored["rows"] == 2000 and "predicted_churned" in scored["header"]


@needs_torch
def test_image_cnn_train_export_predict(ws, tmp_path):
    meta = datasets.import_sample(ws, "digits")
    assert meta["kind"] == "image" and len(meta["classes"]) == 10
    project = projects.new_project(ws, meta["id"], packages={"torchvision": "0.20"})
    assert project["models"][0]["algo"] == "cnn" and project["image"]["size"] == 32  # small images: a CNN
    project["image"].update(size=16, grayscale=True, rotation=5)
    project["models"][0]["params"].update(epochs=3, batch_size=64, device="cpu",
                                          layers=[{"type": "conv", "filters": 8, "kernel": 3, "activation": "relu"},
                                                  {"type": "maxpool", "size": 2}, {"type": "batchnorm"},
                                                  {"type": "dense", "units": 32, "activation": "relu"}])  # fmt: skip
    events: list[dict] = []
    result = training.run(ws, project, Job("job", events.append))
    record = result["models"][0]
    assert record["status"] == "done", record.get("error")
    assert record["metrics"]["accuracy"] > 0.5 and len(record["history"]) == 3
    assert record["details"]["confusion"]["labels"] == [str(i) for i in range(10)]
    assert any(e["kind"] == "epoch" for e in events)
    sample = next((ws.datasets / meta["id"] / "images" / "3").iterdir())
    import base64

    answer = predict.predict_image(ws, project["id"], result["id"], record["id"],
                                   base64.b64encode(sample.read_bytes()).decode())  # fmt: skip
    assert answer["prediction"] in [str(i) for i in range(10)] and answer["image"].startswith("data:image/png")
    built = export.build(ws, project["id"], result["id"], record["id"])
    names = {f["name"] for f in built["files"]}
    assert {"model.pt", "labels.json", "preprocess.json", "predict.py", "requirements.txt", "MODEL_CARD.md"} <= names
    folder = ws.inside(built["folder"])
    out = _run(["predict.py", str(sample)], folder)
    assert "->" in out and "%" in out


@needs_torch
def test_pretrained_network_builds_offline():
    pytest.importorskip("torchvision")
    from synapse_studio.core import images

    net = images.build_network({"algo": "pretrained", "params": {"arch": "mobilenet_v3_small", "pretrained": False,
                                                                 "freeze": True}}, 3, 64, 4)  # fmt: skip
    import torch

    assert net(torch.zeros(2, 3, 64, 64)).shape == (2, 4)
    trainable = [p for p in net.parameters() if p.requires_grad]
    assert 0 < len(trainable) <= 2  # only the new head


def test_download_resumes_after_a_dropped_connection(tmp_path):
    import hashlib
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from synapse_studio.core.images import download

    payload = bytes(range(256)) * 4000  # ~1 MB
    name = f"net-{hashlib.sha256(payload).hexdigest()[:8]}.pth"
    calls: list[str] = []

    class Flaky(BaseHTTPRequestHandler):
        def log_message(self, *args):  # quiet
            pass

        def do_GET(self):
            start = int((self.headers.get("Range") or "bytes=0-").split("=")[1].split("-")[0])
            calls.append(self.headers.get("Range") or "full")
            body = payload[start:]
            self.send_response(206 if start else 200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if len(calls) == 1:  # first attempt: send a third, then drop the connection
                self.wfile.write(body[: len(payload) // 3])
                self.wfile.flush()
                self.connection.shutdown(2)
                return
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Flaky)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        seen: list[int] = []
        target = tmp_path / name
        download(
            f"http://127.0.0.1:{server.server_port}/{name}", target, lambda done, total: seen.append(done), timeout=5
        )
        assert target.read_bytes() == payload
        assert calls[0] == "full" and calls[1].startswith("bytes=") and calls[1] != "bytes=0-"
        assert seen[-1] == len(payload)
    finally:
        server.shutdown()
