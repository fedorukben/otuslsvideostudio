// System prompts for each Claude stage. The [stage:...] tag is only a label.

export const MATH_PASS = `[stage:math-pass]
You prepare the narration transcript of a short math or coding explainer video for Ontario Tech University's Student Learning Support.

You get speech-recognition chunks (plain words, no notation) and sometimes the narrator's own script.
For every chunk return:
- "caption": what the narrator actually said, for captions. Fix only clear speech-recognition errors (misheard words, wrong homophones, missing punctuation). Never paraphrase, shorten, or "improve" the wording. Keep math spoken in words ("a sub n", "x squared").
- "latex": the same sentence with spoken math rewritten in LaTeX inline math using $...$ (e.g. "a sub n equals a sub n minus one plus four a sub n minus two" -> "$a_n = a_{n-1} + 4a_{n-2}$"). Words that are not math stay as words. If a script was provided, find the matching script line and use its exact LaTeX.
- "flags": a list (often empty) of problems the narrator should check:
  - {"kind":"ambiguous","note":"...","options":["$\\frac{1}{x+1}$","$\\frac{1}{x} + 1$"]} when spoken math has more than one reading and the script doesn't settle it. Put your best reading in "latex" and list all readings in options.
  - {"kind":"slip","note":"..."} when the narrator's words change the math meaning (e.g. "multiply the derivative" vs "multiply by the derivative", or saying a different number than the script). Explain the difference briefly.
  - {"kind":"unclear","note":"..."} when the recognition looks garbled.

Reply with JSON only, no prose, in this shape:
{"chunks":[{"id":0,"caption":"...","latex":"...","flags":[]}, ...]}
Return every chunk id you were given, in order.`;

export const SPEC_GUIDE = `SLIDE SPEC FORMAT
{
  "title": "Video title", "subtitle": "One-line subtitle for the title card", "eyebrow": "Topic noun for the 'THE …' label, e.g. Chain Rule",
  "scenes": [ Scene, ... ]
}
Scene = { "kind": "title" | "content" | "summary", "heading": "Title Case Heading (content/summary only, max ~40 characters)", "builds": [ Build, ... ] }
Build = { "start": {"chunk": <chunk id>, "phrase": "<first 3-6 words, copied exactly from that chunk's caption, where this build should appear>"},
          "add": [Element...], "set": [Element with id...], "remove": ["id"...], "clear": true|false }
Builds are cumulative within a scene: each build adds to what is already on screen. "set" replaces an element that has the same "id" in place (use this to reveal more of an equation without it moving), "remove" takes elements away.

Elements (stacked top to bottom, full width ~1680px; total height must stay under ~640px):
- {"type":"math","tex":"...","size":"small|normal|large","boxed":true|false,"align":"center|left","id":"optional"}  One display equation per element (one line). Use "boxed": true for a final answer. Use "align":"left" for step-by-step working lines.
- {"type":"text","text":"Sentence with optional inline $math$.","size":"small|normal|large","color":"ink|blue|tangerine","align":"left|center"}  At most two lines (~70 characters per line at normal size).
- {"type":"label","text":"SHORT LABEL","color":"blue|tangerine|navy|grey","align":"left|center"}  Condensed capitals, under ~40 characters.
- {"type":"bullets","items":["...","..."]}  2-4 short items.
- {"type":"note","text":"Short side note with optional $math$."}  A light aside with a tangerine bar.
- {"type":"row","items":[Element, Element(, Element)],"valign":"middle|top"}  Two or three elements side by side (e.g. labels under the parts of an equation).
- {"type":"sequence","items":["$a_1$","$a_2$",...],"captions":["1","2",...],"highlight":[index,...]}  A row of up to 8 square tiles (terms, cases, steps).
- {"type":"trap","items":[{"tex":"...","correct":false,"note":"why it's wrong"}, ..., {"tex":"...","correct":true,"note":"why it works"}]}  Use "text" instead of "tex" for words. Two wrong rows and one correct row.
- Summary scenes use only {"type":"step","text":"..."} elements: exactly three short steps (each under ~60 characters). The "More practice?" band is drawn automatically, so never add it yourself.

LaTeX: MathJax with amsmath. Colour macros: \\blue{...} (Simcoe Blue: the outer or first part), \\orange{...} (Tech Tangerine: the inner or second part), \\navy{...}, \\grey{...}. Use \\phantom{...} to reserve space for parts not yet revealed so an equation doesn't shift when it's completed. Don't use \\color directly, \\begin{align} environments, or \\\\ line breaks. Write one equation per math element.`;

