# Gera os videos de camera falsa (y4m) a partir de uma foto com rosto. Saida em C:/tmp (nao versionar).
import os, subprocess, sys

FOTO = os.environ.get("RADAR_FACE_IMG", r"C:\repos\automacoes-inteligentes-site\src\img\eric-foto.png")
OUT_DIR = r"C:\tmp"
os.makedirs(OUT_DIR, exist_ok=True)
if not os.path.exists(FOTO):
    print(f"foto nao encontrada: {FOTO} — defina RADAR_FACE_IMG"); sys.exit(1)

alvos = {
    # rosto grande, ocupa o quadro (caso "perto")
    "radar-fake-near.y4m": "scale=1280:-2,crop=1280:720",
    # rosto pequeno (~65px) no alto do quadro (caso "fundo da sala")
    "radar-fake.y4m": "scale=160:-1,pad=1280:720:600:40:black",
}
for nome, vf in alvos.items():
    out = os.path.join(OUT_DIR, nome)
    cmd = ["ffmpeg", "-y", "-loop", "1", "-i", FOTO, "-t", "4", "-r", "10", "-vf", vf, "-pix_fmt", "yuv420p", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    ok = r.returncode == 0 and os.path.getsize(out) > 1_000_000
    print(("OK  " if ok else "FALHA ") + out)
    if not ok: print(r.stderr[-800:]); sys.exit(1)
