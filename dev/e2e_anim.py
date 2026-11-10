# Animated video end to end: diagram morphs + an advanced scene, through the real UI.
import time, os
from playwright.sync_api import sync_playwright
B = "http://localhost:8888"
MOCK = """
window.__SVS_MOCK_ASR = (async () => {
  const words = ["Picture f times g as a rectangle. Now nudge both sides a little. There's also a tiny corner. It shrinks so fast that it vanishes.",
    "Now let the nudges go to zero and watch the corner disappear.", "So the change is g delta f plus f delta g.", "That is the product rule.",
    "Let's try an example.", "Remember the corner.", "So to recap."];
  let i = 0;
  return async (samples) => samples.length > 16000 * 2 ? words[i++ % words.length] : "nudge both sides";
})();
"""
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    ctx.add_init_script(MOCK)
    pg = ctx.new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(B); pg.wait_for_selector("text=Create the admin account")
    pg.fill("input[name=setupCode]", "letmein"); pg.fill("input[name=name]", "Ben"); pg.fill("input[name=email]", "ben@ontariotechu.ca"); pg.fill("input[name=password]", "a-strong-password")
    pg.click("text=Create admin"); pg.wait_for_selector("text=My videos")
    pg.goto(B + "/#/admin/keys"); pg.wait_for_selector("text=Add a key")
    pg.fill("input[name=label]", "k"); pg.fill("input[name=key]", "sk-ant-api03-test-0000WXYZ"); pg.click("button:has-text('Add key')"); pg.wait_for_selector("text=…WXYZ")
    pg.goto(B + "/#/new"); pg.wait_for_selector("text=Advanced animated scenes")
    pg.fill("input[name=title]", "The Product Rule"); pg.fill("input[name=eyebrow]", "Product Rule")
    pg.select_option("select[name=advancedMode]", "requested")
    pg.fill("textarea[name=advancedNotes]", "Animate the corner shrinking to nothing as the nudges go to zero")
    pg.screenshot(path="dev/out/anim_ui_new.png", full_page=True)
    pg.set_input_files("input[name=audio]", "dev/fixtures/test_voice7.m4a")
    pg.click("text=Upload and start"); pg.wait_for_selector("text=Checkpoint A", timeout=120000)
    pg.click("text=Approve and plan slides"); pg.wait_for_selector(".thumb img", timeout=120000)
    pg.click("[data-play='0']"); time.sleep(2.6)
    pg.locator("#player-0").screenshot(path="dev/out/anim_ui_play.png")
    pg.wait_for_selector("text=▶ Play again", timeout=60000)
    pg.screenshot(path="dev/out/anim_ui_cpb.png", full_page=True)
    pg.click("text=Approve and render"); pg.wait_for_selector("text=Your video is ready", timeout=600000)
    with pg.expect_download() as d: pg.click("text=Download MP4")
    d.value.save_as("dev/out/anim.mp4")
    print("ERRORS:", errs)
    b.close()
print("ANIM E2E DONE")