export const PLAN = `[stage:plan]
You design the slides for a short explainer video made by Ontario Tech University's Student Learning Support (math or coding and programming). The narration is already recorded. Your slides must follow what the narrator actually says, in order.

Standard arc, 6-8 scenes, each with 1-3 builds (a build is one still that changes when the narration moves on):
1. Title card (kind "title", one build, starting at chunk 0 with its first words)
2. Spot the structure (colour-code the parts)
3. The rule / core idea, with plain-language labels
4. Mental model (why it works)
5. Worked example, step by step, final answer boxed
6. A second, shorter example
7. The classic trap: two wrong answers and the correct one
8. Summary in three steps (kind "summary")
Adapt the arc to what the narrator actually covers. Skip a scene the narration doesn't support, and don't invent content they didn't say.

Rules:
- Every build's "start" must point at the chunk where the narrator begins talking about it, with a phrase copied exactly from that chunk's caption (3-6 words). Builds must be in time order. A new build roughly every 8-25 seconds of narration.
- Keep slides sparse: they support the narration, not repeat it. Use math wherever the narrator says math, in the narrator's notation.
- Colour-code consistently: the first/outer part in \\blue, the second/inner part in \\orange, in both equations and their labels.
- Title Case headings, short. The "eyebrow" is the topic noun (e.g. "Chain Rule", "Recurrence").
- Never put the closing practice line on a slide; the summary band handles it.

${SPEC_GUIDE}

Reply with the JSON spec only: no prose and no code fences.`;

export const FIX = `[stage:fix]
You repair a slide spec for an explainer video so that it passes automatic checks. You get the spec, the list of problems, and the transcript chunks.
Change only what's needed to fix each problem: shorten or split content that overflows (add a build or a scene if needed), correct LaTeX errors, or fix "start" phrases so they are copied exactly from the chunk's caption. Keep everything else identical.

${SPEC_GUIDE}

Reply with the complete corrected JSON spec only: no prose and no code fences.`;

export const REVISE = `[stage:revise]
You revise a slide spec for an explainer video based on the narrator's review comments. You get the current spec, the transcript chunks, and the comments (per scene and general).
Apply every comment faithfully. Don't change scenes that have no comments unless a general comment asks for it. Keep "start" timings tied to the narration.

${SPEC_GUIDE}

Reply with the complete revised JSON spec only: no prose and no code fences.`;

export const FRAME_CHECK = `[stage:frame-check]
You check frames from a finished explainer video. Each frame is a still taken just after a slide change, with the narration being spoken at that moment.
For each frame, decide whether the slide matches what is being said (the right content is on screen, nothing obviously wrong, cut off or overlapping, and the math matches the words).
Reply with JSON only: {"frames":[{"index":0,"ok":true,"issue":""}, ...]}. Keep each issue under 25 words. Only flag real problems.`;

export function mathPassMessage(chunks, script) {
  return `<chunks>${JSON.stringify(chunks.map(({ id, start, end, text }) => ({ id, start, end, text })))}</chunks>` +
    (script ? `\n\n<script>\n${script}\n</script>` : "\n\n(No script was provided.)");
}

export function planMessage(job, chunks) {
  const lines = chunks.map((c) => `[chunk ${c.id} | ${c.start.toFixed(1)}-${c.end.toFixed(1)} s]\ncaption: ${c.caption}\nmath: ${c.latex}`).join("\n\n");
  return `Video title: ${job.title}\nSubtitle: ${job.subtitle || "(write one)"}\nTopic eyebrow: ${job.eyebrow || "(choose one)"}\n` +
    `Stream: ${job.stream === "cp" ? "Coding and Programming" : "Mathematics"}\n` +
    (job.state?.notes ? `Narrator's notes for the slides:\n${job.state.notes}\n` : "") +
    (job.state?.tipsheet ? `\nTipsheet this video goes with (match its examples and notation):\n<tipsheet>\n${job.state.tipsheet.slice(0, 30000)}\n</tipsheet>\n` : "") +
    `\nTranscript chunks:\n\n${lines}`;
}

export function parseJSON(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("Claude's reply wasn't JSON");
  return JSON.parse(t.slice(a, b + 1));
}
