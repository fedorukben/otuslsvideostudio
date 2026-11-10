// Turns the rendered builds + timings + captions into an MP4, entirely in the browser.
// Video: WebCodecs H.264 + mp4-muxer. Audio: ffmpeg.wasm (filters, AAC, outro audio).
import { Muxer, ArrayBufferTarget } from "/vendor/mp4-muxer.mjs";
import { W, H, drawCaption } from "./render.js";

const FPS = 30;
const XFADE = 0.35;
const WHITE_FADE = 0.8;

async function pickCodec() {
  if (!("VideoEncoder" in window)) throw new Error("This browser can't encode video. Please use Chrome or Edge.");
  for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42e028"]) {
    for (const hardwareAcceleration of ["prefer-hardware", "prefer-software"]) {
      const cfg = { codec, width: W, height: H, bitrate: 6_000_000, framerate: FPS, hardwareAcceleration, avc: { format: "avc" } };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch {}
    }
  }
  throw new Error("This browser can't encode H.264 video at 1080p. Please use an up-to-date Chrome or Edge.");
}

let mp4boxP = null;
function loadMp4Box() {
  mp4boxP ||= new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = "/vendor/mp4box.all.min.js";
    sc.onload = () => res(window.MP4Box);
    sc.onerror = () => rej(new Error("Could not load mp4box"));
    document.head.appendChild(sc);
  });
  return mp4boxP;
}

// Opens the outro MP4 and returns {duration, frames(): async iterator of VideoFrame} using WebCodecs.
async function openOutro(url) {
  let buf;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    buf = await r.arrayBuffer();
  } catch { return null; }
  // Must really be an MP4 (bytes 4-7 are "ftyp"), not an HTML error page.
  const sig = new TextDecoder().decode(new Uint8Array(buf, 4, 4));
  if (buf.byteLength < 1000 || sig !== "ftyp") return null;
  const MP4Box = await loadMp4Box();
  const file = MP4Box.createFile();
  const info = await new Promise((res, rej) => {
    setTimeout(() => rej(new Error("Couldn't read the outro clip")), 15000);
    file.onReady = res;
    file.onError = rej;
    buf.fileStart = 0;
    file.appendBuffer(buf);
    file.flush();
  });
  const track = info.videoTracks[0];
  if (!track) return null;
  const trak = file.getTrackById(track.id);
  let description;
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const DS = MP4Box.DataStream || window.DataStream;
      const ds = new DS(undefined, 0, DS.BIG_ENDIAN);
      box.write(ds);
      description = new Uint8Array(ds.buffer, 8);
    }
  }
  const samples = [];
  file.onSamples = (id, user, s) => samples.push(...s);
  file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
  file.start();
  file.flush();
  const duration = track.duration / track.timescale;
  return {
    duration,
    async *frames() {
      const queue = [];
      let wake = null, err = null, flushing = null, done = false;
      const dec = new VideoDecoder({
        output: (f) => { queue.push(f); wake?.(); },
        error: (e) => { err = e; wake?.(); },
      });
      dec.configure({ codec: track.codec, codedWidth: track.video.width, codedHeight: track.video.height, description });
      let i = 0;
      const feed = () => {
        while (i < samples.length && dec.decodeQueueSize < 6 && queue.length < 8) {
          const s = samples[i++];
          dec.decode(new EncodedVideoChunk({ type: s.is_sync ? "key" : "delta", timestamp: (1e6 * s.cts) / s.timescale,
            duration: (1e6 * s.duration) / s.timescale, data: s.data }));
        }
        if (i >= samples.length && !flushing) { flushing = dec.flush().then(() => { done = true; wake?.(); }); }
      };
      while (true) {
        if (err) throw err;
        feed();
        if (queue.length) { yield queue.shift(); continue; }
        if (done) break;
        await new Promise((r) => (wake = r));
        wake = null;
      }
      dec.close();
    },
  };
}

/**
 * builds: [{bitmap}] in display order; times: start time (s, lesson clock) of each build;
 * captions: [{start,end,text}] lesson clock; duration: lesson length (s).
 */
// The outro clip may be uploaded with underscores or with spaces in its name.
export const OUTRO_CANDIDATES = ["/assets/OT_Outro_White.mp4", "/assets/OT%20Outro%20White.mp4", "/assets/OT-Outro-White.mp4"];

