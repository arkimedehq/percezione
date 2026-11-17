# Analyzers: contract v1

*[Italiano](analyzers.it.md)*

An analyzer looks at an image and answers with a structured result: body keypoints, a class, yes/no answers. The
perception-service does not know how it works inside: it calls it over HTTP with this contract, which is a subset of
OpenNVR's *AI Adapter Contract v1*. A compatible OpenNVR adapter can therefore be registered as it is.

Analyzers are declared in `data/config.json`, or from the **Analyzers** page of the frontend:

```json
"analyzers": {
  "vlm": { "model": "qwen3-vl:4b-instruct", "vocabulary": { … }, "attributes": { … } },
  "endpoints": { "onnx": { "url": "http://127.0.0.1:8100" } }
}
```

`vlm` is internal: it is Ollama, called by the service with yes/no questions. The `endpoints` are external services
with the contract below. The service checks their health and capabilities every 30 s and on every configuration
change.

## Endpoints

### `GET /health`
```json
{ "status": "ok", "adapter": "onnx-runner", "version": "0.1.0", "providers": ["CPUExecutionProvider"],
  "models": 1, "broken": { "gate": "model.yml: missing «task»" } }
```
A `status` other than `"ok"`, or no answer within 5 s, means the analyzer is not available.
`providers` and `broken` are optional: they are Percezione extensions.

### `GET /capabilities`
```json
{ "adapter": "onnx-runner", "version": "0.1.0", "contract": "v1",
  "tasks_advertised": ["pose_estimation"],
  "models": [ { "name": "pose", "task": "pose_estimation", "family": "rtmpose",
                "outputs": ["standing", "sitting", "lying", "uncertain"] } ] }
```
`models[].outputs` is a Percezione extension: the labels the model can return. The UI offers them in the rules.
An adapter with a single model can omit `models` and declare only `tasks_advertised`.

