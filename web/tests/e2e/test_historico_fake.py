# Histórico de sessões (IndexedDB), presença automática, modo telão e relatório imprimível: parar guarda a sessão,
# ela sobrevive ao recarregar a página, "abrir" traz o relatório de volta; telão liga/desliga; impressão monta o HTML.
import json, sys, time, os
from _base import servir, esperar, ARGS_FAKE, SAIDA
from playwright.sync_api import sync_playwright

PORT = 8797
URL = sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{PORT}/"
Y4M = r"C:\tmp\radar-fake-near.y4m"

httpd = servir(PORT)
errs = []
with sync_playwright() as p:
    browser = p.chromium.launch(args=ARGS_FAKE(Y4M))
    ctx = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = ctx.new_page()
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL, wait_until="networkidle")
    antes = page.evaluate("window.__radar.historico()")
    page.click('.modo[data-modo="presenca"]')
    page.click("#btn-ligar")
    esperar(page, lambda e: e["rodando"] and e["cams"][0]["validos"] > 0, tentativas=60)
    telao_on = page.evaluate("window.__radar.telao(true)")
    time.sleep(1.5)
    telao_txt = page.locator("#telao").inner_text()
    page.screenshot(path=os.path.join(SAIDA, "test_telao.png"))
    telao_off = page.evaluate("window.__radar.telao(false)")
    esperar(page, lambda e: e["sessao"]["amostras"] >= 3, tentativas=40)  # >= 3 amostras (15 s)
    page.click("#btn-parar")
    time.sleep(1.5)
    rel = page.evaluate("window.__radar.relatorioHtml()")
    depois = page.evaluate("window.__radar.historico()")
    # impressão: intercepta window.print e confere o HTML montado
    page.evaluate("window.print = () => { window.__printed = document.getElementById('print-rel').innerText; }")
    page.click("#btn-print")
    impresso = page.evaluate("window.__printed || ''")
    # recarrega: a sessão continua no histórico; abrir traz o relatório
    page.reload(wait_until="networkidle")
    time.sleep(1)
    apos_reload = page.evaluate("window.__radar.historico()")
    aberto = page.evaluate(f"window.__radar.abrirSessao({apos_reload[0]['id']})") if apos_reload else False
    time.sleep(0.5)
    rel_aberto = page.evaluate("window.__radar.relatorioHtml()")
    lista = page.locator("#lista-sessoes li").all_text_contents()
    page.screenshot(path=os.path.join(SAIDA, "test_historico.png"), full_page=True)
    browser.close()
httpd.shutdown()
print("ANTES", len(antes), "DEPOIS", json.dumps(depois), "APOS_RELOAD", json.dumps(apos_reload))
print("TELAO", telao_on, telao_off, repr(telao_txt[:120]))
print("REL", repr(rel[:200]))
print("IMPRESSO", repr(impresso[:160]))
print("ABERTO", aberto, repr(rel_aberto[:160]), "LISTA", lista[:2])
ok = (len(depois) == len(antes) + 1 and depois[0]["modo"] == "presenca" and depois[0]["amostras"] >= 3
      and len(apos_reload) == len(depois) and aberto is True and "PICO" in rel.upper() and "ENTRADAS" in rel.upper() and "PICO" in rel_aberto.upper()
      and telao_on is True and telao_off is False and "PRESEN" in telao_txt.upper()
      and "Radar da Plateia" in impresso and "Avisos" in impresso
      and any("Presença" in l for l in lista) and not errs)
print("PAGE_ERRORS", errs[:5])
print("RESULTADO", "PASSOU" if ok else "FALHOU")
sys.exit(0 if ok else 1)
