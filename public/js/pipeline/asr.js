// Whisper speech recognition in the browser via transformers.js.
// The model downloads once from Hugging Face and is cached by the browser.
// The audio itself never leaves the computer.

let asrPromise = null;
let asrModel = null;

export async function loadASR(modelId = "Xenova/whisper-small.en", onProgress) {
  if (window.__SVS_MOCK_ASR) return window.__SVS_MOCK_ASR; // test hook
  if (asrPromise && asrModel === modelId) return asrPromise;
  asrModel = modelId;
  asrPromise = (async () => {
    const { pipeline, env } = await import("/vendor/transformers/transformers.min.js");
    env.allowLocalModels = false;
    env.backends.onnx.wasm.wasmPaths = "/vendor/transformers/";
    const files = {};
    const progress_callback = (p) => {
      if (p.status === "progress" && p.total) {
        files[p.file] = [p.loaded, p.total];
        const vals = Object.values(files);
        onProgress?.(vals.reduce((a, v) => a + v[0], 0) / vals.reduce((a, v) => a + v[1], 0));
      }
    };
    let device = "wasm";
    try { if (navigator.gpu && (await navigator.gpu.requestAdapter())) device = "webgpu"; } catch {}
    const opts = device === "webgpu"
      ? { device, dtype: { encoder_model: "fp32", decoder_model_merged: "q4" }, progress_callback }
      : { device, dtype: "q8", progress_callback };
    const pipe = await pipeline("automatic-speech-recognition", modelId, opts);
    return async (samples16k) => {
      const out = await pipe(samples16k, { language: undefined, return_timestamps: false });
      return String(out.text || "").trim();
    };
  })();
  asrPromise.catch(() => { asrPromise = null; });
  return asrPromise;
}
