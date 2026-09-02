# Utilidades comuns dos testes e2e: servidor local silencioso e espera por estado.
import functools, http.server, os, threading, time

WEB_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SAIDA = os.path.join(os.path.dirname(__file__), "saida")
os.makedirs(SAIDA, exist_ok=True)

class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def servir(port):
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(_Quiet, directory=WEB_DIR))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd

def esperar(page, cond, tentativas=60, passo=0.5):
    est = None
    for _ in range(tentativas):
        time.sleep(passo)
        est = page.evaluate("window.__radar.estado")
        if cond(est): break
    return est

ARGS_FAKE = lambda y4m: [
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    f"--use-file-for-fake-video-capture={y4m}", "--autoplay-policy=no-user-gesture-required", "--mute-audio",
]
