import posture

CFG = {"min_score": 0.3, "lying_torso_deg": 55, "sitting_thigh_deg": 50, "lying_aspect": 1.4}
NAMES = ["left_shoulder", "right_shoulder", "left_hip", "right_hip", "left_knee", "right_knee"]


def body(points: dict[str, tuple[float, float]], score: float = 0.9):
    return [{"name": n, "x": points.get(n, (0, 0))[0], "y": points.get(n, (0, 0))[1], "score": score if n in points else 0.0} for n in NAMES]


def test_standing_sitting_lying():
    """standing, sitting and lying / in piedi, seduto e sdraiato"""
    standing = body({"left_shoulder": (90, 100), "right_shoulder": (110, 100), "left_hip": (92, 200), "right_hip": (108, 200), "left_knee": (93, 290), "right_knee": (107, 290)})
    assert posture.classify(standing, [80, 80, 120, 380], CFG)[0] == "standing"
    # upright torso, thighs almost horizontal
    sitting = body({"left_shoulder": (90, 100), "right_shoulder": (110, 100), "left_hip": (92, 200), "right_hip": (108, 200), "left_knee": (170, 215), "right_knee": (175, 220)})
    label, f = posture.classify(sitting, [80, 80, 200, 300], CFG)
    assert label == "sitting" and f["thigh_deg"] > 50
    lying = body({"left_shoulder": (100, 200), "right_shoulder": (100, 220), "left_hip": (200, 205), "right_hip": (200, 225), "left_knee": (290, 210), "right_knee": (290, 230)})
    assert posture.classify(lying, [80, 180, 320, 240], CFG) == ("lying", {"aspect": 4.0, "torso_deg": 87.1, "thigh_deg": 86.8, "rule": "torso"})


def test_reclined_on_sofa_is_seated():
    """reclined against a backrest is seated even with foreshortened thighs / appoggiato allo schienale è seduto"""
    # torso at ~45°, thighs pointing at the camera (short and vertical in the image)
    reclined = body({"left_shoulder": (100, 100), "right_shoulder": (120, 100), "left_hip": (150, 150), "right_hip": (170, 150), "left_knee": (155, 190), "right_knee": (175, 190)})
    label, f = posture.classify(reclined, [90, 90, 190, 200], CFG)
    assert (label, f["rule"]) == ("sitting", "reclined")


def test_bent_or_leaning_is_not_lying():
    """bent or leaning forward is not lying / chinato o piegato in avanti non è sdraiato"""
    # torso horizontal, legs straight down, tall box: picking something up
    bent = body({"left_shoulder": (40, 150), "right_shoulder": (45, 160), "left_hip": (120, 145), "right_hip": (125, 155), "left_knee": (122, 230), "right_knee": (127, 235)})
    assert posture.classify(bent, [30, 100, 140, 300], CFG)[0:1] == ("standing",)
    assert posture.classify(bent, [30, 100, 140, 300], CFG)[1]["rule"] == "bent"
    # torso horizontal, thighs horizontal, tall box: seated and leaning forward
    leaning = body({"left_shoulder": (40, 150), "right_shoulder": (45, 160), "left_hip": (120, 145), "right_hip": (125, 155), "left_knee": (60, 160), "right_knee": (65, 165)})
    assert posture.classify(leaning, [30, 100, 140, 300], CFG)[1]["rule"] == "leaning"
    # torso horizontal, no knees: lying only if the box is wide
    no_knees = body({"left_shoulder": (40, 150), "right_shoulder": (45, 160), "left_hip": (120, 145), "right_hip": (125, 155)})
    assert posture.classify(no_knees, [30, 100, 140, 300], CFG)[0] == "uncertain"
    assert posture.classify(no_knees, [30, 100, 300, 200], CFG)[0] == "lying"


def test_without_torso_box_shape_decides():
    """without a torso the box's shape decides / senza busto decide la forma del box"""
    nothing = body({})
    assert posture.classify(nothing, [0, 0, 300, 100], CFG)[0] == "lying"
    assert posture.classify(nothing, [0, 0, 100, 300], CFG)[0] == "uncertain"


def test_unreliable_keypoints_ignored():
    """unreliable keypoints are ignored / punti poco affidabili ignorati"""
    weak = body({"left_shoulder": (90, 100), "right_shoulder": (110, 100), "left_hip": (92, 200), "right_hip": (108, 200)}, score=0.2)
    assert posture.classify(weak, [80, 80, 120, 380], CFG) == ("uncertain", {"aspect": 0.13, "rule": "no_torso"})


def test_gestures_in_shoulder_widths():
    """gestures measured in shoulder widths / gesti in larghezze di spalle"""
    def kp(points):
        return [{"name": n, "x": x, "y": y, "score": 0.9} for n, (x, y) in points.items()]

    base = {"left_shoulder": (80, 200), "right_shoulder": (120, 200), "nose": (100, 150), "left_ear": (90, 150), "right_ear": (110, 150)}
    phone = kp({**base, "right_wrist": (114, 158), "left_wrist": (80, 300)})
    g = posture.gestures(phone, {"ear": 0.6, "face": 0.7})
    assert g["hand_at_ear"] is True and g["ear_dist"] < 0.6
    down = kp({**base, "right_wrist": (120, 300), "left_wrist": (80, 300)})
    assert posture.gestures(down, {}) == {"hand_at_ear": False, "hand_at_face": False, "ear_dist": 3.76, "face_dist": 3.78}
    # hand keypoints (WholeBody) win over the wrist
    hand = kp({**base, "left_wrist": (80, 300), **{f"left_hand_{i}": (100, 160) for i in range(21)}})
    assert posture.gestures(hand, {})["hand_at_face"] is True
    assert posture.gestures(kp({"nose": (1, 1)}), {})["reason"] == "shoulders not visible"
