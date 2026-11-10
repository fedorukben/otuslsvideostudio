# Cutting a whole false-start sentence from a noisy recording with a quiet mutter before the restart:
# the join should be one normal pause (run with MOCK_FLAGS=whole).
from playwright.sync_api import sync_playwright
BASE="http://localhost:8888"
MOCK=open("dev/e2e_voice.py").read().split('MOCK = """')[1].split('"""')[0]
INFO=open("dev/e2e_voice.py").read().split('AUDIO_INFO = """')[1].split('"""')[0]
with sync_playwright() as p:
    b=p.chromium.launch(executable_path="/usr/bin/google-chrome",args=["--no-sandbox"]); ctx=b.new_context(viewport={"width":1280,"height":900}); ctx.add_init_script(MOCK); pg=ctx.new_page()
    errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE); pg.wait_for_selector("text=Create the admin account")
    pg.fill("input[name=setupCode]","letmein"); pg.fill("input[name=name]","Ben"); pg.fill("input[name=email]","a@b.ca"); pg.fill("input[name=password]","a-strong-password"); pg.click("text=Create admin"); pg.wait_for_selector("text=My videos")
    pg.goto(BASE+"/#/admin/keys"); pg.wait_for_selector("text=Add a key"); pg.fill("input[name=label]","k"); pg.fill("input[name=key]","sk-ant-api03-test-key-0000WXYZ"); pg.click("button:has-text('Add key')"); pg.wait_for_selector("text=sk-ant-…WXYZ")
    pg.goto(BASE+"/#/new"); pg.wait_for_selector("text=Start from your narration"); pg.fill("input[name=title]","T"); pg.set_input_files("input[name=audio]","dev/fixtures/false_start_aggh.m4a"); pg.click("text=Upload and start")
    pg.wait_for_selector("text=Checkpoint A", timeout=120000); pg.wait_for_selector(".fsrow", timeout=30000)
    jid=pg.evaluate("location.hash.split('/')[2]")
    times=pg.locator(".chunk .t").all_inner_texts(); print("chunks before:", times)
    pre=pg.evaluate(INFO, jid)
    row=pg.locator(".fsrow", has_text="whole sentence")
    print("row:", row.inner_text().replace("\n"," | ")[:160])
    row.locator("[data-act=cut]").click(); pg.wait_for_selector("text=Cut so far", timeout=30000)
    post=pg.evaluate(INFO, jid)
    print("duration", pre["dur"], "->", post["dur"], "removed", round(pre["dur"]-post["dur"],2))
    print("chunks after:", pg.locator(".chunk .t").all_inner_texts())
    # measure the silence at the join with the decoded audio
    gap=pg.evaluate("""async (id) => {
      const db = await new Promise((r) => { const o = indexedDB.open('sls-video-studio', 1); o.onsuccess = () => r(o.result); });
      const f = await new Promise((r) => { const q = db.transaction('files').objectStore('files').get('audio:' + id); q.onsuccess = () => r(q.result); });
      const ab = await new OfflineAudioContext(1,1,48000).decodeAudioData(await f.arrayBuffer()); const d = ab.getChannelData(0);
      const runs = []; let s = null;
      for (let i = 0; i < d.length / 480; i++) { let e = 0; for (let j = i*480; j < (i+1)*480; j++) e += d[j]*d[j];
        const q = 10*Math.log10(e/480+1e-12) < -45; if (q && s === null) s = i; if (!q && s !== null) { if (i - s > 10) runs.push([(s/100).toFixed(2), ((i-s)/100).toFixed(2)]); s = null; } }
      return runs; }""", jid)
    print("silences (start, length):", gap)
    join = [g for g in gap if 3.3 < float(g[0]) < 3.7]
    assert join and 0.3 <= float(join[0][1]) <= 0.7, f"join pause should be normal, got {join}"
    print("ERRORS:", errs); b.close()
