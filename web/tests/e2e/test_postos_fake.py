# Postos/assentos: posto mapeado sobre a pessoa da câmera falsa vira o NOME dela nos avisos e nas estatísticas.
import json, sys, time, os
from _base import servir, esperar, ARGS_FAKE, SAIDA
from playwright.sync_api import sync_playwright

PORT = 8795
URL = sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{PORT}/"
Y4M = r"C:\tmp\radar-fake-near.y4m"  # rosto grande de frente -> no modo Exercicio vira "fora do exercicio" e gera aviso

httpd = servir(PORT)
errs = []
with sync_playwright() as p:
    browser = p.chromium.launch(args=ARGS_FAKE(Y4M))
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL, wait_until="networkidle")
    page.click('.modo[data-modo="exercicio"]')
    page.evaluate("window.__radar.setSegundos(3)")
    # um posto cobrindo o quadro inteiro (a pessoa está no centro) e um pequeno no canto que não pega ninguém
    page.evaluate("window.__radar.setPostos(0, [{id:'x1', nome:'Mesa da Ana', box:[0.05,0.05,0.9,0.9]}, {id:'x2', nome:'Canto', box:[0,0,0.03,0.03]}])")
    page.click("#btn-ligar")
    est = esperar(page, lambda e: e["rodando"] and e["cams"][0]["validos"] > 0, tentativas=60)
    esperar(page, lambda e: e["sessao"]["avisos"] >= 1, tentativas=40)
    est = page.evaluate("window.__radar.estado")
    nomes = page.evaluate("window.__radar.nomes(0)")
    botao = page.locator(".cell-postos").first.text_content()
    persistido = page.evaluate("JSON.parse(localStorage.getItem('radar.cfg.v1')).postos")
    page.screenshot(path=os.path.join(SAIDA, "test_postos_fake.png"), full_page=True)
    browser.close()
httpd.shutdown()
print("AVISO", est["sessao"]["ultimoAviso"], "NOMES", nomes, "BOTAO", botao, "PERSISTIDO", json.dumps(persistido)[:160])
ok = (est["sessao"]["avisos"] >= 1 and "Mesa da Ana" in (est["sessao"]["ultimoAviso"] or "") and "Mesa da Ana" in nomes
      and "2" in botao and persistido and not errs and not est["erros"])
print("PAGE_ERRORS", errs[:5])
print("RESULTADO", "PASSOU" if ok else "FALHOU")
sys.exit(0 if ok else 1)
