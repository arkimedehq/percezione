import io
import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import app as runner

POSE = Path(__file__).resolve().parents[2] / "models" / "pose"
needs_pose = pytest.mark.skipif(not (POSE / "model.onnx").exists(), reason="RTMPose weights not downloaded (analyzers/models/pose/fetch.sh)")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(runner, "MODELS_DIR", tmp_path)
    monkeypatch.setattr(runner, "registry", runner.Registry(tmp_path))
    with TestClient(runner.app) as c:
        yield c, tmp_path


def jpeg(w=320, h=480) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (90, 90, 90)).save(buf, "JPEG")
    return buf.getvalue()


def test_contract_without_models(client):
    """the contract holds with no models / il contratto vale anche senza modelli"""
    c, _ = client
    assert c.get("/health").json()["models"] == 0
    caps = c.get("/capabilities").json()
    assert caps["contract"] == "v1" and caps["tasks_advertised"] == [] and caps["models"] == []
    r = c.post("/infer", files={"frame": ("f.jpg", jpeg())}, data={"params": json.dumps({"model": "pose"})})
    assert r.status_code == 404


def test_bad_manifest_does_not_stop_the_runner(client):
    """a bad manifest does not stop the runner / un manifest sbagliato non ferma il runner"""
    c, root = client
    (root / "broken").mkdir()
    (root / "broken" / "model.yml").write_text("task: x\nfamily: unknown_family\ninput: {width: 1, height: 1, mean: [0], std: [1]}\n")
    runner.registry.scan()
    health = c.get("/health").json()
    assert health["models"] == 0 and "unknown_family" in health["broken"]["broken"]


@needs_pose
def test_model_copied_into_folder_seen_live_and_inference(client):
    """a model copied into the folder is picked up live and runs / un modello copiato nella cartella è visto a caldo e fa inferenza"""
    c, root = client
    shutil.copytree(POSE, root / "pose")
    runner.registry.scan()
    caps = c.get("/capabilities").json()
    assert caps["tasks_advertised"] == ["pose_estimation"]
    r = c.post("/infer", files={"frame": ("f.jpg", jpeg())}, data={"params": json.dumps({"model": "pose", "box": [100, 100, 220, 400]})}).json()
    assert r["status"] == "ok" and r["model_name"] == "pose"
    assert len(r["result"]["keypoints"]) == 17
    assert r["result"]["label"] in {"standing", "sitting", "lying", "uncertain"}
    bad = c.post("/infer", files={"frame": ("f.jpg", jpeg())}, data={"params": json.dumps({"model": "pose", "box": [1, 2]})})
    assert bad.status_code == 400


@needs_pose
def test_upload_validates_before_installing(client):
    """an upload is validated before it is installed / il caricamento è validato prima di installare"""
    c, root = client
    onnx = (POSE / "model.onnx").read_bytes()
    wrong = (POSE / "model.yml").read_text().replace("width: 192", "width: 200")
    r = c.put("/models/pose2", files={"model": ("model.onnx", onnx), "manifest": ("model.yml", wrong)})
    assert r.status_code == 422 and not (root / "pose2").exists()
    ok = c.put("/models/pose2", files={"model": ("model.onnx", onnx), "manifest": ("model.yml", (POSE / "model.yml").read_text())})
    assert ok.status_code == 200
    assert [m["name"] for m in c.get("/capabilities").json()["models"]] == ["pose2"]


CLIP = Path(__file__).resolve().parents[2] / "models" / "clip"


@pytest.mark.skipif(not (CLIP / "vision.onnx").exists(), reason="CLIP weights not downloaded (analyzers/models/clip/fetch.sh)")
def test_clip_zero_shot_with_phrases_from_manifest_or_request(client):
    """CLIP zero-shot with phrases from the manifest or the request / CLIP zero-shot con frasi dal manifest o dalla richiesta"""
    c, root = client
    shutil.copytree(CLIP, root / "clip")
    runner.registry.scan()
    caps = c.get("/capabilities").json()
    assert caps["models"][0]["task"] == "zero_shot_classification" and "watching_tv" in caps["models"][0]["outputs"]
    r = c.post("/infer", files={"frame": ("f.jpg", jpeg())}, data={"params": json.dumps({"model": "clip"})}).json()
    assert r["status"] == "ok" and r["result"]["label"] in caps["models"][0]["outputs"]
    custom = {"day": ["a photo taken in daylight"], "night": "a photo taken at night, very dark"}
    r = c.post("/infer", files={"frame": ("f.jpg", jpeg())}, data={"params": json.dumps({"model": "clip", "prompts": custom})}).json()
    assert {t["label"] for t in r["result"]["top"]} == {"day", "night"}
    assert abs(sum(t["score"] for t in r["result"]["top"]) - 1) < 1e-3
