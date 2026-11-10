import base64, json
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg = b.new_page()
    pg.on("pageerror", lambda e: print("pageerror:", e))
    pg.on("console", lambda m: m.type == "error" and print("console:", m.text[:200]))
    pg.goto("http://localhost:8888/dev/anim-test.html")
    pg.wait_for_function("window.done === true", timeout=120000)
    for i, f in enumerate(pg.evaluate("window.out")):
        if "png" in f:
            open(f"dev/out/anim_{i:02d}.png", "wb").write(base64.b64decode(f["png"].split(",")[1]))
            print(i, f["label"])
        else: print(json.dumps(f)[:300])
    b.close()
