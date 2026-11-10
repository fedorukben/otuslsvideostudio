import time, sys, os
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
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    ctx.add_init_script(MOCK)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    pg.goto(BASE)
    pg.wait_for_selector("text=Create the admin account")
    pg.screenshot(path=f"{shots}/ui_01_setup.png")
    pg.fill("input[name=setupCode]", "letmein"); pg.fill("input[name=name]", "Ben Fedoruk")
    pg.fill("input[name=email]", "benjamin.fedoruk@ontariotechu.ca"); pg.fill("input[name=password]", "a-strong-password")
    pg.click("text=Create admin")
    pg.wait_for_selector("text=My videos")
    # add an API key
    pg.goto(BASE + "/#/admin/keys"); pg.wait_for_selector("text=Add a key")
    pg.fill("input[name=label]", "TLC budget key"); pg.fill("input[name=key]", "sk-ant-api03-test-key-0000WXYZ")
    pg.click("button:has-text('Add key')"); pg.wait_for_selector("text=sk-ant-…WXYZ")
    pg.screenshot(path=f"{shots}/ui_02_keys.png")
    # new video
    pg.goto(BASE + "/#/new"); pg.wait_for_selector("text=Start from your narration")
    pg.fill("input[name=title]", "Counting with Recurrences"); pg.fill("input[name=eyebrow]", "Recurrence")
    pg.fill("input[name=subtitle]", "Building domino walls one piece at a time")
    pg.set_input_files("input[name=audio]", "dev/fixtures/test_voice7.m4a")
    pg.screenshot(path=f"{shots}/ui_03_new.png")
    pg.click("text=Upload and start")
    pg.wait_for_selector("text=Checkpoint A", timeout=120000)
    time.sleep(1.5)
    pg.screenshot(path=f"{shots}/ui_04_checkpointA.png", full_page=True)
    pg.click("text=Approve and plan slides")
    if os.environ.get("MOCK_SLOW"):
        pg.wait_for_selector("#rcostv", timeout=30000)
        seen = []
        for i in range(10):
            pg.wait_for_timeout(1000)
            if pg.locator("#rcostv").count(): seen.append(pg.inner_text("#rcostv"))
            if i == 4: pg.screenshot(path=f"{shots}/ui_ticker.png")
        print("ticker samples:", seen)
    pg.wait_for_selector("text=Checkpoint B", timeout=120000)
    pg.wait_for_selector(".thumb img", timeout=120000)
    time.sleep(1)
    pg.screenshot(path=f"{shots}/ui_05_checkpointB.png", full_page=True)
    pg.fill("textarea[data-scene='3']", "Box the final answer")
    pg.click("text=Apply comments")
    pg.wait_for_selector(".thumb img", timeout=120000)
    pg.click("text=Approve and render")
    pg.wait_for_selector("#runbox h3", timeout=60000)
    pg.wait_for_selector("#rcost", timeout=60000)
    pg.wait_for_function("document.querySelector('#rprog:not(.indeterminate)')", timeout=120000)
    print("live cost shown:", pg.inner_text("#rcost"), "| header:", pg.inner_text("#jobcost"))
    pg.screenshot(path=f"{shots}/ui_06b_livecost.png")
    pg.screenshot(path=f"{shots}/ui_06_rendering.png")
    pg.wait_for_selector("text=Your video is ready", timeout=600000)
    time.sleep(1)
    pg.screenshot(path=f"{shots}/ui_07_done.png", full_page=True)
    with pg.expect_download() as d:
        pg.click("text=Download MP4")
    d.value.save_as(f"{shots}/e2e.mp4")
    with pg.expect_download() as d:
        pg.click("text=Download captions")
    d.value.save_as(f"{shots}/e2e.srt")
    # admin usage
    pg.goto(BASE + "/#/admin/usage"); pg.wait_for_selector("text=By stage and model")
    pg.screenshot(path=f"{shots}/ui_08_usage.png", full_page=True)
    pg.goto(BASE + "/#/admin/users"); pg.wait_for_selector("text=Add a person")
    pg.screenshot(path=f"{shots}/ui_09_users.png", full_page=True)
    pg.goto(BASE + "/#/admin/settings"); pg.wait_for_selector("text=Prices")
    pg.screenshot(path=f"{shots}/ui_10_settings.png", full_page=True)
    # turn costs off and check the video pages hide them
    pg.uncheck("input[name=showCost]"); pg.click("text=Save settings"); pg.wait_for_selector("text=Settings saved")
    pg.goto(BASE + "/#/videos"); pg.wait_for_selector("text=Counting with Recurrences")
    assert pg.locator("th:has-text('Cost')").count() == 0, "cost column should be hidden"
    pg.click("text=Counting with Recurrences"); pg.wait_for_selector("text=Your video is ready")
    assert pg.locator("text=Claude cost so far").count() == 0, "cost line should be hidden"
    print("cost hidden when the setting is off")
    # ---- AssemblyAI path: add a key, switch transcription, make a second video ----
    pg.goto(BASE + "/#/admin/settings"); pg.wait_for_selector("text=Transcription")
    pg.check("input[name=showCost]"); pg.click("text=Save settings"); pg.wait_for_selector("text=Settings saved")
    pg.goto(BASE + "/#/admin/keys"); pg.wait_for_selector("text=Add a key")
    pg.select_option("select[name=provider]", "assemblyai")
    pg.fill("input[name=label]", "AssemblyAI test"); pg.fill("input[name=key]", "0123456789abcdef0123456789abcdef")
    pg.click("button:has-text('Add key')"); pg.wait_for_selector("text=…cdef")
    pg.screenshot(path=f"{shots}/ui_11_keys_two.png", full_page=True)
    pg.goto(BASE + "/#/admin/settings"); pg.wait_for_selector("text=Transcription")
    pg.check("input[name=asrProvider][value=assemblyai]"); pg.click("text=Save settings"); pg.wait_for_selector("text=Settings saved")
    pg.screenshot(path=f"{shots}/ui_12_settings_asr.png", full_page=True)
    pg.evaluate("window.__SVS_MOCK_ASR = null")  # make sure no in-browser ASR is used
    pg.goto(BASE + "/#/new"); pg.wait_for_selector("text=sent to AssemblyAI")
    pg.fill("input[name=title]", "Counting with Recurrences (AssemblyAI)"); pg.fill("input[name=eyebrow]", "Recurrence")
    pg.fill("textarea[name=script]", "Okay so today we count walls with dominoes. The recurrence is $a_n = a_{n-1} + a_{n-2}$.")
    pg.set_input_files("input[name=audio]", "dev/fixtures/test_voice7.m4a")
    pg.click("text=Upload and start")
    pg.wait_for_selector("text=Checkpoint A", timeout=120000)
    print("assemblyai transcript chunks:", pg.locator(".chunk").count())
    pg.click("text=Approve and plan slides")
    pg.wait_for_selector(".thumb img", timeout=120000)
    pg.click("text=Approve and render")
    pg.wait_for_selector("text=Your video is ready", timeout=600000)
    with pg.expect_download() as d:
        pg.click("text=Download captions")
    d.value.save_as(f"{shots}/e2e_aai.srt")
    pg.goto(BASE + "/#/admin/usage"); pg.wait_for_selector("text=By stage and model")
    assert pg.locator("text=assemblyai/universal-3-5-pro").count() > 0, "AssemblyAI usage should be metered"
    pg.screenshot(path=f"{shots}/ui_13_usage_aai.png", full_page=True)
    print("assemblyai metered:", pg.inner_text("table >> nth=1").replace("\n", " | ")[:300])
    print("ERRORS:", errs)
    b.close()
print("E2E DONE")