### `POST /infer`
`multipart/form-data` with:
- `frame`: JPEG of the whole frame, at Frigate's detect resolution;
- `params`: JSON with `model` (the model's name) and, for top-down models, `box` = `[x1, y1, x2, y2]` in frame pixels.

Response:
```json
{ "status": "ok", "model_name": "pose", "inference_ms": 10.4,
  "result": { "label": "standing", "features": { "torso_deg": 17.5, "thigh_deg": 13.9 },
              "keypoints": [ { "name": "nose", "x": 2211.3, "y": 291.0, "score": 0.566 }, … ] } }
```
Errors:
- 4xx with `detail` for bad requests (unknown model, invalid box, unreadable image);
- `{"status": "error", "error": "…"}` when the inference fails.

### `PUT /models/{name}` (optional)
`multipart/form-data` with `model` (the `.onnx`) and `manifest` (the `model.yml`). The runner tries to load the model
in a temporary folder and installs it only if that works: a manifest that does not match the model is refused with
422. The frontend uses it for "Upload a model", through the service.

## Tasks

| Task | `result` | Used by |
|---|---|---|
| `pose_estimation` | `keypoints`, and optionally `label` and `features` | `posture` observation |
| `zero_shot_classification` | `label`, `score`, `top` | `left_object` observation; optional fast filter of `activity` (`fast`) |
| `image_classification` | `label`, `score`, `top` | family ready, no observation uses it yet |
| `vqa_yes_no` | boolean answers by name | internal VLM, `activity` observation |

## onnx-runner

`analyzers/onnx-runner/` is a single Python process (onnxruntime) that serves every model in
`analyzers/models/<name>/`. Each folder holds:
- `model.onnx`, the weights, which are not versioned: each folder has a `fetch.sh` that downloads them and checks
  their sha256;
- `model.yml`, the manifest: task, family, image preparation, labels and derived rules.

Copying a folder is enough: the runner rescans `analyzers/models/` every 5 s. A broken model does not stop the others
and shows up in `broken`.

Supported families:
- **`rtmpose`**: top-down, SimCC (OpenMMLab's RTMPose).
  - Crop around `box` with an `input.padding` margin, at the input's aspect ratio.
  - Normalization with `input.mean` and `input.std`.
  - Keypoints from the argmax of `simcc_x` and `simcc_y` divided by `simcc_split_ratio`; the confidence is the lower
    of the two maxima, as in MMPose.
  - With `derive.posture` it adds `label` and `features` (`posture.py`): a torso tilted more than `lying_torso_deg`
    means lying, a thigh tilted more than `sitting_thigh_deg` means sitting, otherwise standing.
    Without a visible torso the box's shape decides: much wider than tall (`lying_aspect`) is lying, otherwise
    `uncertain`.
    A torso between `upright_torso_deg` (30°) and `lying_torso_deg` (55°): sitting back against a backrest
    (`reclined` rule). On a sofa, seen from a high camera, the thighs point at the lens and look vertical.
    A horizontal torso is "lying" only if the whole body is:
    - vertical thighs mean bending over while standing (`bent` rule);
    - horizontal thighs with a box taller than wide (below `lying_min_aspect`, 0.9) mean sitting and leaning forward
      (`leaning` rule);
    - with no visible knees and a tall box, the result is `uncertain`.
- **`clip`**: zero-shot. The label is the one whose phrases (`prompts` in the manifest, or `params.prompts`) are most
  similar to the image. With `box`, a wide crop around the person.
- **`classifier`**: optional crop on `box`, resize to `input.width`×`input.height`, normalization, softmax over
  `labels`.

```sh
cd analyzers/models/pose && ./fetch.sh            # RTMPose-m weights (51 MB, Apache 2.0)
cd analyzers/onnx-runner && uv sync
uv run uvicorn app:app --host 127.0.0.1 --port 8100
uv run pytest
```

Providers: CUDA when available, otherwise CPU. CoreML is not used: for models this small the CPU is enough.

## `posture` observation

```json
"posture": { "analyzer": "onnx", "model": "pose", "interval_s": 5, "stable_s": 15, "rest_zones": ["sofa"] }
```
- For each recognized person present on the camera, a sample is taken every `interval_s`: Frigate's frame and the
  track's box.
- `lying` with the box's center outside every `rest_zones` becomes `on_floor`.
- If the camera has no rest zones:
  - by default `lying` stays `lying`, because the sofa may not be drawn yet;
  - with `no_rest_place: true` ("There is no sofa or bed in this room") it always becomes `on_floor`.
  - If rest zones are drawn, they count and `no_rest_place` is ignored.
- Debounce as for activities: a change becomes `posture_changed` (`value: {from, to}`) only once it has been stable
  for `stable_s`. `uncertain` does not count.
- A short absence does not reset the posture: Frigate often splits one stay into several tracks. The posture is
  forgotten only after 5 minutes of absence, so a new track does not announce "→ sitting" again. Moving to another
  camera, instead, starts it from scratch.
- Rules filter with `when.value` on `standing`, `sitting`, `lying` and `on_floor`.

Current limit: only people recognized by their face, as for presence and activity. An unknown person on the floor
does not generate events.

## `left_object` observation (objects left behind)

```json
"left_object": { "zone": "sidewalk", "analyzer": "onnx", "model": "clip", "check_s": 20, "persist_s": 90, "min_score": 0.5, "min_cells": 2 }
```
Trash, parcels or bulky items left in a zone of the camera (`src/left-objects.ts`). OpenNVR has no model for dumped
trash: here a comparison of the scene is combined with CLIP.

1. **Empty zone.** The comparison runs only when nobody is on the camera: no person active for Frigate and no
   person event in the last 15 s.
2. **Fingerprint.** Every `check_s` the zone's rectangle becomes a 24×24 grid of mean brightness. Only the cells
   inside the polygon count.
3. **Comparison.**
   - Against the reference (the empty zone), the shared shift, the median, is removed first: the setting sun is not
     a change.
   - A cell has changed beyond 18 gray levels.
   - Fewer than `min_cells` changed cells: the reference slowly follows the scene.
   - More than half of the zone changed is light (a cloud, infrared): a new reference is taken.
4. **Persistence.** The change must stay the same for `persist_s`: moving leaves and shadows start over.
5. **Classification.**
   - CLIP classifies the same crop **before and after**, with the phrases of `OBJECT_PROMPTS`: `trash`, `parcel`,
     `bulky`, `nothing`.
   - The object is the one whose probability rises the most, as long as it rises by at least 0.25 and reaches
     `min_score`.
   - On a single crop CLIP gets it wrong: bare tiles or a wall reach 0.7 as "parcel". The same error is in the crop
     from before, though, so the difference removes it.
6. **Event.** An `object_left` event is created with:
   - `value.to`: the object;
   - `zone`;
   - `person`: whoever Frigate recognized between the last empty zone and the change;
   - `media.frigate_ids`: every person who passed by in that interval;
   - `object`: score, rise, box, number of passersby and photos.

   The before/after photos are in `data/left-objects/` and are served at `/api/left-objects/<id>-before|after.jpg`.
   In any case the new scene becomes the reference, so the same object does not trigger twice.

Rules filter with `when.event: "object_left"` and `when.value` on `trash`, `parcel`, `bulky`.

Known limits:
- Frigate only tracks people: whoever unloads from a car is not linked to the event, but the object is found anyway.
- A car parking in the zone is a lasting change: CLIP puts it in `nothing` and it becomes the reference.
- An object being taken away does not produce an event.
