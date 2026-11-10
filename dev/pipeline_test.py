import base64
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox","--autoplay-policy=no-user-gesture-required"])
    pg = b.new_page()
    pg.on("console", lambda m: print("console:", m.text[:300]))
    pg.on("pageerror", lambda e: print("pageerror:", e))
    pg.goto("http://localhost:8888/dev/pipeline-test.html")
    pg.wait_for_function("window.done === true", timeout=600000)
    m = pg.evaluate("window.mp4b64")
    if m: open("dev/out/test.mp4","wb").write(base64.b64decode(m))
    s = pg.evaluate("window.srt")
    if s: open("dev/out/test.srt","w").write(s)
    b.close()
