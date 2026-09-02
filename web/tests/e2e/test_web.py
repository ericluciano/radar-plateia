# 1 camera falsa (rosto pequeno no fundo): motor inicia, rosto detectado e trackeado, 5 modos sem erro.
import json, sys, time, os
from _base import servir, esperar, ARGS_FAKE, SAIDA
from playwright.sync_api import sync_playwright

PORT = 8791
URL = sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{PORT}/"
Y4M = r"C:\tmp\radar-fake.y4m"

httpd = servir(PORT)
page_errors, console_errors = [], []
with sync_playwright() as p:
    browser = p.chromium.launch(args=ARGS_FAKE(Y4M))
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: page_errors.append(str(e)))
    page.goto(URL, wait_until="networkidle")
    page.click("#btn-ligar")
    est = esperar(page, lambda e: e["rodando"] and e["cams"][0]["validos"] > 0)
    print("ESTADO", json.dumps(est, ensure_ascii=False))
    modos = {}
    for m in ["exercicio", "produtividade", "postura", "presenca", "atencao"]:
        page.click(f'.modo[data-modo="{m}"]'); time.sleep(2)
        e = page.evaluate("window.__radar.estado"); modos[m] = (e["modo"], len(e["erros"]))
    print("MODOS", modos)
    # medidor de ruido (microfone falso do Chromium) e relatorio/CSV
    page.click("#chk-ruido"); time.sleep(2.5)
    ruido = page.evaluate("window.__radar.estado.ruido")
    csv = page.evaluate("window.__radar.csv()")
    linhas_csv = csv.count("\r\n")
    print("RUIDO", ruido, "CSV_LINHAS", linhas_csv, "CSV_INICIO", csv[:40].encode("unicode_escape").decode()[:60])
    page.screenshot(path=os.path.join(SAIDA, "test_web.png"), full_page=True)
    final = page.evaluate("window.__radar.estado")
    browser.close()
httpd.shutdown()
ok = est and est["rodando"] and est["cams"][0]["validos"] >= 1 and not page_errors and not final["erros"] \
     and all(v[0] == k for k, v in modos.items()) and isinstance(ruido, int) and linhas_csv >= 3 \
     and csv.startswith("﻿hora;tipo;modo")
print("PAGE_ERRORS", page_errors[:5], "CONSOLE_ERRORS", console_errors[:5])
print("RESULTADO", "PASSOU" if ok else "FALHOU")
sys.exit(0 if ok else 1)
