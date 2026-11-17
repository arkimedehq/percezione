# syntax=docker/dockerfile:1
# onnx-runner for docker compose (deploy/, "pose" profile). Build context: analyzers/.
# Models live in /models (a volume); the ones named in FETCH_MODELS are downloaded on first start, checked by sha256.
FROM python:3.12-slim
RUN apt-get update && apt-get install --no-install-recommends -y curl unzip && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.10.4 /uv /bin/
WORKDIR /app
COPY onnx-runner/pyproject.toml onnx-runner/uv.lock ./
RUN uv sync --frozen --no-dev
COPY onnx-runner/*.py ./
# model descriptions and download scripts, never the weights
COPY models/ /opt/models/
RUN find /opt/models -name '*.onnx' -delete -o -name tokenizer.json -delete
ENV MODELS_DIR=/models FETCH_MODELS=""
EXPOSE 8100
CMD ["sh", "-c", "for m in $FETCH_MODELS; do [ -f /models/$m/model.yml ] || { mkdir -p /models/$m && cp -r /opt/models/$m/. /models/$m/; }; [ -f /models/$m/model.onnx ] || sh /models/$m/fetch.sh || exit 1; done; exec uv run --no-sync uvicorn app:app --host 0.0.0.0 --port 8100"]
