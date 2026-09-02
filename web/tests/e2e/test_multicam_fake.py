# 2 celulas na mesma camera falsa (rosto grande): soma dos contadores, grade 2, renomear, presenca, remover.
import json, sys, time, os
from _base import servir, esperar, ARGS_FAKE, SAIDA
from playwright.sync_api import sync_playwright

PORT = 8792
URL = sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{PORT}/"
Y4M = r"C:\tmp\radar-fake-near.y4m"

httpd = servir(PORT)
page_errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(args=ARGS_FAKE(Y4M))
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.goto(URL, wait_until="networkidle")
    page.click("#btn-ligar")
    est = esperar(page, lambda e: e["rodando"] and e["cams"][0]["validos"] > 0)
    page.click("#btn-add-cam")
    est = esperar(page, lambda e: len(e["cams"]) == 2 and all(c["rodando"] and c["validos"] > 0 for c in e["cams"]))
    print("CAMS", json.dumps(est["cams"], ensure_ascii=False))
    time.sleep(3)
    contadores = page.locator(".contador .num").all_text_contents()
    grade = page.evaluate("document.getElementById('feeds').dataset.n")
    print("CONTADORES", contadores, "GRADE", grade)
    page.fill(".cell:nth-child(2) .cell-nome", "Sala 2")
    page.click('.modo[data-modo="presenca"]')
    esperar(page, lambda e: all(c["validos"] > 0 for c in e["cams"]), 20); time.sleep(1)
    presenca = page.locator(".contador .num").all_text_contents()
    print("PRESENCA", presenca)
    page.click('.modo[data-modo="atencao"]'); time.sleep(2)
    page.screenshot(path=os.path.join(SAIDA, "test_multicam_fake.png"), full_page=True)
    page.click(".cell:nth-child(2) .cell-x"); time.sleep(1.5)
    est = page.evaluate("window.__radar.estado")
    print("APOS_REMOVER", len(est["cams"]), json.dumps(est["erros"], ensure_ascii=False))
    browser.close()
httpd.shutdown()
ok = (contadores and int(contadores[0]) >= 2 and grade == "2" and presenca and int(presenca[0]) >= 2
      and len(est["cams"]) == 1 and not page_errors and not est["erros"])
print("PAGE_ERRORS", page_errors[:5])
print("RESULTADO", "PASSOU" if ok else "FALHOU")
sys.exit(0 if ok else 1)
