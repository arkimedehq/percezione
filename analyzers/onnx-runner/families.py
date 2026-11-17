"""ONNX model families: how to prepare the image and how to read the output (docs/analyzers.md).

A model is a folder with `model.onnx` and `model.yml`; the manifest gives the family and the parameters, so a new
model of a known family needs no code.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
import yaml
from PIL import Image
from tokenizers import Tokenizer

import posture

FAMILIES = ("rtmpose", "classifier", "clip")


class ManifestError(ValueError):
    pass


def providers() -> list[str]:
    """CUDA when available, otherwise CPU. CoreML exists on Apple machines but for small models the CPU is faster."""
    available = ort.get_available_providers()
    return [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in available]


@dataclass
class Model:
    name: str
    path: Path
    manifest: dict[str, Any]
    session: ort.InferenceSession
    mtime: float
    # clip: text session, tokenizer and already encoded phrases
    extra: dict[str, Any] = field(default_factory=dict)
    calls: int = 0
    total_ms: float = 0.0
    errors: int = 0
    loaded_at: float = field(default_factory=time.time)

    @property
    def task(self) -> str:
        return self.manifest["task"]

    @property
    def family(self) -> str:
        return self.manifest["family"]

    def describe(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "task": self.task,
            "family": self.family,
            "outputs": self.manifest.get("outputs", self.manifest.get("labels", [])),
            "inputs": {k: self.manifest["input"][k] for k in ("width", "height")},
            "calls": self.calls,
            "errors": self.errors,
            "avg_ms": round(self.total_ms / self.calls, 1) if self.calls else None,
        }

    def infer(self, img: Image.Image, params: dict[str, Any]) -> dict[str, Any]:
        if self.family == "rtmpose":
            return infer_rtmpose(self, img, params)
        if self.family == "clip":
            return infer_clip(self, img, params)
        return infer_classifier(self, img, params)


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        m = yaml.safe_load(path.read_text())
    except yaml.YAMLError as e:
        raise ManifestError(f"invalid model.yml: {e}") from e
    if not isinstance(m, dict):
        raise ManifestError("invalid model.yml: a mapping is needed")
    for key in ("task", "family", "input"):
        if key not in m:
            raise ManifestError(f"model.yml: missing '{key}'")
    if m["family"] not in FAMILIES:
        raise ManifestError(f"unknown family '{m['family']}' (known: {', '.join(FAMILIES)})")
    inp = m["input"]
    for key in ("width", "height", "mean", "std"):
        if key not in inp:
            raise ManifestError(f"model.yml: missing input.{key}")
    if m["family"] == "classifier" and not m.get("labels"):
        raise ManifestError("model.yml: a classifier needs labels")
    if m["family"] == "clip" and not isinstance(m.get("prompts"), dict):
        raise ManifestError("model.yml: clip needs prompts (label → phrases)")
    return m


def model_files(folder: Path, manifest: dict[str, Any]) -> list[Path]:
    """The files the model is made of: model.onnx, or those listed in `files` (clip)."""
    files = manifest.get("files") or {"model": "model.onnx"}
    return [folder / f for f in files.values()]


def load_model(folder: Path) -> Model:
    manifest = load_manifest(folder / "model.yml")
    for f in model_files(folder, manifest):
        if not f.exists():
            raise ManifestError(f"missing {f.name}")
    mtime = max(f.stat().st_mtime for f in [*model_files(folder, manifest), folder / "model.yml"])
    if manifest["family"] == "clip":
        files = manifest["files"]
        session = ort.InferenceSession(str(folder / files["vision"]), providers=providers())
        extra = {
            "text": ort.InferenceSession(str(folder / files["text"]), providers=providers()),
            "tokenizer": Tokenizer.from_file(str(folder / files["tokenizer"])),
            "cache": {},
        }
        return Model(name=folder.name, path=folder, manifest=manifest, session=session, mtime=mtime, extra=extra)
    onnx = folder / "model.onnx"
    session = ort.InferenceSession(str(onnx), providers=providers())
    shape = session.get_inputs()[0].shape
    want = [manifest["input"]["height"], manifest["input"]["width"]]
    if all(isinstance(d, int) for d in shape[2:4]) and list(shape[2:4]) != want:
        raise ManifestError(f"model.onnx wants {shape[2:4]} (height, width), model.yml says {want}")
    return Model(name=folder.name, path=folder, manifest=manifest, session=session, mtime=mtime)


def normalize(img: Image.Image, inp: dict[str, Any]) -> np.ndarray:
    arr = np.asarray(img.convert("RGB"), dtype=np.float32)
    if inp.get("channels", "RGB") == "BGR":
        arr = arr[:, :, ::-1]
    arr = (arr - np.array(inp["mean"], dtype=np.float32)) / np.array(inp["std"], dtype=np.float32)
    return np.ascontiguousarray(arr.transpose(2, 0, 1)[None])


def crop_box(img: Image.Image, box: list[float] | None, width: int, height: int, padding: float):
    """Top-down crop: the box's center, sides extended by the padding and brought to the input's aspect ratio.

    Returns the `width`×`height` image and the inverse transform (origin and scale) to map points back to the
    original image.
    """
    if box:
        x1, y1, x2, y2 = box
    else:
        x1, y1, x2, y2 = 0, 0, img.width, img.height
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    w, h = (x2 - x1) * padding, (y2 - y1) * padding
    ratio = width / height
    if w > h * ratio:
        h = w / ratio
    else:
        w = h * ratio
    ox, oy = cx - w / 2, cy - h / 2
    sx, sy = w / width, h / height
    # PIL AFFINE: for each output point (u, v) it takes (sx*u + ox, sy*v + oy) from the input
    out = img.convert("RGB").transform((width, height), Image.Transform.AFFINE, (sx, 0, ox, 0, sy, oy), Image.Resampling.BILINEAR)
    return out, (ox, oy, sx, sy)


def infer_rtmpose(m: Model, img: Image.Image, params: dict[str, Any]) -> dict[str, Any]:
    inp = m.manifest["input"]
    box = params.get("box")
    crop, (ox, oy, sx, sy) = crop_box(img, box, inp["width"], inp["height"], float(inp.get("padding", 1.25)))
    simcc_x, simcc_y = m.session.run(None, {m.session.get_inputs()[0].name: normalize(crop, inp)})
    ratio = float(m.manifest.get("simcc_split_ratio", 2.0))
    xs = simcc_x[0].argmax(axis=1) / ratio
    ys = simcc_y[0].argmax(axis=1) / ratio
    # as in MMPose (get_simcc_maximum): the confidence is the lower of the two maxima
    scores = np.minimum(simcc_x[0].max(axis=1), simcc_y[0].max(axis=1))
    labels = m.manifest.get("labels") or [str(i) for i in range(len(xs))]
    keypoints = [
        {"name": labels[i], "x": round(float(ox + xs[i] * sx), 1), "y": round(float(oy + ys[i] * sy), 1), "score": round(float(scores[i]), 3)}
        for i in range(len(xs))
    ]
    result: dict[str, Any] = {"keypoints": keypoints}
    derive = m.manifest.get("derive") or {}
    frame_box = box or [0, 0, img.width, img.height]
    if "posture" in derive:
        label, features = posture.classify(keypoints, frame_box, derive["posture"])
        result["label"] = label
        result["features"] = features
    if "gestures" in derive:
        result["gestures"] = posture.gestures(keypoints, derive["gestures"])
    return result


def _text_embedding(m: Model, prompt: str) -> np.ndarray:
    """Phrase → normalized vector, one phrase at a time (no padding) and cached."""
    cache: dict[str, np.ndarray] = m.extra["cache"]
    if prompt not in cache:
        ids = np.array([m.extra["tokenizer"].encode(prompt).ids[:77]], dtype=np.int64)
        v = m.extra["text"].run(None, {"input_ids": ids})[0][0].astype(np.float64)
        cache[prompt] = v / np.linalg.norm(v)
    return cache[prompt]


def infer_clip(m: Model, img: Image.Image, params: dict[str, Any]) -> dict[str, Any]:
    """Zero-shot: cosine similarity between the image and each label's phrases, softmax over `logit_scale`."""
    inp = m.manifest["input"]
    size = inp["width"]
    box = params.get("box")
    if box:
        # a wide square crop around the person, within the frame
        crop, _ = crop_box(img, box, size * 4, size * 4, float(inp.get("padding", 2.0)))
    else:
        crop = img.convert("RGB")
    # as in CLIPProcessor: short side to `size` (bicubic) and center crop
    scale = size / min(crop.size)
    crop = crop.resize((max(size, round(crop.width * scale)), max(size, round(crop.height * scale))), Image.Resampling.BICUBIC)
    left, top = (crop.width - size) // 2, (crop.height - size) // 2
    crop = crop.crop((left, top, left + size, top + size))
    v = m.session.run(None, {m.session.get_inputs()[0].name: normalize(crop, inp)})[0][0].astype(np.float64)
    v /= np.linalg.norm(v)
    prompts: dict[str, list[str]] = params.get("prompts") or m.manifest["prompts"]
    labels = list(prompts)
    def sim(label: str) -> float:
        phrases = prompts[label] if isinstance(prompts[label], list) else [prompts[label]]
        return float(np.mean([v @ _text_embedding(m, ph) for ph in phrases]))

    sims = np.array([sim(label) for label in labels])
    logits = float(m.manifest.get("logit_scale", 100)) * sims
    p = np.exp(logits - logits.max())
    p /= p.sum()
    top = np.argsort(-p)[:5]
    return {
        "label": labels[int(top[0])],
        "score": round(float(p[top[0]]), 4),
        "top": [{"label": labels[int(i)], "score": round(float(p[i]), 4), "similarity": round(float(sims[i]), 4)} for i in top],
    }


def infer_classifier(m: Model, img: Image.Image, params: dict[str, Any]) -> dict[str, Any]:
    inp = m.manifest["input"]
    box = params.get("box")
    src = img.crop(tuple(int(v) for v in box)) if box else img
    x = normalize(src.convert("RGB").resize((inp["width"], inp["height"]), Image.Resampling.BILINEAR), inp)
    logits = m.session.run(None, {m.session.get_inputs()[0].name: x})[0][0].astype(np.float64)
    p = np.exp(logits - logits.max())
    p /= p.sum()
    labels = m.manifest["labels"]
    top = np.argsort(-p)[:5]
    return {"label": labels[int(top[0])], "score": round(float(p[top[0]]), 4), "top": [{"label": labels[int(i)], "score": round(float(p[i]), 4)} for i in top]}
