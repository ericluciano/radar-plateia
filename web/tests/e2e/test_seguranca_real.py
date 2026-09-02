# Modo Seguranca com WEBCAM REAL (headless): prova que o detector de pessoas roda no hardware real.
# Nao afirma "sem colete" nem "com colete" — depende de quem esta na frente da camera. Imprime o estado e salva screenshot.
# RADAR_CAM_LABEL=BRIO escolhe a camera pelo trecho do nome (default: camera padrao do sistema).
import json, sys, time, os
from _base import servir, esperar, SAIDA
from playwright.sync_api import sync_playwright

PORT = 8794
URL = sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{PORT}/"
ESPERA_S = float(os.environ.get("RADAR_REAL_ESPERA", "12"))
CAM_LABEL = os.environ.get("RADAR_CAM_LABEL", "").lower()

httpd = servir(PORT)
errs = []
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--mute-audio"])
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL, wait_until="networkidle")
    page.click('.modo[data-modo="seguranca"]')
    page.evaluate("window.__radar.setSegundos(5)")
    page.click("#btn-ligar")
    est = esperar(page, lambda e: e["rodando"] and e["pessoasOk"], tentativas=90)
    escolhida = "padrão"
    if CAM_LABEL:
        devs = page.evaluate("window.__radar.devices()")
        alvo = next((d for d in devs if CAM_LABEL in (d["label"] or "").lower()), None)
        if alvo:
            page.evaluate(f"window.__radar.setCamDevice(0, {json.dumps(alvo['id'])})")
            escolhida = alvo["label"]
            esperar(page, lambda e: e["cams"][0]["rodando"], tentativas=30)
        else:
            print("CAMERA_NAO_ENCONTRADA", CAM_LABEL, [d["label"] for d in devs])
    time.sleep(ESPERA_S)
    est = page.evaluate("window.__radar.estado")
    contadores = page.locator(".contador .num").all_text_contents()
    log = page.locator("#log li").all_text_contents()[:6]
    page.screenshot(path=os.path.join(SAIDA, "test_seguranca_real.png"), full_page=True)
    browser.close()
httpd.shutdown()
print("CAMERA", escolhida)
print("ESTADO", json.dumps({"pessoasOk": est["pessoasOk"], "cams": est["cams"], "sessao": est["sessao"], "erros": est["erros"]}, ensure_ascii=False))
print("CONTADORES", contadores, "LOG", log)
ok = est["rodando"] and est["pessoasOk"] and est["cams"][0]["rodando"] and not errs and not est["erros"]
print("PAGE_ERRORS", errs[:5])
print("RESULTADO", "PASSOU" if ok else "FALHOU", "(camera real; pessoas detectadas:", est["cams"][0]["tracks"], ")")
sys.exit(0 if ok else 1)
