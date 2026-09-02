# Gera os videos de camera falsa (y4m) a partir de uma foto com rosto. Saida em C:/tmp (nao versionar).
import os, subprocess, sys

FOTO = os.environ.get("RADAR_FACE_IMG", r"C:\repos\automacoes-inteligentes-site\src\img\eric-foto.png")
OUT_DIR = r"C:\tmp"
os.makedirs(OUT_DIR, exist_ok=True)
if not os.path.exists(FOTO):
    print(f"foto nao encontrada: {FOTO} — defina RADAR_FACE_IMG"); sys.exit(1)

# Variante com COLETE de alta visibilidade pintado no torso (modo Seguranca): painel amarelo fluorescente + 2 faixas refletivas.
COLETE_PNG = os.path.join(OUT_DIR, "radar-fake-colete.png")
try:
    from PIL import Image, ImageDraw
    im = Image.open(FOTO).convert("RGB")
    w, h = im.size
    d = ImageDraw.Draw(im)
    d.rectangle([int(0.15 * w), int(0.44 * h), int(0.85 * w), int(0.82 * h)], fill=(204, 255, 0))
    for fy in (0.55, 0.66):
        d.rectangle([int(0.15 * w), int(fy * h), int(0.85 * w), int((fy + 0.03) * h)], fill=(225, 225, 225))
    im.save(COLETE_PNG)
    print("OK  " + COLETE_PNG)
except Exception as e:  # sem PIL o teste de Seguranca nao roda, os outros sim
    print("AVISO sem PIL, colete nao gerado:", e); COLETE_PNG = None

alvos = {
    # rosto grande, ocupa o quadro (caso "perto")
    "radar-fake-near.y4m": (FOTO, "scale=1280:-2,crop=1280:720"),
    # rosto pequeno (~65px) no alto do quadro (caso "fundo da sala")
    "radar-fake.y4m": (FOTO, "scale=160:-1,pad=1280:720:600:40:black"),
    # pessoa inteira (meio corpo) no centro, sem colete
    "radar-fake-pessoa.y4m": (FOTO, "scale=-2:720,pad=1280:720:(ow-iw)/2:0:black"),
}
if COLETE_PNG:
    alvos["radar-fake-colete.y4m"] = (COLETE_PNG, "scale=-2:720,pad=1280:720:(ow-iw)/2:0:black")

for nome, (entrada, vf) in alvos.items():
    out = os.path.join(OUT_DIR, nome)
    cmd = ["ffmpeg", "-y", "-loop", "1", "-i", entrada, "-t", "4", "-r", "10", "-vf", vf, "-pix_fmt", "yuv420p", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    ok = r.returncode == 0 and os.path.getsize(out) > 1_000_000
    print(("OK  " if ok else "FALHA ") + out)
    if not ok: print(r.stderr[-800:]); sys.exit(1)