export async function encodeVideo({ builds, times, captions, duration, outroUrl, onProgress, signal }) {
  const cfg = await pickCodec();
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: "avc", width: W, height: H, frameRate: FPS }, fastStart: "in-memory" });
  let encErr = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => (encErr = e) });
  enc.configure(cfg);

  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext("2d", { alpha: false });
  let outro = null;
  for (const u of outroUrl ? [outroUrl] : OUTRO_CANDIDATES) {
    outro = await openOutro(u).catch(() => null);
    if (outro) { outroUrl = u; break; }
  }
  const outroFrames = outro ? Math.round(outro.duration * FPS) : 0;
  const lessonFrames = Math.round(duration * FPS);
  const total = lessonFrames + outroFrames;
  let capIdx = 0;

  const encodeFrame = async (i) => {
    if (encErr) throw encErr;
    if (signal?.aborted) throw new Error("Cancelled");
    const frame = new VideoFrame(cv, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    enc.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
    frame.close();
    while (enc.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
    if (i % 15 === 0) { onProgress?.(i / total); await new Promise((r) => setTimeout(r, 0)); }
  };

  for (let i = 0; i < lessonFrames; i++) {
    const t = i / FPS;
    let b = 0;
    while (b + 1 < times.length && times[b + 1] <= t) b++;
    ctx.globalAlpha = 1;
    const since = t - times[b];
    if (b > 0 && since < XFADE) {
      ctx.drawImage(builds[b - 1].bitmap, 0, 0);
      ctx.globalAlpha = Math.max(0, since / XFADE);
    }
    ctx.drawImage(builds[b].bitmap, 0, 0);
    ctx.globalAlpha = 1;
    while (capIdx < captions.length && captions[capIdx].end <= t) capIdx++;
    const cap = captions[capIdx];
    if (cap && cap.start <= t && t < cap.end) drawCaption(ctx, cap.text);
    if (outro && t > duration - WHITE_FADE) {
      ctx.globalAlpha = Math.min(1, (t - (duration - WHITE_FADE)) / WHITE_FADE);
      ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
    await encodeFrame(i);
  }
  if (outro) {
    // Resample the outro to 30 fps: each output frame shows the latest decoded frame at that time.
    const it = outro.frames();
    let cur = (await it.next()).value, nxt = (await it.next()).value;
    for (let k = 0; k < outroFrames; k++) {
      const tUs = (k * 1e6) / FPS;
      while (nxt && nxt.timestamp <= tUs + 1000) { cur?.close(); cur = nxt; nxt = (await it.next()).value; }
      if (cur) ctx.drawImage(cur, 0, 0, W, H);
      await encodeFrame(lessonFrames + k);
    }
    cur?.close(); nxt?.close();
    for await (const f of it) f.close();
  }
  await enc.flush();
  enc.close();
  muxer.finalize();
  onProgress?.(1);
  return { video: new Uint8Array(muxer.target.buffer), hasOutro: !!outro, outroUrl: outro ? outroUrl : null, outroDuration: outroFrames / FPS };
}

let ffmpegP = null;
async function getFFmpeg(onLog) {
  ffmpegP ||= (async () => {
    const { FFmpeg } = await import("/vendor/ffmpeg/index.js");
    const ff = new FFmpeg();
    try {
      await ff.load({ coreURL: "/vendor/ffmpeg/core/ffmpeg-core.js", wasmURL: "/vendor/ffmpeg/core/ffmpeg-core.wasm" });
    } catch (e) {
      // Fallback if the self-hosted 32 MB core can't be served: same version from a public CDN.
      const cdn = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";
      await ff.load({ coreURL: `${cdn}/ffmpeg-core.js`, wasmURL: `${cdn}/ffmpeg-core.wasm` });
    }
    return ff;
  })();
  ffmpegP.catch(() => { ffmpegP = null; });
  const ff = await ffmpegP;
  ff.off?.("log");
  if (onLog) ff.on("log", ({ message }) => onLog(message));
  return ff;
}

/**
 * Adds cleaned narration (+ the outro's own audio) to the silent video.
 * audioStart/duration are on the original recording's clock.
 */
export async function muxAudio({ video, audioFile, audioStart, duration, hasOutro, outroUrl, onProgress }) {
  const ff = await getFFmpeg();
  const progress = ({ progress }) => onProgress?.(Math.max(0, Math.min(1, progress)));
  ff.on("progress", progress);
  const ext = (audioFile.name.split(".").pop() || "m4a").toLowerCase().replace(/[^a-z0-9]/g, "");
  await ff.writeFile("video.mp4", video);
  await ff.writeFile(`voice.${ext}`, new Uint8Array(await audioFile.arrayBuffer()));
  const S = audioStart.toFixed(3), D = duration.toFixed(3), fadeOut = Math.max(0, duration - 0.8).toFixed(3);
  const voice = `[1:a]atrim=start=${S}:end=${(audioStart + duration).toFixed(3)},asetpts=PTS-STARTPTS,highpass=f=80,` +
    `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:d=0.3,afade=t=out:st=${fadeOut}:d=0.8,` +
    `aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${D}`;
  let args;
  let outroHasAudio = false;
  if (hasOutro) {
    const outro = new Uint8Array(await (await fetch(outroUrl)).arrayBuffer());
    await ff.writeFile("outro.mp4", outro);
    // does the outro have an audio track?
    let probe = "";
    const grab = ({ message }) => (probe += message + "\n");
    ff.on("log", grab);
    await ff.exec(["-hide_banner", "-i", "outro.mp4"]);
    ff.off("log", grab);
    outroHasAudio = /Stream #\d+:\d+.*Audio/.test(probe);
  }
  if (hasOutro && outroHasAudio) {
    args = ["-i", "video.mp4", "-i", `voice.${ext}`, "-i", "outro.mp4", "-filter_complex",
      `${voice}[a0];[2:a]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo[a1];[a0][a1]concat=n=2:v=0:a=1[a]`,
      "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", "out.mp4"];
  } else {
    args = ["-i", "video.mp4", "-i", `voice.${ext}`, "-filter_complex", `${voice},apad[a]`,
      "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", "out.mp4"];
  }
  const code = await ff.exec(args);
  ff.off("progress", progress);
  if (code !== 0) throw new Error("Audio mixing failed (ffmpeg exit code " + code + ")");
  const out = await ff.readFile("out.mp4");
  for (const f of ["video.mp4", `voice.${ext}`, "outro.mp4", "out.mp4"]) { try { await ff.deleteFile(f); } catch {} }
  return new Blob([out], { type: "video/mp4" });
}

// Stills for the contact sheet and the final check (JPEG data URLs).
export async function stillAt({ bitmap, caption, width = 960 }) {
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  if (caption) drawCaption(ctx, caption);
  const small = new OffscreenCanvas(width, Math.round((width * H) / W));
  small.getContext("2d").drawImage(cv, 0, 0, small.width, small.height);
  const blob = await small.convertToBlob({ type: "image/jpeg", quality: 0.8 });
  return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}
