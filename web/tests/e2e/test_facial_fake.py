# Reconhecimento facial com consentimento: cadastra o rosto da câmera falsa como "Eric Teste" e confere que o nome
# passa a aparecer no track, na etiqueta e no aviso; sem consentimento não liga; apagar limpa.
import json, sys, time, os
from _base import servir, esperar, ARGS_FAKE, SAIDA
from playwright.sync_api import sync_playwright

PORT = 8796
URL = sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{PORT}/"
Y4M = r"C:\tmp\radar-fake-near.y4m"

httpd = servir(PORT)
errs = []
with sync_playwright() as p:
    browser = p.chromium.launch(args=ARGS_FAKE(Y4M))
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL, wait_until="networkidle")
    page.evaluate("window.__radar.apagarPessoas()")
    # sem consentimento: marcar só a caixa do reconhecimento NÃO liga
    page.check("#chk-facial")
    sem_consent = page.evaluate("window.__radar.estado.facial.ligado")
    ligado = page.evaluate("window.__radar.setFacial(true)")
    page.click("#btn-ligar")  # começa no modo Atenção (rosto de frente não gera aviso): cadastra e reconhece com calma
    esperar(page, lambda e: e["rodando"] and e["cams"][0]["validos"] > 0, tentativas=60)
    est = esperar(page, lambda e: e["facial"]["pronto"] or e["facial"]["erro"], tentativas=240)  # modelo 6,5 MB + tfjs no headless
    print("MODELO", json.dumps(est["facial"], ensure_ascii=False))
    cad = None
    for _ in range(6):  # rosto precisa estar estável (>= 1,5 s) e sozinho; detecção espúria some em 1-2 s
        time.sleep(1.5)
        cad = page.evaluate("window.__radar.cadastrarRosto(0, 'Eric Teste')")
        if cad.get("ok"): break
    print("CADASTRO", cad)
    est = esperar(page, lambda e: any(t["pessoa"] == "Eric Teste" for t in e["cams"][0]["pessoas"]), tentativas=120)
    reconhecido = any(t["pessoa"] == "Eric Teste" for t in est["cams"][0]["pessoas"])
    # troca pro modo Exercício com regra de 12 s: o rosto de frente vira "fora do exercício" DEPOIS de ser reconhecido de novo
    page.click('.modo[data-modo="exercicio"]')
    page.evaluate("window.__radar.setSegundos(12)")
    est = esperar(page, lambda e: "Eric Teste" in (e["sessao"]["ultimoAviso"] or ""), tentativas=100)
    nomes = page.evaluate("window.__radar.nomes(0)")
    lista = page.locator("#lista-pessoas li").all_text_contents()
    print("TRACKS", json.dumps(est["cams"][0]["pessoas"], ensure_ascii=False), "AVISO", est["sessao"]["ultimoAviso"], "NOMES", nomes, "LISTA", lista)
    page.screenshot(path=os.path.join(SAIDA, "test_facial_fake.png"), full_page=True)
    page.evaluate("window.__radar.apagarPessoas()")
    depois = page.evaluate("window.__radar.pessoas()")
    browser.close()
httpd.shutdown()
ok = (sem_consent is False and ligado is True and est["facial"]["pronto"] and cad.get("ok") is True
      and reconhecido and "Eric Teste" in (est["sessao"]["ultimoAviso"] or "")
      and "Eric Teste" in nomes and any("Eric Teste" in l for l in lista) and depois == [] and not errs and not est["erros"])
print("PAGE_ERRORS", errs[:5], "ERROS_APP", est["erros"][:5])
print("RESULTADO", "PASSOU" if ok else "FALHOU")
sys.exit(0 if ok else 1)
