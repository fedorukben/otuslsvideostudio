# SLS Video Studio

An internal Ontario Tech Student Learning Support site that turns a recorded narration into a finished explainer video: a 1920×1080 MP4 in Ontario Tech styling, with burnt-in captions, the official outro, and an `.srt` file.

People sign in with email and a password. Admins manage users, API keys and spending caps, and see every Claude call metered by person, stage and video.

## How it works

| Step | Where it runs | Cost |
| --- | --- | --- |
| 1. Upload narration (M4A/MP3/WAV), title, stream, optional script, tipsheet and notes | Browser | free |
| 2. Transcribe: **in-browser Whisper** (free, audio stays local) **or AssemblyAI** (metered, word-level timing). Chosen in Settings | Browser, or AssemblyAI via the site | free, or about $0.02 per 5-minute video |
| 3. Math pass: spoken math to LaTeX, flag ambiguities and slips | Claude Haiku via the site | < $0.01 |
| 4. **Checkpoint A**: you fix the transcript and the math | Browser | free |
| 5. Slide planning: writes a slide *spec* (JSON), not code | Claude Opus via the site | ~$0.30–$0.60 |
| 6. Spec check (LaTeX, layout, timing), auto-fixed up to 3 rounds | Browser + Claude Sonnet | $0–$0.25 |
| 7. **Checkpoint B**: every slide shown; comment per scene | Browser (+ Sonnet for comments) | ~$0.10 per round |
| 8. Timing: each build matched to the words you say | Browser (Whisper) | free |
| 9. Render: slides (MathJax), captions, crossfades, white dip, outro; H.264 encode | Browser (WebCodecs) | free |
| 10. Audio: highpass, loudnorm to −16 LUFS, fades, AAC, outro audio | Browser (ffmpeg.wasm) | free |
| 11. Final check of key frames against the narration | Claude Haiku via the site | < $0.01 |

**Privacy.** With in-browser Whisper, the audio and the finished MP4 never leave the user's computer. With AssemblyAI, the audio is uploaded through the site to AssemblyAI (a US company) for transcription; the site then deletes the transcript at AssemblyAI and its own temporary copy. Either way, the finished MP4 stays on the user's computer; they're kept in the browser's IndexedDB. The server stores only accounts, settings, the transcript text, the slide spec and usage records (in Netlify Blobs). API keys are encrypted (AES-256-GCM) and never sent to a browser.

**Claude calls.** The browser queues each call at `/api/claude/start`. A Netlify *background function* makes the call (it can run up to 15 minutes), records token usage and cost, and the browser polls for the reply. Spending caps are checked before every call.

## Deploy to Netlify

1. **Add the outro clip.** Put the official outro in `public/assets/` as `OT_Outro_White.mp4` (the name `OT Outro White.mp4` with spaces also works). Without it, videos render with no outro and a warning. The reverse logo (`public/assets/logo-reverse.svg`) is already included, copied from the Ontario Tech design system.
2. **Put the folder in a Git repository** (GitHub, for example) and create a Netlify site from it. `netlify.toml` sets everything: on each deploy Netlify runs `npm run build`, which copies the browser libraries from npm into `public/vendor/`. That folder is **not** stored in Git, so GitHub's upload limits don't matter. You can also deploy with the Netlify CLI: `netlify deploy --prod`.
3. **Set environment variables** (Site configuration → Environment variables):
   - `JWT_SECRET`: a random string of 32+ characters (signs sign-in sessions).
   - `ENCRYPTION_SECRET`: a different random string of 32+ characters (encrypts API keys). **Don't change it later**, or stored keys can't be decrypted and must be re-added.
   - `SETUP_CODE`: a one-time code you'll type to create the first admin.

   To make a random string: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
4. **Check that background functions are available** on your Netlify plan. The Opus planning call can take a few minutes, longer than a normal function's limit. If your plan doesn't include them, set `SYNC_CLAUDE=true`; the short stages will work, but planning may time out.
5. **Open the site.** You'll get *Create the admin account*: enter the setup code, your name, email and a password. This works only once.
6. **As admin:** add an Anthropic API key under **API keys**, set the monthly cap under **Settings**, and add people under **Users**. New users get a temporary password and choose their own at first sign-in.

