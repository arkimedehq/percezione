#!/bin/sh
# Downloads RTMW-m (OpenMMLab, Apache 2.0): RTMPose WholeBody, 133 keypoints (body, feet, face, hands), 256x192.
set -eu
# sha256sum on Linux, shasum on macOS
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
cd "$(dirname "$0")"
URL=https://download.openmmlab.com/mmpose/v1/projects/rtmw/onnx_sdk/rtmw-dw-l-m_simcc-cocktail14_270e-256x192_20231122.zip
SHA=${SHA:-a6d08a575c9d8b8da7ce6c13e1c7341047fca35594a6d35de04b739eba51139c}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -sfL -o "$TMP/m.zip" "$URL"
if [ -n "$SHA" ]; then echo "$SHA  $TMP/m.zip" | sha256 -c -; else sha256 "$TMP/m.zip"; fi
unzip -q -o "$TMP/m.zip" -d "$TMP"
cp "$(find "$TMP" -name end2end.onnx | head -1)" model.onnx
echo "model.onnx ready"
