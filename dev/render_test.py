import base64, json, sys
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg = b.new_page()
    pg.on("console", lambda m: print("console:", m.text))
    pg.on("pageerror", lambda e: print("pageerror:", e))
    pg.goto("http://localhost:8888/dev/render-test.html")
    pg.wait_for_function("window.done === true", timeout=120000)
    frames = pg.evaluate("window.frames")
    print("render ms", pg.evaluate("window.renderMs"))
    for i, f in enumerate(frames):
        open(f"dev/out/build_{i:02d}.png","wb").write(base64.b64decode(f["png"].split(",")[1]))
        print(i, f["scene"], f["build"], f["errors"])
    b.close()