## Transcription: Whisper or AssemblyAI

Admins choose under **Settings → Transcription**:

- **In-browser Whisper** (default): free, private, but downloads a ~250 MB model the first time and times slides from pauses in the audio.
- **AssemblyAI**: metered per hour of audio (Universal-3.5 Pro $0.21/hr plus $0.05/hr for key terms, editable in Settings). It returns a time for every word, so slides and captions line up exactly. Words from the video's title, script, tipsheet and notes are sent as key terms to improve recognition. Add an AssemblyAI key under **API keys** first. Transcription costs show on the Usage page as the `transcribe` stage, count toward the caps, and appear in the live cost.

## Approval

**Settings → Approval** decides whether an admin must approve a video before it can spend anything:

- **No approval needed** (default).
- **Approval when the estimate is over $X**: the site estimates each video's cost from the narration length (about $0.45 plus $0.04 a minute, plus transcription if AssemblyAI is on).
- **Every video needs approval.**

Waiting videos appear under **Approvals** (with a count in the menu). An admin approves with a budget for that video (suggested at 1.5 times the estimate; blank means no per-video limit) or declines with a note the person sees. The server blocks every Claude and AssemblyAI call for a video that is waiting, declined, or over its approved budget, and budgets can be raised afterwards. Admins' own videos are approved automatically.

## Using it

- Use **Chrome or Edge** on a laptop or desktop. Keep the tab open while it's working.
- The first transcription downloads the Whisper model (about 250 MB for *small*) from Hugging Face; after that it's cached. If campus networks block huggingface.co, pick a smaller model in Settings or test off-campus first.
- **Download the MP4 and SRT when it finishes.** They're kept only in that browser. You can re-render from the approved slides any time (a few cents).
- If a step fails, the video goes back to the previous checkpoint with the error shown, and nothing already paid for is lost.
- Remember: brand@ontariotechu.ca asks to be contacted before the Ontario Tech name or logo is used in a project.

## Admin metering

**Usage** shows, per month: total spend against the cap, videos started, calls, and average per video. It breaks spend down by person, by stage and model (with token counts), and by video, lists recent calls, and has a CSV export.

Caps:
- **Site cap:** blocks new calls once the month's total reaches it.
- **Per-person $ limit** and **per-person video limit:** set per user, or as defaults in Settings.

Costs are worked out from each response's token counts (input, cache writes, cache reads, output) using the price table in **Settings**. The defaults are USD per million tokens, from November 2026: Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50 (with higher rates for prompts over 100k tokens). Update the table if prices change.

## Slide spec

Claude writes JSON, and a fixed renderer draws it, so every video follows the same brand rules. Scenes are `title`, `content` or `summary`. Builds add, set or remove elements cumulatively, and each build is tied to a chunk of narration plus the first few words spoken there. Element types: `math` (optionally `boxed`), `text` (with inline `$math$`), `label`, `bullets`, `note`, `row` (side by side), `sequence` (tiles), `trap` (two ✗ rows and one ✓ row), and `step` (summary). Colour macros: `\blue{}`, `\orange{}`, `\navy{}`, `\grey{}`. You can download or hand-edit the spec at Checkpoint B.

## Develop and test locally

```
npm install
npm run dev            # http://localhost:8888 with in-memory storage and a mock Claude API
npm run test:api       # in another terminal: auth, roles, keys, caps, metering, CSV
python3 dev/e2e_test.py   # full UI run in Chrome with Playwright (mock ASR + mock Claude)
```

The dev server's setup code is `letmein`. Run `npm run build` once after `npm install` to fill `public/vendor/` locally.

## Files

```
netlify/functions/   auth, admin, jobs, claude (+ claude-run-background)
netlify/lib/         shared helpers: storage, sessions, encryption, pricing, the Claude call
public/index.html, app.css, js/app.js        the interface
public/js/pipeline/  audio, asr, prompts, spec, render, timing, encode, run
public/vendor/       MathJax, ffmpeg.wasm, transformers.js, mp4-muxer, mp4box, Ubuntu fonts
dev/                 local server, mock Claude, tests, fixtures
```
