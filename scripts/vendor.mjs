// Copies the browser libraries from node_modules into public/vendor/.
// Netlify runs this on every deploy (see netlify.toml), so the large files never need to be in Git.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nm = (p) => path.join(root, "node_modules", p);
const out = (p) => path.join(root, "public/vendor", p);

function copy(from, to) {
  if (!fs.existsSync(from)) throw new Error(`Missing ${from} — did npm install run?`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
function copyMatching(dir, re, toDir) {
  const files = fs.readdirSync(dir).filter((f) => re.test(f));
  if (!files.length) throw new Error(`No files matching ${re} in ${dir}`);
  for (const f of files) copy(path.join(dir, f), path.join(toDir, f));
}

fs.rmSync(path.join(root, "public/vendor"), { recursive: true, force: true });

// Video encoding and audio mixing
copyMatching(nm("@ffmpeg/ffmpeg/dist/esm"), /\.js$/, out("ffmpeg"));
copyMatching(nm("@ffmpeg/util/dist/esm"), /\.js$/, out("ffmpeg/util"));
copyMatching(nm("@ffmpeg/core/dist/esm"), /^ffmpeg-core\./, out("ffmpeg/core"));
copy(nm("mp4-muxer/build/mp4-muxer.mjs"), out("mp4-muxer.mjs"));
copy(nm("mp4box/dist/mp4box.all.min.js"), out("mp4box.all.min.js"));
// Speech recognition (Whisper)
copy(nm("@huggingface/transformers/dist/transformers.min.js"), out("transformers/transformers.min.js"));
copyMatching(nm("@huggingface/transformers/dist"), /^ort-wasm-simd-threaded\.jsep\./, out("transformers"));
// Math typesetting
copy(nm("mathjax/es5/tex-svg-full.js"), out("mathjax/tex-svg-full.js"));
// Ubuntu fonts
for (const w of [300, 400, 500, 700]) copy(nm(`@fontsource/ubuntu/files/ubuntu-latin-${w}-normal.woff2`), out(`fonts/ubuntu-latin-${w}-normal.woff2`));
copy(nm("@fontsource/ubuntu-condensed/files/ubuntu-condensed-latin-400-normal.woff2"), out("fonts/ubuntu-condensed-latin-400-normal.woff2"));

let n = 0, bytes = 0;
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else { n++; bytes += s.size; } } })(out(""));
console.log(`vendor: copied ${n} files (${(bytes / 1e6).toFixed(1)} MB) into public/vendor/`);
