"""onnx-runner: all of camera-recognition's ONNX models behind the analyzer contract v1 (docs/analyzers.md).

    uv run uvicorn app:app --host 127.0.0.1 --port 8100

- GET  /health        status and loaded models
- GET  /capabilities  tasks and models, with their possible labels
- POST /infer         multipart: frame (JPEG) + params (JSON with "model" and, for top-down models, "box")
- PUT  /models/{name} multipart: model (model.onnx) + manifest (model.yml); the model is live as soon as it loads

Models live in MODELS_DIR/<name>/{model.onnx,model.yml}: copying them there is enough, the runner reloads them live.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import shutil
import tempfile
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image, UnidentifiedImageError

from families import FAMILIES, Model, load_model, providers

VERSION = "0.1.0"
MODELS_DIR = Path(os.environ.get("MODELS_DIR", Path(__file__).resolve().parent.parent / "models"))
SCAN_SECONDS = float(os.environ.get("SCAN_SECONDS", "5"))
NAME_RE = re.compile(r"^[a-z0-9_-]{1,40}$")

log = logging.getLogger("onnx-runner")


class Registry:
    """Loaded models, reloaded when the folder changes (added, removed, new model.onnx or model.yml)."""

    def __init__(self, root: Path):
        self.root = root
        self.models: dict[str, Model] = {}
        self.broken: dict[str, str] = {}
        self.lock = threading.Lock()

    def scan(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        seen = set()
        for folder in sorted(p for p in self.root.iterdir() if p.is_dir() and NAME_RE.match(p.name)):
            if not (folder / "model.yml").exists():
                continue
            seen.add(folder.name)
            # any changed file in the folder (model.onnx, model.yml, clip's files) reloads the model
            mtime = max(f.stat().st_mtime for f in folder.iterdir() if f.is_file())
            current = self.models.get(folder.name)
            if current and current.mtime >= mtime:
                continue
            try:
                model = load_model(folder)
            except Exception as e:  # a broken model does not stop the others; retried on the next scan
                if self.broken.get(folder.name) != str(e):
                    log.error("model %s not loaded: %s", folder.name, e)
                self.broken[folder.name] = str(e)
                with self.lock:
                    self.models.pop(folder.name, None)
                continue
            with self.lock:
                self.models[folder.name] = model
            self.broken.pop(folder.name, None)
            log.info("model %s loaded (%s, %s)", folder.name, model.task, model.family)
        with self.lock:
            for name in set(self.models) - seen:
                del self.models[name]
                log.info("model %s removed", name)
        for name in set(self.broken) - seen:
            del self.broken[name]

    def get(self, name: str) -> Model | None:
        with self.lock:
            return self.models.get(name)

    def all(self) -> list[Model]:
        with self.lock:
            return list(self.models.values())


registry = Registry(MODELS_DIR)


def _watch(stop: threading.Event) -> None:
    while not stop.wait(SCAN_SECONDS):
        try:
            registry.scan()
        except Exception:
            log.exception("model scan failed")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    registry.scan()
    stop = threading.Event()
    threading.Thread(target=_watch, args=(stop,), daemon=True).start()
    yield
    stop.set()


app = FastAPI(title="onnx-runner", version=VERSION, lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "adapter": "onnx-runner",
        "version": VERSION,
        "providers": providers(),
        "models": len(registry.all()),
        "broken": registry.broken,
    }


@app.get("/capabilities")
def capabilities() -> dict[str, Any]:
    models = [m.describe() for m in registry.all()]
    return {
        "adapter": "onnx-runner",
        "version": VERSION,
        "contract": "v1",
        "families": list(FAMILIES),
        "tasks_advertised": sorted({m["task"] for m in models}),
        "models": models,
    }


@app.post("/infer")
async def infer(frame: UploadFile = File(...), params: str = Form("{}")) -> dict[str, Any]:
    try:
        p = json.loads(params)
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"params is not JSON: {e}") from e
    model = registry.get(str(p.get("model", "")))
    if model is None:
        raise HTTPException(404, f"model '{p.get('model')}' not loaded")
    box = p.get("box")
    if box is not None and (not isinstance(box, list) or len(box) != 4 or not all(isinstance(v, (int, float)) for v in box)):
        raise HTTPException(400, "box must be [x1, y1, x2, y2] in pixels")
    try:
        img = Image.open(io.BytesIO(await frame.read()))
        img.load()
    except (UnidentifiedImageError, OSError) as e:
        raise HTTPException(400, f"frame is not an image: {e}") from e
    t0 = time.perf_counter()
    try:
        result = model.infer(img, p)
    except Exception as e:
        model.errors += 1
        log.exception("inference failed on %s", model.name)
        return {"status": "error", "model_name": model.name, "error": str(e)}
    ms = (time.perf_counter() - t0) * 1000
    model.calls += 1
    model.total_ms += ms
    return {"status": "ok", "model_name": model.name, "inference_ms": round(ms, 1), "result": result}


@app.put("/models/{name}")
async def upload(name: str, model: UploadFile = File(...), manifest: UploadFile = File(...)) -> dict[str, Any]:
    """Uploads or replaces a model: it is tried in a temporary folder and installed only if it loads."""
    if not NAME_RE.match(name):
        raise HTTPException(400, "name: lowercase letters, digits, - and _ (max 40)")
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(dir=MODELS_DIR, prefix=".upload-"))
    try:
        with open(tmp / "model.onnx", "wb") as f:
            shutil.copyfileobj(model.file, f)
        (tmp / "model.yml").write_bytes(await manifest.read())
        try:
            loaded = load_model(tmp)
        except Exception as e:
            raise HTTPException(422, f"invalid model: {e}") from e
        dest = MODELS_DIR / name
        if dest.exists():
            shutil.rmtree(dest)
        tmp.rename(dest)
        registry.scan()
        return {"status": "ok", "model": {**loaded.describe(), "name": name}}
    finally:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)
