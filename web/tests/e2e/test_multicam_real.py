# Webcams REAIS da maquina, Chrome visivel (permissao automatica). Precisa de 2 cameras plugadas.
import json, sys, time, os
from _base import servir, esperar, SAIDA
from playwright.sync_api import sync_playwright

PORT = 8793
httpd = servir(PORT)
page_errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(headless=False, args=["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    page = browser.new_page(viewport={"width": 1500, "height": 1000})
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.goto(f"http://127.0.0.1:{PORT}/", wait_until="networkidle")
    page.click("#btn-ligar")
    esperar(page, lambda e: e["rodando"] or e["cams"][0]["erro"])
    devs = page.evaluate("window.__radar.devices()")
    print("DEVICES", json.dumps(devs, ensure_ascii=False))
    reais = [d for d in devs if d["id"]]
    if len(reais) >= 2:
        page.evaluate(f"window.__radar.setCamDevice(0, {json.dumps(reais[0]['id'])})")
        page.evaluate(f"window.__radar.addCam({json.dumps(reais[1]['id'])}, 'Câmera 2')")
    esperar(page, lambda e: len(e["cams"]) >= 2 and all(c["rodando"] for c in e["cams"]), 40)
    time.sleep(12)
    est = page.evaluate("window.__radar.estado")
    print("CAMS", json.dumps(est["cams"], ensure_ascii=False))
    print("FPS_PILL", page.locator("#pill-fps").text_content())
    page.screenshot(path=os.path.join(SAIDA, "test_multicam_real.png"), full_page=True)
    browser.close()
httpd.shutdown()
ok = len(est["cams"]) >= 2 and all(c["rodando"] for c in est["cams"]) and not page_errors and not est["erros"]
print("PAGE_ERRORS", page_errors[:5])
print("RESULTADO", "PASSOU" if ok else "FALHOU")
sys.exit(0 if ok else 1)
