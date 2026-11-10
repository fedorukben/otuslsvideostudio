# False starts flagged by the transcript check are always listed, can be adjusted by hand, and cut.
import sys
from playwright.sync_api import sync_playwright
BASE = "http://localhost:8888"
MOCK = open("dev/e2e_voice.py").read().split('MOCK = """')[1].split('"""')[0]
shots = sys.argv[1] if len(sys.argv) > 1 else "dev/out"
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 1280, "height": 900}); ctx.add_init_script(MOCK); pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
    pg.goto(BASE); pg.wait_for_selector("text=Create the admin account")
    pg.fill("input[name=setupCode]", "letmein"); pg.fill("input[name=name]", "Ben"); pg.fill("input[name=email]", "a@b.ca"); pg.fill("input[name=password]", "a-strong-password")
    pg.click("text=Create admin"); pg.wait_for_selector("text=My videos")
    pg.goto(BASE + "/#/admin/keys"); pg.wait_for_selector("text=Add a key"); pg.fill("input[name=label]", "k"); pg.fill("input[name=key]", "sk-ant-api03-test-key-0000WXYZ")
    pg.click("button:has-text('Add key')"); pg.wait_for_selector("text=sk-ant-…WXYZ")
    pg.goto(BASE + "/#/new"); pg.wait_for_selector("text=Start from your narration"); pg.fill("input[name=title]", "T")
    pg.set_input_files("input[name=audio]", "dev/fixtures/test_voice7.m4a"); pg.click("text=Upload and start")
    pg.wait_for_selector("text=Checkpoint A", timeout=120000)
    pg.wait_for_selector(".fsrow", timeout=30000)
    rows = pg.locator(".fsrow .txt").all_inner_texts()
    for r in rows: print("ROW:", r.replace("\n", " | ")[:200])
    assert len(rows) == 3, f"expected 3 false starts (2 flagged + 1 repeat), got {len(rows)}"
    assert any("couldn't find these exact words" in r for r in rows), "unplaced flag should still be listed"
    pg.locator(".card.clean").scroll_into_view_if_needed()
    pg.screenshot(path=f"{shots}/fs_01_list.png", full_page=True)
    # adjust the 'Picture a' cut by hand, listen, cut
    row = pg.locator(".fsrow", has_text="picture a")
    row.locator("[data-act=adjust]").click()
    a = float(row.locator("[data-ab=a]").input_value())
    row.locator("[data-ab=b]").fill(f"{a + 0.6:.2f}")
    row.locator("[data-act=listen]").click(); row.locator(".pv audio").first.wait_for()
    print("adjusted length:", row.locator(".len").inner_text())
    pg.screenshot(path=f"{shots}/fs_02_adjust.png", full_page=True)
    row.locator("[data-act=cut]").click()
    pg.wait_for_selector("text=Cut so far", timeout=30000)
    caps = pg.eval_on_selector_all(".chunk textarea[data-k=caption]", "els => els.map(e => e.value)")
    print("caption 1 after cut:", caps[1])
    assert caps[1].startswith("Wall two units"), caps[1]
    print("rows left:", pg.locator(".fsrow").count())
    print("ERRORS:", errs)
    b.close()
print("FALSE STARTS E2E DONE")
