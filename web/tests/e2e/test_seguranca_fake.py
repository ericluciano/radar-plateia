# Modo Seguranca: pessoa SEM colete vira "Sem EPI" e gera aviso apos T segundos; pessoa COM colete alta-visibilidade fica "Com EPI".
import json, sys, time, os
from _base import servir, esperar, ARGS_FAKE, SAIDA
from playwright.sync_api import sync_playwright

PORT = 8793
URL = sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{PORT}/"
SEM = r"C:\tmp\radar-fake-pessoa.y4m"
COM = r"C:\tmp\radar-fake-colete.y4m"


def rodar(p, y4m, segundos, espera_s, nome):
    errs = []
    browser = p.chromium.launch(args=ARGS_FAKE(y4m))
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(URL, wait_until="networkidle")
    page.click('.modo[data-modo="seguranca"]')
    page.evaluate(f"window.__radar.setSegundos({segundos})")
    page.evaluate("window.__radar.setEpi({colete: true, capacete: false, rigor: 'normal'})")
    campo_visivel = page.evaluate("!document.getElementById('campo-epi').hidden")
    page.click("#btn-ligar")
    esperar(page, lambda e: e["rodando"] and e["pessoasOk"] and e["cams"][0]["tracks"] > 0, tentativas=90)
    time.sleep(espera_s)
    est = page.evaluate("window.__radar.estado")
    contadores = page.locator(".contador .num").all_text_contents()
    page.screenshot(path=os.path.join(SAIDA, f"test_seguranca_{nome}.png"), full_page=True)
    browser.close()
    return est, contadores, campo_visivel, errs


httpd = servir(PORT)
with sync_playwright() as p:
    sem, c_sem, campo, e1 = rodar(p, SEM, 3, 8, "sem_colete")
    com, c_com, _, e2 = rodar(p, COM, 3, 8, "com_colete")
httpd.shutdown()

resumo = lambda e: {"pessoasOk": e["pessoasOk"], "cams": e["cams"], "sessao": e["sessao"], "epi": e["epi"], "erros": e["erros"]}
print("SEM_COLETE", json.dumps(resumo(sem), ensure_ascii=False), "CONTADORES", c_sem)
print("COM_COLETE", json.dumps(resumo(com), ensure_ascii=False), "CONTADORES", c_com)

ok_sem = (sem["cams"][0]["ruins"] >= 1 and sem["sessao"]["avisos"] >= 1 and "colete" in (sem["sessao"]["ultimoAviso"] or "")
          and campo and len(c_sem) == 3 and not e1 and not sem["erros"])
ok_com = (com["cams"][0]["bons"] >= 1 and com["cams"][0]["ruins"] == 0 and com["sessao"]["avisos"] == 0
          and not e2 and not com["erros"])
print("PAGE_ERRORS", (e1 + e2)[:5])
print("RESULTADO", "PASSOU" if ok_sem and ok_com else "FALHOU", "sem_colete", ok_sem, "com_colete", ok_com)
sys.exit(0 if ok_sem and ok_com else 1)
