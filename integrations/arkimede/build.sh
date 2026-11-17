#!/bin/sh
# Builds dist/camera-recognition-<version>.zip, the package to upload in Arkimede (Settings → Plugins).
set -eu
cd "$(dirname "$0")"
version=$(sed -n 's/^version: *//p' plugin.yaml)
mkdir -p dist
out="dist/camera-recognition-$version.zip"
rm -f "$out"
zip -qr -X "$out" plugin.yaml skills -x '*/__pycache__/*' '*.pyc'
echo "$out"
