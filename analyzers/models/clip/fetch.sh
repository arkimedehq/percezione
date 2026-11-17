#!/bin/sh
# Downloads CLIP ViT-B/32 (OpenAI, MIT) exported to ONNX by Xenova, int8-quantized, at a pinned revision.
set -eu
# sha256sum on Linux, shasum on macOS
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
cd "$(dirname "$0")"
REV=6b7c523703ae26e39be4b03774966f8571c7f523
BASE=https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/$REV
curl -sfL -o vision.onnx "$BASE/onnx/vision_model_quantized.onnx"
curl -sfL -o text.onnx "$BASE/onnx/text_model_quantized.onnx"
curl -sfL -o tokenizer.json "$BASE/tokenizer.json"
sha256 -c SHA256SUMS
echo "vision.onnx, text.onnx and tokenizer.json ready"
