# syntax=docker/dockerfile:1
# YOLOv9 to ONNX for Frigate's ONNX detector: the export of Frigate's docs (docs/data/object_detectors_models.yaml
# @ v0.18.0), with a last stage that copies the model into Frigate's model_cache only when it is missing.
# The model is made on the machine that runs it and never distributed (YOLOv9 is GPL-3.0).
FROM python:3.11 AS build
RUN apt-get update && apt-get install --no-install-recommends -y cmake libgl1 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.10.4 /uv /bin/
WORKDIR /yolov9
ADD https://github.com/WongKinYiu/yolov9.git .
RUN uv pip install --system -r requirements.txt
RUN uv pip install --system onnx==1.18.0 onnxruntime onnx-simplifier==0.4.* onnxscript
ARG MODEL_SIZE=t
ARG IMG_SIZE=320
ADD https://github.com/WongKinYiu/yolov9/releases/download/v0.1/yolov9-${MODEL_SIZE}-converted.pt yolov9-${MODEL_SIZE}.pt
RUN sed -i "s/ckpt = torch.load(attempt_download(w), map_location='cpu')/ckpt = torch.load(attempt_download(w), map_location='cpu', weights_only=False)/g" models/experimental.py
RUN python3 export.py --weights ./yolov9-${MODEL_SIZE}.pt --imgsz ${IMG_SIZE} --simplify --include onnx

FROM busybox:1.37
ARG MODEL_SIZE=t
COPY --from=build /yolov9/yolov9-${MODEL_SIZE}.onnx /yolo.onnx
CMD ["sh", "-c", "mkdir -p /config/model_cache && if [ -f /config/model_cache/yolo.onnx ]; then echo 'yolo.onnx already there'; else cp /yolo.onnx /config/model_cache/yolo.onnx && echo 'yolo.onnx ready'; fi"]
