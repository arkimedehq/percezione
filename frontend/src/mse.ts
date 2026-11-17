/**
 * Live video from go2rtc, through the service's proxy (/api/live): go2rtc's MSE protocol.
 * The client declares the codecs it can play, go2rtc answers with the MIME type and then sends fMP4 segments.
 */
const CODECS = ["avc1.640029", "avc1.64002A", "avc1.640033", "avc1.42E01E", "hvc1.1.6.L153.B0", "mp4a.40.2", "opus"];

export function supportsMse(): boolean {
  return typeof MediaSource !== "undefined";
}

export function playMse(video: HTMLVideoElement, src: string, onError: (msg: string) => void): () => void {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live?src=${encodeURIComponent(src)}`);
  ws.binaryType = "arraybuffer";
  const ms = new MediaSource();
  let sb: SourceBuffer | undefined;
  const queue: ArrayBuffer[] = [];
  let closed = false;

  const pump = () => {
    if (!sb || sb.updating || queue.length === 0) return;
    // keeps a few seconds in memory and stays close to live
    const b = sb.buffered;
    if (b.length && b.end(b.length - 1) - b.start(0) > 15) {
      sb.remove(b.start(0), b.end(b.length - 1) - 5);
      return;
    }
    sb.appendBuffer(queue.shift()!);
    if (b.length) {
      const end = b.end(b.length - 1);
      if (end - video.currentTime > 2) video.currentTime = end - 0.3;
    }
  };

  ws.onopen = () => {
    const value = CODECS.filter((c) => MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`)).join(",");
    ws.send(JSON.stringify({ type: "mse", value }));
  };
  ws.onmessage = (e) => {
    if (typeof e.data === "string") {
      const msg = JSON.parse(e.data) as { type: string; value: string };
      if (msg.type === "error") onError(msg.value);
      if (msg.type !== "mse") return;
      video.src = URL.createObjectURL(ms);
      const add = () => {
        sb = ms.addSourceBuffer(msg.value);
        sb.mode = "segments";
        sb.addEventListener("updateend", pump);
        pump();
      };
      if (ms.readyState === "open") add();
      else ms.addEventListener("sourceopen", add, { once: true });
      void video.play().catch(() => undefined);
      return;
    }
    queue.push(e.data as ArrayBuffer);
    pump();
  };
  // stall watchdog: a stream that stops delivering frames (camera or go2rtc hiccup) is reported, so the caller
  // can show still frames and retry instead of leaving a frozen or black tile
  let lastTime = -1;
  let still = 0;
  const watchdog = setInterval(() => {
    if (closed) return;
    still = video.currentTime === lastTime ? still + 1 : 0;
    lastTime = video.currentTime;
    if (still >= 4) {
      clearInterval(watchdog);
      onError("video fermo");
      ws.close();
    }
  }, 2_000);

  ws.onclose = (e) => {
    if (!closed && e.code === 4404) onError("stream sconosciuto");
    else if (!closed) onError("connessione al video chiusa");
  };
  return () => {
    closed = true;
    clearInterval(watchdog);
    ws.close();
    if (video.src) URL.revokeObjectURL(video.src);
    video.removeAttribute("src");
  };
}
