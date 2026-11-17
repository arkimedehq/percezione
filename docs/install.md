# Installing Percezione

*[Italiano](install.it.md)*

## 1. What you need

- **Machine:** Linux on x86-64 or ARM64, always on. 4 GB of RAM for a few cameras on the CPU; 16 GB or more with
  the activity model (Ollama). An SSD for the system; a second disk for Frigate's storage is welcome.
- **Software:** Docker Engine with the Compose plugin. Follow
  [Install Docker Engine](https://docs.docker.com/engine/install/) for your distribution; do not use the snap
  package.
- **Cameras:** IP cameras with an RTSP stream (most brands). Their RTSP address, user and password.
- **macOS and Windows:** with Docker Desktop, Percezione runs on the CPU only. Good for trying it out, not for 24/7
  use.

## 2. Hardware acceleration (optional)

Skip this section for the CPU.

### NVIDIA GPU (amd64)
1. **Driver.** On Ubuntu: `sudo ubuntu-drivers install`, then reboot. With Secure Boot on, enroll the key the driver
   asks for at the reboot, or turn Secure Boot off.
2. **NVIDIA Container Toolkit:** follow
   [NVIDIA's guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html),
   then run:
   ```sh
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   ```
3. **Check:** `docker run --rm --gpus all ubuntu nvidia-smi` must show your GPU.
4. **First start:** the `frigate-model` service builds a YOLOv9 detection model on your machine. It downloads a few GB
   (PyTorch) and takes 5–15 minutes, once. The model size is set by `YOLO_MODEL_SIZE` and `YOLO_IMG_SIZE` in `.env`.

### Intel GPU or NPU
- `/dev/dri` must exist (`ls /dev/dri`). Frigate gets only the Intel render node: `renderD128`, unless
  `INTEL_RENDER_DEVICE` in `.env` names another one.
- Frigate both detects and decodes the video on the Intel GPU (VAAPI), so the CPU stays almost free.
- For the NPU, the host needs recent NPU firmware; see
  [Frigate's notes](https://docs.frigate.video/configuration/object_detectors#openvino-detector).

### Intel GPU for Frigate, NVIDIA GPU for the vision model
On a PC with an Intel CPU that has integrated graphics (e.g. a Core i9-9900K, not the "F" models) and an NVIDIA card,
the best split is Frigate on the Intel GPU and the whole NVIDIA card for Ollama:
```sh
docker compose -f docker-compose.yml -f hardware/intel.yml -f hardware/ollama-nvidia.yml --profile vlm up -d
```
1. **BIOS:** with an NVIDIA card installed, many motherboards turn the integrated GPU off. Turn it on, e.g. with
   "iGPU Multi-Monitor" or "Internal Graphics: Enabled".
2. **Render nodes:** `ls -l /dev/dri/by-path` shows two of them. Intel's is the one on PCI `00:02.0`; if it is not
   `renderD128`, set `INTEL_RENDER_DEVICE` in `.env`.
3. **NVIDIA:** follow the driver and Container Toolkit steps above.

### Google Coral
- **USB:** nothing to install.
- **PCIe / M.2:**
  1. Install the `gasket` driver for your distribution and check that `/dev/apex_0` exists.
  2. In `deploy/hardware/coral.yml`, replace `/dev/bus/usb` with `/dev/apex_0`.
  3. Set `CORAL_DEVICE=pci` in `.env`.

## 3. Install

```sh
git clone https://github.com/arkimedehq/percezione.git
cd percezione/deploy
cp .env.example .env      # optional: time zone, ports, a broker of your own
docker compose up -d      # add -f docker-compose.yml -f hardware/<yours>.yml for an accelerator
docker compose logs -f setup percezione
```

`setup` runs first and exits. It creates:
- the secrets in `data/secrets`, readable only by their owner;
- Frigate's `config.yml`, with the detector for your hardware;
- the go2rtc and Mosquitto configuration.

It never overwrites what is already there, so you can edit `frigate/config/config.yml` safely.

To build the images from source instead of downloading them, add `--build`.

### Optional parts

```sh
docker compose --profile vlm --profile pose up -d
```

- **`vlm`** (activities): Ollama starts with no model; Percezione downloads the one it is set to by itself
  (`qwen3-vl:4b-instruct` by default, about 3 GB; `qwen3-vl:8b-instruct` with 8 GB of GPU memory), with the progress on
  the **Analyzers** page.
- **`pose`** (posture): downloads RTMPose on first start. For left objects add CLIP with `ONNX_MODELS=pose clip` in
  `.env`.

## 4. First start

1. **Password:** open `http://<this machine>:8090` and choose the password (at least 8 characters). Whoever opens the
   page first chooses it, so do it right after the install.
2. **Cameras** page: add a camera from its RTSP address. The password is asked separately and never shown again.
3. **Zones:** on the camera, draw the zones that matter (the sofa, the entrance) and the masks for what moves but does
   not matter (the camera's clock, trees).
4. **People** page: create the people of the house and add 3–10 face photos each.
   - On its first start Frigate downloads its face models (about 320 MB). Until then, every photo is refused with
     "No face was detected"; wait a few minutes and try again.
   - When the models are in, Percezione restarts Frigate once: Frigate loads them only when it starts, and
     before that it would not recognize the faces its cameras see.
   - With time, the "to name" box fills with faces seen by the cameras: naming them is the best source of faces.
5. **Rules** and **Outputs:** choose what to be told about, and where (Home Assistant, webhooks, agents).
6. **Tuning** (optional): presence times, activity thresholds, the picture for the VLM and how often Percezione talks
   to Frigate. An empty field uses its default.

## 5. Ports

| Port | What |
|---|---|
| 8090 | Percezione: UI and API (`PERCEZIONE_PORT`) |
| 8091 | Frigate's UI, behind Percezione's login (`FRIGATE_UI_PORT`) |
| 8554 | RTSP of the cameras for other apps, behind go2rtc's login, when sharing is on (`GO2RTC_RTSP_PORT`) |
| 8555 | WebRTC, when sharing is on |
| 1984 | go2rtc's API, behind its login, only with `-f share.yml` (`GO2RTC_API_PORT`): for apps that check the stream names |

Frigate's API and Mosquitto are not exposed; go2rtc's API only with `share.yml`.

## 6. A broker of your own

To use an existing MQTT broker (e.g. Home Assistant's Mosquitto) instead of the included one:
1. Create two users on it: one for Frigate, one for Percezione.
2. Set `MQTT_HOST` (and `MQTT_PORT`) in `.env`.
3. After the first start, put the two logins in `data/secrets/system.json` (`mqtt.frigate`, `mqtt.percezione`).
4. Run `docker compose up -d` again.

The included Mosquitto keeps running, unused.

## 7. Updates

1. Make a backup first: **Usage** page → *Download the backup*.
2. Run:
   ```sh
   git pull
   docker compose pull
   docker compose up -d      # with the same -f and --profile options as before
   ```

## 8. Backup

The **Usage** page downloads one file with the configuration, the people with their faces and the tokens; the
cameras' passwords only if you ask. Restoring it on a new installation brings everything back, and Percezione
restarts by itself. Details: [backup.md](backup.md).

## 9. Troubleshooting

- **Is everything up?** `curl http://localhost:8090/healthz` answers `{"ok":true,…}`, or names the part that is down
  (mqtt, frigate, go2rtc).
- **Logs:** `docker compose logs -f percezione frigate`.
- **"Unknown host name"** when opening the UI: it answers only to addresses, `localhost` and local names (`server`,
  `*.local`, `*.lan`, `*.home.arpa`). To use a name of your own domain, add it to `PERCEZIONE_HOSTS` in `.env` and run
  `docker compose up -d`.
- **"Too many wrong passwords"**: after two wrong passwords each attempt waits longer, up to a minute. Wait and try
  again.
- **Frigate's "admin" user:** on first start Frigate creates an `admin` user for its own authenticated UI (port 8971)
  and prints its password in its log. Percezione does not use it and does not expose that port. You can ignore it.
- **Docker Desktop for Mac:** Mosquitto warns that its password file is not owned by `mosquitto`. File owners are
  simulated there; it still works.
- **A camera keeps restarting on an Intel GPU** (Frigate's log: "Failed to sync surface", "Failed to download
  frame"): its H.264 is one VAAPI cannot decode (it happens with some Hikvision door stations). In the camera's editor
  set **Video decoding** to **CPU**: only that camera is decoded on the CPU.
- **Frigate complains about shared memory:** raise `FRIGATE_SHM_SIZE` in `.env` (about 128 MB per 1080p camera).

## 10. Uninstall

```sh
docker compose down
```

Everything Percezione keeps is in `deploy/data` and `deploy/frigate`. Delete those two folders to start from scratch.
