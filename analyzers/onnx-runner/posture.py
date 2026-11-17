"""From the 17 COCO keypoints to a posture: standing, sitting, lying (a horizontal body) or uncertain.

Simple, explainable geometry, with the thresholds in model.yml: the angle of the torso (shoulders → hips) and of the
thighs (hips → knees) from the image's vertical. The cameras are mounted high and somewhat wide-angle, so the
thresholds are tuned on a set of test frames. Whether the body is on the sofa or on the floor cannot be
seen from the keypoints: the service decides that with zones.
"""

from __future__ import annotations

import math
from typing import Any

Point = tuple[float, float]


def _mid(kp: dict[str, dict[str, Any]], a: str, b: str, min_score: float) -> Point | None:
    pts = [kp[n] for n in (a, b) if kp[n]["score"] >= min_score]
    if not pts:
        return None
    return (sum(p["x"] for p in pts) / len(pts), sum(p["y"] for p in pts) / len(pts))


def _angle_from_vertical(top: Point, bottom: Point) -> float:
    dx, dy = bottom[0] - top[0], bottom[1] - top[1]
    return math.degrees(math.atan2(abs(dx), abs(dy) or 1e-6))


def classify(keypoints: list[dict[str, Any]], box: list[float], cfg: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    min_score = float(cfg.get("min_score", 0.3))
    kp = {k["name"]: k for k in keypoints}
    shoulders = _mid(kp, "left_shoulder", "right_shoulder", min_score)
    hips = _mid(kp, "left_hip", "right_hip", min_score)
    knees = _mid(kp, "left_knee", "right_knee", min_score)
    w, h = box[2] - box[0], box[3] - box[1]
    aspect = w / h if h else 0.0
    features: dict[str, Any] = {"aspect": round(aspect, 2)}

    if shoulders is None or hips is None:
        # without a torso only the box's shape counts
        if aspect >= float(cfg.get("lying_aspect", 1.4)):
            return "lying", {**features, "rule": "aspect"}
        return "uncertain", {**features, "rule": "no_torso"}

    torso = _angle_from_vertical(shoulders, hips)
    features["torso_deg"] = round(torso, 1)
    thigh = _angle_from_vertical(hips, knees) if knees else None
    if thigh is not None:
        features["thigh_deg"] = round(thigh, 1)
    if torso > float(cfg.get("lying_torso_deg", 55)):
        return _horizontal_torso(thigh, aspect, features, cfg)
    # Standing or walking people keep the torso within ~30°. Between that and
    # lying it is someone reclined against a backrest: on the sofa, seen from a high corner, the thighs point at
    # the camera and look vertical, so the thigh angle would say "standing" (torso around 45°).
    if torso > float(cfg.get("upright_torso_deg", 30)):
        return "sitting", {**features, "rule": "reclined"}

    if thigh is None:
        return "uncertain", {**features, "rule": "no_knees"}
    if thigh > float(cfg.get("sitting_thigh_deg", 50)):
        return "sitting", {**features, "rule": "thigh"}
    return "standing", {**features, "rule": "upright"}


def _horizontal_torso(thigh: float | None, aspect: float, features: dict[str, Any], cfg: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """A horizontal torso is lying only if the whole body is: legs not vertical and a box that is not tall.

    Bending over to pick something up also tilts the torso (75-90° with a box not much taller than wide, legs
    straight down) and would read as "lying". Legs vertical means bent while standing; thighs horizontal in a
    tall box means seated and leaning forward.
    """
    tall = aspect < float(cfg.get("lying_min_aspect", 0.9))
    if thigh is not None and thigh <= float(cfg.get("sitting_thigh_deg", 50)):
        return "standing", {**features, "rule": "bent"}
    if tall:
        return ("sitting", {**features, "rule": "leaning"}) if thigh is not None else ("uncertain", {**features, "rule": "torso_tall_box"})
    return "lying", {**features, "rule": "torso"}


def _hand(kp: dict[str, dict[str, Any]], side: str, min_score: float) -> Point | None:
    """Center of the hand: mean of the reliable hand keypoints (WholeBody), otherwise the wrist."""
    pts = [k for n, k in kp.items() if n.startswith(f"{side}_hand_") and k["score"] >= min_score]
    if pts:
        return (sum(p["x"] for p in pts) / len(pts), sum(p["y"] for p in pts) / len(pts))
    w = kp.get(f"{side}_wrist")
    return (w["x"], w["y"]) if w and w["score"] >= min_score else None


def gestures(keypoints: list[dict[str, Any]], cfg: dict[str, Any]) -> dict[str, Any]:
    """Where the hands are relative to the head, in shoulder widths (so it does not depend on the distance from the camera).

    `hand_at_ear`: a hand near an ear (phone at the ear); `hand_at_face`: a hand near the nose (eating,
    drinking, touching the face). Also returns the distances, to tune the thresholds.
    """
    min_score = float(cfg.get("min_score", 0.3))
    kp = {k["name"]: k for k in keypoints}
    ls, rs = kp.get("left_shoulder"), kp.get("right_shoulder")
    if not ls or not rs or min(ls["score"], rs["score"]) < min_score:
        return {"hand_at_ear": None, "hand_at_face": None, "reason": "shoulders not visible"}
    unit = math.dist((ls["x"], ls["y"]), (rs["x"], rs["y"])) or 1.0
    hands = [h for h in (_hand(kp, "left", min_score), _hand(kp, "right", min_score)) if h]
    if not hands:
        return {"hand_at_ear": None, "hand_at_face": None, "reason": "hands not visible"}

    def nearest(names: list[str]) -> float | None:
        targets = [(kp[n]["x"], kp[n]["y"]) for n in names if n in kp and kp[n]["score"] >= min_score]
        if not targets:
            return None
        return min(math.dist(h, t) for h in hands for t in targets) / unit

    ear = nearest(["left_ear", "right_ear"])
    face = nearest(["nose"])
    return {
        "hand_at_ear": None if ear is None else ear < float(cfg.get("ear", 0.6)),
        "hand_at_face": None if face is None else face < float(cfg.get("face", 0.7)),
        "ear_dist": None if ear is None else round(ear, 2),
        "face_dist": None if face is None else round(face, 2),
    }
