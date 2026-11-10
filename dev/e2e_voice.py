# Voice patching end to end: set up a voice, fix a line at Checkpoint A, render, undo at the end.
import time, sys
from playwright.sync_api import sync_playwright
BASE = "http://localhost:8888"
MOCK = """
window.__SVS_MOCK_ASR = (async () => {
  const words = ["Okay so today we count walls", "Picture a wall two units tall and n units long", "Look at the right hand end of the wall",
    "So every wall of length n is one of these plus the walls with two flat dominoes", "Let's find a three and then a four and a five",
    "A common mistake is to write a n equals a n minus one plus one", "So to recap here are three steps"];
  let i = 0;
  return async (samples) => samples.length > 16000 * 2 ? words[i++ % words.length] : "plus the walls with";
})();
"""
shots = sys.argv[1] if len(sys.argv) > 1 else "dev/out"
AUDIO_INFO = """async (id) => {
  const db = await new Promise((r) => { const o = indexedDB.open('sls-video-studio', 1); o.onsuccess = () => r(o.result); });
  const get = (k) => new Promise((r) => { const q = db.transaction('files').objectStore('files').get(k); q.onsuccess = () => r(q.result || null); });
  const a = await get('audio:' + id), o = await get('audio-original:' + id);
  const dur = async (f) => { const ctx = new OfflineAudioContext(1, 1, 48000); return (await ctx.decodeAudioData(await f.arrayBuffer())).duration; };
  return { name: a && a.name, dur: a && await dur(a), orig: !!o, origDur: o && await dur(o) };
}"""
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    ctx.add_init_script(MOCK)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    pg.goto(BASE); pg.wait_for_selector("text=Create the admin account")
    pg.fill("input[name=setupCode]", "letmein"); pg.fill("input[name=name]", "Ben Fedoruk")
    pg.fill("input[name=email]", "benjamin.fedoruk@ontariotechu.ca"); pg.fill("input[name=password]", "a-strong-password")
    pg.click("text=Create admin"); pg.wait_for_selector("text=My videos")
    # Voice before any ElevenLabs key
    pg.goto(BASE + "/#/voice"); pg.wait_for_selector("text=Use my AI voice")
    assert pg.locator("text=needs to add an ElevenLabs API key").count() == 1
    pg.screenshot(path=f"{shots}/voice_01_nokey.png", full_page=True)
    # keys
    pg.goto(BASE + "/#/admin/keys"); pg.wait_for_selector("text=Add a key")
    pg.fill("input[name=label]", "TLC budget key"); pg.fill("input[name=key]", "sk-ant-api03-test-key-0000WXYZ")
    pg.click("button:has-text('Add key')"); pg.wait_for_selector("text=sk-ant-…WXYZ")
    pg.select_option("select[name=provider]", "elevenlabs")
    pg.fill("input[name=label]", "ElevenLabs"); pg.fill("input[name=key]", "sk_0123456789abcdef0123456789abVOIC")
    pg.click("button:has-text('Add key')"); pg.wait_for_selector("text=…VOIC")
    pg.screenshot(path=f"{shots}/voice_02_keys.png", full_page=True)
    # Voice page: off by default, then on, then upload a sample
    pg.goto(BASE + "/#/voice"); pg.wait_for_selector("text=Use my AI voice")
    assert not pg.is_checked("#vonoff")
    pg.screenshot(path=f"{shots}/voice_03_off.png", full_page=True)
    pg.check("#vonoff"); pg.wait_for_selector("text=record yourself reading the sample script")
    pg.click("text=The sample script")
    pg.screenshot(path=f"{shots}/voice_04_setup.png", full_page=True)
    pg.set_input_files("input[name=sample]", "dev/fixtures/voice_sample.m4a")
    pg.check("input[name=consent]")
    pg.click("button:has-text('Create my voice')")
    pg.wait_for_selector("text=Made from", timeout=60000)
    pg.fill("#vtest", "Okay, so let's check our answer.")
    pg.click("#vplay"); pg.wait_for_selector("#vtake audio", timeout=30000)
    print("test take:", pg.inner_text("#vcost"))
    pg.screenshot(path=f"{shots}/voice_05_ready.png", full_page=True)
    # a video, to Checkpoint A
    pg.goto(BASE + "/#/new"); pg.wait_for_selector("text=Start from your narration")
    pg.fill("input[name=title]", "Counting with Recurrences"); pg.fill("input[name=eyebrow]", "Recurrence")
    pg.set_input_files("input[name=audio]", "dev/fixtures/test_voice7.m4a")
    pg.click("text=Upload and start")
    pg.wait_for_selector("text=Checkpoint A", timeout=120000)
    jid = pg.evaluate("location.hash.split('/')[2]")
    before = pg.evaluate(AUDIO_INFO, jid)
    pg.wait_for_selector("text=Fix a line with your AI voice")
    pg.click("text=Fix a line with your AI voice")
    pg.click("[data-fix='5']")
    pg.wait_for_selector("#orig audio")
    pg.fill("#ptext", "A common mistake is to write a n equals a n minus one plus one, so watch for that, because it is a very common slip.")
    pg.click("#ptakes"); pg.wait_for_selector("[data-use='2']", timeout=60000)
    pg.screenshot(path=f"{shots}/voice_06_takes.png", full_page=True)
    pg.click("[data-use='1']")
    pg.wait_for_selector(".pill:has-text('AI voice')", timeout=60000)
    after = pg.evaluate(AUDIO_INFO, jid)
    print("audio before:", before, "\naudio after:", after)
    assert after["orig"] and after["name"].endswith("-patched.wav") and after["dur"] > before["dur"] + 2, "patched audio should be longer"
    caps = pg.eval_on_selector_all(".chunk textarea[data-k=caption]", "els => els.map(e => e.value)")
    assert "very common slip" in caps[5], caps[5]
    times = pg.locator(".chunk .t").all_inner_texts()
    print("chunk times after patch:", times)
    pg.screenshot(path=f"{shots}/voice_07_patched.png", full_page=True)
    pg.click("text=Approve and plan slides")
    pg.wait_for_selector(".thumb img", timeout=120000)
    pg.click("text=Approve and render")
    pg.wait_for_selector("text=Your video is ready", timeout=600000)
    with pg.expect_download() as d:
        pg.click("text=Download MP4")
    d.value.save_as(f"{shots}/voice_patched.mp4")
    with pg.expect_download() as d:
        pg.click("text=Download captions")
    d.value.save_as(f"{shots}/voice_patched.srt")
    pg.screenshot(path=f"{shots}/voice_08_done.png", full_page=True)
    # undo after rendering: the page should ask for a re-render
    pg.wait_for_selector("details.patch")
    pg.evaluate("document.querySelector('details.patch').open = true")
    pg.once("dialog", lambda dlg: dlg.accept())
    pg.click("#undoall")
    pg.wait_for_selector("text=since this video was rendered", timeout=30000)
    restored = pg.evaluate(AUDIO_INFO, jid)
    assert not restored["orig"] and abs(restored["dur"] - before["dur"]) < 0.01, restored
    print("undo restored:", restored)
    # usage
    pg.goto(BASE + "/#/admin/usage"); pg.wait_for_selector("text=By stage and model")
    assert pg.locator("text=elevenlabs/eleven_multilingual_v2").count() > 0
    pg.screenshot(path=f"{shots}/voice_09_usage.png", full_page=True)
    pg.goto(BASE + "/#/admin/settings"); pg.wait_for_selector("text=Voice patching")
    pg.locator("text=Voice patching").scroll_into_view_if_needed()
    pg.screenshot(path=f"{shots}/voice_10_settings.png")
    print("ERRORS:", errs)
    b.close()
print("VOICE E2E DONE")
