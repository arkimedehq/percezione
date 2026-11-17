#!/bin/sh
# Downloads the RTMPose-m (OpenMMLab) weights into model.onnx, checking the zip's sha256.
set -eu
# sha256sum on Linux, shasum on macOS
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
cd "$(dirname "$0")"
URL=https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7_420e-256x192-e48f03d0_20230504.zip
SHA=f7fbb6c5c11a1bb70f3d445e4ddec5d144ea89ad5649c081ef976f9b24a0b741
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -sfL -o "$TMP/m.zip" "$URL"
echo "$SHA  $TMP/m.zip" | sha256 -c -
unzip -q -o "$TMP/m.zip" -d "$TMP"
cp "$TMP"/*/rtmpose_onnx/*/end2end.onnx model.onnx
echo "model.onnx ready"
